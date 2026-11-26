// file-logique.mjs : logique pure de la file d'agents du Régulateur (un agent refusé par le plafond attend son tour, le suivant est
// lancé dès qu'un créneau se libère, un agent échoué est relancé deux fois au plus).
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code (copie identique, vérifiée par un
// test) et chargé par require() dans les hooks Codex (Node 22.12 ou plus, sans avertissement).
//
// État : { prochain, entrees: [{ id, agent, session, ajoute, description, demande, essais, statut, ordre }], relances: { clé: 1 à 2 } }.
//   agent    claude, codex ou un autre agent (nom en minuscules, chiffres et tirets) : la file est PAR agent et PAR session (seule la session qui a demandé l'agent le lance).
//   demande  ce qu'il faut pour relancer l'agent : Claude, { prompt, description, subagentType, model?, name?, cwd? } ; Codex, les
//            arguments de spawn_agent tels que le hook les a vus (aucun champ n'est supposé).
//   statut   en-attente, ou ordonne (Codex : le modèle a reçu l'ordre de lancer l'agent ; sans lancement constaté au bout de dix
//            minutes, l'entrée redevient lançable).
//   essais   nombre de relances déjà faites pour cette entrée (0 à 2).
// Par défaut : vide, donc inerte.

export const MAX_FILE = 50;
export const MAX_DEMANDE = 60000;
export const MAX_RELANCES = 2;
export const DELAI_ORDRE_MS = 10 * 60 * 1000;
export const AGE_MAX_ENTREE_MS = 6 * 60 * 60 * 1000;
// Au plus trois agents (lancements ou relances) dans un seul ordre au modèle : les suivants viennent au tour d'après.
export const MAX_PAR_ORDRE = 3;

const LARGEUR_DESCRIPTION = 80;
const LARGEUR_NOM = 40;
const LARGEUR_CLE = 200;
const LARGEUR_SESSION = 128;
const MAX_ORDRE_CARACTERES = 20000;
const MAX_REPONSE = 60000;
const AGENT = /^[a-z][a-z0-9-]{0,31}$/;

const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const agentValide = v => typeof v === 'string' && AGENT.test(v);
const sessionValide = v => typeof v === 'string' && v.length >= 1 && v.length <= LARGEUR_SESSION;
const dateValide = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
// '__proto__' est refusé : sur un objet ordinaire, l'affecter changerait le prototype au lieu de créer une clé.
const cleValide = v => typeof v === 'string' && v.length >= 1 && v.length <= LARGEUR_CLE && v !== '__proto__';
const accord = (n, un, plusieurs) => `${n} ${n === 1 ? un : plusieurs}`;

function nettoyer(x, largeur) {
  const t = typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '';
  return t.length > largeur ? `${t.slice(0, largeur - 3)}...` : t;
}

// La demande avec ses clés triées à tous les niveaux : deux demandes identiques s'écrivent pareil, quel que soit l'ordre des clés.
const canonique = v => (Array.isArray(v) ? v.map(canonique) : estObjet(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonique(v[k])])) : v);
export const signature = demande => JSON.stringify(canonique(demande));

export const etatParDefaut = () => ({ prochain: 1, entrees: [], relances: {} });

function copieDemande(demande) {
  if (!estObjet(demande)) return null;
  try {
    const sig = signature(demande);
    if (sig.length > MAX_DEMANDE) return null;
    return JSON.parse(sig);
  } catch (_) {
    return null;
  }
}

function entreeNormale(e) {
  if (!estObjet(e) || !Number.isInteger(e.id) || e.id < 1) return null;
  if (!agentValide(e.agent) || !sessionValide(e.session) || !dateValide(e.ajoute)) return null;
  const demande = copieDemande(e.demande);
  if (demande === null) return null;
  const ordonne = e.statut === 'ordonne' && dateValide(e.ordre);
  return {
    id: e.id,
    agent: e.agent,
    session: e.session,
    ajoute: e.ajoute,
    description: nettoyer(e.description, LARGEUR_DESCRIPTION),
    demande,
    essais: Number.isInteger(e.essais) && e.essais >= 0 && e.essais <= MAX_RELANCES ? e.essais : 0,
    statut: ordonne ? 'ordonne' : 'en-attente',
    ordre: ordonne ? e.ordre : null,
  };
}

