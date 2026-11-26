// pause-logique.mjs : logique pure de la Pause (suspendre une session ou un agent sans le tuer, puis le reprendre).
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code (copie identique, vérifiée par un
// test) et chargé par require() dans le noyau du Cockpit (Node 22.12 ou plus, sans avertissement).
// La pause est COOPÉRATIVE : le moteur n'a pas de pause native. L'adaptateur retient la boucle d'une session ou d'un agent avant sa prochaine
// requête au modèle et avant son prochain outil ; une réponse en cours d'écriture ou un outil déjà lancé va jusqu'au bout. Seul le bouton
// Stop de l'application interrompt sur-le-champ.
// État (COCKPIT_DIR/pause.json) :
//   { sessions: { <id de session>: { titre, vu, pause, depuis, agents: { <id d'agent>: { nom, statut, pause, depuis } } } } }
// Une session en pause arrête aussi ses agents ; un agent peut être arrêté seul. `vu` est le dernier battement de l'adaptateur de cette session :
// une session sans battement depuis cinq minutes est morte et sort de l'état. Par défaut : aucune session, donc inerte.

export const AGE_SESSION_MORTE_MS = 5 * 60 * 1000;
export const MAX_SESSIONS = 20;
export const MAX_AGENTS = 50;
// Longueur minimale d'un identifiant abrégé tapé dans une commande (sinon trop de sessions ou d'agents se ressemblent).
export const PREFIXE_MIN = 4;

const LARGEUR_TITRE = 60;
const LARGEUR_NOM = 40;
const LARGEUR_STATUT = 20;
const LARGEUR_ID = 128;
const LARGEUR_ID_COURT = 8;
const USAGE_PAUSE = 'Usage : /pause [tout | session [id ou titre] | agent <nom ou id> | agents | statut]';
const USAGE_REPRENDRE = 'Usage : /reprendre [tout | session [id ou titre] | agent <nom ou id> | agents | statut]';
const SESSION_INCONNUE = "Cette session n'est pas dans l'état de la pause : réessaie dans un instant, ou désigne-la avec session <id>.";
const SESSION_NON_DESIGNEE = "Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».";
const MOTS_TOUT = ['tout', 'toutes', 'tous'];
const MOTS_STATUT = ['statut', 'etat', 'état', 'liste'];
// Un /reprendre tapé dans une session retenue reste en file jusqu'à la fin de son
// tour, donc ne la libère pas. Les messages ne renvoient pas à la commande pour la session qui l'a tapée : ils disent par où reprendre.
const REPRISE_SESSION_COURANTE = "bouton Reprendre ou panneau Cockpit (un /reprendre tapé ici attendrait la fin du tour)";
const REPRISE_TOUT = "bouton Reprendre ou panneau Cockpit, ou « node cockpit.js reprendre tout » (un /reprendre tapé dans une session à l'arrêt attend la fin de son tour)";

const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// '__proto__' est refusé : sur un objet ordinaire, l'affecter changerait le prototype au lieu de créer une clé.
const idValide = v => typeof v === 'string' && v.length >= 1 && v.length <= LARGEUR_ID && v !== '__proto__';
const dateOuNull = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const accord = (n, un, plusieurs) => `${n} ${n < 2 ? un : plusieurs}`; // en français, zéro est au singulier
const iso = ms => new Date(ms).toISOString();
const idCourt = id => id.slice(0, LARGEUR_ID_COURT);

// Un texte sur une ligne, borné : un titre ou un nom venu d'un autre processus ne doit jamais déborder dans un message ou une bande.
function court(x, largeur) {
  const t = typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '';
  return t.length > largeur ? `${t.slice(0, largeur - 3)}...` : t;
}

export const etatParDefaut = () => ({ sessions: {} });

function agentValide(a) {
  const pause = a.pause === true;
  return { nom: court(a.nom, LARGEUR_NOM), statut: court(a.statut, LARGEUR_STATUT), pause, depuis: pause ? dateOuNull(a.depuis) : null };
}

export function normaliserEtat(brut) {
  const b = estObjet(brut) ? brut : {};
  const sessions = {};
  for (const [id, s] of estObjet(b.sessions) ? Object.entries(b.sessions) : []) {
    if (Object.keys(sessions).length >= MAX_SESSIONS) break;
    if (!idValide(id) || !estObjet(s)) continue;
    const agents = {};
    for (const [aid, a] of estObjet(s.agents) ? Object.entries(s.agents) : []) {
      if (Object.keys(agents).length >= MAX_AGENTS) break;
      if (idValide(aid) && estObjet(a)) agents[aid] = agentValide(a);
    }
    const pause = s.pause === true;
    sessions[id] = { titre: court(s.titre, LARGEUR_TITRE), vu: dateOuNull(s.vu), pause, depuis: pause ? dateOuNull(s.depuis) : null, agents };
  }
  return { sessions };
}

// Les sessions sans battement lisible depuis cinq minutes sont mortes (fenêtre fermée, processus tué) : elles sortent de l'état,
// leur pause avec elles. Rend { etat, retirees }.
export function purger(etatBrut, maintenant) {
  const etat = normaliserEtat(etatBrut);
  if (!Number.isFinite(maintenant)) return { etat, retirees: 0 };
  const vivantes = {};
  for (const [id, s] of Object.entries(etat.sessions)) {
    const vu = s.vu === null ? NaN : Date.parse(s.vu);
    if (Number.isFinite(vu) && maintenant - vu <= AGE_SESSION_MORTE_MS) vivantes[id] = s;
  }
  return { etat: { sessions: vivantes }, retirees: Object.keys(etat.sessions).length - Object.keys(vivantes).length };
}

// Le battement d'une session : fiche = { session, titre, agents: [{ id, nom, statut }] }. La session est créée ou mise à jour (`vu`), ses
// agents alignés sur la liste donnée (un agent qui n'y est plus sort de l'état, sa pause avec lui), la pause de la session et celles
// de ses agents connus conservées. Les sessions mortes sont purgées au passage, ce qui libère de la place. Une fiche illisible ne change rien.
export function inscrire(etatBrut, fiche, maintenant) {
  const etat = purger(etatBrut, maintenant).etat;
  if (!estObjet(fiche) || !idValide(fiche.session) || !Number.isFinite(maintenant)) return normaliserEtat(etatBrut);
  const avant = Object.hasOwn(etat.sessions, fiche.session) ? etat.sessions[fiche.session] : null;
  if (avant === null && Object.keys(etat.sessions).length >= MAX_SESSIONS) return etat;
  const agents = {};
  for (const a of Array.isArray(fiche.agents) ? fiche.agents : []) {
    if (!estObjet(a) || !idValide(a.id) || Object.keys(agents).length >= MAX_AGENTS) continue;
    const ancien = avant !== null && Object.hasOwn(avant.agents, a.id) ? avant.agents[a.id] : null;
    agents[a.id] = { nom: court(a.nom, LARGEUR_NOM), statut: court(a.statut, LARGEUR_STATUT), pause: ancien !== null && ancien.pause, depuis: ancien !== null ? ancien.depuis : null };
  }
  const titre = court(fiche.titre, LARGEUR_TITRE) || (avant !== null ? avant.titre : '');
  const session = { titre, vu: iso(maintenant), pause: avant !== null && avant.pause, depuis: avant !== null ? avant.depuis : null, agents };
  return { sessions: { ...etat.sessions, [fiche.session]: session } };
}

// La boucle d'une session (agentId absent) ou d'un agent doit-elle attendre avant sa prochaine étape ? Une session en pause arrête aussi
// ses agents ; un agent en pause seul n'arrête ni sa session ni ses voisins. Une session inconnue n'attend jamais : sans état, rien ne bloque.
// Rend { attendre: false } ou { attendre: true, cible: 'session' | 'agent', depuis }.
export function doitAttendre(etatBrut, session, agentId) {
  const etat = normaliserEtat(etatBrut);
  if (!Object.hasOwn(etat.sessions, session)) return { attendre: false };
  const s = etat.sessions[session];
  if (s.pause) return { attendre: true, cible: 'session', depuis: s.depuis };
  if (agentId !== undefined && Object.hasOwn(s.agents, agentId) && s.agents[agentId].pause) {
    return { attendre: true, cible: 'agent', depuis: s.agents[agentId].depuis };
  }
  return { attendre: false };
}

export function texteDuree(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return "moins d'une minute";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

const depuisTexte = (depuis, maintenant) => (depuis === null || !Number.isFinite(maintenant) ? '' : ` depuis ${texteDuree(maintenant - Date.parse(depuis))}`);

// Ce que la bande et le panneau montrent d'une session : ses agents (arrêtés par leur pause ou par celle de la session) et les compteurs.
export function resume(etatBrut, session) {
  const etat = normaliserEtat(etatBrut);
  const toutes = Object.values(etat.sessions);
  const cette = Object.hasOwn(etat.sessions, session) ? etat.sessions[session] : null;
  const agents = cette === null ? [] : Object.entries(cette.agents).map(([id, a]) => ({ id, nom: a.nom, statut: a.statut, propre: a.pause, arrete: cette.pause || a.pause, depuis: a.depuis }));
  return {
    sessions: toutes.length,
    sessionsEnPause: toutes.filter(s => s.pause).length,
    agentsArretes: toutes.reduce((n, s) => n + Object.values(s.agents).filter(a => s.pause || a.pause).length, 0),
    cette: cette === null ? null : { pause: cette.pause, depuis: cette.depuis, titre: cette.titre, agents },
  };
}

// Les sessions pour le panneau du Cockpit : chacune avec ses agents et ce qui les arrête, dans l'ordre de l'état.
export function listeSessions(etatBrut) {
  return Object.entries(normaliserEtat(etatBrut).sessions).map(([id, s]) => ({
    id,
    court: idCourt(id),
    titre: s.titre,
    vu: s.vu,
    pause: s.pause,
    depuis: s.depuis,
    agents: Object.entries(s.agents).map(([aid, a]) => ({ id: aid, nom: a.nom, statut: a.statut, propre: a.pause, arrete: s.pause || a.pause, depuis: a.depuis })),
  }));
}

// La bande au-dessus du prompt : ce qui est à l'arrêt, ou undefined quand rien ne l'est (les boutons restent, le texte s'efface).
export function texteBande(etatBrut, session, maintenant) {
  const r = resume(etatBrut, session);
  const morceaux = [];
  if (r.cette !== null && r.cette.pause) morceaux.push(`cette session en pause${depuisTexte(r.cette.depuis, maintenant)}`);
  const seuls = r.cette === null || r.cette.pause ? 0 : r.cette.agents.filter(a => a.propre).length;
  if (seuls > 0) morceaux.push(`${accord(seuls, 'agent', 'agents')} en pause`);
  const autres = r.sessionsEnPause - (r.cette !== null && r.cette.pause ? 1 : 0);
  if (autres > 0) morceaux.push(`${accord(autres, 'autre session', 'autres sessions')} en pause`);
  return morceaux.length === 0 ? undefined : `Pause : ${morceaux.join(' ; ')}`;
}

// La ligne que la session montre pendant qu'elle attend. Une session retenue ne traite pas un /reprendre tapé (voir REPRISE_SESSION_COURANTE) ; un agent
// retenu seul laisse la session principale libre, un /reprendre tapé dans celle-ci marche.
export function texteAttente(cible, depuis, maintenant) {
  const agent = cible === 'agent';
  const reprise = agent ? 'bouton Reprendre ou /reprendre' : 'bouton Reprendre ou panneau Cockpit, pas /reprendre';
  return `Pause : ${agent ? 'cet agent est' : 'cette session est'} à l'arrêt${depuisTexte(depuis, maintenant)} (reprise : ${reprise})`;
}

// /pause statut et /reprendre statut : toutes les sessions ouvertes, leurs agents, et ce qui est à l'arrêt.
export function texteStatut(etatBrut, session, maintenant) {
  const etat = normaliserEtat(etatBrut);
  const r = resume(etat, session);
  if (r.sessions === 0) return 'Pause : aucune session ouverte dans l\'état.';
  const lignes = [`Pause : ${accord(r.sessions, 'session ouverte', 'sessions ouvertes')}, ${r.sessionsEnPause} en pause, ${accord(r.agentsArretes, 'agent arrêté', 'agents arrêtés')}.`];
  for (const [id, s] of Object.entries(etat.sessions)) {
    const moi = id === session ? 'cette session' : 'session';
    const titre = s.titre === '' ? '' : ` « ${s.titre} »`;
    lignes.push(`- ${moi} ${idCourt(id)}${titre} : ${s.pause ? `en pause${depuisTexte(s.depuis, maintenant)}` : 'active'}`);
    for (const [aid, a] of Object.entries(s.agents)) {
      const etatAgent = s.pause ? 'arrêté par sa session' : a.pause ? `en pause${depuisTexte(a.depuis, maintenant)}` : 'actif';
      lignes.push(`    agent ${idCourt(aid)} « ${a.nom} »${a.statut === '' ? '' : ` (${a.statut})`} : ${etatAgent}`);
    }
  }
  return lignes.join('\n');
}

// ---------------------------------------------------------------- commandes /pause et /reprendre

function motsDe(args) {
  const t = String(args == null ? '' : args).replace(/\s+/g, ' ').trim();
  const i = t.indexOf(' ');
  return i < 0 ? { mot: t.toLowerCase(), reste: '' } : { mot: t.slice(0, i).toLowerCase(), reste: t.slice(i + 1) };
}

// Retrouve une entrée par identifiant exact, identifiant abrégé (PREFIXE_MIN caractères au moins) ou morceau du nom, sans tenir compte
// de la casse. `entrees` : [[id, nom]]. Rend { id } ou { erreur }.
function retrouver(entrees, ref, genre) {
  const r = ref.trim().toLowerCase();
  const exacts = entrees.filter(([id]) => id.toLowerCase() === r);
  if (exacts.length === 1) return { id: exacts[0][0] };
  const trouves = entrees.filter(([id, nom]) => (r.length >= PREFIXE_MIN && id.toLowerCase().startsWith(r)) || (nom !== '' && nom.toLowerCase().includes(r)));
  if (trouves.length === 1) return { id: trouves[0][0] };
  if (trouves.length === 0) return { erreur: `${genre} « ${court(ref, LARGEUR_NOM)} » introuvable (identifiants d'au moins ${PREFIXE_MIN} caractères, ou un morceau du nom).` };
  return { erreur: `${genre} « ${court(ref, LARGEUR_NOM)} » ambiguë : ${trouves.map(([id, nom]) => `${idCourt(id)}${nom === '' ? '' : ` « ${nom} »`}`).join(', ')}.` };
}

// La session qu'une référence désigne (identifiant, début d'identifiant, morceau du titre) : { id } ou { erreur }.
export function trouverSession(etatBrut, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return { erreur: SESSION_NON_DESIGNEE };
  return retrouver(Object.entries(normaliserEtat(etatBrut).sessions).map(([id, s]) => [id, s.titre]), ref, 'Session');
}

// Pourquoi la session de la commande n'est pas utilisable : jamais désignée (ligne de commande sans --session), ou pas encore dans l'état.
const erreurSession = session => ({ erreur: idValide(session) ? SESSION_INCONNUE : SESSION_NON_DESIGNEE });

const sansAgentsArretes = agents => Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, { ...a, pause: false, depuis: null }]));
const avecSession = (etat, id, s) => ({ sessions: { ...etat.sessions, [id]: s } });
const toutesLesSessions = (etat, f) => ({ sessions: Object.fromEntries(Object.entries(etat.sessions).map(([id, s]) => [id, f(s)])) });

