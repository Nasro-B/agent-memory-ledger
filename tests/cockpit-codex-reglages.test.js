'use strict';
// Les réglages que la ligne de commande du Cockpit écrit (scripts/cockpit.js) sont ceux que les hooks Codex lisent : chaque test pose un
// réglage par la ligne de commande, puis lance le hook comme Codex le fait et vérifie qu'il l'applique, et qu'il cesse de l'appliquer quand
// la ligne de commande le retire. Un hook qui lirait un autre fichier, ou un autre emplacement, laisserait ces tests rouges.
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Lancement : node --test tests/cockpit-codex-reglages.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');
const CLI = path.join(__dirname, '..', 'scripts', 'cockpit.js');
const HOOKS = path.join(__dirname, '..', 'scripts', 'codex');
// Variables internes (preuves par mutation, qui remplacent un hook par une copie altérée) : celles des bancs propres de chaque hook.
const VARIABLES = { 'cockpit.js': 'COCKPIT_CODEX_TESTE', 'regulateur.js': 'REGULATEUR_CODEX_TESTE', 'consignes.js': 'CONSIGNES_CODEX_TESTE', 'nuit.js': 'NUIT_CODEX_TESTE' };
const scriptDe = nom => process.env[VARIABLES[nom]] || path.join(HOOKS, nom);
const regulateur = require(path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-core.js'));

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-codex-reglages-${process.pid}-${++n}-`));
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.COCKPIT_QUOTA_NATIVE = '0'; // jamais un vrai binaire de Codex pendant un banc
});

// La ligne de commande, comme l'utilisateur la lance ; son message.
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env }, timeout: 60000 });
  assert.equal(r.status, 0, `${args.join(' ')} : ${r.stderr}`);
  return r.stdout.trim();
}
// Un hook, comme Codex le lance : la sortie JSON, ou null quand il n'a rien à dire.
function hook(script, evenement, entree, agent = 'codex') {
  const r = spawnSync(process.execPath, [scriptDe(script), '--agent', agent], {
    input: JSON.stringify({ hook_event_name: evenement, session_id: 'S1', cwd: '/x', ...entree }), encoding: 'utf8', env: { ...process.env }, timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout === '' ? null : JSON.parse(r.stdout);
}
const lancement = (extra = {}) => ({ tool_name: 'collaborationspawn_agent', tool_use_id: 'T1', tool_input: { message: 'Fais le travail 1', agent_type: 'default' }, ...extra });
const refus = sortie => (sortie ? sortie.hookSpecificOutput.permissionDecisionReason : null);
const agentEnCours = nom => ({ texte: `[agent] « ${nom} » (default, id-${nom}) : x`, statut: 'en-cours', note: 'agent en cours depuis 2026-03-02 11:00', session: 'S1' });
const rollout = (pct, nom = 'rollout.jsonl') => {
  const f = path.join(RUN, nom);
  fs.mkdirSync(RUN, { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round((Date.now() + 2 * 3600 * 1000) / 1000) }, secondary: null } } })}\n`);
  return f;
};

