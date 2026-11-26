#!/usr/bin/env node
'use strict';
// consignes.js : adaptateur CODEX des Consignes en vigueur (refus des commandes et des lancements d'agents que le code sait reconnaître).
// Le MÊME fichier sert tous les agents du dépôt qui lisent les hooks de Codex ; la liste est commune (COCKPIT_DIR/consignes.json).
// Logique : ../lib/consignes-logique.mjs (verrous push, deploiement, rebuild, agent).
//
// Sortie : JSON STRICT conforme au schéma embarqué de codex-cli 0.155 (un champ en trop invalide toute la sortie) :
//   PreToolUse, quand un refus s'impose : {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
//   "permissionDecisionReason":"..."}}. Tout le reste, ou rien à refuser : sortie vide.
// Sans matcher dans hooks.json : le nom de l'outil qui exécute une commande varie (Bash, exec_command...), alors la commande
// se lit dans tool_input (command, cmd, script ou input, comme le fait la garde de sécurité de ce dépôt) ; apply_patch est exempté,
// son champ command porte le texte d'un patch, rien n'y est exécuté. L'outil de lancement d'agent est reconnu comme dans
// regulateur.js (nom terminé par spawn_agent). Sous-agents compris : un ordre permanent vaut pour tous.
// Rappel du texte des consignes : cockpit.js (SessionStart, UserPromptSubmit, réinjection après compactage).
// Toute erreur interne : silence et exit 0 (un fichier abîmé ne bloque jamais le travail).

const consignes = require('../lib/consignes-core.js');

const refus = raison => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });

// Une commande : un texte non vide, ou un tableau de mots (l'outil shell de Codex) joint par des espaces.
function texteCommande(valeur) {
  if (typeof valeur === 'string') return valeur.trim() === '' ? null : valeur;
  if (Array.isArray(valeur) && valeur.length > 0 && valeur.every(x => typeof x === 'string')) return valeur.join(' ');
  return null;
}

function commandeDe(entree) {
  if (entree.tool_name.toLowerCase() === 'apply_patch') return null;
  const ti = entree.tool_input;
  if (ti === null || typeof ti !== 'object') return null;
  for (const cle of ['command', 'cmd', 'script', 'input']) {
    const commande = texteCommande(ti[cle]);
    if (commande !== null) return commande;
  }
  return null;
}

function executer(texte) {
  let entree;
  try { entree = JSON.parse(texte); } catch (_) { return null; }
  if (!entree || typeof entree !== 'object' || entree.hook_event_name !== 'PreToolUse' || typeof entree.tool_name !== 'string') return null;
  if (/spawn_agent$/.test(entree.tool_name)) {
    const decision = consignes.decisionAgent();
    return decision.autorise ? null : refus(decision.raison);
  }
  const commande = commandeDe(entree);
  if (commande === null) return null;
  const decision = consignes.decisionCommande(commande);
  return decision.autorise ? null : refus(decision.raison);
}

if (require.main === module) {
  let donnees = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { donnees += c; });
  process.stdin.on('end', () => {
    try {
      const sortie = executer(donnees);
      if (sortie) process.stdout.write(JSON.stringify(sortie));
    } catch (_) { /* silence */ }
    process.exitCode = 0;
  });
} else {
  module.exports = { executer };
}
