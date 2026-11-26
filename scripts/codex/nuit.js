#!/usr/bin/env node
'use strict';
// nuit.js : adaptateur CODEX de la Nuit (l'utilisateur est absent, ou a dit /nuit : ses questions bloquantes vont en boîte, le
// travail continue sur les lignes ouvertes de la conversation, et un récap l'attend au réveil).
// Le MÊME fichier sert tous les agents du dépôt qui lisent les hooks de Codex ; l'agent est donné par --agent (codex | deepseek_H) dans
// hooks.json. Noyau : ../lib/nuit-core.js (état : COCKPIT_DIR/nuit.json, boîte : COCKPIT_DIR/nuit-boite.json).
//
// Trois événements :
//   PreToolUse sur l'outil de questions (request_user_input_async, relevé dans les rollouts réels) : pendant la nuit, la question est
//   refusée, mise en boîte, et le modèle reçoit le refus avec la marche à suivre. Les sous-agents sont soumis à la même règle.
//   Stop (fin du tour du modèle) : un hook ne peut pas lancer de tour, il peut seulement faire continuer le modèle. Pendant la nuit, si une
//   ligne ouverte de CETTE conversation reste, il lui ordonne de continuer avec la suivante, sauf pause du Régulateur, quota critique, plafond
//   de tours ou ligne qui n'avance pas. Une seule continuation par message de l'utilisateur (stop_hook_active), comme le Régulateur : la nuit
//   enchaîne donc un tour de plus par message tant que Codex ne rend pas la main (limite de Codex).
//   UserPromptSubmit (message de l'utilisateur) : date son activité ; s'il met fin à une nuit, le récap est donné au modèle en contexte.
// Sorties : JSON STRICT conforme au schéma embarqué de codex-cli 0.155 (un champ en trop invalide toute la sortie) :
//   PreToolUse       : {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
//   Stop             : {"decision":"block","reason":"..."}
//   UserPromptSubmit : {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
// Tout le reste, ou rien à dire : sortie vide. Toute erreur interne : silence et exit 0 (la Nuit ne bloque jamais sur une panne de son propre réglage).

const nuit = require('../lib/nuit-core.js');

const refus = raison => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });

function agentDesArguments(argv) {
  const i = argv.indexOf('--agent');
  const a = i >= 0 ? argv[i + 1] : undefined;
  return nuit.agentValide(a) ? a : null;
}

function surQuestion(entree, agent) {
  if (typeof entree.tool_name !== 'string' || !/request_user_input(_async)?$/.test(entree.tool_name)) return null;
  const r = nuit.refuserQuestion({ agent, session: entree.session_id, entreeOutil: entree.tool_input });
  return r.refuser ? refus(r.texte) : null;
}

function surStop(entree, agent) {
  if (entree.stop_hook_active === true || entree.agent_id || entree.agent_type) return null;
  const d = nuit.continuer({ agent, session: entree.session_id, reason: 'answer', chemin: typeof entree.transcript_path === 'string' ? entree.transcript_path : undefined });
  return d.continuer ? { decision: 'block', reason: d.texte } : null;
}

function surMessage(entree, agent) {
  if (entree.agent_id || entree.agent_type) return null;
  const r = nuit.noterActivite({ agent, session: entree.session_id });
  return r.reveil ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.recap } } : null;
}

function executer(texte, agent) {
  let entree;
  try { entree = JSON.parse(texte); } catch (_) { return null; }
  if (!entree) return null;
  if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;
  switch (entree.hook_event_name) {
    case 'PreToolUse': return surQuestion(entree, agent);
    case 'Stop': return surStop(entree, agent);
    case 'UserPromptSubmit': return surMessage(entree, agent);
    default: return null;
  }
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
