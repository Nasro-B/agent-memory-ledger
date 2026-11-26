#!/usr/bin/env node
'use strict';
// brancher.js : branche (ou retire) un composant du Cockpit dans le hooks.json d'un dossier de configuration de Codex.
//   node scripts/codex/brancher.js brancher --fichier <hooks.json> --agent <codex|deepseek_H> [--composant <nom>]
//   node scripts/codex/brancher.js retirer  --fichier <hooks.json> --agent <agent> [--composant <nom>]
//   node scripts/codex/brancher.js verifier --fichier <hooks.json> --agent <agent> [--composant <nom>]
// Composants : cockpit (par défaut) : SessionStart, UserPromptSubmit et PostCompact (le bloc est réinjecté après un
// compactage) ; regulateur : PreToolUse, limité par un matcher aux outils de lancement d'agent ; consignes : PreToolUse sans
// matcher (le nom de l'outil qui exécute une commande varie : l'adaptateur lit lui-même la commande et refuse les verrouillées) ;
// file : Stop (le même script que regulateur, sur la fin du tour : il ordonne au modèle de lancer le suivant de la file d'attente) ;
// nuit : PreToolUse, limité par un matcher à l'outil de questions (request_user_input) : pendant l'absence de l'utilisateur la question est refusée
// et mise en boîte ; nuit-tours : Stop (le modèle reçoit l'ordre de continuer avec la ligne suivante) et UserPromptSubmit (le message de
// l'utilisateur met fin à la nuit et donne le récap), le même script nuit.js que nuit ; cockpit-outils : PostToolUse, le même script que cockpit (le
// premier outil qui suit un compactage réinjecte le bloc) ; regulateur-resultat : PostToolUse, avec le même matcher et le même script que regulateur
// (le résultat d'un lancement acquitte la réservation de la demande de la file : sans lui, une demande lancée resterait en file).
// Ajoute un NOUVEAU groupe par événement, ne modifie jamais un groupe existant, sauvegarde le fichier une seule fois par
// composant (<fichier>.avant-agent-memory-ledger-<composant>) et conserve le BOM, la fin de ligne finale et le style des retours
// à la ligne. Les hooks ajoutés doivent ensuite être approuvés par l'utilisateur dans l'app Codex concernée. Chargé par require (installer-codex.js
// --cockpit), il exporte COMPOSANTS, brancher, retirer et verifier au lieu de lire la ligne de commande.

const fs = require('node:fs');
const { cleAgent } = require('../lib/agents-noms.js');

const DOSSIER = __dirname.replace(/\\/g, '/');
const COMPOSANTS = {
  cockpit: { script: 'cockpit.js', evenements: ['SessionStart', 'UserPromptSubmit', 'PostCompact'], matcher: null, timeout: 15, message: 'Cockpit : etat du travail' },
  regulateur: { script: 'regulateur.js', evenements: ['PreToolUse'], matcher: 'spawn_agent', timeout: 10, message: "Regulateur d'agents : plafond et pause" },
  consignes: { script: 'consignes.js', evenements: ['PreToolUse'], matcher: null, timeout: 10, message: 'Consignes en vigueur : commandes verrouillees' },
  file: { script: 'regulateur.js', evenements: ['Stop'], matcher: null, timeout: 10, message: "Regulateur d'agents : file d'attente" },
  nuit: { script: 'nuit.js', evenements: ['PreToolUse'], matcher: 'request_user_input', timeout: 10, message: 'Nuit : questions en boite' },
  'nuit-tours': { script: 'nuit.js', evenements: ['Stop', 'UserPromptSubmit'], matcher: null, timeout: 10, message: 'Nuit : enchainement et reveil' },
  'cockpit-outils': { script: 'cockpit.js', evenements: ['PostToolUse'], matcher: null, timeout: 15, message: 'Cockpit : etat du travail apres compactage' },
  'regulateur-resultat': { script: 'regulateur.js', evenements: ['PostToolUse'], matcher: 'spawn_agent', timeout: 10, message: "Regulateur d'agents : resultat du lancement" },
};

const commande = (c, agent) => `node "${DOSSIER}/${c.script}" --agent ${agent}`;
const groupe = (c, agent) => ({ ...(c.matcher ? { matcher: c.matcher } : {}), hooks: [{ type: 'command', command: commande(c, agent), timeout: c.timeout, statusMessage: c.message }] });
const porteLeHook = (g, c, agent) => !!g && Array.isArray(g.hooks) && g.hooks.some(h => h && h.command === commande(c, agent));

