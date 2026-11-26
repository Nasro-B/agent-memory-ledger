'use strict';
/**
 * Entrées-sorties de la Nuit : l'état, la boîte des questions et des commandes à décider, la liste de travail lue dans le ledger,
 * et les décisions (refuser une question, transformer l'arrêt d'un garde en refus, enchaîner sur la ligne suivante). La logique
 * (état, boîte, textes, commande /nuit, décision d'enchaînement) est dans nuit-logique.mjs.
 *
 * Fichiers (dans COCKPIT_DIR, écrits de façon atomique, relus par les adaptateurs et le Cockpit) :
 *   nuit.json         l'état de la nuit (le Cockpit le relit tel quel)
 *   nuit-boite.json   ce que l'utilisateur doit décider à son réveil
 *   nuit-boite-archive.jsonl, nuit-livraisons.json, nuit.verrou   (voir plus bas)
 *
 * Chaque fonction qui décide prend { agent, session, maintenant? } : la nuit est PAR agent principal et PAR conversation pour
 * les lignes de travail (une ligne d'une autre conversation n'est jamais un ordre), mais UNE pour l'utilisateur (il est absent ou non).
 * L'agent est un nom du dépôt (claude, codex, deepseek_H) ou une clé d'état déjà valide : la boîte garde la clé (agents-noms.js), la
 * liste de travail est lue sous le nom du dépôt comme sous la clé.
 *
 * API : lireEtat, ecrireEtat, lireBoite, ecrireBoite, lignesDe, appliquerCommande, noterActivite, nuitActive, refuserQuestion,
 *       refuserGarde, continuer, recap.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cockpit = require('./cockpit-core.js');
const regulateur = require('./regulateur-core.js');
const quota = require('./quota-core.js');
const logique = require('./nuit-logique.mjs');
const { AGENTS } = require('./config.js');
const { cleAgent, nomsListe } = require('./agents-noms.js');

// La garde de sécurité que la Nuit interroge elle-même pour une commande (scripts/gardes/securite.js, lancée avec --agent : voir
// executerGarde et refuserGarde). NUIT_GARDE (un autre script de garde) et NUIT_GARDE_DELAI_MS ne servent qu'aux bancs.
const DELAI_GARDE_MS = 5000;

const fichierEtat = () => path.join(cockpit.racine(), 'nuit.json');
const fichierBoite = () => path.join(cockpit.racine(), 'nuit-boite.json');
const message = e => (e && e.message ? e.message : String(e));
const objet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const agentValide = v => cleAgent(v) !== null;
// La clé d'état d'un agent du dépôt (deepseek_H devient deepseek-h) ; tout autre nom est laissé tel quel.
const cleDe = agent => cleAgent(agent) ?? agent;

// ---------------------------------------------------------------- verrou
// Toute séquence lire, modifier, écrire sur nuit.json et nuit-boite.json passe sous CE verrou (un seul pour les deux fichiers) : sans lui,
// deux agents au même instant prenaient le même numéro de boîte et une entrée était perdue. Sur le modèle de prendreVerrou de
// cockpit-core.js (création exclusive ; non exporté là-bas, donc repris ici), avec une attente BORNÉE : un hook ne reste jamais bloqué.
// NUIT_VERROU_DELAI_MS ne sert qu'aux bancs.
const DELAI_VERROU_MS = 2000;
const PAS_VERROU_MS = 20;
const VERROU_PERIME_MS = 30 * 1000;
const VERROU_ILLISIBLE_PERIME_MS = 5 * 1000;
const fichierVerrou = () => path.join(cockpit.racine(), 'nuit.verrou');

class VerrouOccupe extends Error {}

function pidVivant(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Un essai : vrai si le verrou est pris. Un verrou laissé par un processus mort, ou trop vieux, est repris. Un verrou au contenu encore
// illisible (son détenteur est en train de l'écrire) n'est repris que s'il est vieux : le lire trop tôt ne doit pas le voler.
function prendreVerrou(chemin) {
  const contenu = JSON.stringify({ pid: process.pid, ts: Date.now() });
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  for (let essai = 0; essai < 2; essai++) {
    try { fs.writeFileSync(chemin, contenu, { flag: 'wx' }); return true; } catch (e) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return false; // Windows : fichier en cours de suppression par son détenteur
      if (e.code !== 'EEXIST') throw e;
      const v = cockpit.lireJson(chemin, null);
      let age;
      try { age = Date.now() - fs.statSync(chemin).mtimeMs; } catch (_) { continue; } // rendu entre-temps : nouvel essai
      const tenu = v && Number.isFinite(v.ts) ? Date.now() - v.ts < VERROU_PERIME_MS && pidVivant(v.pid) : age < VERROU_ILLISIBLE_PERIME_MS;
      if (tenu) return false;
      try { fs.unlinkSync(chemin); } catch (_) { /* repris entre-temps par un autre */ }
    }
  }
  return false;
}

