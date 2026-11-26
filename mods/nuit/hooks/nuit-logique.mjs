// nuit-logique.mjs : logique pure de la Nuit (l'utilisateur est absent, ou a dit /nuit : ses questions bloquantes vont en boîte au lieu d'attendre,
// les arrêts de garde deviennent des refus avec alternative, le travail continue sur les lignes ouvertes de la liste de travail, et un récap
// l'attend au réveil).
// Aucun import, aucune entrée-sortie : le MÊME fichier est destiné à l'adaptateur Claude Code (copie identique, vérifiée par un
// test) et chargé par require() dans les hooks Codex (Node 22.12 ou plus, sans avertissement).
//
// État (COCKPIT_DIR/nuit.json, relu tel quel par le Cockpit) :
//   actif, mode (nuit : /nuit on ; absence : l'utilisateur n'a rien écrit depuis absenceMinutes), depuis, fin,
//   tours (continuations données cette nuit) et maxTours (plafond), derniereLigne et repetition (anti-boucle), sautees (lignes qui n'ont
//   pas avancé et ne sont plus proposées cette nuit), arret (pourquoi l'enchaînement s'est arrêté), refus (compteurs par genre),
//   absenceMinutes (délai de la détection d'absence ; null = pas de détection), derniereActivite (dernier message de l'utilisateur),
//   lignesAuDebut (lignes ouvertes au coucher, pour le récap), passages (par ligne, les nuits où elle a eu tous ses enchaînements sans
//   se fermer : gardés d'une nuit à l'autre, ils font commencer la nuit suivante par les autres lignes).
// Par défaut : inactif, donc inerte.

export const MAX_BOITE = 50;
export const MAX_TOURS_DEFAUT = 60;
export const MAX_TOURS_LIMITE = 500;
export const ABSENCE_DEFAUT_MIN = 60;
export const ABSENCE_LIMITE_MIN = 24 * 60;
// Une ligne proposée trois fois de suite sans avoir bougé n'est plus proposée de la nuit.
export const REPETITION_MAX = 3;
// Début du texte que l'adaptateur soumet lui-même au modèle : permet de ne pas le prendre pour un message de l'utilisateur.
export const PREFIXE_CONTINUATION = 'NUIT : ';

const MAX_SAUTEES = 50;
// Passages : pour chaque ligne, le nombre de nuits où elle a eu ses REPETITION_MAX enchaînements sans se fermer. Gardé d'une nuit à
// l'autre : la nuit suivante commence par les lignes qui ont eu le moins de passages. Sans cette mémoire, chaque
// nuit reprendrait toujours la ligne ouverte la plus ancienne.
const MAX_PASSAGES = 1000;
const MAX_PASSAGES_PAR_LIGNE = 9999;
const MODES = ['nuit', 'absence'];
const ARRETS = ['plafond', 'termine', 'pause', 'quota', 'repetition'];
const GENRES_REFUS = ['question', 'garde', 'action'];
const TYPES_BOITE = ['question', 'action'];
const LIGNE = /^C-\d+$/;
const AGENT = /^[a-z][a-z0-9-]{0,31}$/;
const LARGEUR_TITRE = 240;
const LARGEUR_DETAIL = 600;
// Les détails gardés en boîte : la raison du garde et la commande ENTIÈRE (ou le texte entier d'une question), pour que l'utilisateur décide
// en voyant tout. Au-delà de LARGEUR_COMMANDE_ENTIERE, la coupure est annoncée dans le texte lui-même.
const LARGEUR_COMMANDE_ENTIERE = 4000;
const LARGEUR_DETAILS_BOITE = 5000;
const EMPREINTE = /^[0-9a-f]{64}$/;
// Une commande autorisée par l'utilisateur se relance dans ce délai, après quoi son autorisation ne vaut plus.
export const DUREE_AUTORISATION_MS = 12 * 60 * 60 * 1000;
export const REPONSE_AUTORISER = 'Autoriser';
const LARGEUR_OPTION = 80;
const LARGEUR_DESCRIPTION_OPTION = 120;
const LARGEUR_SESSION = 128;
const MAX_OPTIONS = 6;

// Un tableau passe aussi : chaque lecture qui suit vise un champ nommé qu'un tableau n'a pas.
const estObjet = v => v !== null && typeof v === 'object';
const dateOuNull = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const entierOu = (v, defaut, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : defaut);
const compteur = v => (Number.isInteger(v) && v >= 0 ? v : 0);
const agentValide = v => typeof v === 'string' && AGENT.test(v);
const sessionValide = v => typeof v === 'string' && v.length >= 1 && v.length <= LARGEUR_SESSION;

// Un texte sur une ligne, borné : ce que l'utilisateur ou le modèle a écrit ne doit jamais déborder dans un message ou un panneau.
function nettoyer(x, largeur) {
  const t = typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '';
  return t.length > largeur ? `${t.slice(0, largeur - 3)}...` : t;
}

export function etatParDefaut() {
  return {
    actif: false, mode: null, depuis: null, fin: null,
    tours: 0, maxTours: MAX_TOURS_DEFAUT, absenceMinutes: ABSENCE_DEFAUT_MIN, derniereActivite: null,
    derniereLigne: null, repetition: 0, sautees: [], arret: null,
    refus: { question: 0, garde: 0, action: 0 }, lignesAuDebut: null, passages: {},
  };
}

// Les passages gardés : { 'C-123': n }, n de 1 à MAX_PASSAGES_PAR_LIGNE, au plus MAX_PASSAGES lignes (les dernières inscrites restent).
function passagesNormaux(brut) {
  const out = {};
  const entrees = estObjet(brut) ? Object.entries(brut) : []; // un tableau passe : ses clés ne sont pas des identifiants de ligne
  for (const [id, n] of entrees.slice(-MAX_PASSAGES)) {
    if (LIGNE.test(id) && Number.isInteger(n) && n >= 1) out[id] = Math.min(n, MAX_PASSAGES_PAR_LIGNE);
  }
  return out;
}

