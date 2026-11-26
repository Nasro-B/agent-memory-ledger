#!/usr/bin/env node
'use strict';
// cockpit.js : adaptateur CODEX du Cockpit (l'état du travail, injecté dans le contexte de l'agent).
// Le MÊME fichier sert tous les agents du dépôt qui lisent les hooks de Codex ; l'agent est donné par --agent (codex | deepseek_H) dans
// hooks.json. Noyau : ../lib/cockpit-core.js. Lecture seule : aucune action sur un dépôt, un plan ou le fichier contexte.
//
// Sorties : JSON STRICT conforme au schéma embarqué de codex-cli 0.155 (un champ en trop invalide toute la sortie) :
//   SessionStart, UserPromptSubmit : {"hookSpecificOutput":{"hookEventName":"<Evt>","additionalContext":"COCKPIT ..."}}
//   Tout autre événement, ou rien à dire : sortie vide.
// SessionStart injecte toujours. UserPromptSubmit n'injecte que si le bloc a changé (hors horodatage) ET si la dernière
// injection de ce fil date de plus de 10 minutes. Une nouvelle valeur quota n'attend pas ce delai.
// PostCompact (le schéma Codex interdit d'y injecter) : sortie vide, mais l'état d'injection de ce fil est effacé, donc le
// message suivant réinjecte le bloc que le compactage a pu faire oublier. PostToolUse : le premier outil après ce
// compactage le réinjecte aussi (marque inj-<agent>-<session>.compacte), une seule fois ; sans marque, sortie vide.
// Après le bloc, une ligne de rappel du Régulateur d'agents (plafond, pause, relance) quand sa politique n'est pas inerte, puis
// les lignes du Garde-quota (alerte d'attention ou critique, consigne de relais au seuil critique, relance après la remise à zéro).
// Sous-agent (agent_id ou agent_type présent) : jamais.
// La mesure git (lente : disque dur) est lancée en arrière-plan quand elle manque ou a plus de 10 minutes, et n'est
// jamais attendue : le bloc suivant la contiendra.
// Toute erreur interne : silence et exit 0.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const core = require('../lib/cockpit-core.js');
const { cleAgent } = require('../lib/agents-noms.js');

// Après un outil (PostToolUse) : le bloc et les consignes ne reviennent que si un
// compactage de CE fil a laissé sa marque (posée au PostCompact). Sans marque, sortie immédiate, avant de charger le reste :
// ce script tourne après chaque outil de Codex.
const marqueCompactage = (agent, session) => path.join(core.racine(), `inj-${agent}-${session}.compacte`);
let ENTREE_BRUTE = null;
if (require.main === module) {
  try { ENTREE_BRUTE = fs.readFileSync(0, 'utf8'); } catch (_) { ENTREE_BRUTE = ''; }
  if (/"hook_event_name"\s*:\s*"PostToolUse"/.test(ENTREE_BRUTE)) {
    let sansMarque = true;
    try {
      const e = JSON.parse(ENTREE_BRUTE);
      const a = agentDesArguments(process.argv.slice(2));
      const s = sessionSure(e && e.session_id);
      sansMarque = !e || e.agent_id || e.agent_type || !a || !s || !fs.existsSync(marqueCompactage(a, s));
    } catch (_) { sansMarque = true; }
    if (sansMarque) process.exit(0);
  }
}

const regulateur = require('../lib/regulateur-core.js');
const logique = require('../lib/regulateur-logique.mjs');
const quota = require('../lib/quota-core.js');
const consignes = require('../lib/consignes-core.js');

const DELAI_INJECTION_MS = 10 * 60 * 1000;
const LEVEE_CONSIGNES = 'CONSIGNES EN VIGUEUR DE L\'UTILISATEUR : aucune. Les consignes données avant sont levées.';
const AGE_GIT_MAX_S = 10 * 60;
const PURGE_MS = 3 * 24 * 3600 * 1000;
const ENTETE = /^COCKPIT \d{4}-\d{2}-\d{2} \d{2}:\d{2} : /;

function empreinte(bloc) {
  return crypto.createHash('sha1').update(String(bloc).replace(ENTETE, '')).digest('hex');
}

// L'agent de --agent, converti en clé d'état (deepseek_H devient deepseek-h) ; null quand ce n'est pas un agent valide.
function agentDesArguments(argv) {
  const i = argv.indexOf('--agent');
  return cleAgent(i >= 0 ? argv[i + 1] : undefined);
}

function sessionSure(id) {
  return typeof id === 'string' && id ? id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : null;
}

// Les états d'injection s'accumulent (un par fil) : ceux de plus de trois jours partent, et seulement eux.
function purger(dossier) {
  let noms;
  try { noms = fs.readdirSync(dossier); } catch (_) { return; }
  const limite = Date.now() - PURGE_MS;
  for (const nom of noms) {
    if (!/^inj-.*\.(?:json|compacte)$/.test(nom)) continue;
    const p = path.join(dossier, nom);
    try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); } catch (_) { /* déjà parti */ }
  }
}

