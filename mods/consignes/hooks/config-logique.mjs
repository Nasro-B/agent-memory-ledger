// config-logique.mjs : logique pure des réglages du Cockpit (les worktrees mesurés et le dossier des plans) et de la commande qui les
// change (`cockpit.js config ...`, `/cockpit config ...`). Source unique des valeurs par défaut.
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code et au module des Consignes (copie identique, vérifiée
// par un test) et chargé par require() dans le noyau du Cockpit et les hooks Codex (Node 22.12 ou plus, sans avertissement).
// Les vérifications qui touchent le disque (le dossier existe, c'est un dépôt git) sont fournies par l'appelant (`verif`) : sans elles,
// la commande ne vérifie rien.
// Réglages : { worktrees: [{ nom, chemin }], plans: { dossier, exclure: [nom], profondeur } }.
// Par défaut : aucun worktree mesuré et aucun dossier de plans (l'utilisateur les pose par la commande de configuration).

export const MAX_WORKTREES = 8;

const gele = o => Object.freeze(o);
export const DEFAUTS = gele({
  worktrees: gele([]),
  plans: gele({ dossier: '', exclure: gele([]), profondeur: 3 }),
});

const LARGEUR_VALEUR = 300;
const PROFONDEUR_MAX = 10;
const NOM_WORKTREE = /^[A-Za-z0-9._-]{1,20}$/;
const USAGE = 'Usage : cockpit config [afficher | worktree ajouter <nom> <chemin> | worktree retirer <nom> | worktrees defaut | plans <dossier> | plans exclure <nom> | plans inclure <nom> | plans profondeur <1 à 10> | plans defaut | defaut]';

const estObjet = v => v !== null && typeof v === 'object';
const chaineNonVide = v => typeof v === 'string' && v.trim() !== '';
const copieWorktrees = liste => liste.map(w => ({ nom: w.nom, chemin: w.chemin }));

// Les réglages valides, toujours une copie : modifier le résultat ne touche ni l'argument ni les défauts.
export function normaliserConfig(brut) {
  const b = estObjet(brut) ? brut : {};
  const p = estObjet(b.plans) ? b.plans : {};
  return {
    worktrees: Array.isArray(b.worktrees) ? copieWorktrees(b.worktrees.filter(w => estObjet(w) && chaineNonVide(w.nom) && chaineNonVide(w.chemin))) : copieWorktrees(DEFAUTS.worktrees),
    plans: {
      dossier: chaineNonVide(p.dossier) ? p.dossier : DEFAUTS.plans.dossier,
      exclure: Array.isArray(p.exclure) && p.exclure.every(chaineNonVide) ? p.exclure.slice() : DEFAUTS.plans.exclure.slice(),
      profondeur: Number.isInteger(p.profondeur) && p.profondeur >= 1 ? p.profondeur : DEFAUTS.plans.profondeur,
    },
  };
}

// Les valeurs que les consignes citent à la place de {worktrees} et {plans} : bornées, sur une ligne.
export function valeursJetons(brut) {
  const c = normaliserConfig(brut);
  const liste = c.worktrees.length === 0 ? '(aucun)' : c.worktrees.map(w => `${w.nom} (${w.chemin})`).join(', ');
  return {
    worktrees: liste.length > LARGEUR_VALEUR ? `${liste.slice(0, LARGEUR_VALEUR - 3)}...` : liste,
    plans: c.plans.dossier,
  };
}

export function texteReglages(brut) {
  const c = normaliserConfig(brut);
  const wt = c.worktrees.length === 0 ? 'aucun' : c.worktrees.map(w => `${w.nom} ${w.chemin}`).join(' ; ');
  return [
    'Réglages du Cockpit.',
    `Worktrees mesurés (${c.worktrees.length}) : ${wt}`,
    `Dossier des plans : ${c.plans.dossier === '' ? 'aucun' : c.plans.dossier} (profondeur ${c.plans.profondeur}, exclus : ${c.plans.exclure.length === 0 ? 'aucun' : c.plans.exclure.join(', ')})`,
  ].join('\n');
}

// Un chemin tel qu'on le range : barres obliques, sans barre finale (sauf la racine d'un lecteur ou de l'arborescence).
function chemin(texte) {
  const t = texte.replace(/\\/g, '/');
  return t.length > 1 && t.endsWith('/') && !/^[A-Za-z]:\/$/.test(t) ? t.replace(/\/+$/, '') : t;
}

const cleChemin = texte => process.platform === 'win32' ? chemin(texte).toLowerCase() : chemin(texte);

// Une erreur de vérification, ou null. `exigerDepot` : un worktree doit être un dépôt git, un dossier de plans non.
function verifier(verif, c, exigerDepot) {
  const v = estObjet(verif) ? verif : {};
  if (typeof v.dossierExiste === 'function' && !v.dossierExiste(c)) return `Le dossier ${c} n'existe pas.`;
  if (exigerDepot && typeof v.estDepot === 'function' && !v.estDepot(c)) return `Le dossier ${c} n'est pas une racine de dépôt git utilisable.`;
  return null;
}

// cockpit config <args> : rend { config, message } ou { erreur } (rien ne change en cas d'erreur).
export function analyserCommande(args, brut, verif) {
  const c = normaliserConfig(brut);
  const mots = String(args == null ? '' : args).replace(/\s+/g, ' ').trim().split(' ');
  const [a, b, ...reste] = mots;
  const premier = a.toLowerCase();
  const second = b === undefined ? '' : b.toLowerCase();

  if (premier === '' || premier === 'afficher' || premier === 'liste' || premier === 'etat' || premier === 'état') {
    return mots.length > 1 ? { erreur: USAGE } : { config: c, message: texteReglages(c) };
  }

  if (premier === 'defaut') {
    return mots.length > 1 ? { erreur: USAGE } : { config: normaliserConfig(null), message: 'Tous les réglages remis aux valeurs par défaut.' };
  }

  if (premier === 'worktrees') {
    if (second !== 'defaut' || reste.length > 0) return { erreur: USAGE };
    return { config: { worktrees: copieWorktrees(DEFAUTS.worktrees), plans: c.plans }, message: 'Worktrees remis aux valeurs par défaut.' };
  }

  if (premier === 'worktree') {
    if (second === 'ajouter') {
      const nom = reste[0];
      const cible = reste.slice(1).join(' ');
      if (cible === '') return { erreur: USAGE }; // sans nom, il n'y a pas de chemin non plus
      if (!NOM_WORKTREE.test(nom)) return { erreur: `Nom de worktree invalide : ${nom} (lettres, chiffres, point, tiret et tiret bas, 20 au plus).` };
      const existe = c.worktrees.some(w => w.nom === nom);
      if (!existe && c.worktrees.length >= MAX_WORKTREES) return { erreur: `Déjà ${MAX_WORKTREES} worktrees, le maximum. Retire-en un avec worktree retirer <nom>.` };
      const rangé = chemin(cible);
      const autre = c.worktrees.find(w => w.nom !== nom && cleChemin(w.chemin) === cleChemin(rangé));
      if (autre) return { erreur: `Le chemin ${rangé} est déjà suivi sous le nom ${autre.nom}.` };
      const probleme = verifier(verif, rangé, true);
      if (probleme !== null) return { erreur: probleme };
      const worktrees = existe ? c.worktrees.map(w => (w.nom === nom ? { nom, chemin: rangé } : w)) : [...c.worktrees, { nom, chemin: rangé }];
      return { config: { worktrees, plans: c.plans }, message: `Worktree ${nom} ${existe ? 'modifié' : 'ajouté'} : ${rangé}.` };
    }
    if (second === 'retirer') {
      if (reste.length !== 1) return { erreur: USAGE };
      const nom = reste[0];
      if (!c.worktrees.some(w => w.nom === nom)) return { erreur: `Worktree ${nom} introuvable (noms : ${c.worktrees.map(w => w.nom).join(', ') || 'aucun'}).` };
      return { config: { worktrees: c.worktrees.filter(w => w.nom !== nom), plans: c.plans }, message: `Worktree ${nom} retiré.` };
    }
    return { erreur: USAGE };
  }

  if (premier === 'plans') {
    if (second === '') return { erreur: USAGE };
    const avecPlans = plans => ({ worktrees: c.worktrees, plans });
    if (second === 'defaut') return reste.length > 0 ? { erreur: USAGE } : { config: avecPlans(normaliserConfig(null).plans), message: 'Plans remis aux valeurs par défaut.' };
    if (second === 'profondeur') {
      if (reste.length !== 1 || !/^\d+$/.test(reste[0])) return { erreur: USAGE };
      const n = Number(reste[0]);
      if (n < 1 || n > PROFONDEUR_MAX) return { erreur: USAGE };
      return { config: avecPlans({ ...c.plans, profondeur: n }), message: `Profondeur de recherche des plans : ${n}.` };
    }
    if (second === 'exclure') {
      if (reste.length !== 1) return { erreur: USAGE };
      const exclure = c.plans.exclure.includes(reste[0]) ? c.plans.exclure : [...c.plans.exclure, reste[0]];
      return { config: avecPlans({ ...c.plans, exclure }), message: `Dossier de plans exclu : ${reste[0]}.` };
    }
    if (second === 'inclure') {
      if (reste.length !== 1) return { erreur: USAGE };
      if (!c.plans.exclure.includes(reste[0])) return { erreur: `${reste[0]} n'est pas exclu (exclus : ${c.plans.exclure.join(', ') || 'aucun'}).` };
      return { config: avecPlans({ ...c.plans, exclure: c.plans.exclure.filter(x => x !== reste[0]) }), message: `Dossier de plans de nouveau pris en compte : ${reste[0]}.` };
    }
    const dossier = chemin(mots.slice(1).join(' '));
    const probleme = verifier(verif, dossier, false);
    if (probleme !== null) return { erreur: probleme };
    return { config: avecPlans({ ...c.plans, dossier }), message: `Dossier des plans : ${dossier}.` };
  }

  return { erreur: USAGE };
}