export function normaliserEtat(brut) {
  const b = estObjet(brut) ? brut : {};
  const actif = b.actif === true;
  const sautees = [];
  for (const id of Array.isArray(b.sautees) ? b.sautees : []) {
    if (sautees.length >= MAX_SAUTEES) break;
    if (typeof id === 'string' && LIGNE.test(id) && !sautees.includes(id)) sautees.push(id);
  }
  const r = estObjet(b.refus) ? b.refus : {};
  return {
    actif,
    mode: MODES.includes(b.mode) ? b.mode : (actif ? 'nuit' : null),
    depuis: dateOuNull(b.depuis),
    fin: dateOuNull(b.fin),
    tours: compteur(b.tours),
    maxTours: entierOu(b.maxTours, MAX_TOURS_DEFAUT, 1, MAX_TOURS_LIMITE),
    absenceMinutes: b.absenceMinutes === null ? null : entierOu(b.absenceMinutes, ABSENCE_DEFAUT_MIN, 1, ABSENCE_LIMITE_MIN),
    derniereActivite: dateOuNull(b.derniereActivite),
    derniereLigne: typeof b.derniereLigne === 'string' && LIGNE.test(b.derniereLigne) ? b.derniereLigne : null,
    repetition: compteur(b.repetition),
    sautees,
    arret: ARRETS.includes(b.arret) ? b.arret : null,
    refus: { question: compteur(r.question), garde: compteur(r.garde), action: compteur(r.action) },
    lignesAuDebut: Number.isInteger(b.lignesAuDebut) && b.lignesAuDebut >= 0 ? b.lignesAuDebut : null,
    passages: passagesNormaux(b.passages),
  };
}

// Début d'une nuit : les compteurs repartent de zéro ; les réglages, la dernière activité de l'utilisateur et les passages des nuits d'avant restent.
// Sans instant lisible : rien ne change.
export function activer(etatBrut, { mode, maintenant, lignesOuvertes } = {}) {
  const etat = normaliserEtat(etatBrut);
  if (!Number.isFinite(maintenant)) return etat;
  return {
    ...etat,
    actif: true,
    mode: MODES.includes(mode) ? mode : 'nuit',
    depuis: new Date(maintenant).toISOString(),
    fin: null,
    tours: 0,
    derniereLigne: null,
    repetition: 0,
    sautees: [],
    arret: null,
    refus: { question: 0, garde: 0, action: 0 },
    lignesAuDebut: Number.isInteger(lignesOuvertes) && lignesOuvertes >= 0 ? lignesOuvertes : null,
  };
}

// Fin de la nuit : les compteurs et le mode restent pour le récap. Une nuit déjà finie garde sa date de fin.
export function desactiver(etatBrut, maintenant) {
  const etat = normaliserEtat(etatBrut);
  if (!etat.actif || !Number.isFinite(maintenant)) return etat;
  return { ...etat, actif: false, fin: new Date(maintenant).toISOString() };
}

// Un message de l'utilisateur : il date son activité, et met fin à une nuit active (c'est le réveil). { etat, reveil }.
export function noterActivite(etatBrut, maintenant) {
  const etat = normaliserEtat(etatBrut);
  if (!Number.isFinite(maintenant)) return { etat, reveil: false };
  const reveil = etat.actif;
  const date = new Date(maintenant).toISOString();
  return { etat: { ...desactiver(etat, maintenant), derniereActivite: date }, reveil };
}

// L'utilisateur n'a rien écrit depuis absenceMinutes. Faux sans activité connue, sans délai réglé, ou quand la nuit est déjà active.
export function absenceAtteinte(etatBrut, maintenant) {
  const etat = normaliserEtat(etatBrut);
  if (etat.actif || etat.absenceMinutes === null || etat.derniereActivite === null || !Number.isFinite(maintenant)) return false;
  return maintenant - Date.parse(etat.derniereActivite) >= etat.absenceMinutes * 60 * 1000;
}

export const estActive = (etatBrut, maintenant) => normaliserEtat(etatBrut).actif || absenceAtteinte(etatBrut, maintenant);

// Active la nuit en mode absence si l'utilisateur est absent. { etat, active } ; active ne vaut vrai qu'au moment où la nuit commence.
export function activerSiAbsent(etatBrut, maintenant, lignesOuvertes) {
  const etat = normaliserEtat(etatBrut);
  if (!absenceAtteinte(etat, maintenant)) return { etat, active: false };
  return { etat: activer(etat, { mode: 'absence', maintenant, lignesOuvertes }), active: true };
}

export function compterRefus(etatBrut, genre) {
  const etat = normaliserEtat(etatBrut);
  if (!GENRES_REFUS.includes(genre)) return etat;
  return { ...etat, refus: { ...etat.refus, [genre]: etat.refus[genre] + 1 } };
}

// ---------------------------------------------------------------- boîte
// COCKPIT_DIR/nuit-boite.json : ce que l'utilisateur doit décider à son réveil. { prochain, entrees: [{ id, agent, session, type, ajoute, titre,
// details, options: [{ label, description }], statut, reponse, traite }] }.
//   type    question (l'outil de questions a été refusé pendant la nuit) ou action (un push ou un déploiement attend son accord).
//   statut  en-attente, repondue (reponse et traite), ecartee (traite).
//   Champs présents seulement quand ils ont une valeur : lot (le numéro de la première entrée d'un même appel de l'outil de questions :
//   leurs réponses vont ensemble), empreinte (SHA-256 de la commande entière, de l'agent et de la conversation, prise à la mise en boîte
//   d'une action), consommee (la date où une commande autorisée est passée, une seule fois).

export const boiteParDefaut = () => ({ prochain: 1, entrees: [] });

function optionsNormales(options) {
  const out = [];
  for (const o of Array.isArray(options) ? options : []) {
    if (out.length >= MAX_OPTIONS) break;
    const label = nettoyer(typeof o === 'string' ? o : estObjet(o) ? o.label : '', LARGEUR_OPTION);
    if (label !== '') out.push({ label, description: nettoyer(estObjet(o) ? o.description : '', LARGEUR_DESCRIPTION_OPTION) });
  }
  return out;
}

function entreeBoiteNormale(e) {
  if (!estObjet(e) || !Number.isInteger(e.id) || e.id < 1) return null;
  if (!agentValide(e.agent) || !sessionValide(e.session) || !TYPES_BOITE.includes(e.type)) return null;
  const ajoute = dateOuNull(e.ajoute);
  const titre = nettoyer(e.titre, LARGEUR_TITRE);
  if (ajoute === null || titre === '') return null;
  const traite = dateOuNull(e.traite);
  const reponse = nettoyer(e.reponse, LARGEUR_DETAIL);
  const repondue = e.statut === 'repondue' && traite !== null && reponse !== '';
  const ecartee = e.statut === 'ecartee' && traite !== null;
  const n = {
    id: e.id,
    agent: e.agent,
    session: e.session,
    type: e.type,
    ajoute,
    titre,
    details: nettoyer(e.details, LARGEUR_DETAILS_BOITE),
    options: optionsNormales(e.options),
    statut: repondue ? 'repondue' : ecartee ? 'ecartee' : 'en-attente',
    reponse: repondue ? reponse : null,
    traite: repondue || ecartee ? traite : null,
  };
  if (Number.isInteger(e.lot) && e.lot >= 1) n.lot = e.lot;
  if (e.type === 'action' && typeof e.empreinte === 'string' && EMPREINTE.test(e.empreinte)) n.empreinte = e.empreinte;
  const consommee = dateOuNull(e.consommee);
  if (n.empreinte !== undefined && repondue && consommee !== null) n.consommee = consommee;
  return n;
}