describe('le Régulateur et sa file', () => {
  test('politique pause, plafond, libre : le hook de lancement refuse puis laisse passer', () => {
    cli('politique', 'pause');
    assert.match(refus(hook('regulateur.js', 'PreToolUse', lancement())), /^Régulateur d'agents : en pause\./);
    cli('politique', 'reprendre');
    assert.equal(hook('regulateur.js', 'PreToolUse', lancement()), null);
    cli('politique', '1');
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A') });
    assert.match(refus(hook('regulateur.js', 'PreToolUse', lancement())), /^Régulateur d'agents : 1 agent en cours sur 1 /);
    assert.equal(hook('regulateur.js', 'PreToolUse', lancement(), 'deepseek_H'), null, 'les agents d un autre agent du dépôt ne comptent pas');
    cli('politique', 'libre');
    assert.equal(hook('regulateur.js', 'PreToolUse', lancement()), null);
  });

  test('politique file on : le refus met en file, le Stop ordonne de lancer, politique file vider vide', () => {
    cli('politique', '1');
    cli('politique', 'file', 'on');
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A') });
    assert.match(refus(hook('regulateur.js', 'PreToolUse', lancement())), /Cet agent est mis en file \(n° 1 sur 1\)/);
    assert.equal(regulateur.lireFile().entrees.length, 1);
    assert.equal(hook('regulateur.js', 'Stop', { stop_hook_active: false }), null, 'plus de créneau libre');
    ecrireEtatLedger('codex', 'P1', {});
    const ordre = hook('regulateur.js', 'Stop', { stop_hook_active: false });
    assert.match(ordre.reason, /Fais le travail 1/);
    assert.match(cli('politique', 'file', 'vider'), /1/);
    assert.deepEqual(regulateur.lireFile().entrees, []);
    cli('politique', 'file', 'off');
    assert.equal(hook('regulateur.js', 'Stop', { stop_hook_active: false }), null);
  });

  test('quota : les seuils posés par la ligne de commande sont ceux du refus de lancement', () => {
    const f = rollout(65);
    assert.equal(hook('regulateur.js', 'PreToolUse', lancement({ transcript_path: f })), null, 'seuils par défaut : 65 % ne bloque pas');
    cli('quota', '50', '60');
    assert.match(refus(hook('regulateur.js', 'PreToolUse', lancement({ transcript_path: f }))), /^Garde-quota : fenêtre 7 j à 65 % \(seuil 60 %\)/);
    cli('quota', 'defaut');
    assert.equal(hook('regulateur.js', 'PreToolUse', lancement({ transcript_path: f })), null);
  });
});

describe('les Consignes', () => {
  test('consignes verrou, pause, reprendre : le hook refuse la commande verrouillée, puis la laisse passer', () => {
    const poussee = { tool_name: 'Bash', tool_use_id: 'T1', tool_input: { command: 'git push origin main' } };
    assert.equal(hook('consignes.js', 'PreToolUse', poussee), null, 'sans consigne');
    cli('consignes', 'ajouter', 'Pas de poussée sans mon ordre');
    assert.equal(hook('consignes.js', 'PreToolUse', poussee), null, 'une consigne sans verrou ne refuse rien');
    cli('consignes', 'verrou', '1', 'push');
    assert.match(refus(hook('consignes.js', 'PreToolUse', poussee)), /^Consigne 1 de l'utilisateur \(« Pas de poussée sans mon ordre »\), verrou push : /);
    cli('consignes', 'pause', '1');
    assert.equal(hook('consignes.js', 'PreToolUse', poussee), null);
    cli('consignes', 'reprendre', '1');
    assert.match(refus(hook('consignes.js', 'PreToolUse', poussee)), /verrou push/);
    cli('consignes', 'retirer', '1');
    assert.equal(hook('consignes.js', 'PreToolUse', poussee), null);
  });

  test('le verrou agent refuse le lancement d un agent', () => {
    cli('consignes', 'ajouter', 'Aucun nouvel agent cette nuit');
    cli('consignes', 'verrou', '1', 'agent');
    assert.match(refus(hook('consignes.js', 'PreToolUse', lancement())), /^Consigne 1 de l'utilisateur .*verrou agent : /);
  });
});

describe('la Nuit', () => {
  test('nuit on, off : la question est refusée, l enchaînement ordonné, puis plus rien', () => {
    const question = { tool_name: 'request_user_input_async', tool_use_id: 'T1', tool_input: { questions: [{ title: 'Quelle option ?' }] } };
    ecrireEtatLedger('codex', 'P1', { 'C-0001': { texte: 'travail A', statut: 'ouvert' } });
    assert.equal(hook('nuit.js', 'PreToolUse', question), null, 'sans nuit');
    cli('nuit', 'on', '--agent', 'codex', '--session', 'S1');
    assert.match(refus(hook('nuit.js', 'PreToolUse', question)), /^NUIT : L'utilisateur est absent, ta question ne peut pas attendre sa réponse\./);
    assert.match(hook('nuit.js', 'Stop', { stop_hook_active: false }).reason, /^NUIT : L'utilisateur est absent\. Continue sans l'attendre avec la ligne suivante/);
    assert.match(cli('nuit', 'statut', '--agent', 'codex', '--session', 'S1'), /1 à décider en boîte/);
    cli('nuit', 'off', '--agent', 'codex', '--session', 'S1');
    assert.equal(hook('nuit.js', 'PreToolUse', question), null);
    assert.equal(hook('nuit.js', 'Stop', { stop_hook_active: false }), null);
  });

  test('--agent deepseek_H : la question de cet agent est refusée et mise dans sa boîte', () => {
    const question = { tool_name: 'request_user_input', tool_use_id: 'T1', tool_input: { questions: [{ title: 'Autre ?' }] } };
    cli('nuit', 'on', '--agent', 'deepseek_H', '--session', 'S1');
    assert.match(refus(hook('nuit.js', 'PreToolUse', question, 'deepseek_H')), /^NUIT : /);
    assert.match(cli('nuit', 'statut', '--agent', 'deepseek_H', '--session', 'S1'), /1 à décider en boîte/);
  });
});

describe('le Cockpit', () => {
  test('le bloc injecté dit ce que la ligne de commande a réglé : plafond, consignes, dossier des plans, seuils du quota', () => {
    const plans = path.join(RUN, 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'P.md'), '- [x] a\n- [ ] b\n');
    cli('politique', '3');
    cli('consignes', 'ajouter', 'Pas de poussée');
    cli('consignes', 'verrou', '1', 'push');
    cli('config', 'plans', plans);
    cli('quota', '50', '60');
    const contexte = hook('cockpit.js', 'SessionStart', { source: 'startup', transcript_path: rollout(55) }).hookSpecificOutput.additionalContext;
    assert.match(contexte, /^COCKPIT .*agents max 3 .*consignes 1 \(1 verrouillée\) .*plans 50 % \(1\/2\)/);
    assert.match(contexte, /\nRÉGULATEUR D'AGENTS .*Maximum 3 agents en parallèle\./);
    assert.match(contexte, /\nGARDE-QUOTA : Quota 7 j à 55 % : attention /, 'le seuil d attention posé à 50 %');
    assert.match(contexte, /\n1\. Pas de poussée \[verrou : push\]$/);
    assert.match(cli('ligne'), /plans 50 % \(1\/2\)/, 'la ligne de commande dit la même chose');
  });
});
