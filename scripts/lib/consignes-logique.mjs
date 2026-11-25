// consignes-logique.mjs : logique pure des Consignes en vigueur (les ordres permanents de l'utilisateur, rappelés à chaque requête,
// et le refus des commandes et des agents que le code sait reconnaître).
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code (copie identique,
// vérifiée par un test) et chargé par require() dans les hooks Codex (Node 22.12 ou plus, sans avertissement).
// État : { prochain, consignes: [{ id, texte, actif, verrou }] }. Par défaut : aucune consigne, donc inerte (rien à rappeler,
// rien à refuser), exactement comme avant les Consignes.
//
// Verrous (ce que le code vérifie) et motifs de commandes. Ils sont voisins de ceux de la garde de sécurité (scripts/gardes/securite.js), qui
// DEMANDE à l'utilisateur avant un push ou un déploiement ; une consigne verrouillée REFUSE sans demander :
//   push         git push (options globales de git admises : -C, -c, --git-dir...)
//   deploiement  vercel ... --prod, wrangler deploy ou publish
//   rebuild      build d'application mobile :
//                gradlew assemble, bundle ou build ; eas build ; expo prebuild
//   agent        aucun nouvel agent (refus du lancement, pas d'une commande)
// Limite connue : comme la garde de sécurité, la commande est lue telle quelle. Un « git push » écrit en toutes lettres dans un
// message de commit la ferait refuser ; le modèle reformule. Une consigne sans verrou n'est que rappelée, jamais vérifiée.

export const MAX_CONSIGNES = 20;
export const MAX_TEXTE = 240;
export const VERROUS = Object.freeze(['push', 'deploiement', 'rebuild', 'agent']);

const USAGE = 'Usage : /consignes [liste | ajouter <texte> | retirer <n> | pause <n> | reprendre <n> | verrou <n> push|deploiement|rebuild|agent|aucun]';
const INTRO = "CONSIGNES EN VIGUEUR DE L'UTILISATEUR (ordres permanents, liste complète et à jour : elle remplace toute liste vue avant ; valables après compactage ; « verrou » = le code refuse ce qu'il sait reconnaître) :";
// Ce que l'utilisateur peut taper pour choisir un verrou (aucun retire le verrou).
const SAISIE_VERROU = { push: 'push', deploiement: 'deploiement', 'déploiement': 'deploiement', rebuild: 'rebuild', agent: 'agent', agents: 'agent', aucun: null, aucune: null };

const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const idValide = n => Number.isInteger(n) && n >= 1;
const accord = (n, un, plusieurs) => `${n} ${n < 2 ? un : plusieurs}`;

// Motifs. Aucun drapeau g (un test() sur une regex globale garde un état d'une commande à l'autre) ; [^|;&\n]* ne traverse ni
// un séparateur de commandes ni un retour à la ligne.
const VALEUR = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const OPTIONS_GIT = String.raw`(?:\s+(?:-C\s+${VALEUR}|--(?:git-dir|work-tree|namespace|exec-path)\s+${VALEUR}|--[a-z][a-z-]*(?:=${VALEUR})?))*`;
const MOTIFS = {
  push: [new RegExp(String.raw`\bgit${OPTIONS_GIT}\s+push\b`, 'i')],
  deploiement: [/\bvercel\b[^|;&\n]*--prod\b/i, /\bwrangler\s+(?:deploy|publish)\b/i],
  rebuild: [/\bgradlew\b[^|;&\n]*[\s:](?:assemble\w*|bundle\w*|build)(?=\s|$)/i, /\beas\s+build(?![\w:])/i, /\bexpo\s+prebuild\b/i],
};
// git.exe push, wrangler.cmd deploy : l'extension est retirée avant le test, comme dans la garde de sécurité (seuls les binaires
// dont un motif exige l'espace qui suit leur nom ; vercel et gradlew acceptent déjà un suffixe).
const EXTENSIONS = /(git|wrangler|eas|expo)\.(?:exe|cmd|bat)/gi;

export const etatParDefaut = () => ({ prochain: 1, consignes: [] });

export function normaliserEtat(brut) {
  const b = estObjet(brut) ? brut : {};
  const consignes = [];
  const vus = new Set();
  for (const e of Array.isArray(b.consignes) ? b.consignes : []) {
    if (consignes.length >= MAX_CONSIGNES) break;
    if (!estObjet(e) || !idValide(e.id) || vus.has(e.id) || typeof e.texte !== 'string') continue;
    const texte = e.texte.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTE).trimEnd();
    if (texte === '') continue;
    vus.add(e.id);
    consignes.push({ id: e.id, texte, actif: e.actif !== false, verrou: VERROUS.includes(e.verrou) ? e.verrou : null });
  }
  const plusGrand = consignes.reduce((m, c) => Math.max(m, c.id), 0);
  return { prochain: Math.max(idValide(b.prochain) ? b.prochain : 1, plusGrand + 1), consignes };
}

