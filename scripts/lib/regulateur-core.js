'use strict';
/**
 * Entrées-sorties du Régulateur d'agents : la politique (plafond d'agents en parallèle, pause, relance des échoués) vit
 * dans COCKPIT_DIR/politique-agents.json, lue par les adaptateurs de Claude Code et de Codex et par le Cockpit.
 * La logique (décision, commande /plafond, rappel) est dans regulateur-logique.mjs.
 * (« /agents » est une commande intégrée de Claude Code : le moteur refuse de l'enregistrer, d'où le nom /plafond.)
 *
 * La file d'attente (un agent refusé par le plafond attend son tour) vit dans COCKPIT_DIR/file-agents.json, lue et écrite par les
 * adaptateurs et par le Cockpit ; sa logique est dans file-logique.mjs. Chaque opération lit, modifie, puis écrit
 * seulement si l'état change ; les mutations partagent un verrou inter-processus et une écriture atomique (transaction.js).
 *
 * La file n'accepte que des clés d'agent (minuscules, chiffres et tirets : agents-noms.js). Un nom d'agent du dépôt qui n'a pas cette
 * forme (deepseek_H) est converti à l'entrée de chaque fonction ; la liste de travail, elle, le connaît sous son nom.
 *
 * API : lirePolitique, ecrirePolitique, appliquerCommande, etatAgents, echouesRecents ; file : lireFile, ecrireFile, mettreEnFile, purgerFile, entreesLancables,
 * ordonner, retirerReconnue, viderFile, resumeFile ; relances : relancesFaites, peutRelancer, compterRelance, oublierRelances ;
 * réservations (un lancement en cours n'est pas proposé deux fois) : reserverReconnue, acquitter.
 */

const path = require('node:path');
const cockpit = require('./cockpit-core.js');
const logique = require('./regulateur-logique.mjs');
const file = require('./file-logique.mjs');
const { avecVerrou, ecrireAtomique } = require('./transaction.js');
const { cleAgent, nomsListe } = require('./agents-noms.js');

const fichier = () => path.join(cockpit.racine(), 'politique-agents.json');
const fichierFile = () => path.join(cockpit.racine(), 'file-agents.json');

// Un nom d'agent du dépôt (deepseek_H) devient sa clé d'état (deepseek-h) ; tout autre nom est laissé tel quel, et la logique de la file
// le refuse s'il n'a pas la forme d'une clé.
const cleEtat = agent => cleAgent(agent) ?? agent;

// Les projets de la liste de travail pour cet agent, [[projet, résumé]] : le nom du dépôt et sa clé d'état sont tous deux cherchés.
function projetsDe(agent, maintenant) {
  const noms = nomsListe(agent);
  const { agents } = cockpit.resumeLedger({ agents: noms, maintenant });
  return noms.flatMap(nom => Object.entries(agents[nom] || {}));
}

function lirePolitique() {
  return logique.normaliserPolitique(cockpit.lireJson(fichier(), null));
}

function ecrirePolitique(politique) {
  cockpit.ecrireJson(fichier(), { ...logique.normaliserPolitique(politique), maj: new Date().toISOString() });
}

const lireFile = () => file.normaliserEtat(cockpit.lireJson(fichierFile(), null));

function ecrireFile(etat) {
  cockpit.ecrireJson(fichierFile(), { ...file.normaliserEtat(etat), maj: new Date().toISOString() });
}

// N'écrit que si l'état change : une lecture ou une opération sans effet ne touche pas au fichier.
function enregistrer(avant, apres) {
  if (JSON.stringify(avant) !== JSON.stringify(apres)) ecrireFile(apres);
}

// Met une demande en file : { entree, position, total, deja } ou { refus }. Les entrées de plus de six heures sont retirées au passage.
function mettreEnFile(brute) {
  const demande = { ...brute, agent: cleEtat(brute.agent) };
  const avant = lireFile();
  const purgee = file.purger(avant, demande.maintenant).etat;
  const r = file.mettreEnFile(purgee, demande);
  enregistrer(avant, r.etat ?? purgee);
  if (r.refus) return { refus: r.refus };
  return { entree: r.entree, position: r.position, total: file.enAttente(r.etat, demande.agent, demande.session).length, deja: r.deja };
}

// Retire les entrées de plus de six heures (une file oubliée ne lance rien le lendemain) ; rend le nombre retiré. N'écrit que s'il y en a.
function purgerFile(maintenant) {
  const avant = lireFile();
  const { etat, retirees } = file.purger(avant, maintenant);
  if (retirees > 0) ecrireFile(etat);
  return retirees;
}

function ordonner(ids, maintenant) {
  const avant = lireFile();
  enregistrer(avant, file.ordonner(avant, ids, maintenant));
}

// Le modèle vient de lancer ce qu'on lui avait demandé : l'entrée de même demande quitte la file. Rend vrai si elle existait.
function retirerReconnue(agent, session, demande) {
  const avant = lireFile();
  const entree = file.reconnaitre(avant, cleEtat(agent), session, demande);
  if (entree === null) return false;
  ecrireFile(file.retirer(avant, entree.id));
  return true;
}

// Vide la file (tous, ou seulement cet agent, ou cet agent dans cette session) ; rend le nombre d'entrées retirées.
function viderFile(agent = null, session = null) {
  const avant = lireFile();
  const { etat, retirees } = file.vider(avant, cleEtat(agent), session);
  if (retirees > 0) ecrireFile(etat);
  return retirees;
}

const resumeFile = (agent = null) => file.resume(lireFile(), cleEtat(agent));