export function normaliserBoite(brut) {
  const b = estObjet(brut) ? brut : {};
  const entrees = [];
  const vus = new Set();
  for (const e of Array.isArray(b.entrees) ? b.entrees : []) {
    if (entrees.length >= MAX_BOITE) break;
    const n = entreeBoiteNormale(e);
    if (n === null || vus.has(n.id)) continue;
    vus.add(n.id);
    entrees.push(n);
  }
  const plusGrand = entrees.reduce((m, e) => Math.max(m, e.id), 0);
  return { prochain: Math.max(Number.isInteger(b.prochain) ? b.prochain : 1, plusGrand + 1), entrees };
}

export const enAttente = boiteBrute => normaliserBoite(boiteBrute).entrees.filter(e => e.statut === 'en-attente');

// Met une question ou une action en boîte : { boite, entree, deja } ou { refus: 'invalide' | 'pleine' }. La même entrée encore à décider
// (même agent, même session, même genre, même titre, et mêmes détails pour une question, même empreinte pour une action) ne s'ajoute pas
// deux fois. Une boîte pleine fait d'abord place à l'entrée déjà traitée la plus anciennement ; sans entrée traitée, elle refuse.
// lot : le numéro du lot, ou 'soi' pour la première entrée d'un lot (son propre numéro).
export function ajouterEntree(boiteBrute, { agent, session, type, titre, details, options, maintenant, lot, empreinte } = {}) {
  const boite = normaliserBoite(boiteBrute);
  if (!agentValide(agent) || !sessionValide(session) || !TYPES_BOITE.includes(type) || !Number.isFinite(maintenant)) return { refus: 'invalide' };
  const t = nettoyer(titre, LARGEUR_TITRE);
  if (t === '') return { refus: 'invalide' };
  // Le titre est court : deux commandes (ou deux questions) qui ne diffèrent qu'au-delà restent deux entrées, par leur empreinte ou leurs détails.
  const d = nettoyer(details, LARGEUR_DETAILS_BOITE);
  const emp = type === 'action' && typeof empreinte === 'string' && EMPREINTE.test(empreinte) ? empreinte : undefined;
  const existante = boite.entrees.find(e => e.statut === 'en-attente' && e.agent === agent && e.session === session && e.type === type && e.titre === t
    && (type === 'action' ? e.empreinte === emp : e.details === d));
  if (existante) return { boite, entree: existante, deja: true };
  let entrees = boite.entrees;
  let evincee = null;
  if (entrees.length >= MAX_BOITE) {
    const traitees = entrees.filter(e => e.statut !== 'en-attente').sort((a, b) => Date.parse(a.traite) - Date.parse(b.traite));
    if (traitees.length === 0) return { refus: 'pleine' };
    evincee = traitees[0];
    entrees = entrees.filter(e => e.id !== traitees[0].id);
  }
  const entree = entreeBoiteNormale({ id: boite.prochain, agent, session, type, ajoute: new Date(maintenant).toISOString(), titre: t, details, options, lot: lot === 'soi' ? boite.prochain : lot, empreinte: emp });
  // evincee : l'entrée traitée qui a laissé sa place (une décision de l'utilisateur) ; l'appelant la garde dans l'archive de la boîte.
  if (evincee === null) return { boite: { prochain: boite.prochain + 1, entrees: [...entrees, entree] }, entree, deja: false };
  return { boite: { prochain: boite.prochain + 1, entrees: [...entrees, entree] }, entree, deja: false, evincee };
}

// ---------------------------------------------------------------- questions refusées

const RECOMMANDEE = /\s*\((?:recommended|recommandée?)\)\s*$/i;

// Ce qu'une demande de l'outil de questions (Claude : AskUserQuestion, Codex : request_user_input_async) dit, pour la boîte :
// { titre, details, options }. Les boutons du récap ne répondent qu'à une question seule ; sans texte lisible, la trace reste.
export function questionsDeOutil(entree) {
  const questions = [];
  for (const q of estObjet(entree) && Array.isArray(entree.questions) ? entree.questions : []) {
    if (!estObjet(q)) continue;
    const texte = nettoyer(typeof q.question === 'string' ? q.question : q.title, LARGEUR_TITRE);
    if (texte !== '') questions.push({ texte, options: optionsNormales(q.options) });
  }
  if (questions.length === 0) return { titre: 'Question sans texte lisible', details: '', options: [] };
  const autres = questions.length - 1;
  const suffixe = autres === 0 ? '' : ` (+${autres} ${autres === 1 ? 'autre question' : 'autres questions'})`;
  const details = questions.length === 1 && questions[0].options.length === 0
    ? ''
    : nettoyer(questions.map(q => (q.options.length ? `${q.texte} Options : ${q.options.map(o => o.label).join(' ; ')}` : q.texte)).join(' | '), LARGEUR_DETAIL);
  return {
    titre: `${nettoyer(questions[0].texte, LARGEUR_TITRE - suffixe.length)}${suffixe}`,
    details,
    options: questions.length === 1 ? questions[0].options : [],
  };
}

// Une entrée de boîte PAR question d'un appel de l'outil de questions : [{ titre, details, options }]. Chaque question garde SES options
// (donc ses boutons) et son texte entier (dans les détails quand le titre le coupe). Sans texte lisible, une seule entrée garde la trace.
export function entreesDeQuestions(entree) {
  const questions = [];
  for (const q of estObjet(entree) && Array.isArray(entree.questions) ? entree.questions : []) {
    if (!estObjet(q)) continue;
    const brut = typeof q.question === 'string' ? q.question : q.title;
    const titre = nettoyer(brut, LARGEUR_TITRE);
    if (titre !== '') questions.push({ titre, entier: nettoyer(brut, LARGEUR_COMMANDE_ENTIERE), options: optionsNormales(q.options) });
  }
  if (questions.length === 0) return [{ titre: 'Question sans texte lisible', details: '', options: [] }];
  const n = questions.length;
  return questions.map((q, i) => ({
    titre: q.titre,
    details: [n > 1 ? `Question ${i + 1} sur ${n} posées ensemble.` : '', q.entier !== q.titre ? `Question entière : ${q.entier}` : ''].filter(Boolean).join(' '),
    options: q.options,
  }));
}