// Exécute fn en tenant le verrou de la nuit ; lève VerrouOccupe s'il n'a pas pu être pris dans le délai. Réentrant dans le processus.
let verrouTenu = 0;
function sousVerrou(fn) {
  if (verrouTenu > 0) return fn();
  const chemin = fichierVerrou();
  const delai = Number(process.env.NUIT_VERROU_DELAI_MS) || DELAI_VERROU_MS;
  const limite = Date.now() + delai;
  while (!prendreVerrou(chemin)) {
    if (Date.now() >= limite) throw new VerrouOccupe(`fichiers de la nuit occupés depuis plus de ${delai} ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAS_VERROU_MS);
  }
  verrouTenu++;
  try { return fn(); } finally {
    verrouTenu--;
    try { fs.unlinkSync(chemin); } catch (_) { /* déjà retiré */ }
  }
}

// L'empreinte d'une commande mise en boîte : la commande ENTIÈRE, telle que l'outil la reçoit, avec l'agent et la conversation.
const empreinteCommande = (agent, session, commande) => crypto.createHash('sha256').update(JSON.stringify([cleDe(agent), session, commande])).digest('hex');

const lireEtat = () => logique.normaliserEtat(cockpit.lireJson(fichierEtat(), null));

function ecrireEtat(etat) {
  cockpit.ecrireJson(fichierEtat(), { ...logique.normaliserEtat(etat), maj: new Date().toISOString() });
}

const lireBoite = () => logique.normaliserBoite(cockpit.lireJson(fichierBoite(), null));

function ecrireBoite(boite) {
  cockpit.ecrireJson(fichierBoite(), { ...logique.normaliserBoite(boite), maj: new Date().toISOString() });
}

// L'archive de la boîte (COCKPIT_DIR/nuit-boite-archive.jsonl, une entrée par ligne, jamais réécrite) : les entrées traitées qui ont laissé
// leur place quand la boîte était pleine. Sans elle, une décision de l'utilisateur sortait du fichier sans être gardée nulle part.
// Lève si l'écriture échoue.
const fichierArchive = () => path.join(cockpit.racine(), 'nuit-boite-archive.jsonl');

function archiver(entrees) {
  if (entrees.length === 0) return;
  const archiveLe = new Date().toISOString();
  fs.mkdirSync(path.dirname(fichierArchive()), { recursive: true });
  fs.appendFileSync(fichierArchive(), entrees.map(e => `${JSON.stringify({ ...e, archiveLe })}\n`).join(''));
}

// Les entrées de l'archive, dans l'ordre où elles y sont entrées (une ligne abîmée est ignorée).
function lireArchive() {
  let texte;
  try { texte = fs.readFileSync(fichierArchive(), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const ligne of texte.split('\n')) {
    if (ligne.trim() === '') continue;
    try { const e = JSON.parse(ligne); if (objet(e) && Number.isInteger(e.id)) out.push(e); } catch (_) { /* ligne abîmée */ }
  }
  return out;
}

// Réponses de l'utilisateur données dans la boîte à des entrées de CETTE conversation depuis `depuis` (le début de son tour, en ms) et pas
// encore dites à son modèle : rendues une seule fois, comme des textes à lui injecter tout de suite (l'adaptateur les donne après un
// outil). Sans cela, la réponse attend en file la fin du tour, et une commande autorisée peut arriver quand la nuit est déjà finie.
// COCKPIT_DIR/nuit-livraisons.json garde les numéros déjà dits ({ "12": date }), au plus MAX_LIVRAISONS.
const MAX_LIVRAISONS = 300;
const fichierLivraisons = () => path.join(cockpit.racine(), 'nuit-livraisons.json');
const NUIT_FINIE = " La nuit est terminée : l'accord donné dans la boîte ne valait que pendant la nuit. Relance la commande normalement, le garde de sécurité demandera l'accord de l'utilisateur.";

function reponsesALivrer({ agent, session, depuis, maintenant = Date.now() }) {
  agent = cleDe(agent);
  // Un agent, une conversation ou un instant illisibles ne correspondent à aucune entrée : rien n'est rendu.
  const aDire = e => e.agent === agent && e.session === session && e.statut === 'repondue' && Date.parse(e.traite) > depuis;
  if (!lireBoite().entrees.some(aDire)) return [];
  let nouvelles = [];
  try {
    nouvelles = sousVerrou(() => {
      const brut = cockpit.lireJson(fichierLivraisons(), null);
      const livrees = objet(brut) ? brut : {};
      const pretes = lireBoite().entrees.filter(e => aDire(e) && livrees[e.id] === undefined); // ancre-mutation:reponse-une-fois
      if (pretes.length === 0) return [];
      for (const e of pretes) livrees[e.id] = new Date(maintenant).toISOString();
      const gardees = Object.fromEntries(Object.entries(livrees).slice(-MAX_LIVRAISONS));
      cockpit.ecrireJson(fichierLivraisons(), gardees);
      return pretes;
    });
  } catch (_) { return []; } // fichiers occupés : la réponse arrivera par le message de fin de tour
  const actif = lireEtat().actif;
  return nouvelles.map(e => {
    const texte = logique.texteReponse(e);
    if (texte === null) return null;
    const finie = !actif && e.type === 'action' && e.reponse === logique.REPONSE_AUTORISER ? NUIT_FINIE : '';
    return `${texte}${finie} (Dite ici sans attendre la fin de ton tour ; elle te sera redite en message.)`;
  }).filter(Boolean);
}

// Les lignes ouvertes de la liste de travail de cet agent, tous projets : [{ id, texte, statut, note, session }].
function lignesDe(agent) {
  const noms = nomsListe(agent);
  const { agents } = cockpit.resumeLedger({ agents: noms });
  const projets = noms.flatMap(nom => Object.values(agents[nom] || {}));
  return projets.flatMap(p => p.lignesOuvertes);
}

// Combien de lignes de cette conversation sont ouvertes ; null quand la conversation n'est pas connue (commande tapée dans un terminal).
const nbLignes = (agent, session) => (typeof session === 'string' && session !== '' ? logique.lignesCandidates(lignesDe(agent), session).length : null);

// `/nuit <args>` (et `cockpit.js nuit <args>`) : rend { message, effet, reponse?, prompt? } ou { erreur }. N'écrit que ce qui change.
// `prompt` : pour une réponse notée, le texte à donner au modèle. `effet` : active, reveil, reponse, ecartee ou null.
// Une commande qui ne change rien (statut, recap, boite) ne prend pas le verrou ; une commande qui écrit est rejouée SOUS le verrou, sur les
// fichiers relus : c'est cette seconde analyse qui est écrite et rendue.
// Les réglages de la nuit (plafond d'enchaînements, délai d'absence, retour aux valeurs par défaut) ne se changent pas pendant une nuit
// active : l'utilisateur est absent, c'est donc un agent qui les changerait. Un agent qui abaissait le plafond pendant la nuit la faisait
// s'arrêter bien plus tôt, et le réglage restait après le réveil. L'utilisateur règle avant /nuit on, ou après son réveil.
const REGLAGES = ['tours', 'absence', 'defaut'];
const REFUS_REGLAGE = "Nuit : les réglages (tours, absence, defaut) ne se changent pas pendant une nuit active, l'utilisateur est absent. Rien n'a changé. L'utilisateur les règle avant /nuit on ou après son réveil.";

function appliquerCommande(args, { agent, session, maintenant = Date.now() }) {
  const premier = String(args == null ? '' : args).trim().split(/\s+/)[0].toLowerCase();
  if (REGLAGES.includes(premier) && lireEtat().actif) return { erreur: REFUS_REGLAGE }; // ancre-mutation:reglage-nuit-active
  const lignesOuvertes = nbLignes(agent, session);
  const analyser = () => {
    const etat = lireEtat();
    const boite = lireBoite();
    const r = logique.analyserCommande(args, etat, boite, { maintenant, lignesOuvertes });
    if (r.erreur) return { r, ecritures: [] };
    return { r, ecritures: [
      [JSON.stringify(r.boite) !== JSON.stringify(boite), fichierBoite, () => ecrireBoite(r.boite)],
      [JSON.stringify(r.etat) !== JSON.stringify(etat), fichierEtat, () => ecrireEtat(r.etat)],
    ].filter(([change]) => change) };
  };
  let a = analyser();
  if (a.ecritures.length > 0) {
    try {
      const erreur = sousVerrou(() => { // ancre-mutation:verrou-commande
        a = analyser();
        for (const [, fichier, ecrire] of a.ecritures) {
          try { ecrire(); } catch (e) { return `Écriture impossible dans ${fichier()} (${message(e)}) : rien n'a changé.`; }
        }
        return null;
      });
      if (erreur !== null) return { erreur };
    } catch (e) {
      if (!(e instanceof VerrouOccupe)) throw e;
      return { erreur: `Nuit : ${message(e)} : rien n'a changé, recommence.` };
    }
  }
  const r = a.r;
  if (r.erreur) return { erreur: r.erreur };
  if (r.reponse === undefined) return { message: r.message, effet: r.effet };
  // La réponse est donnée au modèle de la conversation où l'utilisateur répond. Si la question venait d'une AUTRE conversation, les deux le
  // savent : le modèle d'ici ne l'applique pas comme sienne, et l'utilisateur sait à qui la porter.
  const origine = r.reponse.entree.session;
  const ailleurs = typeof session === 'string' && session !== '' && typeof origine === 'string' && origine !== session; // ancre-mutation:reponse-autre-conversation
  if (!ailleurs) return { message: r.message, effet: r.effet, reponse: r.reponse, prompt: logique.texteReponse(r.reponse.entree) };
  const prompt = logique.texteReponse(r.reponse.entree);
  const court = origine.slice(0, 8);
  return {
    message: `${r.message} Attention : cette question a été posée par une autre conversation (${court}), c'est elle qui attend la réponse.`,
    effet: r.effet,
    reponse: r.reponse,
    prompt: prompt === null ? null : `${prompt} (Cette entrée de la boîte vient d'une autre conversation, ${court} : ne l'applique pas comme si c'était ta question ; dis à l'utilisateur que la réponse est à donner à cette conversation.)`,
  };
}