export const consignesActives = etat => normaliserEtat(etat).consignes.filter(c => c.actif);

const suffixe = c => (c.verrou ? ` [verrou : ${c.verrou}]` : '');
// Les jetons {worktrees} et {plans} d'un texte de consigne sont remplacés à chaque lecture par les valeurs courantes des réglages du
// Cockpit (config-logique.mjs, valeursJetons) : changer les réglages change la consigne, le texte enregistré garde ses jetons.
// Un seul passage : une valeur qui contient un jeton n'est pas remplacée une seconde fois. Une valeur absente se lit « (non configuré) ».
const JETONS = /\{(worktrees|plans)\}/g;
const NON_CONFIGURE = '(non configuré)';
const substituer = (texte, valeurs) => {
  const v = estObjet(valeurs) ? valeurs : {};
  return texte.replace(JETONS, (_, cle) => (typeof v[cle] === 'string' && v[cle] !== '' ? v[cle] : NON_CONFIGURE));
};

const avecVerrou = (c, valeurs) => `${c.id}. ${substituer(c.texte, valeurs)}${suffixe(c)}`;

// Texte du prompt système (adaptateur Claude Code, recomposé à chaque requête, donc intact après un compactage ; Codex : injecté avec le
// bloc du Cockpit). Il ne dépend QUE des consignes, jamais de l'heure ni d'un compte : le prompt reste en cache.
export function texteInjection(etat, valeurs) {
  const actives = consignesActives(etat);
  return actives.length ? [INTRO, ...actives.map(c => avecVerrou(c, valeurs))].join('\n') : null;
}

export function texteListe(etat, valeurs) {
  const e = normaliserEtat(etat);
  if (e.consignes.length === 0) return 'Aucune consigne en vigueur. Ajoute-en une avec /consignes ajouter <texte>.';
  const actives = e.consignes.filter(c => c.actif).length;
  const lignes = e.consignes.map(c => `${c.id}. [${c.actif ? 'actif' : 'pause'}] ${substituer(c.texte, valeurs)}${suffixe(c)}`);
  return [`Consignes en vigueur : ${accord(actives, 'active', 'actives')} sur ${e.consignes.length}.`, ...lignes].join('\n');
}

// Une ligne de statut ; undefined quand aucune consigne n'est active.
export function texteStatut(etat) {
  const actives = consignesActives(etat);
  if (actives.length === 0) return undefined;
  return `Consignes : ${accord(actives.length, 'active', 'actives')} (${accord(actives.filter(c => c.verrou).length, 'verrouillée', 'verrouillées')})`;
}

const raisonRefus = (c, objet, valeurs) => `Consigne ${c.id} de l'utilisateur (« ${substituer(c.texte, valeurs)} »), verrou ${c.verrou} : ${objet}. Si l'utilisateur lève cet ordre, il dira « /consignes pause ${c.id} ».`;