export function normaliserEtat(brut) {
  const b = estObjet(brut) ? brut : {};
  const entrees = [];
  const vus = new Set();
  for (const e of Array.isArray(b.entrees) ? b.entrees : []) {
    if (entrees.length >= MAX_FILE) break;
    const n = entreeNormale(e);
    if (n === null || vus.has(n.id)) continue;
    vus.add(n.id);
    entrees.push(n);
  }
  const relances = {};
  if (estObjet(b.relances)) {
    for (const [cle, n] of Object.entries(b.relances)) {
      if (cleValide(cle) && Number.isInteger(n) && n >= 1 && n <= MAX_RELANCES) relances[cle] = n;
    }
  }
  const plusGrand = entrees.reduce((m, e) => Math.max(m, e.id), 0);
  return { prochain: Math.max(Number.isInteger(b.prochain) ? b.prochain : 1, plusGrand + 1), entrees, relances };
}

const memeCouple = (e, agent, session) => e.agent === agent && e.session === session;
const enAttenteDe = (entrees, agent, session) => entrees.filter(e => memeCouple(e, agent, session) && e.statut === 'en-attente');
const rang = (entrees, id, agent, session) => enAttenteDe(entrees, agent, session).findIndex(e => e.id === id) + 1;

// Les entrées de cet agent, dans cette session, qui attendent leur tour (celles dont l'ordre est donné n'en font pas partie).
export const enAttente = (etatBrut, agent, session) => enAttenteDe(normaliserEtat(etatBrut).entrees, agent, session);

// Met une demande en file : { etat, entree, position, deja } ou { refus: 'invalide' | 'trop-grande' | 'pleine' }.
// La même demande (même agent, même session, mêmes arguments) ne s'ajoute pas deux fois : elle redevient simplement en attente.
// enTete : les relances passent avant les autres.
export function mettreEnFile(etatBrut, { agent, session, description, demande, maintenant, essais = 0, enTete = false } = {}) {
  const etat = normaliserEtat(etatBrut);
  if (!agentValide(agent) || !sessionValide(session) || !estObjet(demande) || !Number.isFinite(maintenant)) return { refus: 'invalide' };
  let sig;
  try { sig = signature(demande); } catch (_) { return { refus: 'invalide' }; }
  if (sig.length > MAX_DEMANDE) return { refus: 'trop-grande' };
  const existante = etat.entrees.find(e => memeCouple(e, agent, session) && signature(e.demande) === sig);
  if (existante) {
    const entree = { ...existante, statut: 'en-attente', ordre: null };
    const entrees = etat.entrees.map(e => (e.id === entree.id ? entree : e));
    return { etat: { ...etat, entrees }, entree, position: rang(entrees, entree.id, agent, session), deja: true };
  }
  if (etat.entrees.length >= MAX_FILE) return { refus: 'pleine' };
  const entree = entreeNormale({
    id: etat.prochain,
    agent,
    session,
    ajoute: new Date(maintenant).toISOString(),
    description,
    demande,
    essais,
    statut: 'en-attente',
  });
  const entrees = enTete ? [entree, ...etat.entrees] : [...etat.entrees, entree];
  return { etat: { ...etat, prochain: etat.prochain + 1, entrees }, entree, position: rang(entrees, entree.id, agent, session), deja: false };
}

const ordrePerime = (e, maintenant) => Number.isFinite(maintenant) && Date.parse(e.ordre) + DELAI_ORDRE_MS <= maintenant;