function libelleSession(etat, id, courante) {
  const s = etat.sessions[id];
  return id === courante ? 'cette session' : `la session ${idCourt(id)}${s.titre === '' ? '' : ` « ${s.titre} »`}`;
}

function surSession(sens, etat, id, courante, maintenant) {
  const s = etat.sessions[id];
  const nom = libelleSession(etat, id, courante);
  const agents = Object.keys(s.agents).length;
  if (sens === 'pause') {
    if (s.pause) return { etat, message: `Pause : ${nom} est déjà en pause${depuisTexte(s.depuis, maintenant)}.` };
    const avec = agents === 0 ? '' : ` avec ${accord(agents, 'agent', 'agents')}`;
    // La session qui tape la commande est retenue si c'est elle qu'on arrête : elle se reprend par le bouton ou le panneau ; une autre session se reprend d'ici.
    const reprise = id === courante ? REPRISE_SESSION_COURANTE : `/reprendre session ${idCourt(id)}`;
    return {
      etat: avecSession(etat, id, { ...s, pause: true, depuis: iso(maintenant) }),
      message: `Pause : ${nom} est en pause${avec}. Elle s'arrête avant sa prochaine étape (une réponse ou un outil en cours va jusqu'au bout). Reprise : ${reprise}.`,
    };
  }
  const agentsEnPause = Object.values(s.agents).filter(a => a.pause).length;
  if (!s.pause && agentsEnPause === 0) return { etat, message: `Reprise : ${nom} n'est pas en pause.` };
  return { etat: avecSession(etat, id, { ...s, pause: false, depuis: null, agents: sansAgentsArretes(s.agents) }), message: `Reprise : ${nom} reprend${agents === 0 ? '' : ` avec ${accord(agents, 'agent', 'agents')}`}.` };
}