// Un message de l'utilisateur : il date son activité et met fin à une nuit active. { reveil: false } ou { reveil: true, recap }.
function noterActivite({ agent, session, maintenant = Date.now() }) {
  const r = sousVerrou(() => {
    const note = logique.noterActivite(lireEtat(), maintenant);
    ecrireEtat(note.etat);
    return note;
  });
  if (!r.reveil) return { reveil: false };
  return { reveil: true, recap: logique.texteRecap(r.etat, lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) }) };
}

// La nuit est-elle en cours ? Si l'utilisateur est absent depuis assez longtemps, elle commence ici (mode absence).
function nuitActive({ agent, session, maintenant = Date.now() }) {
  const etat = lireEtat();
  if (etat.actif) return true;
  if (!logique.absenceAtteinte(etat, maintenant)) return false;
  const lignes = nbLignes(agent, session);
  try {
    return sousVerrou(() => {
      const relu = lireEtat();
      if (relu.actif) return true;
      const r = logique.activerSiAbsent(relu, maintenant, lignes);
      if (r.active) ecrireEtat(r.etat);
      return r.active;
    });
  } catch (e) {
    if (!(e instanceof VerrouOccupe)) throw e;
    return true; // l'absence est atteinte : la nuit vaut, même si son début n'a pas pu être écrit cette fois
  }
}