// Les entrées que cet agent, dans cette session, peut lancer maintenant : dans l'ordre de la file, au plus n.
export function prochaines(etatBrut, agent, session, n, maintenant) {
  if (!Number.isInteger(n) || n < 1) return [];
  return normaliserEtat(etatBrut).entrees
    .filter(e => memeCouple(e, agent, session) && (e.statut === 'en-attente' || ordrePerime(e, maintenant)))
    .slice(0, n);
}

// Marque ces entrées comme ordonnées au modèle (Codex), avec la date de l'ordre.
export function ordonner(etatBrut, ids, maintenant) {
  const etat = normaliserEtat(etatBrut);
  if (!Array.isArray(ids) || ids.length === 0 || !Number.isFinite(maintenant)) return etat;
  const ordre = new Date(maintenant).toISOString();
  return { ...etat, entrees: etat.entrees.map(e => (ids.includes(e.id) ? { ...e, statut: 'ordonne', ordre } : e)) };
}

// L'entrée dont la demande est exactement celle-ci (le modèle vient de lancer ce qu'on lui avait ordonné), ou null.
export function reconnaitre(etatBrut, agent, session, demande) {
  let sig;
  try { sig = signature(demande); } catch (_) { return null; }
  return normaliserEtat(etatBrut).entrees.find(e => memeCouple(e, agent, session) && signature(e.demande) === sig) ?? null;
}

export function retirer(etatBrut, id) {
  const etat = normaliserEtat(etatBrut);
  return { ...etat, entrees: etat.entrees.filter(e => e.id !== id) };
}

// Vide la file, ou seulement l'agent et la session donnés (null = tous). Rend { etat, retirees }.
export function vider(etatBrut, agent = null, session = null) {
  const etat = normaliserEtat(etatBrut);
  const reste = etat.entrees.filter(e => !((agent === null || e.agent === agent) && (session === null || e.session === session)));
  return { etat: { ...etat, entrees: reste }, retirees: etat.entrees.length - reste.length };
}

// Une file oubliée ne doit pas lancer des agents le lendemain : au bout de six heures, une entrée est retirée.
export function purger(etatBrut, maintenant) {
  const etat = normaliserEtat(etatBrut);
  if (!Number.isFinite(maintenant)) return { etat, retirees: 0 };
  const reste = etat.entrees.filter(e => Date.parse(e.ajoute) + AGE_MAX_ENTREE_MS >= maintenant);
  return { etat: { ...etat, entrees: reste }, retirees: etat.entrees.length - reste.length };
}

// Object.hasOwn : un nom que tout objet porte déjà (constructor, toString) n'est pas une relance faite.
export function relancesFaites(etatBrut, cle) {
  const { relances } = normaliserEtat(etatBrut);
  return Object.hasOwn(relances, cle) ? relances[cle] : 0;
}

export const peutRelancer = (etatBrut, cle) => cleValide(cle) && relancesFaites(etatBrut, cle) < MAX_RELANCES;

export function compterRelance(etatBrut, cle) {
  const etat = normaliserEtat(etatBrut);
  if (!cleValide(cle)) return etat;
  return { ...etat, relances: { ...etat.relances, [cle]: Math.min(MAX_RELANCES, relancesFaites(etat, cle) + 1) } };
}

export function oublierRelances(etatBrut, cle) {
  const etat = normaliserEtat(etatBrut);
  const { [cle]: _oubliee, ...reste } = etat.relances;
  return { ...etat, relances: reste };
}

const chaine = v => (typeof v === 'string' ? v : undefined);
const CHAMPS_LANCEMENT = ['prompt', 'description', 'subagentType', 'model', 'name', 'cwd'];

// La demande à garder d'un lancement d'agent Claude (l'entrée de l'événement agent.spawn) : les six champs du lancement qui sont
// des textes, aucun autre (fork, arrière-plan, identifiants ne se rejouent pas).
export function demandeDeLancement(lancement) {
  const demande = {};
  if (!estObjet(lancement)) return demande;
  for (const cle of CHAMPS_LANCEMENT) {
    const v = chaine(lancement[cle]);
    if (v !== undefined) demande[cle] = v;
  }
  return demande;
}