// L'option que celui qui pose la question a marquée « (Recommended) » ou « (recommandé) », sans la mention ; null s'il n'y en a pas.
export function optionRecommandee(options) {
  for (const o of optionsNormales(options)) {
    if (!RECOMMANDEE.test(o.label)) continue;
    const sans = o.label.replace(RECOMMANDEE, '').trim();
    if (sans !== '') return sans;
  }
  return null;
}

// Pourquoi la boîte n'a pas pris une entrée, dit au modèle : il doit savoir que sa question ou sa commande n'est PAS notée.
const CAUSES_NON_NOTEE = {
  pleine: `la boîte est pleine : ${MAX_BOITE} entrées à décider`,
  verrou: 'les fichiers de la nuit sont occupés par un autre agent',
  ecriture: "l'écriture de la boîte a échoué",
  invalide: 'entrée refusée par la boîte',
};
const LARGEUR_TITRE_CITE = 100;

// Plusieurs questions d'un même appel : une entrée par question. questions : [{ id | null, titre, options, cause }] ; lot : leur lot.
function texteRefusQuestions(questions, enAttente, lot) {
  const numero = q => Number.isInteger(q.id) && q.id >= 1;
  const citee = q => `« ${nettoyer(q.titre, LARGEUR_TITRE_CITE)} »`;
  const notees = questions.filter(numero);
  const perdues = questions.filter(q => !numero(q));
  const recos = notees.map(q => [q.id, optionRecommandee(q.options)]).filter(([, r]) => r !== null).map(([n, r]) => `n° ${n} « ${r} »`);
  return [
    `NUIT : L'utilisateur est absent, tes ${questions.length} questions ne peuvent pas attendre sa réponse.`,
    notees.length === 0 ? '' : `Notées en boîte, une entrée par question${Number.isInteger(lot) ? ` (lot n° ${lot} : leurs réponses vont ensemble)` : ''} : ${notees.map(q => `n° ${q.id} ${citee(q)}`).join(' ; ')}. ${enAttente} à décider au réveil.`,
    perdues.length === 0 ? '' : `PAS notées en boîte : ${perdues.map(q => `${citee(q)} (${CAUSES_NON_NOTEE[q.cause] || 'boîte indisponible'})`).join(' ; ')}. Écris-les dans le fichier contexte.`,
    'Ne les repose pas.',
    `Choisis toi-même, pour chacune, l'option la plus sûre et réversible${recos.length ? ` (marquées recommandées : ${recos.join(' ; ')})` : ''}, note ces choix et leurs raisons dans le fichier contexte, puis continue.`,
    'Si la suite dépend vraiment de ces réponses, passe à une autre ligne ouverte de ta liste de travail.',
  ].filter(Boolean).join(' ');
}

// Ce que le modèle lit à la place de la réponse de l'utilisateur. id : le numéro en boîte, ou null quand la boîte n'a pas pu la noter (cause : pourquoi).
// questions (plus d'une) : le détail par question d'un même appel, chacune avec son numéro ou la cause de son absence.
export function texteRefusQuestion({ id, enAttente, options, cause, questions, lot } = {}) {
  if (Array.isArray(questions) && questions.filter(estObjet).length > 1) return texteRefusQuestions(questions.filter(estObjet), enAttente, lot);
  const reco = optionRecommandee(options);
  const noteeEnBoite = Number.isInteger(id) && id >= 1
    ? `Elle est notée en boîte (n° ${id}, ${enAttente} à décider au réveil).`
    : CAUSES_NON_NOTEE[cause] ? `Elle n'a PAS pu être notée en boîte (${CAUSES_NON_NOTEE[cause]}) : écris-la dans le fichier contexte.`
      : "La boîte n'a pas pu la noter : écris-la dans le fichier contexte.";
  return [
    'NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse.',
    noteeEnBoite,
    'Ne la repose pas.',
    `Choisis toi-même l'option la plus sûre et réversible${reco ? ` (de préférence « ${reco} », marquée recommandée)` : ''}, note ce choix et ses raisons dans le fichier contexte, puis continue.`,
    "Si la suite dépend vraiment de cette réponse, passe à une autre ligne ouverte de ta liste de travail.",
  ].join(' ');
}

// Ce que le modèle lit quand l'utilisateur a décidé une entrée de la boîte (une réponse notée par `/nuit repondre` ou par un bouton du récap) ;
// null pour une entrée sans réponse. Le préfixe permet à l'adaptateur de ne pas prendre ce texte pour un message de l'utilisateur.
export function texteReponse(entree) {
  if (!estObjet(entree) || !Number.isInteger(entree.id) || entree.id < 1 || !TYPES_BOITE.includes(entree.type)) return null;
  const reponse = nettoyer(entree.reponse, LARGEUR_DETAIL);
  if (reponse === '') return null;
  const titre = nettoyer(entree.titre, LARGEUR_TITRE);
  const lot = Number.isInteger(entree.lot) ? ` Elle fait partie du lot n° ${entree.lot} : les questions de ce lot ont été posées ensemble, leurs réponses vont ensemble.` : '';
  if (entree.type === 'question') return `${PREFIXE_CONTINUATION}réponse de l'utilisateur à la question n° ${entree.id} (« ${titre} ») : ${reponse}. Applique-la maintenant.${lot}`;
  // Une commande gardée avec son empreinte ne passe que relancée telle quelle : le dire évite qu'une variante retourne en boîte.
  const identique = typeof entree.empreinte === 'string' ? " Relance-la exactement à l'identique, une seule fois : une différence, même d'un caractère, la remet en attente." : '';
  const suite = /^autoriser$/i.test(reponse) ? ` Tu peux la lancer.${identique}` : /^refuser$/i.test(reponse) ? ' Ne la lance pas.' : '';
  return `${PREFIXE_CONTINUATION}décision de l'utilisateur sur la commande n° ${entree.id} (« ${titre} ») : ${reponse}.${suite}`;
}

// ---------------------------------------------------------------- arrêts de garde

const LARGEUR_RAISON = 600;
const LARGEUR_RAISON_REFUS = 300;
const LARGEUR_COMMANDE = 160;

// La sortie de la garde de sécurité (scripts/gardes/securite.js) pour une commande : null quand il laisse passer (ou n'avertit que), sinon
// { genre: 'bloc' | 'ask', raison }. Un continue:false arrête le tour du modèle : c'est ce que la nuit transforme en refus.
export function analyserSortieGarde(sortie) {
  if (!estObjet(sortie)) return null;
  const specifique = estObjet(sortie.hookSpecificOutput) ? sortie.hookSpecificOutput : {};
  const decision = specifique.permissionDecision;
  const raison = nettoyer(specifique.permissionDecisionReason, LARGEUR_RAISON) || nettoyer(sortie.stopReason, LARGEUR_RAISON) || 'refus du garde de sécurité';
  if (sortie.continue === false || decision === 'deny') return { genre: 'bloc', raison };
  if (decision === 'ask') return { genre: 'ask', raison };
  return null;
}

