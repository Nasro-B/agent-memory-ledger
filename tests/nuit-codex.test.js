'use strict';
// Bancs de l'adaptateur Codex de la Nuit : scripts/codex/nuit.js
// Lancement : node --test tests/nuit-codex.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variable interne (preuves par mutation) : NUIT_CODEX_TESTE = adaptateur à tester (défaut : ../scripts/codex/nuit.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');

const ADAPTATEUR = process.env.NUIT_CODEX_TESTE || path.join(__dirname, '..', 'scripts', 'codex', 'nuit.js');
const core = require(path.join(__dirname, '..', 'scripts', 'lib', 'nuit-core.js'));
const regulateur = require(path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-core.js'));

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `nuit-codex-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
});

const MIN = 60 * 1000;
const HEURE = 60 * MIN;
const il_y_a = ms => new Date(Date.now() - ms).toISOString();
const sansTiretLong = t => !/\u{2014}/u.test(t);
const fichier = nom => path.join(process.env.COCKPIT_DIR, nom);
const lire = nom => JSON.parse(fs.readFileSync(fichier(nom), 'utf8'));
const existe = nom => fs.existsSync(fichier(nom));
const ledger = (lignes, agent = 'codex') => ecrireEtatLedger(agent, 'P1', lignes);
const ligne = (texte, extra = {}) => ({ texte, statut: 'ouvert', ...extra });
const ctx = (extra = {}) => ({ agent: 'codex', session: 'S1', ...extra });
const ouvrirNuit = (extra = {}) => core.appliquerCommande('on', ctx(extra));

function lancer(entree, { agent = 'codex', args = ['--agent', agent] } = {}) {
  const input = typeof entree === 'string' ? entree : JSON.stringify(entree);
  return spawnSync(process.execPath, [ADAPTATEUR, ...args], { input, encoding: 'utf8', env: { ...process.env }, timeout: 60000 });
}
const question = (extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'S1', cwd: 'C:/x', tool_name: 'request_user_input_async', tool_use_id: 'T1', tool_input: { questions: [{ title: 'Quelles ressources de test ?' }] }, ...extra });
const stop = (extra = {}) => ({ hook_event_name: 'Stop', session_id: 'S1', stop_hook_active: false, last_assistant_message: '', ...extra });
const message = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'S1', prompt: 'je suis là', ...extra });

describe('question refusée pendant la nuit (PreToolUse)', () => {
  test('sans nuit, la question n est pas refusée : sortie vide, code 0, rien d écrit', () => {
    const r = lancer(question());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('pendant la nuit, la question est refusée dans le schéma strict de Codex, et mise en boîte', () => {
    ouvrirNuit();
    const r = lancer(question());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    assert.equal(s.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(s.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /^NUIT : L'utilisateur est absent, ta question ne peut pas attendre sa réponse\. Elle est notée en boîte \(n° 1, 1 à décider au réveil\)\./);
    assert.ok(sansTiretLong(r.stdout));
    const e = core.lireBoite().entrees[0];
    assert.deepEqual([e.agent, e.session, e.type, e.titre], ['codex', 'S1', 'question', 'Quelles ressources de test ?']);
    assert.equal(lire('nuit.json').refus.question, 1);
  });

  test('toute variante du nom de l outil de questions est refusée, aucun autre outil ne l est', () => {
    ouvrirNuit();
    for (const tool_name of ['request_user_input_async', 'request_user_input', 'collaborationrequest_user_input_async', 'mcp.request_user_input']) {
      assert.match(lancer(question({ tool_name })).stdout, /"deny"/, tool_name);
    }
    for (const tool_name of ['Bash', 'apply_patch', 'exec_command', 'spawn_agent', 'request_user_input_async_extra', 'ask_request_user_inputs', 'user_input', 5, null, undefined, ['request_user_input']]) {
      const r = lancer(question({ tool_name }));
      assert.equal(r.status, 0, String(tool_name));
      assert.equal(r.stdout, '', String(tool_name));
    }
  });

  test('un sous-agent qui pose une question est soumis à la même règle', () => {
    ouvrirNuit();
    assert.match(lancer(question({ agent_id: 'A9', agent_type: 'default' })).stdout, /"deny"/);
  });

  test('deepseek_H a sa propre boîte d agent, avec la même nuit', () => {
    ouvrirNuit({ agent: 'deepseek_H' });
    const r = lancer(question(), { agent: 'deepseek_H' });
    assert.match(r.stdout, /"deny"/);
    assert.equal(core.lireBoite().entrees[0].agent, 'deepseek-h');
  });

  test('la question mise en boîte porte la conversation qui l a posée', () => {
    ouvrirNuit({ session: 'S9' });
    assert.match(lancer(question({ session_id: 'S9' })).stdout, /"deny"/);
    assert.equal(core.lireBoite().entrees[0].session, 'S9');
  });

  test('l absence de l\'utilisateur suffit à refuser la question, et la nuit est notée en mode absence', () => {
    core.noterActivite({ ...ctx(), maintenant: Date.now() - 2 * HEURE });
    assert.match(lancer(question()).stdout, /"deny"/);
    assert.equal(lire('nuit.json').mode, 'absence');
  });

  test('une question qui ne peut pas être notée est refusée quand même, sans promettre de boîte', () => {
    ouvrirNuit();
    fs.mkdirSync(fichier('nuit-boite.json'), { recursive: true });
    const raison = JSON.parse(lancer(question()).stdout).hookSpecificOutput.permissionDecisionReason;
    assert.ok(raison.includes('Elle n\'a PAS pu être notée en boîte'), raison);
  });
});

describe('enchaînement (Stop)', () => {
  const ordre = r => JSON.parse(r.stdout);

  test('sans nuit, rien : sortie vide, code 0', () => {
    ledger({ 'C-0001': ligne('A') });
    const r = lancer(stop());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('nuit active et ligne ouverte : le modèle reçoit l ordre de continuer, dans le schéma strict de Codex', () => {
    ledger({ 'C-0001': ligne('premier travail'), 'C-0002': ligne('second travail') });
    ouvrirNuit();
    const r = lancer(stop());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = ordre(r);
    assert.deepEqual(Object.keys(s).sort(), ['decision', 'reason']);
    assert.equal(s.decision, 'block');
    assert.match(s.reason, /^NUIT : L'utilisateur est absent\. Continue sans l'attendre avec la ligne suivante de ta liste de travail : C-0001 « premier travail »\./);
    assert.ok(s.reason.endsWith('(enchaînement 1 sur 60)'), s.reason);
    assert.ok(sansTiretLong(r.stdout));
    assert.deepEqual([lire('nuit.json').tours, lire('nuit.json').derniereLigne], [1, 'C-0001']);
  });

  test('stop_hook_active : une seule continuation par message de l\'utilisateur, l état n est pas touché', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B') }); // une même ligne n est proposée que trois fois de suite
    ouvrirNuit();
    assert.equal(lancer(stop({ stop_hook_active: true })).stdout, '');
    assert.equal(lire('nuit.json').tours, 0);
    for (const actif of [1, 'true', null, undefined]) assert.equal(ordre(lancer(stop({ stop_hook_active: actif }))).decision, 'block', `valeur ${JSON.stringify(actif)} : seul true arrête`);
  });

  test('la pause du Régulateur et un quota au seuil critique arrêtent l enchaînement', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    regulateur.appliquerCommande('pause');
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(lire('nuit.json').arret, 'pause');
    regulateur.appliquerCommande('reprendre');
    const rollout = path.join(RUN, 'rollout.jsonl');
    const mesure = pct => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round((Date.now() + 2 * HEURE) / 1000) }, secondary: null } } });
    fs.writeFileSync(rollout, `${mesure(95)}\n`);
    assert.equal(lancer(stop({ transcript_path: rollout })).stdout, '');
    assert.equal(lire('nuit.json').arret, 'quota');
    fs.writeFileSync(rollout, `${mesure(10)}\n`);
    assert.equal(ordre(lancer(stop({ transcript_path: rollout }))).decision, 'block');
  });

  test('le plafond de tours et la fin du travail arrêtent l enchaînement', () => {
    ledger({ 'C-0001': ligne('A') });
    core.appliquerCommande('tours 1', ctx());
    ouvrirNuit();
    assert.equal(ordre(lancer(stop())).decision, 'block');
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(lire('nuit.json').arret, 'plafond');
    ledger({ 'C-0001': ligne('autre fil', { session: 'AUTRE' }) });
    core.appliquerCommande('off', ctx());
    core.appliquerCommande('on', ctx());
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(lire('nuit.json').arret, 'termine');
  });

  test('un sous-agent ne déclenche jamais l enchaînement', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    for (const extra of [{ agent_id: 'A9' }, { agent_type: 'default' }]) assert.equal(lancer(stop(extra)).stdout, '', JSON.stringify(extra));
    assert.equal(lire('nuit.json').tours, 0);
  });

  test('chaque agent principal enchaîne sur ses lignes et sa conversation', () => {
    ledger({ 'C-0001': ligne('pour codex') });
    ledger({ 'C-0002': ligne('pour deepseek') }, 'deepseek_H');
    ouvrirNuit();
    core.appliquerCommande('on', ctx({ agent: 'deepseek_H' }));
    assert.match(ordre(lancer(stop(), { agent: 'deepseek_H' })).reason, /C-0002 « pour deepseek »/);
    assert.match(ordre(lancer(stop(), { agent: 'codex' })).reason, /C-0001 « pour codex »/);
    assert.equal(lancer(stop({ session_id: 'S2' })).stdout, '', 'une autre conversation n a aucune ligne');
  });

  test('l absence de l\'utilisateur suffit à enchaîner', () => {
    ledger({ 'C-0001': ligne('A') });
    core.noterActivite({ ...ctx(), maintenant: Date.now() - 2 * HEURE });
    assert.equal(ordre(lancer(stop())).decision, 'block');
    assert.equal(lire('nuit.json').mode, 'absence');
  });
});

describe('réveil (UserPromptSubmit)', () => {
  test('un message de l\'utilisateur sans nuit date son activité et ne dit rien', () => {
    const r = lancer(message());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(Number.isFinite(Date.parse(lire('nuit.json').derniereActivite)));
  });

  test('un message de l\'utilisateur pendant la nuit la termine et donne le récap au modèle, dans le schéma strict de Codex', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    lancer(question());
    const r = lancer(message());
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    assert.equal(s.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(s.hookSpecificOutput.additionalContext, /^NUIT : récap\./);
    assert.ok(s.hookSpecificOutput.additionalContext.includes('À décider (1) :'), s.hookSpecificOutput.additionalContext);
    assert.ok(sansTiretLong(r.stdout));
    assert.equal(lire('nuit.json').actif, false);
  });

  test('le récap compte les lignes de l agent principal et de la conversation du message', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B'), 'C-0003': ligne('C') });
    ledger({ 'C-0009': ligne('pour deepseek', { session: 'S9' }) }, 'deepseek_H');
    ouvrirNuit({ agent: 'deepseek_H', session: 'S9' });
    const contexte = JSON.parse(lancer(message({ session_id: 'S9' }), { agent: 'deepseek_H' }).stdout).hookSpecificOutput.additionalContext;
    assert.ok(contexte.includes('Lignes ouvertes : 1 au coucher, 1 maintenant.'), contexte);
  });

  test('le récap n est donné qu une fois', () => {
    ouvrirNuit();
    assert.notEqual(lancer(message()).stdout, '');
    assert.equal(lancer(message()).stdout, '');
  });

  test('un sous-agent n est pas l\'utilisateur : il ne réveille rien', () => {
    ouvrirNuit();
    for (const extra of [{ agent_id: 'A9' }, { agent_type: 'default' }]) assert.equal(lancer(message(extra)).stdout, '', JSON.stringify(extra));
    assert.equal(lire('nuit.json').actif, true);
  });
});

describe('ce que la Nuit ne touche pas', () => {
  test('les autres événements donnent une sortie vide, même pendant la nuit', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    for (const hook_event_name of ['SessionStart', 'PostToolUse', 'PostCompact', 'SubagentStart', 'SubagentStop', 'PermissionRequest']) {
      const r = lancer(question({ hook_event_name }));
      assert.equal(r.stdout, '', hook_event_name);
    }
    assert.equal(lire('nuit.json').tours, 0);
  });

  test('une entrée illisible, vide, sans fil, ou un nom d agent invalide donnent une sortie vide, code 0, rien sur stderr', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    const entrees = ['', 'pas du json', '[]', 'null', JSON.stringify(question({ session_id: undefined })), JSON.stringify(question({ session_id: '' })), JSON.stringify(question({ session_id: 5 })), JSON.stringify(stop({ session_id: undefined })), JSON.stringify(message({ session_id: '' }))];
    for (const entree of entrees) {
      const r = lancer(entree);
      assert.equal(r.status, 0, entree);
      assert.equal(r.stdout, '', entree);
      assert.equal(r.stderr, '', entree);
    }
    for (const args of [['--agent', '../evil'], ['--agent', ''], ['--agent', 'AGENT'], []]) assert.equal(lancer(question(), { args }).stdout, '', args.join(' '));
    assert.equal(core.lireBoite().entrees.length, 0);
  });

  test('une panne interne reste silencieuse : sortie vide, code 0, rien sur stderr', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    fs.chmodSync(fichier('nuit.json'), 0o444); // l'état ne peut plus être écrit : l'enchaînement échoue
    try {
      const r = lancer(stop());
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    } finally {
      fs.chmodSync(fichier('nuit.json'), 0o666);
    }
    assert.equal(lire('nuit.json').tours, 0, 'rien n a avancé');
  });

  test('executer ne lève jamais sur une entrée invalide : il rend null', () => {
    const { executer } = require(ADAPTATEUR);
    for (const entree of ['pas du json', '', '[]', 'null', '"abc"', '5', 'true', '{}']) assert.equal(executer(entree, 'codex'), null, entree);
  });
});