// Les arguments de $.agent.spawn pour rejouer une demande gardée : le prompt toujours (vide s'il manque, le lanceur le refusera),
// les cinq autres champs seulement s'ils sont des textes.
export function argumentsDeLancement(demande) {
  const d = estObjet(demande) ? demande : {};
  const args = { prompt: chaine(d.prompt) ?? '' };
  for (const cle of CHAMPS_LANCEMENT.slice(1)) {
    const v = chaine(d[cle]);
    if (v !== undefined) args[cle] = v;
  }
  return args;
}

const CAUSES_SANS_FILE = {
  pleine: `la file est pleine (${MAX_FILE} agents)`,
  'trop-grande': `cette demande est trop grande pour la file (${MAX_DEMANDE} caractères au plus)`,
  ecriture: "la file d'attente ne peut pas être écrite",
};

// Le refus d'un lancement mis en file. mode 'code' : l'adaptateur lance l'agent lui-même (Claude) ; 'modele' : le Régulateur demande
// au modèle de le lancer (Codex, un hook ne peut pas lancer d'agent).
export function texteRefus({ position, total, mode }) {
  const tete = `Régulateur d'agents : maximum atteint. Cet agent est mis en file (n° ${position} sur ${total})`;
  if (mode === 'modele') {
    return `${tete}. Dès qu'un créneau se libère, le Régulateur te demandera de le lancer, avec exactement les mêmes arguments. Ne le relance pas toi-même et n'en lance pas un autre à la place.`;
  }
  return `${tete} et sera lancé automatiquement dès qu'un créneau se libère ; sa réponse t'arrivera comme un message. Ne le relance pas et n'en lance pas un autre à la place.`;
}

// Le refus classique, quand la mise en file est impossible : on dit pourquoi.
export function texteRefusSansFile(raison) {
  const cause = CAUSES_SANS_FILE[raison] ?? 'cette demande ne peut pas être mise en file';
  return `Régulateur d'agents : maximum atteint, et ${cause}. Ne lance pas celui-ci maintenant : dès qu'un agent finit, lance le suivant de ta liste.`;
}

// Les entrées qu'un seul ordre peut porter : au plus les créneaux libres, trois demandes et vingt mille caractères (une demande seule
// passe toujours, même grande).
export function choisirPourOrdre(entrees, libres) {
  if (!Array.isArray(entrees) || !Number.isInteger(libres) || libres < 1) return [];
  const choisies = [];
  let total = 0;
  for (const e of entrees) {
    if (choisies.length >= Math.min(libres, MAX_PAR_ORDRE)) break;
    const taille = signature(e.demande).length;
    if (choisies.length > 0 && total + taille > MAX_ORDRE_CARACTERES) break;
    choisies.push(e);
    total += taille;
  }
  return choisies;
}

// L'ordre donné au modèle (Codex, à la fin de son tour) : lancer ces agents avec ces arguments exacts. null quand il n'y a rien à dire.
// libres : les créneaux libres, ou autre chose qu'un entier (aucun plafond) pour n'en rien dire.
export function texteOrdre(entrees, libres) {
  if (!Array.isArray(entrees) || entrees.length === 0) return null;
  const n = entrees.length;
  const lignes = entrees.map((e, i) => `${i + 1}. ${signature(e.demande)}`);
  const compte = Number.isInteger(libres) ? `${accord(libres, 'créneau libre', 'créneaux libres')} et ${accord(n, 'agent', 'agents')} en file` : `${accord(n, 'agent', 'agents')} en file`;
  return [
    `RÉGULATEUR D'AGENTS : ${compte}. Lance maintenant, avec spawn_agent et exactement ces arguments, ${n === 1 ? "l'agent suivant" : 'les agents suivants'} de la file.`,
    ...lignes,
    "Ne lance rien d'autre : le suivant te sera demandé de la même façon dès qu'un créneau se libère.",
  ].join('\n');
}

