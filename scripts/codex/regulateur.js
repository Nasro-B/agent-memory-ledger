#!/usr/bin/env node
'use strict';
// regulateur.js : adaptateur CODEX du Régulateur d'agents (plafond d'agents en parallèle, pause, file d'attente).
// Le MÊME fichier sert tous les agents du dépôt qui lisent les hooks de Codex ; l'agent est donné par --agent (codex | deepseek_H) dans
// hooks.json. Logique : ../lib/regulateur-logique.mjs et ../lib/file-logique.mjs. Politique : COCKPIT_DIR/politique-agents.json ;
// file : COCKPIT_DIR/file-agents.json.
//
// Deux événements :
//   PreToolUse sur l'outil de lancement d'agent (`collaborationspawn_agent`, relevé dans la capture réelle). Raisons de refuser : le quota
//   (Garde-quota : une fenêtre au seuil critique, lue dans le rollout du fil) et la politique (Régulateur : plafond atteint ou pause). Le
//   quota passe en premier. Au plafond, avec la file activée, la demande (ses arguments, tels que le hook les a vus) est mise en file et le
//   refus le dit. Une demande autorisee est reservee ; seul le succes connu de PostToolUse la retire.
//   Stop (fin du tour du modèle) : un hook ne peut pas lancer d'agent, il peut seulement faire continuer le modèle. Avec la file activée, si
//   un créneau est libre, il donne au modèle l'ordre de lancer le suivant de la file (arguments exacts) et de relancer les agents échoués
//   (relance activée, deux fois au plus chacun). Une seule continuation par message de l'utilisateur (stop_hook_active).
// Sorties : JSON STRICT conforme au schéma embarqué de codex-cli 0.155 (un champ en trop invalide toute la sortie) :
//   PreToolUse : {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
//   Stop       : {"decision":"block","reason":"..."} (le modèle continue avec la raison). Tout le reste, ou rien à dire : sortie vide.
// Codex n'a pas de liste d'agents du moteur : les agents en cours du fil se lisent dans le ledger (regulateur-core.js).
// Toute erreur interne : silence et exit 0 (le Régulateur ne bloque jamais sur une panne de son propre réglage).

const regulateur = require('../lib/regulateur-core.js');
const logique = require('../lib/regulateur-logique.mjs');
const file = require('../lib/file-logique.mjs');
const quota = require('../lib/quota-core.js');
const { cleAgent } = require('../lib/agents-noms.js');

const HEURE = 60 * 60 * 1000;
const AGE_MAX_ECHEC_MS = 2 * HEURE; // un agent échoué depuis plus longtemps n'est pas relancé : pas d'archéologie dans le ledger
const SANS_PLAFOND = Number.MAX_SAFE_INTEGER;

const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// L'agent de --agent, converti en clé d'état (deepseek_H devient deepseek-h) ; null quand ce n'est pas un agent valide.
function agentDesArguments(argv) {
  const i = argv.indexOf('--agent');
  return cleAgent(i >= 0 ? argv[i + 1] : undefined);
}

// Garde-quota : au seuil critique d'une fenêtre, aucun nouvel agent (lit le rollout du fil, sinon la dernière mesure gardée).
// Une panne de la mesure ne bloque jamais un lancement.
function decisionQuota(agent, chemin) {
  try { return quota.decisionAgentCodex({ agent, chemin }); } catch (_) { return { autorise: true }; }
}

const refus = raison => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });

// Ce que le lancement dit de lui-même, pour la description de l'entrée de file : son message, quand il en a un (aucun champ n'est supposé ;
// la file nettoie la description et ignore ce qui n'est pas un texte).
const descriptionDe = arguments_ => arguments_.message;

// Au plafond avec la file activée : la demande est mise en file, et le refus dit où elle en est. Si elle ne peut pas l'être (arguments
// inutilisables, file pleine, écriture impossible), le refus le dit : on ne promet jamais une mise en file qui n'a pas eu lieu.
function refusEnFile(agent, session, arguments_) {
  if (!estObjet(arguments_)) return file.texteRefusSansFile('invalide');
  try {
    const r = regulateur.mettreEnFile({ agent, session, description: descriptionDe(arguments_), demande: arguments_, maintenant: Date.now() });
    if (r.refus !== undefined) return file.texteRefusSansFile(r.refus);
    return file.texteRefus({ position: r.position, total: r.total, mode: 'modele' });
  } catch (_) {
    return file.texteRefusSansFile('ecriture');
  }
}

