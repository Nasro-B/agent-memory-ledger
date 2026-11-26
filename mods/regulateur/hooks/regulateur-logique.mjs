// regulateur-logique.mjs : logique pure du Régulateur d'agents (plafond d'agents en parallèle, pause, rappel).
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code (copie identique,
// vérifiée par un test) et chargé par require() dans les hooks Codex (Node 22.12 ou plus, sans avertissement).
// Politique : { max: 1..50 ou null (libre), pause: bool, relance: bool, file: bool }. Par défaut : inerte (max null, pas de pause,
// pas de relance, pas de file) : la décision autorise tout et le rappel est vide, exactement comme avant le Régulateur.
// file : un agent refusé par le maximum est mis en file (file-logique.mjs) au lieu d'être simplement refusé ; le suivant est lancé
// dès qu'un créneau se libère (Claude : par l'adaptateur ; Codex : sur ordre donné au modèle) et les échoués sont relancés si relance.

export const PLAFOND_MAX = 50;
const STATUTS_OCCUPES = new Set(['pending', 'running', 'waiting']); // AgentStatus : idle et les fins ne tiennent aucun créneau
const LARGEUR_NOM = 40;
const MAX_NOMS = 5;
const USAGE = 'Usage : /plafond [N (1 à 50) | libre | pause | reprendre | relance on|off | file on|off|vider]';
const FILE_CLAUDE = "Un agent refusé par le maximum est mis en file par le Régulateur et lancé automatiquement dès qu'un créneau se libère : ne le relance pas et ne lance pas le suivant toi-même.";
const FILE_CODEX = "Un agent refusé par le maximum est mis en file : à la fin de ton tour, le Régulateur te demandera de le lancer, avec exactement les mêmes arguments. Ne le relance pas toi-même.";
const RELANCE_AUTO = "Relance activée : le Régulateur relance lui-même un agent échoué depuis son point d'arrêt, 2 fois au plus chacun ; ne le relance pas toi-même.";

const accord = (n, un, plusieurs) => `${n} ${n === 1 ? un : plusieurs}`;
const compte = n => (Number.isInteger(n) && n >= 0 ? n : null);

function nomPropre(x) {
  const t = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  return t.length > LARGEUR_NOM ? `${t.slice(0, LARGEUR_NOM - 3)}...` : t;
}

export const politiqueParDefaut = () => ({ max: null, pause: false, relance: false, file: false });

export function normaliserPolitique(brut) {
  const b = brut !== null && typeof brut === 'object' && !Array.isArray(brut) ? brut : {};
  return {
    max: Number.isInteger(b.max) && b.max >= 1 && b.max <= PLAFOND_MAX ? b.max : null,
    pause: b.pause === true,
    relance: b.relance === true,
    file: b.file === true,
  };
}

export function creneauxOccupes(agents) {
  if (!Array.isArray(agents)) return 0;
  let n = 0;
  for (const a of agents) if (a && typeof a === 'object' && STATUTS_OCCUPES.has(a.status)) n++;
  return n;
}

export function decisionLancement(politique, occupes) {
  const p = normaliserPolitique(politique);
  const n = compte(occupes) ?? 0;
  if (p.pause) return { autorise: false, raison: "Régulateur d'agents : en pause. Ne lance aucun agent tant que l'utilisateur n'a pas dit « /plafond reprendre » ou « /plafond libre ».", mettreEnFile: false };
  if (p.max !== null && n >= p.max) {
    // mettreEnFile : l'appelant peut mettre la demande en file (et refuser avec le texte de la file) au lieu de la refuser sèchement.
    return { autorise: false, raison: `Régulateur d'agents : ${accord(n, 'agent en cours', 'agents en cours')} sur ${p.max} (maximum fixé par l'utilisateur). Ne lance pas celui-ci maintenant : dès qu'un agent finit, lance le suivant de ta liste.`, mettreEnFile: p.file };
  }
  return { autorise: true };
}

function etat(p, occupes) {
  const n = compte(occupes);
  const cours = n === null ? '' : `, ${n} en cours`;
  let tete;
  if (p.pause) tete = `en pause${p.max !== null ? ` (maximum ${p.max})` : ''}${cours}`;
  else if (p.max !== null) {
    const libres = n === null ? '' : ` (${n >= p.max ? 'aucun créneau libre' : accord(p.max - n, 'créneau libre', 'créneaux libres')})`;
    tete = `maximum ${p.max}${cours}${libres}`;
  } else tete = `libre${cours}`;
  return `Agents : ${tete}. Relance des échoués : ${p.relance ? 'oui' : 'non'}. File : ${p.file ? 'oui' : 'non'}.`;
}

// /plafond <args> : rend { politique, message } ou { erreur } (rien ne change en cas d'erreur). `file vider` rend en plus viderFile:
// true, la file étant un autre état que l'appelant vide lui-même.
export function analyserCommande(args, politique, occupes) {
  const p = normaliserPolitique(politique);
  const t = String(args == null ? '' : args).trim().toLowerCase().replace(/\s+/g, ' ');
  if (t === '' || t === 'etat' || t === 'état') return { politique: p, message: etat(p, occupes) };
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n < 1 || n > PLAFOND_MAX) return { erreur: USAGE };
    return { politique: { ...p, max: n, pause: false }, message: `Agents : maximum ${n} en parallèle.` };
  }
  if (t === 'libre') return { politique: { ...p, max: null, pause: false }, message: 'Agents : libre, aucun maximum.' };
  if (t === 'pause') return { politique: { ...p, pause: true }, message: 'Agents : en pause, aucun nouvel agent ne sera lancé.' };
  if (t === 'reprendre') {
    return { politique: { ...p, pause: false }, message: p.max === null ? 'Agents : reprise, aucun maximum.' : `Agents : reprise, maximum ${p.max} en parallèle.` };
  }
  const r = /^relance (on|oui|off|non)$/.exec(t);
  if (r) {
    const actif = r[1] === 'on' || r[1] === 'oui';
    return { politique: { ...p, relance: actif }, message: `Agents : relance des échoués ${actif ? 'activée' : 'désactivée'}.` };
  }
  const f = /^file (on|oui|off|non|vider)$/.exec(t);
  if (f) {
    if (f[1] === 'vider') return { politique: p, message: "Agents : file d'attente vidée.", viderFile: true };
    const actif = f[1] === 'on' || f[1] === 'oui';
    return { politique: { ...p, file: actif }, message: `Agents : file d'attente ${actif ? 'activée' : 'désactivée'}.` };
  }
  return { erreur: USAGE };
}