const relancesFaites = cle => file.relancesFaites(lireFile(), cle);
const peutRelancer = cle => file.peutRelancer(lireFile(), cle);

function compterRelance(cle) {
  const avant = lireFile();
  enregistrer(avant, file.compterRelance(avant, cle));
}

function oublierRelances(cle) {
  const avant = lireFile();
  enregistrer(avant, file.oublierRelances(avant, cle));
}

// `/plafond <args>` : rend { message, politique } ou { erreur }. N'écrit que si la politique change. `file vider` vide la file de la
// portée donnée ({ agent, session }, l'un ou l'autre optionnel ; sans portée, celle de tous) et dit combien d'agents ont été retirés.
function appliquerCommande(args, occupes, portee) {
  const avant = lirePolitique();
  const r = logique.analyserCommande(args, avant, occupes);
  if (r.erreur) return { erreur: r.erreur };
  if (JSON.stringify(r.politique) !== JSON.stringify(avant)) ecrirePolitique(r.politique);
  if (r.viderFile) {
    const p = portee ?? {};
    return { message: file.texteVidee(viderFile(p.agent ?? null, p.session ?? null)), politique: r.politique };
  }
  return { message: r.message, politique: r.politique };
}

// Codex n'a pas de liste d'agents du moteur : les agents en cours d'un fil se lisent dans le ledger (lignes [agent] posées
// au démarrage de chaque sous-agent, de ce fil, de cet agent principal). Seuls les agents « en cours » récents tiennent un
// créneau : le noyau écarte comme obsolètes (zombies, fin jamais reçue) ceux qui n'ont pas bougé depuis plus de trois heures
// ou n'ont pas de date lisible (cockpit.AGE_MAX_EN_COURS_MS, défini une seule fois).
function etatAgents({ agent, session, maintenant = Date.now() }) {
  const projets = projetsDe(agent, maintenant).map(([, p]) => p);
  let occupes = 0;
  const echoues = [];
  for (const p of projets) {
    for (const a of p.agents.enCours) if (a.session === session) occupes++;
    for (const a of p.agents.echoues) if (a.session === session) echoues.push(a.nom);
  }
  return { occupes, echoues };
}

// Les agents échoués de ce fil que le ledger garde depuis moins de ageMax (ms) : [{ nom, ligne, projet, maj }], le plus ancien d'abord.
// Un échoué sans date lisible, ou plus ancien, n'est pas relancé : le Régulateur ne fait pas d'archéologie dans le ledger.
function echouesRecents({ agent, session, maintenant = Date.now(), ageMax }) {
  if (!Number.isFinite(ageMax) || ageMax < 0) return [];
  const projets = projetsDe(agent);
  const out = [];
  for (const [projet, p] of projets) {
    for (const a of p.agents.echoues) {
      if (a.session === session && maintenant - Date.parse(a.maj) <= ageMax) out.push({ nom: a.nom, ligne: a.ligne, projet, maj: a.maj });
    }
  }
  return out.sort((x, y) => Date.parse(x.maj) - Date.parse(y.maj));
}

module.exports = {
  lirePolitique, ecrirePolitique, appliquerCommande, etatAgents, echouesRecents,
  lireFile, ecrireFile, mettreEnFile, purgerFile, ordonner, retirerReconnue, viderFile, resumeFile,
  relancesFaites, peutRelancer, compterRelance, oublierRelances,
};

// La lecture, la décision et l'écriture d'une mutation partagent le même verrou.
for (const nom of ['ecrireFile', 'mettreEnFile', 'purgerFile', 'ordonner', 'retirerReconnue', 'viderFile', 'compterRelance', 'oublierRelances', 'appliquerCommande']) {
  const operation = module.exports[nom];
  module.exports[nom] = (...args) => avecVerrou(fichierFile(), () => operation(...args));
}

// Réservations : l'adaptateur qui s'apprête à lancer une demande de la file la réserve (cinq minutes) pour qu'un autre processus ne la
// lance pas aussi ; l'acquittement libère la réservation et, si le lancement a réussi, retire la demande de la file. Une réservation que
// personne n'acquitte expire d'elle-même. entreesLancables ne propose pas les demandes réservées.
const reservationsFile = () => path.join(cockpit.racine(), 'reservations-agents.json');
function reservations() {
  const maintenant = Date.now();
  return Object.fromEntries(Object.entries(cockpit.lireJson(reservationsFile(), {})).filter(([, r]) => r && maintenant - r.ts < 5 * 60 * 1000));
}
function ecrireReservations(valeur) { ecrireAtomique(reservationsFile(), JSON.stringify(valeur)); }
module.exports.reserverReconnue = (agent, session, demande, jeton) => avecVerrou(fichierFile(), () => {
  const e = file.reconnaitre(lireFile(), cleEtat(agent), session, demande);
  if (!e) return;
  const r = reservations(); r[e.id] = { agent: e.agent, session, jeton, ts: Date.now() }; ecrireReservations(r);
});
module.exports.acquitter = (agent, session, demande, reussi, jeton) => avecVerrou(fichierFile(), () => {
  const e = file.reconnaitre(lireFile(), cleEtat(agent), session, demande);
  if (!e) return false;
  const r = reservations();
  if (!r[e.id] || r[e.id].jeton !== jeton) return false;
  delete r[e.id]; ecrireReservations(r);
  return reussi ? retirerReconnue(agent, session, demande) : false;
});
module.exports.entreesLancables = (agent, session, n, maintenant) => {
  const reservees = reservations();
  return file.prochaines(lireFile(), cleEtat(agent), session, file.MAX_FILE, maintenant).filter(e => !reservees[e.id]).slice(0, n);
};