// Met les entrées en boîte, sous le verrou, en une écriture : { resultats: [{ id, cause }], enAttente, lot }. Pour chaque entrée, id est son
// numéro, ou null avec la cause (invalide, pleine, verrou, ecriture) quand la boîte ne l'a pas prise. Plusieurs entrées d'un même appel
// portent le même lot (le numéro de la première).
function mettreEnBoite(entrees) {
  const toutes = cause => ({ resultats: entrees.map(() => ({ id: null, cause })), enAttente: 0, lot: null });
  try {
    return sousVerrou(() => { // ancre-mutation:verrou-boite
      let boite = lireBoite();
      let lot = null;
      const resultats = [];
      const evincees = [];
      for (const entree of entrees) {
        const r = logique.ajouterEntree(boite, { ...entree, lot: entrees.length > 1 ? (lot === null ? 'soi' : lot) : undefined });
        if (r.refus !== undefined) { resultats.push({ id: null, cause: r.refus }); continue; }
        if (entrees.length > 1 && lot === null && r.entree.lot !== undefined) lot = r.entree.lot;
        resultats.push({ id: r.entree.id, cause: undefined, nouvelle: !r.deja });
        if (r.evincee !== undefined) evincees.push(r.evincee);
        boite = r.boite;
      }
      if (resultats.some(r => r.nouvelle)) {
        // L'archive d'abord : une décision de l'utilisateur ne quitte la boîte qu'une fois gardée ailleurs. Si elle ne peut pas être écrite,
        // la boîte n'est pas réécrite non plus (les entrées de cet appel sont dites non notées, cause ecriture).
        try { archiver(evincees); ecrireBoite(boite); } catch (_) { // ancre-mutation:boite-archive
          return { resultats: resultats.map(r => (r.nouvelle ? { id: null, cause: 'ecriture' } : { id: r.id, cause: r.cause })), enAttente: 0, lot: null };
        }
      }
      return { resultats: resultats.map(r => ({ id: r.id, cause: r.cause })), enAttente: logique.enAttente(boite).length, lot };
    });
  } catch (e) {
    return toutes(e instanceof VerrouOccupe ? 'verrou' : 'ecriture');
  }
}