function erreur(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function argument(argv, nom) {
  const i = argv.indexOf(nom);
  return i >= 0 ? argv[i + 1] : undefined;
}

function ecrireAtomique(fichier, texte) {
  const tmp = `${fichier}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, texte);
  for (let essai = 0; ; essai++) {
    try { fs.renameSync(tmp, fichier); return; } catch (e) {
      if (essai >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch (_) { /* rien */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function lire(fichier) {
  let brut;
  try { brut = fs.readFileSync(fichier, 'utf8'); } catch (e) { throw new Error(`fichier illisible : ${fichier} (${e.code || e.message})`); }
  const bom = brut.startsWith('\uFEFF');
  const crlf = brut.includes('\r\n');
  const finDeLigne = /\n$/.test(brut);
  let objet;
  try { objet = JSON.parse(brut.replace(/^\uFEFF/, '')); } catch (e) { throw new Error(`JSON invalide : ${fichier} (${e.message})`); }
  if (!objet || typeof objet !== 'object' || !objet.hooks || typeof objet.hooks !== 'object' || Array.isArray(objet.hooks)) throw new Error(`pas de clé hooks dans ${fichier}`);
  return { brut, objet, bom, crlf, finDeLigne };
}

function serialiser({ objet, bom, crlf, finDeLigne }) {
  let texte = JSON.stringify(objet, null, 2);
  if (finDeLigne) texte += '\n';
  if (crlf) texte = texte.replace(/\n/g, '\r\n');
  return (bom ? '\uFEFF' : '') + texte;
}

function evenementsBranches(objet, c, agent) {
  return c.evenements.filter(e => Array.isArray(objet.hooks[e]) && objet.hooks[e].some(g => porteLeHook(g, c, agent)));
}

function enregistrer(fichier, etat, nom) {
  const apres = serialiser(etat);
  if (apres === etat.brut) return false;
  const sauvegarde = `${fichier}.avant-agent-memory-ledger-${nom}`;
  if (!fs.existsSync(sauvegarde)) fs.copyFileSync(fichier, sauvegarde);
  ecrireAtomique(fichier, apres);
  return true;
}

function brancher(fichier, agent, c, nom) {
  const etat = lire(fichier);
  const ajoutes = [];
  for (const e of c.evenements) {
    if (etat.objet.hooks[e] === undefined) etat.objet.hooks[e] = [];
    if (!Array.isArray(etat.objet.hooks[e])) throw new Error(`${e} n'est pas une liste dans ${fichier}`);
    if (etat.objet.hooks[e].some(g => porteLeHook(g, c, agent))) continue;
    etat.objet.hooks[e].push(groupe(c, agent));
    ajoutes.push(e);
  }
  if (!ajoutes.length) return 'déjà branché';
  enregistrer(fichier, etat, nom);
  return `branché : ${ajoutes.join(', ')}`;
}

function retirer(fichier, agent, c, nom) {
  const etat = lire(fichier);
  const retires = [];
  for (const e of c.evenements) {
    const groupes = etat.objet.hooks[e];
    if (!Array.isArray(groupes) || !groupes.some(g => porteLeHook(g, c, agent))) continue;
    const reste = groupes
      .map(g => (porteLeHook(g, c, agent) ? { ...g, hooks: g.hooks.filter(h => !(h && h.command === commande(c, agent))) } : g))
      .filter(g => !(Array.isArray(g.hooks) && g.hooks.length === 0));
    if (reste.length) etat.objet.hooks[e] = reste; else delete etat.objet.hooks[e];
    retires.push(e);
  }
  if (!retires.length) return 'pas branché';
  enregistrer(fichier, etat, nom);
  return `retiré : ${retires.join(', ')}`;
}

function verifier(fichier, agent, c) {
  const presents = evenementsBranches(lire(fichier).objet, c, agent);
  return presents.length ? `branché : ${presents.join(', ')}` : 'pas branché';
}

function principal(argv) {
  const [action] = argv;
  const actions = { brancher, retirer, verifier };
  if (!actions[action]) return erreur(`commande inconnue : ${action || '(aucune)'} (attendu : brancher, retirer, verifier)`);
  const fichier = argument(argv, '--fichier');
  const agent = argument(argv, '--agent');
  const nom = argument(argv, '--composant') ?? 'cockpit';
  if (!Object.prototype.hasOwnProperty.call(COMPOSANTS, nom)) return erreur(`composant inconnu : ${nom} (attendu : ${Object.keys(COMPOSANTS).join(', ')})`);
  if (!fichier) return erreur('--fichier requis');
  if (cleAgent(agent) === null) return erreur(`--agent invalide : ${JSON.stringify(agent)}`);
  try { process.stdout.write(`${actions[action](fichier, agent, COMPOSANTS[nom], nom)}\n`); } catch (e) { erreur(e.message); }
}

if (require.main === module) principal(process.argv.slice(2));
else module.exports = { COMPOSANTS, brancher, retirer, verifier };
