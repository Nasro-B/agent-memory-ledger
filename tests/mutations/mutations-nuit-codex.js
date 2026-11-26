'use strict';
// Preuve par mutation du banc nuit-codex.test.js (adaptateur Codex de la Nuit : questions refusées, enchaînement, réveil).
//   node tests/mutations/mutations-nuit-codex.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-nuit-codex.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-nuit-codex.js --liste         affiche les noms
//   node tests/mutations/mutations-nuit-codex.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutation équivalente écartée : passer transcript_path tel quel au noyau, sans vérifier qu'il est un texte (fs refuse un chemin qui n'en est
// pas un, la mesure gardée prend le relais : même sortie).

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const m = (nom, suite, de, vers) => ({ nom: `ncodex-${nom}`, suite, de, vers });
const QUESTION = 'question refusée';
const STOP = 'enchaînement';
const REVEIL = 'réveil';
const AUTRES = 'ne touche pas';

const MUTATIONS = [
  // sortie du refus
  m('refus-champ-en-trop', QUESTION, "permissionDecision: 'deny', permissionDecisionReason: raison }", "permissionDecision: 'deny', permissionDecisionReason: raison, extra: 1 }"),
  m('refus-ask', QUESTION, "permissionDecision: 'deny'", "permissionDecision: 'ask'"),
  m('refus-raison', QUESTION, 'permissionDecisionReason: raison', "permissionDecisionReason: 'non'"),
  m('refus-evenement', QUESTION, "hookEventName: 'PreToolUse', permissionDecision", "hookEventName: 'Stop', permissionDecision"),

  // agent
  m('agent-invalide', AUTRES, 'return nuit.agentValide(a) ? a : null;', 'return a || null;'),
  m('agent-argument', AUTRES, "const i = argv.indexOf('--agent');", "const i = argv.indexOf('--agents');"),

  // question
  m('question-outil-type', QUESTION, "if (typeof entree.tool_name !== 'string' || !/request_user_input(_async)?$/.test(entree.tool_name)) return null;", 'if (!/request_user_input(_async)?$/.test(entree.tool_name)) return null;'),
  m('question-outil-fin', QUESTION, '/request_user_input(_async)?$/.test(entree.tool_name)', '/request_user_input(_async)?/.test(entree.tool_name)'),
  m('question-outil-async', QUESTION, '/request_user_input(_async)?$/.test(entree.tool_name)', '/request_user_input$/.test(entree.tool_name)'),
  m('question-outil-sans-async', QUESTION, '/request_user_input(_async)?$/.test(entree.tool_name)', '/request_user_input_async$/.test(entree.tool_name)'),
  m('question-outil-garde', QUESTION, "if (typeof entree.tool_name !== 'string' || !/request_user_input(_async)?$/.test(entree.tool_name)) return null;", ''),
  m('question-agent', QUESTION, 'nuit.refuserQuestion({ agent, session: entree.session_id, entreeOutil: entree.tool_input })', "nuit.refuserQuestion({ agent: 'codex', session: entree.session_id, entreeOutil: entree.tool_input })"),
  m('question-session', QUESTION, 'nuit.refuserQuestion({ agent, session: entree.session_id, entreeOutil: entree.tool_input })', "nuit.refuserQuestion({ agent, session: 'S1', entreeOutil: entree.tool_input })"),
  m('question-entree', QUESTION, 'nuit.refuserQuestion({ agent, session: entree.session_id, entreeOutil: entree.tool_input })', 'nuit.refuserQuestion({ agent, session: entree.session_id })'),
  m('question-refus', QUESTION, 'return r.refuser ? refus(r.texte) : null;', 'return r.refuser ? null : refus(r.texte);'),
  m('question-texte', QUESTION, 'return r.refuser ? refus(r.texte) : null;', "return r.refuser ? refus('non') : null;"),

  // enchaînement
  m('stop-actif', STOP, 'if (entree.stop_hook_active === true || entree.agent_id || entree.agent_type) return null;', 'if (entree.agent_id || entree.agent_type) return null;'),
  m('stop-actif-vrai', STOP, 'entree.stop_hook_active === true ||', 'entree.stop_hook_active ||'),
  m('stop-agent-id', STOP, 'if (entree.stop_hook_active === true || entree.agent_id || entree.agent_type) return null;', 'if (entree.stop_hook_active === true || entree.agent_type) return null;'),
  m('stop-agent-type', STOP, 'if (entree.stop_hook_active === true || entree.agent_id || entree.agent_type) return null;', 'if (entree.stop_hook_active === true || entree.agent_id) return null;'),
  m('stop-agent', STOP, "nuit.continuer({ agent, session: entree.session_id, reason: 'answer',", "nuit.continuer({ agent: 'codex', session: entree.session_id, reason: 'answer',"),
  m('stop-session', STOP, "nuit.continuer({ agent, session: entree.session_id, reason: 'answer',", "nuit.continuer({ agent, session: 'S1', reason: 'answer',"),
  m('stop-reason', STOP, "reason: 'answer', chemin:", "reason: 'aborted', chemin:"),
  m('stop-chemin', STOP, "chemin: typeof entree.transcript_path === 'string' ? entree.transcript_path : undefined });", 'chemin: undefined });'),
  m('stop-continuer', STOP, "return d.continuer ? { decision: 'block', reason: d.texte } : null;", "return d.continuer ? null : { decision: 'block', reason: d.texte };"),
  m('stop-decision', STOP, "{ decision: 'block', reason: d.texte }", "{ decision: 'approve', reason: d.texte }"),
  m('stop-raison', STOP, "{ decision: 'block', reason: d.texte }", "{ decision: 'block', reason: d.motif }"),
  m('stop-champ-en-trop', STOP, "{ decision: 'block', reason: d.texte }", "{ decision: 'block', reason: d.texte, extra: 1 }"),

  // réveil
  m('reveil-agent-id', REVEIL, 'function surMessage(entree, agent) {\n  if (entree.agent_id || entree.agent_type) return null;', 'function surMessage(entree, agent) {\n  if (entree.agent_type) return null;'),
  m('reveil-agent-type', REVEIL, 'function surMessage(entree, agent) {\n  if (entree.agent_id || entree.agent_type) return null;', 'function surMessage(entree, agent) {\n  if (entree.agent_id) return null;'),
  m('reveil-sous-agent', REVEIL, 'function surMessage(entree, agent) {\n  if (entree.agent_id || entree.agent_type) return null;\n', 'function surMessage(entree, agent) {\n'),
  m('reveil-agent', REVEIL, 'nuit.noterActivite({ agent, session: entree.session_id })', "nuit.noterActivite({ agent: 'codex', session: entree.session_id })"),
  m('reveil-session', REVEIL, 'nuit.noterActivite({ agent, session: entree.session_id })', "nuit.noterActivite({ agent, session: 'S1' })"),
  m('reveil-condition', REVEIL, 'return r.reveil ? { hookSpecificOutput:', 'return !r.reveil ? { hookSpecificOutput:'),
  m('reveil-toujours', REVEIL, 'return r.reveil ? { hookSpecificOutput: { hookEventName: \'UserPromptSubmit\', additionalContext: r.recap } } : null;', "return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.recap } };"),
  m('reveil-contexte', REVEIL, 'additionalContext: r.recap', "additionalContext: 'NUIT'"),
  m('reveil-evenement', REVEIL, "hookEventName: 'UserPromptSubmit', additionalContext", "hookEventName: 'PreToolUse', additionalContext"),
  m('reveil-champ-en-trop', REVEIL, 'additionalContext: r.recap } }', 'additionalContext: r.recap, extra: 1 } }'),

  // aiguillage
  m('executer-nul', AUTRES, '  if (!entree) return null;\n  if (!agent ||', '  if (!agent ||'),
  m('executer-agent', AUTRES, "if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;", "if (typeof entree.session_id !== 'string' || !entree.session_id) return null;"),
  m('executer-session-type', AUTRES, "if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;", 'if (!agent || !entree.session_id) return null;'),
  m('executer-session-vide', AUTRES, "if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;", "if (!agent || typeof entree.session_id !== 'string') return null;"),
  m('executer-json', AUTRES, 'try { entree = JSON.parse(texte); } catch (_) { return null; }', 'entree = JSON.parse(texte);'),
  m('evenement-question', AUTRES, "case 'PreToolUse': return surQuestion(entree, agent);", "case 'PreToolUses': return surQuestion(entree, agent);"),
  m('evenement-stop', AUTRES, "case 'Stop': return surStop(entree, agent);", "case 'Stops': return surStop(entree, agent);"),
  m('evenement-message', AUTRES, "case 'UserPromptSubmit': return surMessage(entree, agent);", "case 'UserPromptSubmits': return surMessage(entree, agent);"),
  m('evenement-croise', AUTRES, "case 'Stop': return surStop(entree, agent);", "case 'Stop': return surMessage(entree, agent);"),
  m('evenement-autre', AUTRES, '    default: return null;', '    default: return surQuestion(entree, agent);'),

  // processus
  m('processus-erreur-bruyante', AUTRES, '} catch (_) { /* silence */ }\n    process.exitCode = 0;', '} catch (e) { process.stderr.write(String(e)); process.exitCode = 1; return; }\n    process.exitCode = 0;'),
  m('processus-erreur-bloque', AUTRES, '} catch (_) { /* silence */ }\n    process.exitCode = 0;', "} catch (_) { process.stdout.write(JSON.stringify({ decision: 'block', reason: 'panne' })); }\n    process.exitCode = 0;"),
  m('processus-sortie', AUTRES, 'if (sortie) process.stdout.write(JSON.stringify(sortie));', ''),
];

executer({
  source: path.join(SCRIPTS, 'codex', 'nuit.js'),
  banc: path.join(__dirname, '..', 'nuit-codex.test.js'),
  variable: 'NUIT_CODEX_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('../lib/nuit-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'nuit-core.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