// n refus de plus, sous le verrou. Une panne du compteur ne retire jamais le refus : le modèle doit le lire.
function compter(genre, n = 1) {
  try {
    sousVerrou(() => {
      let etat = lireEtat();
      for (let i = 0; i < n; i++) etat = logique.compterRefus(etat, genre);
      ecrireEtat(etat);
    });
  } catch (_) { /* le refus est dit quand même */ }
}

// La commande que l'utilisateur a autorisée dans la boîte passe UNE fois : l'entrée est marquée consommée sous le verrou AVANT de laisser passer.
// Rend le numéro de l'entrée consommée, ou null (aucune autorisation valable, ou une panne : dans le doute, on refuse).
function consommerAutorisation({ agent, session, empreinte, attestees, maintenant }) {
  try {
    return sousVerrou(() => {
      const boite = lireBoite();
      const entree = logique.autorisationValable(boite, { agent, session, empreinte, maintenant, attestees }); // ancre-mutation:autorisation
      if (entree === null) return null;
      const r = logique.consommerAutorisation(boite, entree.id, maintenant);
      if (r === null) return null;
      ecrireBoite(r.boite);
      return entree.id;
    });
  } catch (_) {
    return null;
  }
}

// L'outil de questions (Claude : AskUserQuestion, Codex : request_user_input_async) pendant la nuit : { refuser: false }, ou
// { refuser: true, id, ids, lot, texte }. UNE entrée de boîte par question de l'appel, chacune avec ses options : ids donne le numéro de
// chacune (null si la boîte ne l'a pas prise), id celui de la première, lot ce qui les relie (null pour une question seule).
function refuserQuestion({ agent, session, entreeOutil, maintenant = Date.now() }) {
  agent = cleDe(agent);
  if (!nuitActive({ agent, session, maintenant })) return { refuser: false };
  const questions = logique.entreesDeQuestions(entreeOutil);
  const mise = mettreEnBoite(questions.map(q => ({ agent, session, type: 'question', titre: q.titre, details: q.details, options: q.options, maintenant })));
  compter('question', questions.length);
  const texte = logique.texteRefusQuestion({
    id: mise.resultats[0].id,
    cause: mise.resultats[0].cause,
    enAttente: mise.enAttente,
    options: questions[0].options,
    lot: mise.lot,
    questions: questions.map((q, i) => ({ id: mise.resultats[i].id, cause: mise.resultats[i].cause, titre: q.titre, options: q.options })),
  });
  return { refuser: true, id: mise.resultats[0].id, ids: mise.resultats.map(r => r.id), lot: mise.lot, texte };
}