function surTout(sens, etat, maintenant) {
  const sessions = Object.values(etat.sessions);
  if (sessions.length === 0) return { erreur: "Aucune session ouverte dans l'état de la pause." };
  if (sens === 'pause') {
    const aArreter = sessions.filter(s => !s.pause).length;
    if (aArreter === 0) return { etat, message: `Pause : tout est déjà en pause (${accord(sessions.length, 'session', 'sessions')}).` };
    return {
      etat: toutesLesSessions(etat, s => (s.pause ? s : { ...s, pause: true, depuis: iso(maintenant) })),
      message: `Pause : tout est en pause (${accord(sessions.length, 'session', 'sessions')}, leurs agents avec). Elles s'arrêtent avant leur prochaine étape. Reprise : ${REPRISE_TOUT}.`,
    };
  }
  const aReprendre = sessions.filter(s => s.pause || Object.values(s.agents).some(a => a.pause)).length;
  if (aReprendre === 0) return { etat, message: 'Reprise : rien n\'est en pause.' };
  return { etat: toutesLesSessions(etat, s => ({ ...s, pause: false, depuis: null, agents: sansAgentsArretes(s.agents) })), message: `Reprise : tout reprend (${accord(aReprendre, 'session reprise', 'sessions reprises')}).` };
}

