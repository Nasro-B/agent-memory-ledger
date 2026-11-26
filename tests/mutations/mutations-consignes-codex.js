'use strict';
// Preuve par mutation du banc consignes-codex.test.js (adaptateur Codex des Consignes en vigueur).
//   node tests/mutations/mutations-consignes-codex.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-consignes-codex.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-consignes-codex.js --liste         affiche les noms
//   node tests/mutations/mutations-consignes-codex.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutations équivalentes écartées (la sortie observable ne change pas) : les gardes qui ne servent qu'à éviter une exception
// (entrée qui n'est pas un objet, tool_input nul, tool_name qui n'est pas un texte, commande nulle : l'exception est avalée par
// le silence du hook), et le try/catch du point d'entrée (aucune entrée ne lève hors du JSON.parse, déjà protégé).

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const SPAWN = 'const decision = consignes.decisionAgent();\n    return decision.autorise ? null : refus(decision.raison);';
const CMD = 'const decision = consignes.decisionCommande(commande);\n  return decision.autorise ? null : refus(decision.raison);';

const MUTATIONS = [
  // forme de la sortie
  { nom: 'cod-refus-evenement', suite: 'refus des commandes', de: "hookEventName: 'PreToolUse', permissionDecision", vers: "hookEventName: 'PostToolUse', permissionDecision" },
  { nom: 'cod-refus-decision', suite: 'refus des commandes', de: "permissionDecision: 'deny'", vers: "permissionDecision: 'ask'" },
  { nom: 'cod-refus-raison', suite: 'refus des commandes', de: 'permissionDecisionReason: raison', vers: "permissionDecisionReason: 'refusé'" },
  { nom: 'cod-refus-champ-en-trop', suite: 'refus des commandes', de: '({ hookSpecificOutput: {', vers: '({ continue: false, hookSpecificOutput: {' },
  { nom: 'cod-sortie-non-ecrite', suite: 'refus des commandes', de: 'if (sortie) process.stdout.write(JSON.stringify(sortie));', vers: '' },
  { nom: 'cod-exit-code', suite: 'refus des commandes', de: 'process.exitCode = 0;', vers: 'process.exitCode = 1;' },
  // lecture de l'entrée
  { nom: 'cod-evenement-ignore', suite: 'robustesse', de: "entree.hook_event_name !== 'PreToolUse'", vers: 'false' },
  { nom: 'cod-evenement-toujours-autre', suite: 'refus des commandes', de: "entree.hook_event_name !== 'PreToolUse'", vers: 'true' },
  // la commande
  { nom: 'cod-commande-vide-acceptee', suite: 'refus des commandes', de: "valeur.trim() === '' ? null : valeur", vers: 'valeur' },
  { nom: 'cod-commande-blanche-acceptee', suite: 'refus des commandes', de: "valeur.trim() === '' ? null : valeur", vers: "valeur === '' ? null : valeur" },
  { nom: 'cod-tableau-non-joint', suite: 'refus des commandes', de: "return valeur.join(' ');", vers: "return valeur.join('');" },
  { nom: 'cod-tableau-virgules', suite: 'refus des commandes', de: "return valeur.join(' ');", vers: "return valeur.join(',');" },
  { nom: 'cod-tableau-sans-test-de-texte', suite: 'refus des commandes', de: 'valeur.length > 0 && valeur.every(x => typeof x === \'string\')', vers: 'valeur.length > 0' },
  { nom: 'cod-tableau-vide-accepte', suite: 'refus des commandes', de: "Array.isArray(valeur) && valeur.length > 0 && ", vers: 'Array.isArray(valeur) && ' },
  { nom: 'cod-tableau-ignore', suite: 'refus des commandes', de: "if (Array.isArray(valeur) && valeur.length > 0 && valeur.every(x => typeof x === 'string')) return valeur.join(' ');\n", vers: '' },
  { nom: 'cod-texte-ignore', suite: 'refus des commandes', de: "  if (typeof valeur === 'string') return valeur.trim() === '' ? null : valeur;\n", vers: '' },
  { nom: 'cod-cles-command-retiree', suite: 'refus des commandes', de: "['command', 'cmd', 'script', 'input']", vers: "['cmd', 'script', 'input']" },
  { nom: 'cod-cles-cmd-retiree', suite: 'refus des commandes', de: "['command', 'cmd', 'script', 'input']", vers: "['command', 'script', 'input']" },
  { nom: 'cod-cles-script-retiree', suite: 'refus des commandes', de: "['command', 'cmd', 'script', 'input']", vers: "['command', 'cmd', 'input']" },
  { nom: 'cod-cles-input-retiree', suite: 'refus des commandes', de: "['command', 'cmd', 'script', 'input']", vers: "['command', 'cmd', 'script']" },
  { nom: 'cod-cles-ordre', suite: 'refus des commandes', de: "['command', 'cmd', 'script', 'input']", vers: "['cmd', 'command', 'script', 'input']" },
  { nom: 'cod-premiere-cle-seulement', suite: 'refus des commandes', de: "    const commande = texteCommande(ti[cle]);\n    if (commande !== null) return commande;\n  }\n  return null;", vers: "    return texteCommande(ti[cle]);\n  }\n  return null;" },
  { nom: 'cod-apply-patch-analyse', suite: 'refus des commandes', de: "if (entree.tool_name.toLowerCase() === 'apply_patch') return null;", vers: '' },
  { nom: 'cod-apply-patch-casse', suite: 'refus des commandes', de: "entree.tool_name.toLowerCase() === 'apply_patch'", vers: "entree.tool_name === 'apply_patch'" },
  { nom: 'cod-apply-patch-tout-exempte', suite: 'refus des commandes', de: "entree.tool_name.toLowerCase() === 'apply_patch'", vers: "/apply_patch/i.test(entree.tool_name)" },
  { nom: 'cod-commande-decision-ignoree', suite: 'refus des commandes', de: CMD, vers: 'return null;' },
  { nom: 'cod-commande-toujours-refusee', suite: 'refus des commandes', de: CMD, vers: 'const decision = consignes.decisionCommande(commande);\n  return refus(decision.raison);' },
  { nom: 'cod-commande-sans-texte', suite: 'refus des commandes', de: 'consignes.decisionCommande(commande)', vers: "consignes.decisionCommande('')" },
  // lancement d'agent
  { nom: 'cod-spawn-non-reconnu', suite: 'refus des nouveaux agents', de: "if (/spawn_agent$/.test(entree.tool_name)) {", vers: 'if (false) {' },
  { nom: 'cod-spawn-fin-de-nom', suite: 'refus des nouveaux agents', de: '/spawn_agent$/', vers: '/spawn_agent/' },
  { nom: 'cod-spawn-debut-de-nom', suite: 'refus des nouveaux agents', de: '/spawn_agent$/', vers: '/^spawn_agent$/' },
  { nom: 'cod-spawn-decision-ignoree', suite: 'refus des nouveaux agents', de: SPAWN, vers: 'return null;' },
  { nom: 'cod-spawn-toujours-refuse', suite: 'refus des nouveaux agents', de: SPAWN, vers: 'const decision = consignes.decisionAgent();\n    return refus(decision.raison);' },
  { nom: 'cod-spawn-passe-aux-commandes', suite: 'refus des nouveaux agents', de: SPAWN, vers: 'const decision = consignes.decisionAgent();\n    if (!decision.autorise) return refus(decision.raison);' },
];

executer({
  source: path.join(SCRIPTS, 'codex', 'consignes.js'),
  banc: path.join(__dirname, '..', 'consignes-codex.test.js'),
  variable: 'CONSIGNES_CODEX_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('../lib/consignes-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'consignes-core.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