// echoues : [{ nom, essai }], essai = numéro de la relance (1 ou 2).
export function texteRelance(echoues) {
  if (!Array.isArray(echoues) || echoues.length === 0) return null;
  const n = echoues.length;
  const lignes = echoues.map((x, i) => `${i + 1}. ${nettoyer(x.nom, LARGEUR_NOM) || 'sans nom'} (relance ${x.essai} sur ${MAX_RELANCES})`);
  return [
    `RÉGULATEUR D'AGENTS : ${n === 1 ? '1 agent a échoué' : `${n} agents ont échoué`}. Relance-${n === 1 ? 'le' : 'les'} maintenant depuis ${n === 1 ? 'son' : 'leur'} point d'arrêt, sans repartir de zéro :`,
    ...lignes,
  ].join('\n');
}

// Le message de `/plafond file vider` : retirees = ce que vider() a rendu.
export function texteVidee(retirees) {
  if (!Number.isInteger(retirees) || retirees < 1) return "Agents : la file d'attente est déjà vide.";
  return `Agents : file d'attente vidée (${retirees} ${retirees === 1 ? 'agent retiré' : 'agents retirés'}).`;
}

// Une ligne de statut pour cet agent et cette session ; undefined quand il n'y a rien dans la file.
export function texteStatut(etatBrut, agent, session) {
  const siens = normaliserEtat(etatBrut).entrees.filter(e => memeCouple(e, agent, session));
  const attente = siens.filter(e => e.statut === 'en-attente').length;
  const ordonnees = siens.length - attente;
  if (siens.length === 0) return undefined;
  return `File : ${attente} en attente${ordonnees > 0 ? `, ${ordonnees} ${ordonnees === 1 ? 'ordonné' : 'ordonnés'}` : ''}`;
}

// Les comptes de la file, toutes sessions confondues (pour le Cockpit) ; agent donné : seulement le sien.
export function resume(etatBrut, agent = null) {
  const entrees = normaliserEtat(etatBrut).entrees.filter(e => agent === null || e.agent === agent);
  const dates = entrees.map(e => Date.parse(e.ajoute));
  const ordonnees = entrees.filter(e => e.statut === 'ordonne').length;
  return {
    enAttente: entrees.length - ordonnees,
    ordonnees,
    plusAncienne: entrees.length === 0 ? null : new Date(Math.min(...dates)).toISOString(),
  };
}

// Ce que le modèle lit quand un agent lancé par la file se termine. issue : termine, echec (relancé), abandon (relances épuisées),
// echec-final (échec sans relance : relance désactivée, ou agent qui ne se relance pas), interrompu.
export function texteFinAgent({ description, issue, reponse, essai }) {
  const nom = nettoyer(description, LARGEUR_DESCRIPTION) || 'sans description';
  const tete = `Régulateur d'agents : l'agent « ${nom} »`;
  if (issue === 'echec') return `${tete} a échoué. Il est relancé automatiquement (relance ${essai} sur ${MAX_RELANCES}).`;
  if (issue === 'abandon') return `${tete} a échoué ${MAX_RELANCES + 1} fois (le premier lancement et ${MAX_RELANCES} relances). Il n'est plus relancé : reprends-le toi-même si besoin.`;
  if (issue === 'echec-final') return `${tete} a échoué. Il n'est pas relancé automatiquement : reprends-le toi-même si besoin.`;
  if (issue === 'interrompu') return `${tete} a été interrompu. Il n'est pas relancé.`;
  const texte = typeof reponse === 'string' ? reponse : '';
  let corps = "L'agent n'a rendu aucune réponse.";
  if (texte.length > MAX_REPONSE) corps = `${texte.slice(0, MAX_REPONSE)}\n[réponse coupée : ${texte.length} caractères, les ${MAX_REPONSE} premiers sont montrés]`;
  else if (texte !== '') corps = texte;
  return `${tete} (mis en file puis lancé automatiquement) a terminé. Sa réponse :\n${corps}`;
}