function surAgents(sens, etat, id, maintenant, ref) {
  const s = etat.sessions[id];
  const liste = Object.entries(s.agents);
  let cible = liste;
  if (ref !== null) {
    const r = retrouver(liste.map(([aid, a]) => [aid, a.nom]), ref, 'Agent');
    if (r.erreur) return { erreur: r.erreur };
    cible = liste.filter(([aid]) => aid === r.id);
  }
  if (cible.length === 0) return { etat, message: 'Pause : aucun agent dans cette session.' };
  const nom = ref === null ? accord(cible.length, 'agent', 'agents') : `l'agent « ${cible[0][1].nom || idCourt(cible[0][0])} »`;
  const pluriel = ref === null && cible.length > 1;
  const ids = new Set(cible.map(([aid]) => aid));
  const change = f => avecSession(etat, id, { ...s, agents: Object.fromEntries(liste.map(([aid, a]) => [aid, ids.has(aid) ? f(a) : a])) });
  if (sens === 'pause') {
    const verbe = pluriel ? 'sont' : 'est';
    if (cible.every(([, a]) => a.pause)) return { etat, message: `Pause : ${nom} ${verbe} déjà en pause.` };
    return { etat: change(a => (a.pause ? a : { ...a, pause: true, depuis: iso(maintenant) })), message: `Pause : ${nom} ${verbe} en pause. Reprise : /reprendre.` };
  }
  if (cible.every(([, a]) => !a.pause)) {
    return { etat, message: s.pause ? `Reprise : ${nom} ${pluriel ? 'n\'ont' : 'n\'a'} pas de pause propre, mais ${pluriel ? 'leur' : 'sa'} session est en pause (/reprendre la relance).` : `Reprise : ${nom} ${pluriel ? 'ne sont' : 'n\'est'} pas en pause.` };
  }
  return { etat: change(a => ({ ...a, pause: false, depuis: null })), message: `Reprise : ${nom} ${pluriel ? 'reprennent' : 'reprend'}${s.pause ? ` (${pluriel ? 'leur' : 'sa'} session reste en pause)` : ''}.` };
}

