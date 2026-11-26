// quota-logique.mjs : logique pure du Garde-quota (fenêtres de quota, alertes à 80 % puis 90 %, blocage des nouveaux agents,
// consigne au modèle, remise à zéro, commande /quota). Les fenêtres sont celles que le moteur rapporte : 7 j seule quand le moteur ne rapporte pas
// de session de 5 h, 5 h et 7 j chez Codex ; rien ici ne suppose l'une d'elles.
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code (copie identique,
// vérifiée par un test) et chargé par require() dans les hooks Codex (Node 22.12 ou plus, sans avertissement).
// Une fenêtre : { nom: '5 h' | '7 j' | 'budget' | autre, pct: nombre ou null, resetsAt?: date ISO }.
// Les fonctions qui prennent une configuration la veulent NORMALISÉE (normaliserConfig) ; le reste est tolérant.

const NOMS = Object.freeze({ five_hour: '5 h', seven_day: '7 j', spend_limit: 'budget' });
const ORDRE = ['5 h', '7 j', 'budget'];
const RANG = { ok: 0, attention: 1, critique: 2 };
const USAGE = 'Usage : /quota [<attention> <critique> | bloquer on|off | consigne on|off | son on|off | defaut]';

const objet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const entier = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const date = s => (typeof s === 'string' ? Date.parse(s) : NaN);
const pourcent = p => Math.round(p);
const oui = actif => (actif ? 'oui' : 'non');

export const configParDefaut = () => ({ attention: 80, critique: 90, bloquerAgents: true, consigne: true, son: true });

// Seul `false` désactive un réglage ; un seuil d'attention qui n'est pas sous le seuil critique remet les deux aux défauts
// (ce qui borne déjà l'attention à 99 au plus et le seuil critique à 2 au moins : les bornes ci-dessous sont celles d'un pourcentage).
export function normaliserConfig(brut) {
  const b = objet(brut) ? brut : {};
  let attention = entier(b.attention, 1, 100) ?? 80;
  let critique = entier(b.critique, 1, 100) ?? 90;
  if (attention >= critique) { attention = 80; critique = 90; }
  return { attention, critique, bloquerAgents: b.bloquerAgents !== false, consigne: b.consigne !== false, son: b.son !== false };
}

// Fenêtres de quota du moteur (SessionRateLimit : kind, percentUsed, resetsAt) vers les fenêtres du Garde-quota.
export function normaliserFenetres(brut) {
  if (!Array.isArray(brut)) return [];
  const out = [];
  for (const f of brut) {
    if (!objet(f) || typeof f.kind !== 'string' || f.kind === '') continue;
    const w = {
      nom: Object.hasOwn(NOMS, f.kind) ? NOMS[f.kind] : f.kind,
      pct: Number.isFinite(f.percentUsed) ? Math.round(f.percentUsed * 10) / 10 : null,
    };
    if (Number.isFinite(date(f.resetsAt))) w.resetsAt = f.resetsAt;
    out.push(w);
  }
  return trierFenetres(out);
}

// Les fenêtres d'une mesure gardée dans un fichier (déjà au format du Garde-quota) : celles qui sont bien formées, rien d'autre.
export function assainirFenetres(brut) {
  if (!Array.isArray(brut)) return [];
  const out = [];
  for (const f of brut) {
    if (!objet(f) || typeof f.nom !== 'string' || f.nom === '') continue;
    const w = { nom: f.nom, pct: Number.isFinite(f.pct) ? f.pct : null };
    if (Number.isFinite(date(f.resetsAt))) w.resetsAt = f.resetsAt;
    out.push(w);
  }
  return trierFenetres(out);
}

// 5 h, 7 j, budget, puis les autres dans l'ordre où elles sont venues.
function trierFenetres(liste) {
  const rang = n => { const i = ORDRE.indexOf(n); return i === -1 ? ORDRE.length : i; };
  return liste.map((w, i) => [w, i]).sort((a, b) => rang(a[0].nom) - rang(b[0].nom) || a[1] - b[1]).map(x => x[0]);
}

// Le nom d'une fenêtre de Codex vient de sa durée : 300 minutes font « 5 h », 10080 minutes font « 7 j ».
function nomDeDuree(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} j`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

// rate_limits d'un événement token_count du rollout de Codex (primary et secondary : { used_percent, window_minutes,
// resets_at en secondes depuis 1970 }) vers les fenêtres du Garde-quota.
export function normaliserFenetresCodex(brut) {
  if (!objet(brut)) return [];
  const out = [];
  for (const f of [brut.primary, brut.secondary]) {
    if (!objet(f) || !Number.isInteger(f.window_minutes) || f.window_minutes <= 0) continue;
    const w = { nom: nomDeDuree(f.window_minutes), pct: Number.isFinite(f.used_percent) ? Math.round(f.used_percent * 10) / 10 : null };
    const fin = Number.isFinite(f.resets_at) && f.resets_at > 0 ? new Date(f.resets_at * 1000) : null;
    if (fin !== null && Number.isFinite(fin.getTime())) w.resetsAt = fin.toISOString();
    out.push(w);
  }
  return trierFenetres(out);
}

export function niveau(pct, config) {
  if (!Number.isFinite(pct)) return 'ok';
  if (pct >= config.critique) return 'critique';
  if (pct >= config.attention) return 'attention';
  return 'ok';
}

// Une fenêtre dont la remise à zéro est passée ne dit plus rien de l'usage présent.
export const actives = (fenetres, maintenant) =>
  (Array.isArray(fenetres) ? fenetres : []).filter(f => objet(f) && !(date(f.resetsAt) <= maintenant));

export function niveauGlobal(fenetres, config, maintenant) {
  let haut = 'ok';
  for (const f of actives(fenetres, maintenant)) {
    const n = niveau(f.pct, config);
    if (RANG[n] > RANG[haut]) haut = n;
  }
  return haut;
}

export function dureeCourte(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "moins d'une minute";
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

const lister = noms => (noms.length <= 1 ? noms.join('') : `${noms.slice(0, -1).join(', ')} et ${noms[noms.length - 1]}`);

// Annonces à faire : une par fenêtre, par période (date de remise à zéro) et par niveau. `deja` est l'état rendu la fois d'avant
// (liste de clés) ; l'état rendu ne garde que les clés des fenêtres actuelles, une période terminée s'oublie donc d'elle-même.
// Un pourcentage illisible garde les annonces déjà faites de sa fenêtre. Le critique comprend l'attention déjà dépassée.
export function alertes(fenetres, config, maintenant, deja) {
  const vues = new Set(Array.isArray(deja) ? deja.filter(s => typeof s === 'string') : []);
  const nouvelles = [];
  const gardees = new Set();
  for (const f of actives(fenetres, maintenant)) {
    const prefixe = `${f.nom}|${f.resetsAt ?? ''}|`;
    if (!Number.isFinite(f.pct)) {
      for (const k of vues) if (k.startsWith(prefixe)) gardees.add(k);
      continue;
    }
    const n = niveau(f.pct, config);
    if (n === 'ok') continue;
    const cle = `${prefixe}${n}`;
    if (!vues.has(cle)) nouvelles.push({ fenetre: f.nom, niveau: n, pct: f.pct, resetsAt: f.resetsAt, cle });
    gardees.add(`${prefixe}attention`);
    if (n === 'critique') gardees.add(cle);
  }
  return { nouvelles, deja: [...gardees] };
}

// Fenêtres actuellement à l'attention ou au critique : ce qu'il faut retenir pour voir plus tard qu'elles sont remises à zéro.
export function hautsActuels(fenetres, config, maintenant) {
  return actives(fenetres, maintenant)
    .filter(f => niveau(f.pct, config) !== 'ok')
    .map(f => (f.resetsAt ? { nom: f.nom, resetsAt: f.resetsAt } : { nom: f.nom }));
}

// Noms des fenêtres retenues hautes que la mesure donne maintenant basses ET dont la remise à zéro est passée ou a changé de date.
// Sans mesure de la fenêtre, on ne sait pas : rien.
export function remisesAZero(hauts, fenetres, config, maintenant) {
  const remises = [];
  if (!Array.isArray(hauts)) return remises;
  const courantes = Array.isArray(fenetres) ? fenetres : [];
  for (const p of hauts) {
    if (!objet(p) || typeof p.nom !== 'string') continue;
    const f = courantes.find(x => objet(x) && x.nom === p.nom);
    if (!f || niveau(f.pct, config) !== 'ok') continue;
    const prevu = date(p.resetsAt);
    const nouvelle = date(f.resetsAt);
    const passee = Number.isFinite(prevu) && prevu <= maintenant;
    const changee = Number.isFinite(nouvelle) && (!Number.isFinite(prevu) || nouvelle > prevu);
    if (passee || changee) remises.push(p.nom);
  }
  return remises;
}

// Met à jour la liste des fenêtres retenues hautes d'après une mesure, et rend les remises à zéro constatées. Une fenêtre
// retenue que la mesure ne contient pas garde son entrée (on ne sait pas encore) ; une fenêtre mesurée basse en sort.
export function suivreHauts(anciens, fenetres, config, maintenant) {
  const mesurees = new Set((Array.isArray(fenetres) ? fenetres : []).filter(objet).map(f => f.nom));
  const gardes = (Array.isArray(anciens) ? anciens : []).filter(p => objet(p) && typeof p.nom === 'string' && !mesurees.has(p.nom));
  return { hauts: [...hautsActuels(fenetres, config, maintenant), ...gardes], remises: remisesAZero(anciens, fenetres, config, maintenant) };
}

export const DUREE_REMISE_MS = 30 * 60 * 1000;

// La consigne de remise à zéro reste dans le prompt 30 minutes après la constatation, puis s'en va d'elle-même.
export function remiseRecente(remise, maintenant) {
  return objet(remise) && Array.isArray(remise.noms) && remise.noms.length > 0 && typeof remise.ts === 'number'
    && remise.ts <= maintenant && maintenant - remise.ts < DUREE_REMISE_MS;
}

export function decisionAgent(fenetres, config, maintenant) {
  if (!config.bloquerAgents) return { autorise: true };
  const f = actives(fenetres, maintenant).find(x => niveau(x.pct, config) === 'critique');
  if (!f) return { autorise: true };
  const fin = date(f.resetsAt);
  const reste = Number.isFinite(fin) ? `, remise à zéro dans ${dureeCourte(fin - maintenant)}` : '';
  return { autorise: false, raison: `Garde-quota : fenêtre ${f.nom} à ${pourcent(f.pct)} % (seuil ${config.critique} %)${reste}. Ne lance aucun agent avant la remise à zéro : journalise, commite les fichiers attribués et écris le prompt de relais.` };
}

// Consigne du prompt système (recomposé à chaque requête, donc intact après un compactage). Elle ne dépend NI du pourcentage
// exact NI de l'heure : un texte qui changerait à chaque mesure casserait le cache du prompt au pire moment (quota presque épuisé).
export function consigne(fenetres, config, maintenant, { autre = "l'autre agent", fichier = null } = {}) {
  if (!config.consigne) return null;
  const noms = actives(fenetres, maintenant).filter(f => niveau(f.pct, config) === 'critique').map(f => f.nom);
  if (!noms.length) return null;
  return `GARDE-QUOTA (ordre de l'utilisateur, valable après compactage) : fenêtre ${lister(noms)} au-delà de ${config.critique} %. Maintenant : journalise ce qui est fait (history et Memory-Auto), commite les fichiers attribués (jamais de push), écris le prompt de relais pour ${autre}${fichier ? ` dans ${fichier}` : ''}, puis ne lance plus d'agent avant la remise à zéro.`;
}

export function consigneRemise(noms) {
  const l = Array.isArray(noms) ? noms.filter(n => typeof n === 'string' && n !== '') : [];
  if (!l.length) return null;
  const sujet = l.length === 1 ? `la fenêtre ${l[0]} est remise` : `les fenêtres ${lister(l)} sont remises`;
  return `GARDE-QUOTA : ${sujet} à zéro. Les nouveaux agents sont de nouveau permis : relance les agents arrêtés par la coupure (liste dans le Cockpit), puis reprends les lignes ouvertes.`;
}

// Ligne de statut : une entrée par fenêtre active ; undefined quand il n'y a rien à montrer (efface la ligne).
export function texteStatut(fenetres, config, maintenant) {
  const morceaux = actives(fenetres, maintenant).map(f => {
    const n = niveau(f.pct, config);
    const marque = n === 'critique' ? ' CRITIQUE' : n === 'attention' ? ' ATTENTION' : '';
    const fin = date(f.resetsAt);
    const reste = Number.isFinite(fin) ? ` (remise à zéro dans ${dureeCourte(fin - maintenant)})` : '';
    return `${f.nom} ${Number.isFinite(f.pct) ? pourcent(f.pct) : '?'} %${marque}${reste}`;
  });
  return morceaux.length ? morceaux.join(' | ') : undefined;
}

export function texteAlerte(alerte, maintenant, config = configParDefaut()) {
  const fin = date(alerte.resetsAt);
  const reste = Number.isFinite(fin) ? ` (remise à zéro dans ${dureeCourte(fin - maintenant)})` : '';
  const etat = alerte.niveau === 'critique' ? (config.bloquerAgents ? 'seuil critique, nouveaux agents bloqués' : 'seuil critique') : 'attention';
  return `Quota ${alerte.fenetre} à ${pourcent(alerte.pct)} % : ${etat}${reste}`;
}

const etat = c => `Quota : seuils ${c.attention} % puis ${c.critique} %. Blocage des agents : ${oui(c.bloquerAgents)}. Consigne au modèle : ${oui(c.consigne)}. Son : ${oui(c.son)}.`;

const REGLAGES = {
  bloquer: { cle: 'bloquerAgents', dit: actif => `Quota : blocage des agents ${actif ? 'activé' : 'désactivé'}.` },
  consigne: { cle: 'consigne', dit: actif => `Quota : consigne au modèle ${actif ? 'activée' : 'désactivée'}.` },
  son: { cle: 'son', dit: actif => `Quota : son ${actif ? 'activé' : 'désactivé'}.` },
};

// /quota <args> : rend { config, message } ou { erreur } (rien ne change en cas d'erreur).
export function analyserCommande(args, configBrute) {
  const config = normaliserConfig(configBrute);
  const t = String(args == null ? '' : args).trim().toLowerCase().replace(/\s+/g, ' ');
  if (t === '' || t === 'etat' || t === 'état') return { config, message: etat(config) };
  if (t === 'defaut' || t === 'défaut') return { config: configParDefaut(), message: 'Quota : réglages remis aux valeurs par défaut.' };
  const seuils = /^(\d+) (\d+)$/.exec(t);
  if (seuils) {
    const attention = Number(seuils[1]);
    const critique = Number(seuils[2]);
    if (entier(attention, 1, 100) === null || entier(critique, 1, 100) === null || attention >= critique) return { erreur: USAGE };
    return { config: { ...config, attention, critique }, message: `Quota : seuils ${attention} % puis ${critique} %.` };
  }
  const reglage = /^(bloquer|consigne|son) (on|oui|off|non)$/.exec(t);
  if (reglage) {
    const r = REGLAGES[reglage[1]];
    const actif = reglage[2] === 'on' || reglage[2] === 'oui';
    return { config: { ...config, [r.cle]: actif }, message: r.dit(actif) };
  }
  return { erreur: USAGE };
}