// La sortie du garde de sécurité pour une commande, pendant la nuit : { refuser: false } quand il laisse passer, sinon
// { refuser: true, genre, id, texte } (genre ask : la commande attend l'accord de l'utilisateur, notée en boîte sous le numéro id).
// Une commande que l'utilisateur a autorisée dans la boîte (voir logique.autorisationValable ; attestees vient de l'adaptateur) rend, une seule fois,
// { refuser: false, autorisee: <numéro> } : la nuit ne la refuse plus, le garde de sécurité lui-même garde son dernier mot ensuite.
// Seul le genre ask est concerné : un refus ferme du garde (genre bloc) n'est JAMAIS levé par la boîte.
function refuserGarde({ agent, session, sortie, commande, attestees, maintenant = Date.now() }) {
  agent = cleDe(agent);
  const analyse = logique.analyserSortieGarde(sortie);
  if (analyse === null || !nuitActive({ agent, session, maintenant })) return { refuser: false };
  let id = null;
  let cause;
  if (analyse.genre === 'ask') {
    const empreinte = typeof commande === 'string' && commande !== '' ? empreinteCommande(agent, session, commande) : undefined;
    const autorisee = empreinte === undefined ? null : consommerAutorisation({ agent, session, empreinte, attestees, maintenant });
    if (autorisee !== null) return { refuser: false, autorisee };
    ({ id, cause } = mettreEnBoite([{ agent, session, type: 'action', ...logique.actionDeGarde({ commande, raison: analyse.raison }), empreinte, maintenant }]).resultats[0]);
  }
  compter(analyse.genre === 'ask' ? 'action' : 'garde');
  return { refuser: true, genre: analyse.genre, id, texte: logique.texteRefusGarde({ genre: analyse.genre, raison: analyse.raison, id, cause }) };
}

// Le quota de cet agent est-il au seuil critique ? Codex : le rollout du fil (chemin), sinon la dernière mesure gardée ; Claude : sa
// mesure gardée par le Garde-quota. Une panne de la mesure n'arrête pas la nuit. Les réglages du Garde-quota font foi (blocage éteint = faux).
function quotaCritique({ agent, chemin, maintenant }) {
  try { return !quota.decisionAgentCodex({ agent, chemin, maintenant }).autorise; } catch (_) { return false; }
}

// À la fin d'un tour du modèle principal : faut-il enchaîner ? Rend la décision de la logique ({ continuer, motif | ligne, restantes, texte }).
// L'état est écrit avant de rendre la décision : si l'écriture échoue, l'erreur remonte plutôt que de continuer sans compter les tours.
function continuer({ agent, session, reason, chemin, maintenant = Date.now() }) {
  nuitActive({ agent, session, maintenant });
  // Les mesures lentes (liste de travail, quota) sont prises avant le verrou ; la décision et son écriture se font sous lui, sur l'état relu.
  const mesurer = etat => {
    const evalue = etat.actif && reason === 'answer';
    return { evalue, lignes: lignesDe(agent), pause: evalue && regulateur.lirePolitique().pause, quotaCritique: evalue && quotaCritique({ agent, chemin, maintenant }) };
  };
  let m = mesurer(lireEtat());
  return sousVerrou(() => {
    const etat = lireEtat();
    if ((etat.actif && reason === 'answer') !== m.evalue) m = mesurer(etat);
    const d = logique.decisionContinuation({ etat, reason, lignes: m.lignes, session, pause: m.pause, quotaCritique: m.quotaCritique });
    if (JSON.stringify(d.etat) !== JSON.stringify(etat)) ecrireEtat(d.etat);
    return d;
  });
}

const recap = ({ agent, session, maintenant = Date.now() }) => logique.texteRecap(lireEtat(), lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) });