// Un lancement autorisé : si la file est activée et que le modèle vient de lancer ce qu'on lui avait demandé (mêmes arguments), la
// demande quitte la file. Une panne du retrait remonte jusqu'au silence du processus (sortie vide, code 0) : elle ne bloque pas le
// lancement, et la file garde l'entrée, qui redeviendra lançable.
function surLancement(entree, agent) {
  if (typeof entree.tool_name !== 'string' || !/spawn_agent$/.test(entree.tool_name)) return null;
  const parQuota = decisionQuota(agent, entree.transcript_path);
  if (!parQuota.autorise) return refus(parQuota.raison);
  const politique = regulateur.lirePolitique();
  if (!politique.pause && politique.max === null) {
    if (politique.file) regulateur.reserverReconnue(agent, entree.session_id, entree.tool_input, entree.tool_use_id);
    return null;
  }
  const decision = logique.decisionLancement(politique, regulateur.etatAgents({ agent, session: entree.session_id }).occupes);
  if (decision.autorise) {
    if (politique.file) regulateur.reserverReconnue(agent, entree.session_id, entree.tool_input, entree.tool_use_id);
    return null;
  }
  return refus(decision.mettreEnFile ? refusEnFile(agent, entree.session_id, entree.tool_input) : decision.raison);
}

const cleRelance = (agent, session, nom) => `${agent}:${session.slice(0, 8)}:${nom}`;

function surStop(entree, agent) {
  if (entree.stop_hook_active === true) return null;
  const politique = regulateur.lirePolitique();
  if (!politique.file || politique.pause) return null;
  if (!decisionQuota(agent, entree.transcript_path).autorise) return null;
  const session = entree.session_id;
  const maintenant = Date.now();
  regulateur.purgerFile(maintenant);
  const sansPlafond = politique.max === null;
  const libres = sansPlafond ? SANS_PLAFOND : politique.max - regulateur.etatAgents({ agent, session, maintenant }).occupes;
  if (libres < 1) return null;
  const echoues = politique.relance
    ? regulateur.echouesRecents({ agent, session, maintenant, ageMax: AGE_MAX_ECHEC_MS })
      .filter(x => regulateur.peutRelancer(cleRelance(agent, session, x.nom)))
      .slice(0, Math.min(libres, file.MAX_PAR_ORDRE))
    : [];
  const reste = libres - echoues.length;
  const choisies = file.choisirPourOrdre(regulateur.entreesLancables(agent, session, file.MAX_FILE, maintenant), reste);
  const textes = [
    file.texteRelance(echoues.map(x => ({ nom: x.nom, essai: regulateur.relancesFaites(cleRelance(agent, session, x.nom)) + 1 }))),
    file.texteOrdre(choisies, sansPlafond ? null : reste),
  ].filter(t => t !== null);
  if (textes.length === 0) return null;
  for (const x of echoues) regulateur.compterRelance(cleRelance(agent, session, x.nom));
  regulateur.ordonner(choisies.map(e => e.id), maintenant);
  return { decision: 'block', reason: textes.join('\n\n') };
}

function executer(texte, agent) {
  let entree;
  try { entree = JSON.parse(texte); } catch (_) { return null; }
  if (!entree) return null;
  if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;
  if (entree.hook_event_name === 'Stop') return surStop(entree, agent);
  if (['PostToolUse', 'PostToolUseFailure'].includes(entree.hook_event_name) && /spawn_agent$/.test(entree.tool_name || '')) {
    let response = entree.tool_response;
    if (typeof response === 'string') { try { response = JSON.parse(response); } catch (_) { response = null; } }
    if (response && typeof response.output === 'string') { try { response = { ...response, ...JSON.parse(response.output) }; } catch (_) {} }
    const success = entree.hook_event_name === 'PostToolUse' && response && !response.error && !response.isError && (response.exit_code === undefined || response.exit_code === 0) && typeof response.agent_id === 'string' && response.agent_id.length > 0;
    regulateur.acquitter(agent, entree.session_id, entree.tool_input, Boolean(success), entree.tool_use_id);
    return null;
  }
  if (entree.hook_event_name !== 'PreToolUse') return null;
  return surLancement(entree, agent);
}

if (require.main === module) {
  const agent = agentDesArguments(process.argv.slice(2));
  let donnees = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { donnees += c; });
  process.stdin.on('end', () => {
    try {
      const sortie = executer(donnees, agent);
      if (sortie) process.stdout.write(JSON.stringify(sortie));
    } catch (_) { /* silence */ }
    process.exitCode = 0;
  });
} else {
  module.exports = { executer };
}