// Une commande de shell (Bash, PowerShell) est-elle refusée par une consigne verrouillée active ? La première consigne de la
// liste qui correspond répond. Rend { autorise: true } ou { autorise: false, raison, id, verrou }.
export function decisionCommande(etat, commande, valeurs) {
  if (typeof commande !== 'string') return { autorise: true };
  const cmd = commande.replace(EXTENSIONS, '$1');
  for (const c of consignesActives(etat)) {
    const motifs = MOTIFS[c.verrou];
    if (motifs !== undefined && motifs.some(m => m.test(cmd))) {
      return { autorise: false, raison: raisonRefus(c, 'cette commande est refusée, ne la lance pas', valeurs), id: c.id, verrou: c.verrou };
    }
  }
  return { autorise: true };
}

// Lancer un agent est-il refusé par une consigne verrouillée agent ?
export function decisionAgent(etat, valeurs) {
  const c = consignesActives(etat).find(x => x.verrou === 'agent');
  if (c === undefined) return { autorise: true };
  return { autorise: false, raison: raisonRefus(c, "aucun nouvel agent, ne lance pas celui-ci", valeurs), id: c.id, verrou: 'agent' };
}

const entier = s => (/^\d+$/.test(s) ? Number(s) : NaN);

// /consignes <args> : rend { etat, message } ou { erreur } (rien ne change en cas d'erreur).
export function analyserCommande(args, etat, valeurs) {
  const e = normaliserEtat(etat);
  const [mot, ...reste] = String(args == null ? '' : args).replace(/\s+/g, ' ').trim().split(' ');
  const sous = mot.toLowerCase();

  if (sous === '' || sous === 'liste' || sous === 'etat' || sous === 'état') {
    return reste.length > 0 ? { erreur: USAGE } : { etat: e, message: texteListe(e, valeurs) };
  }

  if (sous === 'ajouter') {
    const texte = reste.join(' ');
    if (texte === '') return { erreur: 'Texte manquant. Usage : /consignes ajouter <texte>' };
    if (texte.length > MAX_TEXTE) return { erreur: `Texte trop long (${texte.length} caractères, ${MAX_TEXTE} au plus).` };
    if (e.consignes.length >= MAX_CONSIGNES) return { erreur: `Déjà ${MAX_CONSIGNES} consignes, le maximum. Retire-en une avec /consignes retirer <n>.` };
    return {
      etat: { prochain: e.prochain + 1, consignes: [...e.consignes, { id: e.prochain, texte, actif: true, verrou: null }] },
      message: `Consigne ${e.prochain} ajoutée.`,
    };
  }

  if (sous === 'retirer' || sous === 'pause' || sous === 'reprendre' || sous === 'verrou') {
    if (reste.length !== (sous === 'verrou' ? 2 : 1)) return { erreur: USAGE };
    const id = entier(reste[0]);
    if (!e.consignes.some(c => c.id === id)) return { erreur: `Consigne ${reste[0]} introuvable (identifiants : ${e.consignes.map(c => c.id).join(', ') || 'aucun'}).` };
    const change = modif => ({ prochain: e.prochain, consignes: e.consignes.map(c => (c.id === id ? { ...c, ...modif } : c)) });

    if (sous === 'retirer') return { etat: { prochain: e.prochain, consignes: e.consignes.filter(c => c.id !== id) }, message: `Consigne ${id} retirée.` };
    if (sous === 'pause') return { etat: change({ actif: false }), message: `Consigne ${id} en pause (elle n'est plus rappelée ni appliquée).` };
    if (sous === 'reprendre') return { etat: change({ actif: true }), message: `Consigne ${id} reprise.` };

    const saisie = reste[1].toLowerCase();
    if (!Object.hasOwn(SAISIE_VERROU, saisie)) return { erreur: USAGE };
    const verrou = SAISIE_VERROU[saisie];
    return { etat: change({ verrou }), message: verrou === null ? `Consigne ${id} : verrou retiré.` : `Consigne ${id} : verrou ${verrou}.` };
  }

  return { erreur: USAGE };
}