// /pause <args> et /reprendre <args> (sens : 'pause' ou 'reprendre'). contexte : { session: la session qui reçoit la commande (« cette
// session »), cible?: la session visée quand les arguments n'en nomment aucune (bouton d'une autre session, ligne de commande ; sans cible,
// c'est `session`), maintenant: ms, fiche?: { titre, agents } pour inscrire d'abord la session qui reçoit la commande }.
// Rend { etat, message } ou { erreur } (rien ne change en cas d'erreur).
export function appliquerCommande(sens, args, etatBrut, contexte = {}) {
  const usage = sens === 'pause' ? USAGE_PAUSE : USAGE_REPRENDRE;
  const { session, cible, maintenant, fiche } = contexte;
  const visee = cible ?? session;
  let etat = normaliserEtat(etatBrut);
  if (fiche !== undefined && idValide(session) && Number.isFinite(maintenant)) etat = inscrire(etat, { ...fiche, session }, maintenant);
  const { mot, reste } = motsDe(args);

  if (MOTS_STATUT.includes(mot)) return reste === '' ? { etat, message: texteStatut(etat, session, maintenant) } : { erreur: usage };
  if (!Number.isFinite(maintenant)) return { erreur: "Pause : instant illisible, rien n'a changé." };
  if (MOTS_TOUT.includes(mot)) return reste === '' ? surTout(sens, etat, maintenant) : { erreur: usage };

  if (mot === '' || mot === 'session') {
    let id = visee;
    if (reste !== '') {
      const r = retrouver(Object.entries(etat.sessions).map(([sid, s]) => [sid, s.titre]), reste, 'Session');
      if (r.erreur) return { erreur: r.erreur };
      id = r.id;
    }
    return Object.hasOwn(etat.sessions, id) ? surSession(sens, etat, id, session, maintenant) : erreurSession(id);
  }

  if (mot === 'agent' || mot === 'agents') {
    if ((mot === 'agent') === (reste === '')) return { erreur: usage };
    if (!Object.hasOwn(etat.sessions, visee)) return erreurSession(visee);
    return surAgents(sens, etat, visee, maintenant, mot === 'agent' ? reste : null);
  }
  return { erreur: usage };
}
