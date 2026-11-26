'use strict';
// Bancs de l'adaptateur Codex des Consignes en vigueur : scripts/codex/consignes.js
// Lancement : node --test tests/consignes-codex.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR).
// Variable interne (preuves par mutation) : CONSIGNES_CODEX_TESTE = adaptateur à tester (défaut : ../scripts/codex/consignes.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const ADAPTATEUR = process.env.CONSIGNES_CODEX_TESTE || path.join(__dirname, '..', 'scripts', 'codex', 'consignes.js');

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `consignes-codex-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
});

const cons = (id, texte, verrou = null, actif = true) => ({ id, texte, actif, verrou });
const poser = consignes => {
  fs.mkdirSync(process.env.COCKPIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.COCKPIT_DIR, 'consignes.json'), JSON.stringify({ prochain: 50, consignes }));
};
const PUSH = cons(1, 'Pas de push sans mon ordre', 'push');
const DEPLOIEMENT = cons(2, 'Pas de déploiement', 'deploiement');
const REBUILD = cons(3, 'Pas de rebuild APK', 'rebuild');
const AGENT = cons(4, 'Aucun nouvel agent cette nuit', 'agent');

function lancer(entree, args = []) {
  const input = typeof entree === 'string' ? entree : JSON.stringify(entree);
  return spawnSync(process.execPath, [ADAPTATEUR, ...args], { input, encoding: 'utf8', env: { ...process.env }, timeout: 60000 });
}
const outil = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'S1', cwd: 'C:/x', tool_name, tool_use_id: 'T1', tool_input, ...extra });
const bash = (command, extra) => outil('Bash', { command }, extra);
const commandeExec = (cmd, extra) => outil('exec_command', { cmd }, extra);
const spawnAgent = (extra = {}) => outil('collaborationspawn_agent', { message: 'fais X' }, extra);

describe('refus des commandes', () => {
  test('sans fichier ou sans verrou, aucune sortie : le hook ne gêne jamais tant que l\'utilisateur n a rien décidé', () => {
    for (const entree of [bash('git push origin main'), commandeExec('vercel --prod'), spawnAgent()]) {
      const r = lancer(entree);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
    poser([cons(1, 'Français'), cons(2, 'Pas de push', 'push', false)]);
    assert.equal(lancer(bash('git push')).stdout, '');
  });

  test('git push est refusé dans le schéma strict de Codex, avec la consigne, son texte et la façon de la lever', () => {
    poser([PUSH]);
    const r = lancer(bash('git push origin main'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    assert.equal(s.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(s.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /^Consigne 1 de l'utilisateur \(« Pas de push sans mon ordre »\), verrou push : /);
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /\/consignes pause 1/);
    assert.ok(!/\u{2014}/u.test(r.stdout), 'jamais de tiret cadratin');
  });

  test('la commande se lit dans command, cmd, script ou input, et un tableau de mots est joint', () => {
    poser([PUSH]);
    for (const tool_input of [{ command: 'git push' }, { cmd: 'git push' }, { script: 'git push' }, { input: 'git push' }, { command: ['bash', '-lc', 'git push origin main'] }, { command: ['git', 'push'] }]) {
      assert.match(lancer(outil('un_outil', tool_input)).stdout, /"deny"/, JSON.stringify(tool_input));
    }
    for (const nom of ['Bash', 'exec_command', 'shell', 'PowerShell', 'exec']) assert.match(lancer(outil(nom, { command: 'git push' })).stdout, /"deny"/, nom);
  });

  test('la première valeur texte non vide fait foi', () => {
    poser([PUSH]);
    assert.match(lancer(outil('x', { command: '', cmd: 'git push' })).stdout, /"deny"/);
    assert.match(lancer(outil('x', { command: 5, cmd: 'git push' })).stdout, /"deny"/);
    assert.match(lancer(outil('x', { command: '   ', cmd: 'git push' })).stdout, /"deny"/, 'un champ de blancs est vide');
    assert.match(lancer(outil('x', { command: [], cmd: 'git push' })).stdout, /"deny"/, 'un tableau vide est vide');
    assert.equal(lancer(outil('x', { command: ['git', 'push', 5] })).stdout, '', 'un tableau qui n est pas tout en texte n est pas une commande');
    assert.equal(lancer(outil('x', { command: 'git status', cmd: 'git push' })).stdout, '');
  });

  test('une commande ordinaire passe, et un outil sans commande aussi', () => {
    poser([PUSH, DEPLOIEMENT, REBUILD]);
    for (const entree of [bash('git status'), commandeExec('npm test'), outil('Read', { file_path: 'C:/x/a.txt' }), outil('Bash', {}), outil('Bash', { command: '' }), outil('Bash', { command: ['ls', 5] })]) {
      assert.equal(lancer(entree).stdout, '', JSON.stringify(entree));
    }
  });

  test('apply_patch n est pas une commande : un patch qui cite git push passe', () => {
    poser([PUSH, DEPLOIEMENT, REBUILD]);
    for (const nom of ['apply_patch', 'APPLY_PATCH']) assert.equal(lancer(outil(nom, { command: '*** Begin Patch\n+ git push\n+ vercel --prod\n*** End Patch' })).stdout, '', nom);
    assert.match(lancer(bash('apply_patch <<EOF\ngit push\nEOF')).stdout, /"deny"/, 'un shell qui appelle apply_patch reste analysé');
    for (const nom of ['apply_patch_shell', 'mon_apply_patch', 'apply_patches', 'apply-patch']) assert.match(lancer(outil(nom, { command: 'git push' })).stdout, /"deny"/, `seul le nom exact est exempté : ${nom}`);
  });

  test('déploiement et rebuild sont refusés par leur verrou, et chacun par le sien seulement', () => {
    poser([DEPLOIEMENT, REBUILD]);
    assert.match(JSON.parse(lancer(bash('vercel --prod')).stdout).hookSpecificOutput.permissionDecisionReason, /^Consigne 2 de l'utilisateur .*verrou deploiement/);
    assert.match(JSON.parse(lancer(commandeExec('./gradlew assembleRelease')).stdout).hookSpecificOutput.permissionDecisionReason, /^Consigne 3 de l'utilisateur .*verrou rebuild/);
    assert.equal(lancer(bash('git push')).stdout, '');
  });

  test('les sous-agents sont refusés aussi : un ordre permanent vaut pour tous', () => {
    poser([PUSH]);
    assert.match(lancer(bash('git push', { agent_id: 'A1', agent_type: 'default' })).stdout, /"deny"/);
  });

  test('le même hook sert codex et deepseek_H, avec ou sans --agent', () => {
    poser([PUSH]);
    for (const args of [[], ['--agent', 'codex'], ['--agent', 'deepseek_H']]) assert.match(lancer(bash('git push'), args).stdout, /"deny"/, args.join(' '));
  });

  test('le fichier est relu à chaque appel', () => {
    poser([cons(1, 'Pas de push')]);
    assert.equal(lancer(bash('git push')).stdout, '');
    poser([PUSH]);
    assert.match(lancer(bash('git push')).stdout, /"deny"/);
    poser([{ ...PUSH, actif: false }]);
    assert.equal(lancer(bash('git push')).stdout, '');
  });
});

describe('refus des nouveaux agents', () => {
  test('avec le verrou agent, le lancement est refusé avec la consigne', () => {
    poser([AGENT]);
    for (const tool_name of ['collaborationspawn_agent', 'spawn_agent', 'collaboration.spawn_agent']) {
      const s = JSON.parse(lancer(outil(tool_name, { message: 'fais X' })).stdout);
      assert.equal(s.hookSpecificOutput.permissionDecision, 'deny', tool_name);
      assert.match(s.hookSpecificOutput.permissionDecisionReason, /^Consigne 4 de l'utilisateur \(« Aucun nouvel agent cette nuit »\), verrou agent : /, tool_name);
    }
  });

  test('sans verrou agent ou en pause, le lancement passe ; les autres outils ne sont pas des lancements', () => {
    poser([{ ...AGENT, actif: false }, PUSH]);
    assert.equal(lancer(spawnAgent()).stdout, '');
    poser([AGENT]);
    for (const tool_name of ['Bash', 'apply_patch', 'exec_command', 'mcp__codex_app__x', 'collaborationsend_input', 'spawn_agent_extra']) {
      assert.equal(lancer(outil(tool_name, { message: 'x' })).stdout, '', tool_name);
    }
  });

  test('le verrou agent ne refuse aucune commande, et un verrou de commande ne refuse aucun lancement', () => {
    poser([AGENT]);
    assert.equal(lancer(bash('git push && ./gradlew assembleRelease && vercel --prod')).stdout, '');
    poser([PUSH, DEPLOIEMENT, REBUILD]);
    assert.equal(lancer(spawnAgent()).stdout, '');
  });

  test('un lancement d agent n est jamais lu comme une commande, même si son contenu en porte une', () => {
    poser([PUSH, { ...AGENT, actif: false }]);
    assert.equal(lancer(outil('collaborationspawn_agent', { command: 'git push', message: 'git push' })).stdout, '');
    poser([PUSH]);
    assert.equal(lancer(outil('spawn_agent', { cmd: 'git push origin main' })).stdout, '');
  });
});

describe('robustesse', () => {
  test('une entrée invalide, un autre événement ou un fichier illisible : silence, exit 0', () => {
    poser([PUSH, AGENT]);
    for (const entree of ['', 'pas du json', '[]', 'null', '5', '"x"', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' } }), JSON.stringify(outil(5, { command: 'git push' })), JSON.stringify(outil('Bash', 'git push')), JSON.stringify(outil('Bash', null))]) {
      const r = lancer(entree);
      assert.equal(r.status, 0, String(entree));
      assert.equal(r.stdout, '', String(entree));
      assert.equal(r.stderr, '', String(entree));
    }
    fs.writeFileSync(path.join(process.env.COCKPIT_DIR, 'consignes.json'), '{pas du json');
    assert.equal(lancer(bash('git push')).stdout, '');
    assert.equal(lancer(spawnAgent()).stdout, '');
  });

  test('le hook ne crée aucun fichier : lecture seule', () => {
    poser([PUSH]);
    const avant = fs.readdirSync(process.env.COCKPIT_DIR);
    lancer(bash('git push'));
    lancer(bash('git status'));
    assert.deepEqual(fs.readdirSync(process.env.COCKPIT_DIR), avant);
  });
});