// La commande d'un appel d'outil, comme la garde de sécurité la lit : command (Claude Code, Codex), cmd (exec_command de Codex), script
// ou input (le premier qui est un texte non vide). Une commande donnée en tableau n'est pas soumise à la garde par la Nuit.
function commandeDe(entreeOutil) {
  if (!objet(entreeOutil)) return null;
  for (const cle of ['command', 'cmd', 'script', 'input']) {
    if (typeof entreeOutil[cle] === 'string' && entreeOutil[cle].trim() !== '') return entreeOutil[cle];
  }
  return null;
}

// Le nom que la garde attend après --agent : celui que le dépôt connaît (claude, codex, deepseek_H), retrouvé depuis la clé d'état.
const agentDeLaGarde = agent => AGENTS.find(a => cleAgent(a) === cleDe(agent));

// Ce que dit la garde de sécurité de cet appel d'outil (sa sortie JSON), ou null si elle est introuvable, trop lente, plantée ou muette.
// Son verdict dépend de l'agent (Claude Code : demande d'accord ; les autres : refus sauf ordre de l'utilisateur) : il lui est donné.
function executerGarde(entree, agent) {
  const nom = agentDeLaGarde(agent);
  const r = spawnSync(process.execPath, [process.env.NUIT_GARDE || path.join(__dirname, '..', 'gardes', 'securite.js'), ...(nom === undefined ? [] : ['--agent', nom])], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session }),
    encoding: 'utf8',
    timeout: Number(process.env.NUIT_GARDE_DELAI_MS) || DELAI_GARDE_MS,
    windowsHide: true,
  });
  if (r.error) return null;
  try { return JSON.parse(r.stdout); } catch (_) { return null; } // une sortie vide ou qui n'est pas du JSON : le garde n'a rien dit
}

// Un appel d'outil qui exécute une commande : hors nuit, ou sans commande, le garde n'est même pas lancé.
function refuserCommande(ctx, entree) {
  const commande = commandeDe(entree.tool_input);
  if (commande === null || !nuitActive(ctx)) return { refuser: false };
  return refuserGarde({ ...ctx, sortie: executerGarde(entree, ctx.agent), commande, attestees: entree.autorisees });
}

// Les opérations que les hooks demandent au noyau, en JSON (adaptateur de Claude Code : `cockpit.js nuit-hook <opération>` ; Codex : appel direct).
// question : { agent, session, tool_input } ; garde : { agent, session, tool_name, tool_input, cwd, autorisees? } (autorisees : [{ id, empreinte }],
// les autorisations que l'utilisateur a données lui-même dans l'adaptateur, gardées dans la mémoire du moteur) ; continuer : { agent, session, reason, chemin? } ;
// activite : { agent, session } ; commande : { agent, session, args } (la commande /nuit, rend { message, effet, reponse?, prompt? } ou { erreur }).
// `maintenant` (ms) est facultatif. Une entrée invalide ou une panne rend { erreur } : le hook laisse passer.
function executerHook(operation, entree) {
  try {
    if (!objet(entree) || !agentValide(entree.agent) || typeof entree.session !== 'string' || entree.session === '') return { erreur: 'entrée invalide' };
    const ctx = { agent: entree.agent, session: entree.session, maintenant: Number.isFinite(entree.maintenant) ? entree.maintenant : Date.now() };
    switch (operation) {
      case 'question': return refuserQuestion({ ...ctx, entreeOutil: entree.tool_input });
      case 'garde': return refuserCommande(ctx, entree);
      case 'continuer': return continuer({ ...ctx, reason: entree.reason, chemin: typeof entree.chemin === 'string' ? entree.chemin : undefined });
      case 'activite': return noterActivite(ctx);
      case 'commande': return appliquerCommande(typeof entree.args === 'string' ? entree.args : '', ctx);
      default: return { erreur: `opération inconnue : ${operation}` };
    }
  } catch (e) {
    return { erreur: message(e) };
  }
}

module.exports = { empreinteCommande, agentValide, lireEtat, ecrireEtat, lireBoite, ecrireBoite, lireArchive, reponsesALivrer, lignesDe, appliquerCommande, noterActivite, nuitActive, refuserQuestion, refuserGarde, continuer, recap, executerHook };