// Pour chaque motif des raisons de la garde de sécurité (scripts/gardes/securite.js), la voie à prendre à la place. Les motifs suivent les libellés de la garde.
const ALTERNATIVES = [
  [/suppression r[ée]cursive forc[ée]e|suppression r[ée]cursive windows|git clean/i, 'Ne supprime pas en récursif depuis le shell : laisse le dossier en place, note-le pour le réveil de l\'utilisateur, et passe à une autre ligne ouverte.'],
  [/commit refus|rappel avant commit/i, "Fais réellement l'action de la checklist (migration appliquée, variable posée, fonction déployée, cron actif), confirme-la avec checklist-confirmer.js, puis relance le même commit ; sans action possible, laisse le commit pour le réveil."],
  [/saut des v[ée]rifications de git|--no-verify/i, 'Ne contourne pas les hooks de git : corrige la cause de leur échec, puis recommence le commit.'],
  [/pouss[ée]e forc[ée]e|force push/i, "Ne force pas le push : aucun push n'est fait sans l'ordre de l'utilisateur, garde le commit en local."],
  [/reset --hard/i, 'Ne jette pas de modifications : utilise git stash, ou git restore limité aux fichiers voulus.'],
  [/branche prot[ée]g[ée]e/i, 'Ne supprime et ne renomme jamais une branche protégée : travaille sur une autre branche.'],
  [/wrangler deploy/i, "Ne déploie pas sans l'ordre de l'utilisateur ; si ce déploiement est demandé, ajoute --keep-vars."],
  [/git push|d[ée]ploiement de production|--prod/i, "Aucun push ni déploiement sans l'ordre explicite de l'utilisateur : garde le travail en local et continue sans pousser."],
];
const ALTERNATIVE_GENERALE = "Cherche une autre voie qui respecte la règle ; s'il n'y en a pas, note la demande et passe à une autre ligne ouverte.";

export function alternativePourGarde(raison) {
  const texte = typeof raison === 'string' ? raison : '';
  const trouvees = ALTERNATIVES.filter(([motif]) => motif.test(texte)).map(([, alternative]) => alternative);
  return trouvees.length === 0 ? ALTERNATIVE_GENERALE : trouvees.join(' ');
}

// Ce que le modèle lit à la place du refus qui arrêtait son tour. id : le numéro en boîte de la demande d'accord, ou null.
export function texteRefusGarde({ genre, raison, id, cause } = {}) {
  const motif = nettoyer(raison, LARGEUR_RAISON_REFUS);
  const alternative = alternativePourGarde(raison);
  if (genre === 'ask') {
    const boite = Number.isInteger(id) && id >= 1 ? ` La demande est notée en boîte (n° ${id}) : il l'autorisera ou la refusera à son réveil.`
      : CAUSES_NON_NOTEE[cause] ? ` La demande n'a PAS pu être notée en boîte (${CAUSES_NON_NOTEE[cause]}) : note-la dans le fichier contexte pour son réveil.` : '';
    return `NUIT : cette commande demande l'accord de l'utilisateur (${motif}). Il est absent : elle n'est pas lancée. ${alternative}${boite}`;
  }
  return `NUIT : le garde de sécurité refuse cette commande (${motif}). L'utilisateur est absent : ne t'arrête pas, change de voie. ${alternative}`;
}

// La commande sur une ligne, ENTIÈRE jusqu'à LARGEUR_COMMANDE_ENTIERE ; au-delà, la coupure est annoncée avec les deux longueurs.
export function commandeEntiere(commande) {
  const c = typeof commande === 'string' ? commande.replace(/\s+/g, ' ').trim() : '';
  return c.length > LARGEUR_COMMANDE_ENTIERE ? `${c.slice(0, LARGEUR_COMMANDE_ENTIERE)} [COMMANDE COUPÉE : ${c.length} caractères en tout, ${LARGEUR_COMMANDE_ENTIERE} montrés]` : c;
}

// La commande qui attend l'accord de l'utilisateur, pour la boîte : { titre, details, options }. Le titre est court ; les détails portent la raison
// du garde puis la commande entière, pour que l'utilisateur décide en voyant tout.
export function actionDeGarde({ commande, raison } = {}) {
  const c = nettoyer(commande, LARGEUR_COMMANDE);
  const entiere = commandeEntiere(commande);
  return {
    titre: c === '' ? "Commande en attente d'accord" : `Commande en attente d'accord : ${c}`,
    details: [nettoyer(raison, LARGEUR_DETAIL), entiere === '' ? '' : `Commande entière : ${entiere}`].filter(Boolean).join(' | '),
    options: [
      { label: REPONSE_AUTORISER, description: 'L\'utilisateur autorise cette commande : elle peut être lancée' },
      { label: 'Refuser', description: 'Ne pas la lancer' },
    ],
  };
}

// ---------------------------------------------------------------- enchaînement

const STATUTS_OUVERTS = ['ouvert', 'en-cours'];
const LARGEUR_LIGNE = 160;
// Zéro et un prennent le singulier, comme en français.
const accord = (n, un, plusieurs) => `${n} ${n <= 1 ? un : plusieurs}`;