// Rappel du prompt système (adaptateur Claude Code, recomposé à chaque requête, donc intact après un compactage). Il ne dépend QUE de
// la politique : un texte qui changerait avec le nombre d'agents casserait le cache du prompt à chaque requête.
export function rappelStable(politique) {
  const p = normaliserPolitique(politique);
  const morceaux = [];
  if (p.pause) {
    morceaux.push("PAUSE : ne lance aucun agent tant que l'utilisateur n'a pas dit « /plafond reprendre » ou « /plafond libre ».");
  } else {
    if (p.max !== null) {
      morceaux.push(`Maximum ${p.max} agents en parallèle. ${p.file ? FILE_CLAUDE : "Dès qu'un agent finit, lance le suivant de ta liste sans attendre ; si le maximum est atteint, n'en lance pas avant qu'un finisse."}`);
    }
    if (p.relance) morceaux.push(p.file ? RELANCE_AUTO : "Relance activée : un agent échoué se relance depuis son point d'arrêt, 2 fois au plus chacun.");
  }
  return morceaux.length ? `RÉGULATEUR D'AGENTS (ordre de l'utilisateur, valable après compactage) : ${morceaux.join(' ')}` : null;
}

// Rappel dynamique (Codex : injecté quand l'état change, jamais dans un prompt mis en cache). null quand il n'y a rien à dire.
// etat : { occupes: nombre d'agents qui tiennent un créneau, echoues: noms des agents échoués }.
export function rappel(politique, etatCourant) {
  const p = normaliserPolitique(politique);
  const e = etatCourant !== null && typeof etatCourant === 'object' ? etatCourant : {};
  const n = compte(e.occupes);
  const echoues = Array.isArray(e.echoues) ? e.echoues.map(nomPropre).filter(Boolean) : [];
  const morceaux = [];
  if (p.pause) {
    morceaux.push("PAUSE : ne lance aucun agent tant que l'utilisateur n'a pas dit « /plafond reprendre » ou « /plafond libre ».");
  } else if (p.max !== null) {
    morceaux.push(`Maximum ${p.max} agents en parallèle.`);
    if (n !== null) {
      morceaux.push(n >= p.max
        ? `${n} en cours, aucun créneau libre : n'en lance pas avant qu'un finisse.`
        : `${n} en cours, ${accord(p.max - n, 'créneau libre', 'créneaux libres')}. Dès qu'un agent finit, lance le suivant de ta liste sans attendre.`);
    }
    if (p.file) morceaux.push(FILE_CODEX);
  }
  if (p.relance && echoues.length) {
    const noms = echoues.slice(0, MAX_NOMS).join(', ') + (echoues.length > MAX_NOMS ? ` +${echoues.length - MAX_NOMS}` : '');
    morceaux.push(`Agents échoués à relancer depuis leur point d'arrêt (2 relances au plus chacun) : ${noms}.`);
  }
  if (!morceaux.length) return null;
  // Borné par construction : au plus cinq noms de 40 caractères et des phrases fixes (le banc le vérifie : 600 au plus).
  return `RÉGULATEUR D'AGENTS (ordre de l'utilisateur, valable après compactage) : ${morceaux.join(' ')}`;
}
