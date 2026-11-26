'use strict';
// Les sorties des hooks Codex du Cockpit contre les schémas de sortie de codex-cli 0.155 (tests/schemas-hooks-codex-0.155.json) : un champ en
// trop, ou une décision hors de la liste, invalide toute la sortie. Chaque hook est lancé comme Codex le fait (l'événement en JSON sur l'entrée
// standard) et sa sortie réelle est validée par tests/schema.js. Jamais dans les vraies racines : chaque test a son dossier temporaire.
// Lancement : node --test tests/hooks-codex-schema.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const { erreursSortieCodex } = require('./schema.js');
const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');
const LIB = path.join(__dirname, '..', 'scripts', 'lib');
const regulateur = require(path.join(LIB, 'regulateur-core.js'));
const consignes = require(path.join(LIB, 'consignes-core.js'));
const nuit = require(path.join(LIB, 'nuit-core.js'));
const HOOKS = path.join(__dirname, '..', 'scripts', 'codex');

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `hooks-codex-schema-${process.pid}-${++n}-`));
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.COCKPIT_QUOTA_NATIVE = '0'; // jamais un vrai binaire de Codex pendant un banc
});

// Lance un hook comme Codex : { stdout } est la sortie réelle, validée pour l'événement donné.
function sortie(script, evenement, entree, agent = 'codex') {
  const r = spawnSync(process.execPath, [path.join(HOOKS, script), '--agent', agent], {
    input: JSON.stringify({ hook_event_name: evenement, session_id: 'S1', cwd: '/x', ...entree }), encoding: 'utf8', env: { ...process.env }, timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.notEqual(r.stdout, '', `${script} ${evenement} : une sortie était attendue`);
  assert.deepEqual(erreursSortieCodex(evenement, r.stdout), [], `${script} ${evenement} : ${r.stdout}`);
  return JSON.parse(r.stdout);
}

describe('sorties validées contre le schéma de codex-cli 0.155', () => {
  test('cockpit.js : SessionStart et UserPromptSubmit', () => {
    assert.match(sortie('cockpit.js', 'SessionStart', { source: 'startup' }).hookSpecificOutput.additionalContext, /^COCKPIT /);
    assert.match(sortie('cockpit.js', 'UserPromptSubmit', { session_id: 'S2', prompt: 'bonjour' }, 'deepseek_H').hookSpecificOutput.additionalContext, /^COCKPIT /);
  });

  test('cockpit.js : PostToolUse, le premier outil après un compactage', () => {
    sortie('cockpit.js', 'UserPromptSubmit', { prompt: 'bonjour' });
    spawnSync(process.execPath, [path.join(HOOKS, 'cockpit.js'), '--agent', 'codex'], { input: JSON.stringify({ hook_event_name: 'PostCompact', session_id: 'S1', cwd: '/x' }), encoding: 'utf8' });
    assert.equal(sortie('cockpit.js', 'PostToolUse', { tool_name: 'shell' }).hookSpecificOutput.hookEventName, 'PostToolUse');
  });

  test('regulateur.js : le refus d un lancement (PreToolUse) et l ordre de la file (Stop)', () => {
    regulateur.appliquerCommande('pause');
    const refus = sortie('regulateur.js', 'PreToolUse', { tool_name: 'collaborationspawn_agent', tool_use_id: 'T1', tool_input: { message: 'fais X' } });
    assert.equal(refus.hookSpecificOutput.permissionDecision, 'deny');
    regulateur.appliquerCommande('reprendre');
    regulateur.appliquerCommande('3');
    regulateur.appliquerCommande('file on');
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'travail', demande: { message: 'Fais le travail 1' }, maintenant: Date.now() });
    assert.equal(sortie('regulateur.js', 'Stop', { stop_hook_active: false, last_assistant_message: '' }).decision, 'block');
  });

  test('consignes.js : le refus d une commande verrouillée (PreToolUse)', () => {
    consignes.appliquerCommande('ajouter Pas de poussée sans mon ordre');
    consignes.appliquerCommande('verrou 1 push');
    const refus = sortie('consignes.js', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'T1', tool_input: { command: 'git push origin main' } });
    assert.equal(refus.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('nuit.js : la question refusée (PreToolUse), l enchaînement (Stop) et le récap au réveil (UserPromptSubmit)', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': { texte: 'travail A', statut: 'ouvert' } });
    nuit.appliquerCommande('on', { agent: 'codex', session: 'S1' });
    const question = sortie('nuit.js', 'PreToolUse', { tool_name: 'request_user_input_async', tool_use_id: 'T1', tool_input: { questions: [{ title: 'Quelle option ?' }] } });
    assert.equal(question.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(sortie('nuit.js', 'Stop', { stop_hook_active: false, last_assistant_message: '' }).decision, 'block');
    assert.match(sortie('nuit.js', 'UserPromptSubmit', { prompt: 'je suis là' }).hookSpecificOutput.additionalContext, /^NUIT : récap/);
  });
});