// Les lignes de la liste de travail que cette conversation peut reprendre : celles dont elle est propriétaire, ouvertes ou en cours (ni
// bloquées par l'utilisateur, ni faites), dans l'ordre des numéros. Une ligne d'une autre conversation n'est jamais un ordre pour celle-ci.
export function lignesCandidates(lignes, session) {
  const out = [];
  for (const l of Array.isArray(lignes) ? lignes : []) {
    if (!estObjet(l) || typeof l.id !== 'string' || !LIGNE.test(l.id) || l.session !== session || !STATUTS_OUVERTS.includes(l.statut)) continue;
    out.push({ id: l.id, texte: nettoyer(l.texte, LARGEUR_LIGNE) });
  }
  return out.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

// Ce que le modèle lit pour continuer seul avec la ligne suivante (le texte que l'adaptateur soumet, ou que le hook Codex donne au Stop).
export function texteContinuation({ ligne, restantes, tours, maxTours }) {
  return `${PREFIXE_CONTINUATION}L'utilisateur est absent. Continue sans l'attendre avec la ligne suivante de ta liste de travail : ${ligne.id} « ${ligne.texte} ». `
    + `Il reste ${accord(restantes, 'ligne ouverte', 'lignes ouvertes')} pour cette conversation. `
    + "Vérifie d'abord dans le code si elle est déjà faite ; si oui, ferme-la sur preuve. "
    + "Ne pose aucune question : l'outil de questions sera refusé et ta question notée en boîte pour son réveil, alors choisis l'option la plus sûre et réversible. "
    + "Aucun push, aucun déploiement sans son ordre. "
    + `(enchaînement ${tours} sur ${maxTours})`;
}

// À la fin d'un tour du modèle principal : faut-il enchaîner sur une autre ligne ? Rend { continuer: false, motif, etat } ou
// { continuer: true, ligne, restantes, texte, etat }. Les motifs d'arrêt, dans l'ordre : inactive (pas de nuit), interrompu (le tour n'a
// pas fini par une réponse : l'utilisateur a peut-être repris la main), pause (Régulateur), quota (Garde-quota au seuil critique), plafond
// (tours), termine (plus de ligne), repetition (les lignes restantes n'avancent pas). Les quatre derniers sont gardés dans `arret` pour le récap.
export function decisionContinuation({ etat, reason, lignes, session, pause, quotaCritique } = {}) {
  const e = normaliserEtat(etat);
  const arret = (motif, retenu = true) => ({ continuer: false, motif, etat: retenu ? { ...e, arret: motif } : e });
  if (!e.actif) return arret('inactive', false);
  if (reason !== 'answer') return arret('interrompu', false);
  if (pause === true) return arret('pause');
  if (quotaCritique === true) return arret('quota');
  if (e.tours >= e.maxTours) return arret('plafond');
  const toutes = lignesCandidates(lignes, session);
  // Ordre de proposition : d'abord les lignes qui ont eu le moins de passages les nuits d'avant, puis l'ordre des numéros. Le tri est
  // stable : sans aucun passage gardé, c'est l'ordre des numéros, comme avant.
  // La ligne qui vient d'avoir tous ses enchaînements est examinée la première (elle est écartée pour le reste de la nuit, comme avant).
  const saturee = l => l.id === e.derniereLigne && e.repetition >= REPETITION_MAX;
  const rang = l => (saturee(l) ? -1 : (e.passages[l.id] || 0));
  const candidates = toutes.filter(l => !e.sautees.includes(l.id));
  candidates.sort((a, b) => rang(a) - rang(b));
  let sautees = e.sautees;
  let ligne = null;
  for (const l of candidates) {
    if (l.id === e.derniereLigne && e.repetition >= REPETITION_MAX) { sautees = [...sautees, l.id].slice(0, MAX_SAUTEES); continue; }
    ligne = l;
    break;
  }
  if (ligne === null) {
    const motif = toutes.length === 0 ? 'termine' : 'repetition';
    return { continuer: false, motif, etat: { ...e, sautees, arret: motif } };
  }
  const restantes = candidates.filter(l => !sautees.includes(l.id)).length;
  const suivant = { ...e, tours: e.tours + 1, derniereLigne: ligne.id, repetition: ligne.id === e.derniereLigne ? e.repetition + 1 : 1, sautees, arret: null };
  // Son dernier enchaînement de la nuit : un passage de plus, compté ici (et non quand elle est écartée) parce que le plafond de tours
  // peut arrêter la nuit juste après. Réinscrite en dernier pour rester parmi les passages gardés.
  if (suivant.repetition === REPETITION_MAX) {
    const { [ligne.id]: avant = 0, ...autres } = e.passages;
    suivant.passages = passagesNormaux({ ...autres, [ligne.id]: avant + 1 });
  }
  return { continuer: true, ligne, restantes, texte: texteContinuation({ ligne, restantes, tours: suivant.tours, maxTours: e.maxTours }), etat: suivant };
}

// ---------------------------------------------------------------- textes

const MODES_TEXTE = { nuit: 'nuit', absence: 'absence de l\'utilisateur' };
const MAX_LISTEES = 10;
const PHRASES_ARRET = {
  plafond: etat => `le plafond de ${etat.maxTours} enchaînements est atteint`,
  termine: () => 'toutes les lignes ouvertes de cette conversation sont traitées',
  pause: () => "le Régulateur d'agents est en pause",
  quota: () => 'le Garde-quota a atteint son seuil critique',
  repetition: () => "les lignes restantes n'avançaient pas : elles ont été laissées de côté",
};

export function texteDuree(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'durée inconnue';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "moins d'une minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

const phraseArret = etat => (etat.arret === null ? null : `Enchaînement arrêté : ${PHRASES_ARRET[etat.arret](etat)}.`);

function ligneBoite(e) {
  const options = e.options.length === 0 ? '' : ` Options : ${e.options.map(o => o.label).join(' ; ')}`;
  const sort = e.statut === 'repondue' ? ` (répondue : ${e.reponse})` : e.statut === 'ecartee' ? ' (écartée)' : '';
  return `${e.id}. [${e.type}${e.lot === undefined ? '' : `, lot ${e.lot}`}] ${e.titre}${options}${sort}`;
}

// Dans `/nuit boite`, une entrée à décider montre aussi ses détails (la commande entière d'une action, le texte entier d'une question).
const ligneBoiteDetaillee = e => (e.details === '' ? ligneBoite(e) : `${ligneBoite(e)}\n    ${e.details}`);

// La boîte en entier : d'abord ce qui reste à décider, puis ce qui est traité.
export function texteBoite(boiteBrute) {
  const boite = normaliserBoite(boiteBrute);
  if (boite.entrees.length === 0) return 'Boîte de la nuit : vide.';
  const attente = boite.entrees.filter(e => e.statut === 'en-attente');
  const traitees = boite.entrees.filter(e => e.statut !== 'en-attente');
  return [`Boîte de la nuit : ${attente.length} à décider, ${accord(traitees.length, 'traitée', 'traitées')}.`, ...attente.map(ligneBoiteDetaillee), ...traitees.map(ligneBoite)].join('\n');
}

// La bande de statut (courte, toujours visible) : la nuit en cours, ou les questions qui attendent l'utilisateur ; undefined quand il n'y a rien à dire.
export function texteBande(etatBrut, boiteBrute, maintenant) {
  const etat = normaliserEtat(etatBrut);
  const n = enAttente(boiteBrute).length;
  if (!etat.actif) return n === 0 ? undefined : `Nuit : ${n} à décider en boîte (/nuit boite)`;
  return `Nuit active depuis ${texteDuree(maintenant - Date.parse(etat.depuis))} : ${etat.tours}/${etat.maxTours} enchaînements${etat.arret === null ? '' : ' (arrêté)'}, ${n} à décider`;
}

// Ce que le modèle relit à chaque requête pendant la nuit (donc intact après un compactage) ; null quand la nuit n'est pas active.
export function texteRappel(etatBrut) {
  const etat = normaliserEtat(etatBrut);
  if (!etat.actif) return null;
  const arret = phraseArret(etat);
  return `NUIT EN COURS (${MODES_TEXTE[etat.mode]}) : L'utilisateur est absent. Ne lui pose aucune question : l'outil de questions est refusé et ta question est notée en boîte pour son réveil. `
    + "Un arrêt du garde de sécurité devient un refus avec une alternative : change de voie, ne t'arrête pas. "
    + 'Continue avec les lignes ouvertes de ta liste de travail. Aucun push, aucun déploiement sans son ordre.'
    + `${arret === null ? '' : ` ${arret}`}`;
}

// Une ligne d'état (la nuit, sa détection d'absence, la boîte).
export function texteStatut(etatBrut, boiteBrute, maintenant) {
  const etat = normaliserEtat(etatBrut);
  const aDecider = `${enAttente(boiteBrute).length} à décider en boîte.`;
  if (etat.actif) {
    const arret = phraseArret(etat);
    return `Nuit : active (${MODES_TEXTE[etat.mode]}) depuis ${texteDuree(maintenant - Date.parse(etat.depuis))}, ${accord(etat.tours, 'enchaînement', 'enchaînements')} sur ${etat.maxTours}, ${aDecider}${arret === null ? '' : ` ${arret}`}`;
  }
  const absence = etat.absenceMinutes === null
    ? "désactivée (/nuit absence <minutes> pour l'activer)."
    : `après ${etat.absenceMinutes} min sans message de l'utilisateur (réglable : /nuit absence <minutes> ou /nuit absence off).`;
  return `Nuit : inactive. Détection d'absence : ${absence} ${aDecider}`;
}

// Le récap du réveil : la nuit (durée, enchaînements, lignes), ce qu'elle a refusé, pourquoi elle s'est arrêtée, et la boîte à décider.
// lignesMaintenant : le nombre de lignes ouvertes au moment du récap (null si inconnu).
export function texteRecap(etatBrut, boiteBrute, { maintenant, lignesMaintenant } = {}) {
  const etat = normaliserEtat(etatBrut);
  const lignes = [`NUIT : récap${etat.actif ? ' (nuit en cours)' : ''}.`];
  if (etat.depuis === null) {
    lignes.push('Aucune nuit enregistrée.');
  } else {
    const fin = etat.fin === null ? maintenant : Date.parse(etat.fin);
    lignes.push(`Durée : ${texteDuree(fin - Date.parse(etat.depuis))} (${MODES_TEXTE[etat.mode]}). ${accord(etat.tours, 'enchaînement', 'enchaînements')} sur ${etat.maxTours} au plus.`);
    if (etat.lignesAuDebut !== null && Number.isInteger(lignesMaintenant) && lignesMaintenant >= 0) lignes.push(`Lignes ouvertes : ${etat.lignesAuDebut} au coucher, ${lignesMaintenant} maintenant.`);
    const { question, garde, action } = etat.refus;
    lignes.push(question + garde + action === 0
      ? "Aucun refus pendant l'absence."
      : `Refus pendant l'absence : ${accord(question, 'question mise en boîte', 'questions mises en boîte')}, ${accord(garde, 'arrêt de garde transformé en refus', 'arrêts de garde transformés en refus')}, ${accord(action, "commande en attente d'accord", "commandes en attente d'accord")}.`);
    const arret = phraseArret(etat);
    if (arret !== null) lignes.push(arret);
  }
  const attente = enAttente(boiteBrute);
  if (attente.length === 0) {
    lignes.push('Rien à décider en boîte.');
  } else {
    lignes.push(`À décider (${attente.length}) :`, ...attente.slice(0, MAX_LISTEES).map(ligneBoite));
    if (attente.length > MAX_LISTEES) lignes.push(`Et ${accord(attente.length - MAX_LISTEES, 'autre', 'autres')} : /nuit boite.`);
  }
  return lignes.join('\n');
}

// Traite une entrée encore à décider : { boite, entree } ou { erreur } qui dit pourquoi rien n'a changé.
function traiter(boiteBrute, id, maintenant, appliquer) {
  const boite = normaliserBoite(boiteBrute);
  const i = boite.entrees.findIndex(e => e.id === id);
  if (i < 0) return { erreur: `Boîte : question n° ${id} introuvable.` };
  if (boite.entrees[i].statut !== 'en-attente') return { erreur: `Boîte : la question n° ${id} est déjà traitée.` };
  const modif = appliquer(boite.entrees[i]);
  if (modif.erreur) return modif;
  if (!Number.isFinite(maintenant)) return { erreur: "Boîte : instant illisible, rien n'a changé." };
  const entree = { ...boite.entrees[i], ...modif, traite: new Date(maintenant).toISOString() };
  return { boite: { ...boite, entrees: boite.entrees.map((e, j) => (j === i ? entree : e)) }, entree };
}

export function repondre(boiteBrute, id, texte, maintenant) {
  return traiter(boiteBrute, id, maintenant, entree => {
    const reponse = typeof texte === 'string' ? texte.replace(/\s+/g, ' ').trim() : '';
    if (reponse === '') return { erreur: 'Boîte : la réponse est vide.' };
    if (reponse.length > LARGEUR_DETAIL) return { erreur: 'Boîte : la réponse dépasse 600 caractères.' };
    if (entree.type === 'action' && !entree.options.some(option => option.label === reponse)) {
      return { erreur: 'Boîte : cette action exige le libellé exact d’une option déclarée.' };
    }
    return { statut: 'repondue', reponse };
  });
}

export const ecarter = (boiteBrute, id, maintenant) => traiter(boiteBrute, id, maintenant, () => ({ statut: 'ecartee', reponse: null }));

// L'entrée dont l'autorisation laisse passer cette commande UNE fois, ou null. Tout doit tenir ensemble : une action répondue exactement
// « Autoriser », du même agent et de la même conversation, dont l'empreinte est celle de la commande relancée, répondue depuis moins de
// DUREE_AUTORISATION_MS, pas encore consommée, ET attestée par l'adaptateur (attestees : [{ id, empreinte }], les réponses que l'utilisateur a données
// lui-même, gardées dans la mémoire du moteur). Le fichier de la boîte ne suffit jamais : tout agent peut l'écrire, comme il peut lancer
// `cockpit.js nuit repondre` ; une réponse sans attestation reste une simple note.
export function autorisationValable(boiteBrute, { agent, session, empreinte, maintenant, attestees } = {}) {
  if (typeof empreinte !== 'string' || !EMPREINTE.test(empreinte) || !Number.isFinite(maintenant)) return null;
  const attestations = Array.isArray(attestees) ? attestees.filter(estObjet) : [];
  for (const e of normaliserBoite(boiteBrute).entrees) {
    if (e.type !== 'action' || e.statut !== 'repondue' || e.reponse !== REPONSE_AUTORISER) continue;
    if (e.agent !== agent || e.session !== session || e.empreinte !== empreinte || e.consommee !== undefined) continue;
    const age = maintenant - Date.parse(e.traite);
    if (!(age >= 0 && age < DUREE_AUTORISATION_MS)) continue;
    if (!attestations.some(a => a.id === e.id && a.empreinte === empreinte)) continue;
    return e;
  }
  return null;
}

// Marque l'autorisation consommée (elle ne servira plus) : { boite, entree }, ou null si l'entrée n'est pas une action répondue non consommée.
export function consommerAutorisation(boiteBrute, id, maintenant) {
  const boite = normaliserBoite(boiteBrute);
  const i = boite.entrees.findIndex(e => e.id === id && e.type === 'action' && e.statut === 'repondue' && e.empreinte !== undefined && e.consommee === undefined);
  if (i < 0 || !Number.isFinite(maintenant)) return null;
  const entree = { ...boite.entrees[i], consommee: new Date(maintenant).toISOString() };
  return { boite: { ...boite, entrees: boite.entrees.map((e, j) => (j === i ? entree : e)) }, entree };
}

// ---------------------------------------------------------------- commande /nuit

const USAGE = 'Usage : /nuit [on | off | statut | recap | boite | absence <minutes 1 à 1440> | absence off | tours <1 à 500> | repondre <n°> <réponse> | ecarter <n°> | defaut]';
const ENTIER = /^\d+$/;
const INSTANT_ILLISIBLE = { erreur: "Nuit : instant illisible, rien n'a changé." };

// `/nuit <args>` (et `cockpit.js nuit <args>`). Rend { etat, boite, message, effet, reponse? } ou { erreur } (rien ne change en cas d'erreur).
// effet : active (la nuit commence), reveil (elle finit : le récap est le message), reponse (une réponse est notée : à transmettre au
// modèle), ecartee, ou null. `lignesOuvertes` : le nombre de lignes ouvertes de cette conversation au moment de la commande.
export function analyserCommande(args, etatBrut, boiteBrute, { maintenant, lignesOuvertes } = {}) {
  const etat = normaliserEtat(etatBrut);
  const boite = normaliserBoite(boiteBrute);
  const [premier, ...reste] = String(args == null ? '' : args).trim().split(/\s+/);
  const seul = reste.length === 0;
  const sans = (message, changements = {}) => ({ etat: { ...etat, ...changements }, boite, effet: null, message });
  // Un mot fait uniquement de chiffres, ou null (aussi pour un mot absent).
  const entier = texte => (typeof texte === 'string' && ENTIER.test(texte) ? Number(texte) : null);
  const nombre = (texte, max) => {
    const n = entier(texte);
    return n !== null && n >= 1 && n <= max ? n : null;
  };

  switch (premier.toLowerCase()) {
    case '':
    case 'statut':
    case 'etat':
    case 'état':
      return seul ? sans(texteStatut(etat, boite, maintenant)) : { erreur: USAGE };
    case 'recap':
      return seul ? sans(texteRecap(etat, boite, { maintenant, lignesMaintenant: lignesOuvertes })) : { erreur: USAGE };
    case 'boite':
      return seul ? sans(texteBoite(boite)) : { erreur: USAGE };
    case 'on': {
      if (!seul) return { erreur: USAGE };
      if (etat.actif) return sans(`Nuit : déjà active depuis ${texteDuree(maintenant - Date.parse(etat.depuis))}.`);
      if (!Number.isFinite(maintenant)) return INSTANT_ILLISIBLE;
      return {
        etat: activer(etat, { mode: 'nuit', maintenant, lignesOuvertes }),
        boite,
        effet: 'active',
        message: "Nuit : active. Les questions bloquantes iront en boîte, les arrêts de garde deviendront des refus avec alternative, et le travail continue sur les lignes ouvertes de cette conversation. Elle prend fin à ton prochain message ou avec /nuit off.",
      };
    }
    case 'off': {
      if (!seul) return { erreur: USAGE };
      if (!etat.actif) return sans('Nuit : déjà inactive.');
      if (!Number.isFinite(maintenant)) return INSTANT_ILLISIBLE;
      const finie = desactiver(etat, maintenant);
      return { etat: finie, boite, effet: 'reveil', message: texteRecap(finie, boite, { maintenant, lignesMaintenant: lignesOuvertes }) };
    }
    case 'absence': {
      if (reste.length !== 1) return { erreur: USAGE };
      if (reste[0].toLowerCase() === 'off') return sans("Détection d'absence désactivée : seule la commande /nuit on commence une nuit.", { absenceMinutes: null });
      const minutes = nombre(reste[0], ABSENCE_LIMITE_MIN);
      if (minutes === null) return { erreur: USAGE };
      return sans(`Détection d'absence : la nuit commence quand l'utilisateur n'écrit plus depuis ${minutes} min.`, { absenceMinutes: minutes });
    }
    case 'tours': {
      if (reste.length !== 1) return { erreur: USAGE };
      const tours = nombre(reste[0], MAX_TOURS_LIMITE);
      if (tours === null) return { erreur: USAGE };
      return sans(`Plafond d'enchaînements : ${tours} par nuit.`, { maxTours: tours });
    }
    case 'defaut':
      return seul
        ? sans(`Réglages de la nuit remis aux valeurs par défaut (absence après ${ABSENCE_DEFAUT_MIN} min, ${MAX_TOURS_DEFAUT} enchaînements au plus).`, { maxTours: MAX_TOURS_DEFAUT, absenceMinutes: ABSENCE_DEFAUT_MIN })
        : { erreur: USAGE };
    case 'repondre': {
      const id = entier(reste[0]);
      if (id === null) return { erreur: USAGE };
      const r = repondre(boite, id, reste.slice(1).join(' '), maintenant);
      if (r.erreur) return { erreur: r.erreur };
      return { etat, boite: r.boite, effet: 'reponse', message: `Boîte : réponse notée pour la question n° ${id}.`, reponse: { id, texte: r.entree.reponse, entree: r.entree } };
    }
    case 'ecarter': {
      const id = reste.length === 1 ? entier(reste[0]) : null;
      if (id === null) return { erreur: USAGE };
      const r = ecarter(boite, id, maintenant);
      if (r.erreur) return { erreur: r.erreur };
      return { etat, boite: r.boite, effet: 'ecartee', message: `Boîte : question n° ${id} écartée.` };
    }
    default:
      return { erreur: USAGE };
  }
}