function mesurerGitEnArriere(config) {
  if (!config.worktrees.length) return;
  const g = core.lireGitEtat();
  if (g && g.ageS !== null && g.ageS <= AGE_GIT_MAX_S) return;
  try {
    spawn(process.execPath, [path.join(__dirname, '..', 'cockpit.js'), 'rafraichir-git'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  } catch (_) { /* la prochaine injection retentera */ }
}

// Le rappel du Régulateur d'agents (plafond, pause, relance) pour CE fil : null quand la politique est inerte ; une panne
// du comptage des agents le retire, jamais le bloc du Cockpit.
function rappelRegulateur(agent, session) {
  try {
    const politique = regulateur.lirePolitique();
    if (!politique.pause && politique.max === null && !politique.relance) return null;
    return logique.rappel(politique, regulateur.etatAgents({ agent, session }));
  } catch (_) {
    return null;
  }
}

// Le quota de ce Codex (Garde-quota) : met la mesure du Cockpit à jour d'après le rollout du fil (ou garde la dernière) et rend
// les lignes à dire (alertes, consigne au seuil critique, relance après la remise à zéro). null sans mesure ou en cas de panne :
// une panne du quota retire ses lignes, jamais le bloc du Cockpit.
function quotaDeCodex(agent, chemin) {
  try {
    const fenetres = quota.fenetresCourantes({ agent, chemin });
    return fenetres.length ? quota.suivreCodex({ agent, fenetres }) : null;
  } catch (_) {
    return null;
  }
}

// Les consignes en vigueur de l'utilisateur (ordres permanents, avec leurs verrous) : null sans consigne active, fichier abîmé ou panne.
// Une panne des consignes retire leur texte, jamais le bloc du Cockpit.
function texteConsignes() {
  try {
    return consignes.texteInjection();
  } catch (_) {
    return null;
  }
}

function executer(texte, agent) {
  let entree;
  try { entree = JSON.parse(texte); } catch (_) { return null; }
  if (!entree) return null;
  const evenement = entree.hook_event_name;
  if (evenement !== 'SessionStart' && evenement !== 'UserPromptSubmit' && evenement !== 'PostCompact' && evenement !== 'PostToolUse') return null;
  if (entree.agent_id || entree.agent_type) return null;
  const session = sessionSure(entree.session_id);
  if (!agent || !session) return null;
  const fichier = path.join(core.racine(), `inj-${agent}-${session}.json`);
  const marque = marqueCompactage(agent, session);
  if (evenement === 'PostCompact') {
    // Codex interdit d'injecter ici (schéma) : on oublie l'injection de ce fil, le message suivant réinjecte le bloc.
    // Une marque est laissée (seulement si ce fil avait déjà reçu le bloc) : le premier outil suivant le réinjecte aussi.
    let oublie = false;
    try { fs.unlinkSync(fichier); oublie = true; } catch (_) { /* rien à oublier */ }
    if (oublie) { try { fs.writeFileSync(marque, ''); } catch (_) { /* le message suivant réinjectera */ } }
    return null;
  }
  if (evenement === 'PostToolUse') {
    // Un seul processus prend la marque (suppression atomique), même si dix outils finissent en même temps.
    try { fs.unlinkSync(marque); } catch (_) { return null; }
  } else {
    try { fs.unlinkSync(marque); } catch (_) { /* pas de compactage en attente */ }
  }
  const config = core.lireConfig();
  if (evenement === 'SessionStart') purger(core.racine());
  mesurerGitEnArriere(config);
  quota.rafraichirNatif(agent);
  const parQuota = quotaDeCodex(agent, entree.transcript_path); // avant le bloc : il montre la mesure du moment
  const instantane = core.instantane(config);
  const bloc = core.blocCockpit(instantane);
  const empQuota = empreinte(JSON.stringify(Object.fromEntries(Object.entries(instantane.quota).map(([nom, mesure]) => [nom, mesure && { fenetres: mesure.fenetres, source: mesure.source }]))));
  const rappel = rappelRegulateur(agent, entree.session_id);
  const parConsignes = texteConsignes();
  const empConsignes = parConsignes === null ? null : empreinte(parConsignes);
  const avant = core.lireJson(fichier, null); // l'état de la dernière injection de ce fil (null au premier message)
  const consignesAvant = avant && typeof avant.consignes === 'string' ? avant.consignes : null; // un état d'avant les consignes n'en portait aucune
  // Toutes les consignes levées depuis la dernière injection : une ligne le dit une fois, sinon l'agent garde l'ancienne liste en tête.
  const levee = parConsignes === null && consignesAvant !== null;
  const contexte = [bloc, rappel, ...(parQuota ? parQuota.lignes : []), parConsignes].filter(Boolean).join('\n');
  const emp = empreinte(contexte);
  if (evenement === 'UserPromptSubmit') {
    if (avant && avant.empreinte === emp) return null;
    // Une alerte critique, une remise à zéro ou un changement des consignes n'attend pas : dit tout de suite, le reste au plus tôt dix minutes après.
    if (avant && Date.now() - avant.ts < DELAI_INJECTION_MS && !(parQuota && parQuota.urgent) && empConsignes === consignesAvant && empQuota === avant.quota) return null;
  }
  if (parQuota) parQuota.persister(); // les annonces ne sont mémorisées que lorsqu'elles sont réellement remises
  core.ecrireJson(fichier, { empreinte: emp, ts: Date.now(), consignes: empConsignes, quota: empQuota });
  return { hookSpecificOutput: { hookEventName: evenement, additionalContext: levee ? `${contexte}\n${LEVEE_CONSIGNES}` : contexte } };
}

if (require.main === module) {
  const agent = agentDesArguments(process.argv.slice(2));
  try {
    const sortie = executer(ENTREE_BRUTE || '', agent); // l'entrée standard a été lue en tête de fichier
    if (sortie) process.stdout.write(JSON.stringify(sortie));
  } catch (_) { /* silence */ }
  process.exitCode = 0;
} else {
  module.exports = { empreinte, executer };
}
