'use strict';
// Bancs du fichier contexte pour Claude Code (noyau et adaptateur), sans modèle.
// Lancement : node --test tests/context-ledger-claude.test.js
// Jamais dans la vraie maison (~/.agent-memory-ledger) : chaque test a sa propre maison
// <dossier de test>/<nom>/.agent-memory-ledger, passée au hook par AGENT_MEMORY_LEDGER_HOME ; sa racine
// contexte est <maison>/contexte.
// Variables internes (utilisées par les tests de mutation, qui relancent ce fichier) :
//   CONTEXT_LEDGER_HOOK         script à tester (défaut : ../scripts/claude/context-ledger.js)
//   CONTEXT_LEDGER_EN_MUTATION  '1' = exécution sur une copie mutée (pas de récursion)
//   CONTEXT_LEDGER_BASE_TESTS   dossier de travail des bancs (défaut : <dossier temporaire>/aml-tests/claude)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');
const { test, before } = require('node:test');

const HOOK = process.env.CONTEXT_LEDGER_HOOK || path.join(__dirname, '..', 'scripts', 'claude', 'context-ledger.js');
const CORE_PATH = path.join(path.dirname(HOOK), '..', 'lib', 'context-ledger-core.js');
const EN_MUTATION = process.env.CONTEXT_LEDGER_EN_MUTATION === '1';
const BASE_TESTS = process.env.CONTEXT_LEDGER_BASE_TESTS || path.join(os.tmpdir(), 'aml-tests', 'claude');
const RUN = path.join(BASE_TESTS, (EN_MUTATION ? 'mut-' : 'run-') + Date.now() + '-' + process.pid);
const VRAIE_MAISON = path.join(os.homedir(), '.agent-memory-ledger');
const CWD_PROJET = 'C:\\travail\\projet-demo';
const PROJET = 'projet-demo';
// Fichiers de preuve de la maison d'un test (dir = sa racine contexte).
const histoire = dir => path.join(path.dirname(dir), 'history', 'projet-demo.claude.md');
const resume = dir => path.join(path.dirname(dir), 'Memory-Auto.md');
const MEMOIRE_PROJET = path.join(os.homedir(), '.claude', 'projects', 'c--travail-x', 'memory', 'fait.md');

// Les réglages de la personne qui lance les bancs ne doivent jamais fuir dans les tests (ni l'inverse) :
// chaque test pose sa propre maison, et la copie de secours n'existe que dans les tests qui la demandent.
for (const k of ['CONTEXT_LEDGER_DIR', 'CONTEXT_LEDGER_SECOURS_DIR', 'AGENT_MEMORY_LEDGER_HOME']) delete process.env[k];

const core = require(CORE_PATH);

function norm(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }

before(() => {
  assert.ok(!norm(RUN).startsWith(norm(VRAIE_MAISON)), 'les tests ne doivent jamais viser la vraie maison');
  fs.mkdirSync(RUN, { recursive: true });
});

// Crée la maison du test et rend sa racine contexte. La table des projets y déclare « projet-demo ».
function dossier(nom) {
  const base = path.join(RUN, nom);
  fs.rmSync(base, { recursive: true, force: true });
  const maison = path.join(base, '.agent-memory-ledger');
  const d = path.join(maison, 'contexte');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(maison, 'projets.json'), JSON.stringify({ projets: [{ nom: PROJET, motif: 'projet-demo' }] }));
  return d;
}

function envPour(dir) {
  const env = Object.assign({}, process.env, { AGENT_MEMORY_LEDGER_HOME: path.dirname(dir) });
  delete env.CONTEXT_LEDGER_DIR;
  delete env.CONTEXT_LEDGER_HOOK;
  delete env.CONTEXT_LEDGER_EN_MUTATION;
  return env;
}

function hook(dir, payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), env: envPour(dir), encoding: 'utf8', cwd: dir, timeout: 30000, windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  return { code: r.status, out, err: r.stderr, json: out ? JSON.parse(out) : null };
}

function cli(dir, args) {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    env: envPour(dir), encoding: 'utf8', cwd: dir, timeout: 30000, windowsHide: true,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function cliAsync(dir, args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [HOOK, ...args], { env: envPour(dir), cwd: dir, windowsHide: true });
    let out = ''; let err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => resolve({ code, out, err }));
  });
}

function hookAsync(dir, payload) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [HOOK], { env: envPour(dir), cwd: dir, windowsHide: true });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', code => resolve({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
}

// Exécute fn dans ce processus avec la maison du test (dir = sa racine contexte).
function avecRacine(dir, fn) {
  const avant = process.env.AGENT_MEMORY_LEDGER_HOME;
  process.env.AGENT_MEMORY_LEDGER_HOME = path.dirname(dir);
  try { return fn(); } finally {
    if (avant === undefined) delete process.env.AGENT_MEMORY_LEDGER_HOME; else process.env.AGENT_MEMORY_LEDGER_HOME = avant;
  }
}

function etat(dir, projet = PROJET, agent = 'claude') {
  return JSON.parse(fs.readFileSync(path.join(dir, '.etat', `${projet}.${agent}.json`), 'utf8'));
}
function vue(dir, projet = PROJET, agent = 'claude') {
  return fs.readFileSync(path.join(dir, `${projet}.${agent}.md`), 'utf8');
}
function journal(dir, projet = PROJET, agent = 'claude') {
  return fs.readFileSync(path.join(dir, `${projet}.${agent}.journal.log`), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function ups(dir, prompt, extra = {}) {
  return hook(dir, Object.assign({
    hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt_id: 'p-1', cwd: CWD_PROJET, prompt,
  }, extra));
}

function contexte(r) {
  assert.ok(r.json && r.json.hookSpecificOutput, 'sortie hookSpecificOutput attendue, reçu : ' + r.out);
  return r.json.hookSpecificOutput.additionalContext;
}

// Prépare M-0001 + C-0001 (de M-0001) dans le projet projet-demo.
function preparerLigne(dir, texteLigne = 'Corriger le bouton de paiement') {
  const r = ups(dir, 'Corrige le bouton de paiement, il ne répond plus');
  assert.equal(r.code, 0);
  const a = cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', texteLigne]);
  assert.equal(a.code, 0, a.err);
  return 'C-0001';
}

function postWrite(dir, fichier, contenu, extra = {}) {
  return hook(dir, Object.assign({
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: CWD_PROJET, tool_name: 'Write',
    tool_input: { file_path: fichier, content: contenu }, tool_response: {},
  }, extra));
}

function preTool(dir, tool_name, tool_input, extra = {}) {
  return hook(dir, Object.assign({
    hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: CWD_PROJET, tool_name, tool_input,
  }, extra));
}

function estRefuse(r) {
  return !!(r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny');
}

// ---------------------------------------------------------------------------

test('message humain : M créé mot pour mot', () => {
  const dir = dossier('message-humain');
  const prompt = 'Corrige « tout » : l\'API "v2" et $HOME `x`\r\nligne 2 : éàü ; fin  ';
  const r = ups(dir, prompt);
  assert.equal(r.code, 0);
  const ctx = contexte(r);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ctx, /Nouveau message M-0001\. Avant d'agir/);
  assert.ok(ctx.includes(`ajouter --projet ${PROJET} --de M-0001 "texte mot pour mot"`));
  assert.ok(ctx.includes(`sans-travail --projet ${PROJET} M-0001 "raison courte"`));
  assert.ok(ctx.includes('[ctx C-NNNN partiel]'));
  const e = etat(dir);
  assert.equal(e.demandes['M-0001'].texte, prompt);
  assert.equal(e.demandes['M-0001'].statut, 'a-trier');
  assert.equal(e.demandes['M-0001'].session, 'sess-1');
  assert.match(vue(dir), /## À trier \(messages de l'utilisateur pas encore transformés en travail\)\n- M-0001 \| \d{4}-\d\d-\d\d \d\d:\d\d \| « Corrige/);
  const session = JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'claude-sess-1.json'), 'utf8'));
  assert.equal(session.projet, PROJET);
  assert.equal(journal(dir)[0].evt, 'demande');
  assert.equal(journal(dir)[0].texte, prompt);
});

test('même prompt_id : pas de doublon', () => {
  const dir = dossier('dedup');
  ups(dir, 'premier');
  const r = ups(dir, 'premier');
  assert.equal(r.out, '');
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001']);
});

test('projet inconnu : _general, et le projet lié ne change plus quand le cwd change', () => {
  const dir = dossier('general');
  ups(dir, 'bonjour', { cwd: 'C:\\tmp\\ailleurs' });
  assert.ok(fs.existsSync(path.join(dir, '.etat', '_general.claude.json')));
  ups(dir, 'suite', { cwd: CWD_PROJET, prompt_id: 'p-2' });
  assert.deepEqual(Object.keys(etat(dir, '_general').demandes), ['M-0001', 'M-0002']);
  assert.ok(!fs.existsSync(path.join(dir, '.etat', `${PROJET}.claude.json`)));
});

test('task-notification ignorée', () => {
  const dir = dossier('task-notification');
  const r = ups(dir, '  \n<task-notification> <task-id>b1</task-id> terminé');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(!fs.existsSync(path.join(dir, '.etat')));
});

test('sous-agent (agent_id) ignoré sur UserPromptSubmit, PostToolUse, SessionStart et Stop', () => {
  const dir = dossier('sous-agent');
  const r = ups(dir, 'message de sous-agent', { agent_id: 'a123' });
  assert.equal(r.out, '');
  assert.ok(!fs.existsSync(path.join(dir, '.etat')));
  const id = preparerLigne(dir);
  const p = postWrite(dir, histoire(dir), `- fini [ctx ${id}]\n`, { agent_id: 'a123' });
  assert.equal(p.out, '');
  assert.equal(etat(dir).lignes[id].statut, 'ouvert');
  assert.equal(hook(dir, { hook_event_name: 'SessionStart', session_id: 's-x', cwd: CWD_PROJET, source: 'startup', agent_id: 'a1' }).out, '');
  assert.equal(hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: 'p-1', agent_id: 'a1', stop_hook_active: false }).out, '');
});

test('ajouter crée C lié à M', () => {
  const dir = dossier('ajouter');
  ups(dir, 'Refais la page contact');
  const a = cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Refaire la page contact (texte "exact")']);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /C-0001 ajouté/);
  const e = etat(dir);
  assert.equal(e.lignes['C-0001'].texte, 'Refaire la page contact (texte "exact")');
  assert.equal(e.lignes['C-0001'].de, 'M-0001');
  assert.equal(e.lignes['C-0001'].statut, 'ouvert');
  assert.equal(e.demandes['M-0001'].statut, 'converti');
  assert.deepEqual(e.demandes['M-0001'].lignes, ['C-0001']);
  const v = vue(dir);
  assert.match(v, /## Ouvert\n- C-0001 \| [^|]+ \| de M-0001 \| « Refaire la page contact \(texte "exact"\) » \| état : ouvert\n## Bloqué : attend l'utilisateur/);
  assert.ok(!/- M-0001/.test(v), 'M converti ne doit plus être à trier');
  const b = cli(dir, ['ajouter', '--projet', PROJET, 'travail découvert en route']);
  assert.equal(b.code, 0, b.err);
  assert.equal(etat(dir).lignes['C-0002'].de, null);
  const c = cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0099', 'x']);
  assert.notEqual(c.code, 0);
});

test('vue .md : en-têtes exacts', () => {
  const dir = dossier('entetes');
  preparerLigne(dir);
  const lignes = vue(dir).split('\n');
  assert.equal(lignes[0], `# Contexte - ${PROJET} - claude`);
  assert.equal(lignes[1], '<!-- Géré par les hooks context-ledger. Ne jamais supprimer une ligne à la main : seule une preuve [ctx C-NNNN] (historique, mémoire ou commit) la retire. Toute ligne effacée est restaurée. -->');
  assert.equal(lignes[2], '## À trier (messages de l\'utilisateur pas encore transformés en travail)');
  assert.ok(lignes.includes('## Ouvert'));
  assert.ok(lignes.includes('## Bloqué : attend l\'utilisateur'));
  assert.ok(lignes.includes('## Abandonné par l\'utilisateur (trace, sur ordre explicite)'));
});

test('Write sur history avec [ctx C-x] : fait + retiré de la vue', () => {
  const dir = dossier('preuve-write');
  const id = preparerLigne(dir);
  const r = postWrite(dir, histoire(dir), `## 2026-09-24 | fix | bouton\n- corrigé [ctx ${id}]\n`);
  assert.equal(r.code, 0);
  const ctx = contexte(r);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx, new RegExp(`Retiré sur preuve .*${id}`));
  const l = etat(dir).lignes[id];
  assert.equal(l.statut, 'fait');
  assert.ok(l.preuve.includes('history'));
  assert.ok(!vue(dir).includes(id), 'une ligne faite ne doit plus apparaître dans la vue');
  assert.ok(journal(dir).some(j => j.evt === 'fait' && j.id === id && j.preuve.includes('history')));
});

test('Edit sur Memory-Auto et MultiEdit sur la mémoire projet : preuves reconnues (séparateurs / et \\)', () => {
  const dir = dossier('preuve-edit');
  preparerLigne(dir);
  cli(dir, ['ajouter', '--projet', PROJET, 'deuxième']);
  cli(dir, ['ajouter', '--projet', PROJET, 'troisième']);
  const r1 = hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: CWD_PROJET, tool_name: 'Edit',
    tool_input: { file_path: resume(dir).replace(/\\/g, '/'), old_string: 'a', new_string: 'a\n- fait [ctx C-0002]' },
  });
  assert.match(contexte(r1), /C-0002/);
  const r2 = hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: CWD_PROJET, tool_name: 'MultiEdit',
    tool_input: { file_path: MEMOIRE_PROJET, edits: [{ old_string: 'x', new_string: 'y [ctx C-0001, C-0003]' }] },
  });
  assert.match(contexte(r2), /C-0001, C-0003/);
  const e = etat(dir);
  assert.equal(e.lignes['C-0001'].statut, 'fait');
  assert.equal(e.lignes['C-0002'].statut, 'fait');
  assert.equal(e.lignes['C-0003'].statut, 'fait');
});

test('marqueur déjà présent dans l\'ancien texte (Edit) : ne compte pas', () => {
  const dir = dossier('preuve-ancienne');
  const id = preparerLigne(dir);
  const r = hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: CWD_PROJET, tool_name: 'Edit',
    tool_input: { file_path: histoire(dir), old_string: `ancien [ctx ${id}]`, new_string: `ancien corrigé [ctx ${id}]` },
  });
  assert.equal(r.out, '');
  assert.equal(etat(dir).lignes[id].statut, 'ouvert');
});

test('fichier hors preuve (scratchpad) : ignoré', () => {
  const dir = dossier('preuve-hors');
  const id = preparerLigne(dir);
  const r = postWrite(dir, path.join(dir, 'notes.md'), `[ctx ${id}]`);
  assert.equal(r.out, '');
  assert.equal(etat(dir).lignes[id].statut, 'ouvert');
});

test('[ctx C-x partiel] : en-cours, non retiré', () => {
  const dir = dossier('partiel');
  const id = preparerLigne(dir);
  const r = postWrite(dir, histoire(dir), `- avancé [ctx ${id} partiel]\n`);
  assert.match(contexte(r), /partiel/);
  const l = etat(dir).lignes[id];
  assert.equal(l.statut, 'en-cours');
  assert.match(l.note, /^partiel/);
  assert.match(vue(dir), new RegExp(`- ${id} \\|.*état : en-cours \\| partiel`));
});

test('commit avec [ctx C-x] (dépôt git jetable) : fait', () => {
  const dir = dossier('commit');
  preparerLigne(dir);
  cli(dir, ['ajouter', '--projet', PROJET, 'seconde ligne']);
  const repo = path.join(dir, 'depot');
  const sansHooks = path.join(dir, 'hooks-vides');
  fs.mkdirSync(repo); fs.mkdirSync(sansHooks);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@context-ledger.local']);
  git(['config', 'user.name', 'Banc context-ledger']);
  git(['config', 'core.hooksPath', sansHooks]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'fix(paiement): bouton [ctx C-0001]']);
  const r = hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: repo, tool_name: 'Bash',
    tool_input: { command: 'git commit -m "fix(paiement): bouton [ctx C-0001]"' }, tool_response: { stdout: '' },
  });
  assert.match(contexte(r), /Retiré sur preuve \(commit [0-9a-f]{40}/);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'fait');
  assert.match(etat(dir).lignes['C-0001'].preuve, /^commit [0-9a-f]{40}/);
  // Forme cd "<dépôt>" && git commit -F <fichier> (message hors ligne de commande), outil PowerShell.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'msg.txt'), 'feat: seconde\r\n\r\nCorps [ctx C-0002]\r\n');
  git(['add', 'b.txt']);
  git(['commit', '-q', '-F', path.join(dir, 'msg.txt')]);
  const r2 = hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: dir, tool_name: 'PowerShell',
    tool_input: { command: `cd "${repo}" && git commit -F msg.txt` },
  });
  assert.match(contexte(r2), /C-0002/);
  assert.equal(etat(dir).lignes['C-0002'].statut, 'fait');
  // Commande sans commit : rien.
  assert.equal(hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git status' },
  }).out, '');
});

test('ID d\'un autre agent ignoré', () => {
  const dir = dossier('autre-agent');
  const idCodex = avecRacine(dir, () => core.ajouterLigne({ projet: PROJET, agent: 'codex', texte: 'ligne de Codex', de: null }));
  preparerLigne(dir);
  const r = postWrite(dir, histoire(dir), `- [ctx ${idCodex}]\n`);
  assert.equal(r.out, '');
  assert.equal(etat(dir, PROJET, 'codex').lignes[idCodex].statut, 'ouvert');
  assert.equal(etat(dir).lignes['C-0002'].statut, 'ouvert');
  assert.ok(!Object.keys(etat(dir).lignes).includes(idCodex));
});

test('ligne effacée à la main du .md : restaurée au passage suivant (restauration)', () => {
  const dir = dossier('restauration');
  const id = preparerLigne(dir);
  const f = path.join(dir, `${PROJET}.claude.md`);
  const amputee = vue(dir).split('\n').filter(l => !l.includes(id)).join('\n');
  fs.writeFileSync(f, amputee);
  assert.ok(!vue(dir).includes(id));
  const r = hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-2', cwd: CWD_PROJET, source: 'resume' });
  assert.equal(r.code, 0);
  assert.ok(vue(dir).includes(`- ${id} |`), 'la ligne effacée doit revenir');
  assert.ok(journal(dir).some(j => j.evt === 'restauration-vue'));
  fs.unlinkSync(f);
  hook(dir, { hook_event_name: 'Stop', session_id: 'sess-9', stop_hook_active: false });
  assert.ok(vue(dir).includes(`- ${id} |`), 'une vue supprimée doit revenir');
});

test('restauration d\'une vue CRLF amputée (fichiers CRLF)', () => {
  const dir = dossier('restauration-crlf');
  const id = preparerLigne(dir);
  const f = path.join(dir, `${PROJET}.claude.md`);
  // Même contenu en CRLF : pas de réécriture inutile.
  fs.writeFileSync(f, vue(dir).replace(/\n/g, '\r\n'));
  hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-2', cwd: CWD_PROJET, source: 'resume' });
  assert.ok(vue(dir).includes('\r\n'), 'une vue identique en CRLF ne doit pas être réécrite');
  // CRLF + ligne effacée : restaurée.
  fs.writeFileSync(f, vue(dir).split('\r\n').filter(l => !l.includes(id)).join('\r\n'));
  hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-3', cwd: CWD_PROJET, source: 'compact' });
  assert.ok(vue(dir).includes(`- ${id} |`));
});

test('fichiers CRLF : preuve CRLF, citation LF contre message CRLF, texte --fichier CRLF', () => {
  const dir = dossier('crlf');
  ups(dir, 'Laisse tomber le logo\r\npour cette version, on verra plus tard');
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Refaire le logo']);
  const fichierTexte = path.join(dir, 'texte.txt');
  fs.writeFileSync(fichierTexte, '\uFEFFLigne A\r\nLigne B');
  const a = cli(dir, ['ajouter', '--projet', PROJET, '--fichier', fichierTexte]);
  assert.equal(a.code, 0, a.err);
  assert.equal(etat(dir).lignes['C-0002'].texte, 'Ligne A\r\nLigne B');
  assert.match(vue(dir), /« Ligne A \/ Ligne B »/);
  const r = postWrite(dir, histoire(dir), '## x\r\n- fini [ctx C-0002]\r\n');
  assert.match(contexte(r), /C-0002/);
  // Contre-ordre postérieur à la ligne , lui aussi en CRLF.
  ups(dir, 'Finalement laisse tomber le logo\r\npour cette version, on verra plus tard', { prompt_id: 'p-2' });
  const ab = cli(dir, ['abandon', '--projet', PROJET, 'C-0001', 'le logo\npour cette version']);
  assert.equal(ab.code, 0, ab.err);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'abandon-utilisateur');
});

test('garde : PreToolUse Edit/Write du .md refusé', () => {
  const dir = dossier('garde-edit');
  preparerLigne(dir);
  const md = path.join(dir, `${PROJET}.claude.md`);
  const r = preTool(dir, 'Edit', { file_path: md, old_string: 'a', new_string: 'b' });
  assert.ok(estRefuse(r), 'Edit du .md doit être refusé : ' + r.out);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /ne se modifie pas à la main/);
  assert.ok(estRefuse(preTool(dir, 'Write', { file_path: path.join(dir, '.etat', `${PROJET}.claude.json`), content: '{}' })));
  assert.ok(estRefuse(preTool(dir, 'Write', { file_path: 'C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.claude.md', content: '' })));
  assert.ok(estRefuse(preTool(dir, 'MultiEdit', { file_path: 'C:/Users/demo/.agent-memory-ledger/contexte/x.md', edits: [] })));
  assert.equal(preTool(dir, 'Write', { file_path: path.join(RUN, 'hors-racine.md'), content: '' }).out, '');
  assert.equal(preTool(dir, 'Edit', { file_path: histoire(dir), old_string: 'a', new_string: 'b' }).out, '');
});

test('garde : Bash rm / sed -i / redirection > sur la racine refusés', () => {
  const dir = dossier('garde-bash');
  const racineSlash = dir.replace(/\\/g, '/');
  const refuses = [
    ['Bash', `rm "${racineSlash}/${PROJET}.claude.md"`],
    ['Bash', `sed -i 's/C-0001//' ${racineSlash}/${PROJET}.claude.md`],
    ['Bash', `echo x > "${dir}\\${PROJET}.claude.md"`],
    ['Bash', 'rm -f C:/Users/demo/.agent-memory-ledger/contexte/x.claude.md'],
    ['Bash', 'cat ~/.agent-memory-ledger/contexte/x.md > /tmp/copie.md'],
    ['Bash', 'cat ~/.agent-memory-ledger/contexte/x.md >> ~/.agent-memory-ledger/contexte/y.md'],
    ['Bash', 'cd ~/.agent-memory-ledger/contexte && rm *.md'],
    ['Bash', 'cat "$(rm -rf ~/.agent-memory-ledger/contexte)"'],
    ['Bash', 'node -e "require(\'fs\').writeFileSync(\'C:/Users/demo/.agent-memory-ledger/contexte/x.md\', \'\')"'],
    ['PowerShell', 'Remove-Item C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md'],
    ['PowerShell', 'Get-Content C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md | Set-Content C:\\Users\\demo\\.agent-memory-ledger\\contexte\\y.md'],
    ['mcp__Windows-MCP__PowerShell', 'Set-Content -Path "C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md" -Value ""'],
  ];
  for (const [outil, command] of refuses) {
    const r = preTool(dir, outil, { command });
    assert.ok(estRefuse(r), `doit être refusé : ${command} -> ${r.out}`);
  }
});

test('garde : Bash cat sur la racine autorisé (lecture et CLI)', () => {
  const dir = dossier('garde-lecture');
  const autorises = [
    ['Bash', 'cat "C:/Users/demo/.agent-memory-ledger/contexte/projet-demo.claude.md"'],
    ['Bash', `cat "${dir.replace(/\\/g, '/')}/${PROJET}.claude.md"`],
    ['Bash', 'grep -n "C-0001" ~/.agent-memory-ledger/contexte/*.md | head -5'],
    ['Bash', 'tail -n 20 ~/.agent-memory-ledger/contexte/x.claude.journal.log 2>/dev/null'],
    ['Bash', 'ls -la C:/Users/demo/.agent-memory-ledger/contexte 2>&1'],
    ['Bash', 'cd C:/Users/demo/.agent-memory-ledger/contexte && node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js" lister --projet x'],
    ['PowerShell', 'Get-Content C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md 2>$null'],
    ['PowerShell', 'type C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md'],
    ['Bash', 'node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js" ajouter --projet x --de M-0001 "texte > avec ; séparateurs"'],
    ['Bash', 'git status'],
  ];
  for (const [outil, command] of autorises) {
    const r = preTool(dir, outil, { command });
    assert.equal(r.out, '', `doit être autorisé : ${command} -> ${r.out}`);
    assert.equal(r.code, 0);
  }
});

test('garde : sous-agent qui appelle la CLI ou touche la racine refusé', () => {
  const dir = dossier('garde-sous-agent');
  const cmdCli = 'node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js" ajouter --projet x "y"';
  const r = preTool(dir, 'Bash', { command: cmdCli }, { agent_id: 'a42' });
  assert.ok(estRefuse(r), r.out);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /orchestrateur/);
  assert.ok(estRefuse(preTool(dir, 'Bash', { command: 'cat ~/.agent-memory-ledger/contexte/x.md' }, { agent_id: 'a42' })));
  assert.ok(estRefuse(preTool(dir, 'Write', { file_path: 'C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md', content: '' }, { agent_id: 'a42' })));
  assert.equal(preTool(dir, 'Bash', { command: 'npm test' }, { agent_id: 'a42' }).out, '');
  // Sans agent_id, la même CLI passe.
  assert.equal(preTool(dir, 'Bash', { command: cmdCli }).out, '');
});

// Règle : la citation doit venir d'un message écrit APRÈS la création de la ligne.
test('abandon : citation absente ou tirée de la demande d\'origine refusée, contre-ordre postérieur accepté', () => {
  const dir = dossier('abandon');
  ups(dir, 'Corrige le bouton de paiement et refais le logo du site.');
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Refonte du logo']);
  const r1 = cli(dir, ['abandon', '--projet', PROJET, 'C-0001', 'L\'utilisateur a dit que ce n\'est plus utile']);
  assert.notEqual(r1.code, 0);
  assert.match(r1.err, /citation introuvable/);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'ouvert');
  const r2 = cli(dir, ['abandon', '--projet', PROJET, 'C-0001', 'logo']);
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /trop courte/);
  // La demande qui a créé la ligne ne peut pas servir à l'abandonner.
  const origine = cli(dir, ['abandon', '--projet', PROJET, 'C-0001', 'refais le logo du site']);
  assert.notEqual(origine.code, 0, 'la demande d\'origine ne doit pas permettre l\'abandon : ' + origine.out);
  assert.match(origine.err, /message antérieur à la ligne \(M-0001\).*après la création de C-0001/);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'ouvert');
  // Contre-ordre écrit après la création de la ligne : accepté.
  ups(dir, 'Oublie la refonte du logo, on ne la fera pas cette année.', { prompt_id: 'p-2' });
  const r3 = cli(dir, ['abandon', '--projet', PROJET, 'C-0001', 'la refonte du logo, on ne la fera pas']);
  assert.equal(r3.code, 0, r3.err);
  assert.equal(journal(dir).filter(j => j.evt === 'abandon')[0].source, 'M-0002');
  assert.equal(journal(dir).filter(j => j.evt === 'abandon-refuse').length, 3);
  const l = etat(dir).lignes['C-0001'];
  assert.equal(l.statut, 'abandon-utilisateur');
  assert.equal(l.citationUtilisateur, 'la refonte du logo, on ne la fera pas');
  const v = vue(dir);
  const iAb = v.indexOf('## Abandonné par l\'utilisateur');
  assert.ok(v.indexOf('- C-0001') > iAb, 'la ligne doit être dans la section Abandonné');
  const evts = journal(dir).map(j => j.evt);
  assert.ok(evts.includes('abandon-refuse') && evts.includes('abandon'));
});

test('CLI : sans-travail, etat, refus de « fait », lister', () => {
  const dir = dossier('cli');
  ups(dir, 'Merci, c\'est parfait');
  const s = cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'remerciement']);
  assert.equal(s.code, 0, s.err);
  assert.equal(etat(dir).demandes['M-0001'].statut, 'sans-travail');
  assert.equal(Object.keys(etat(dir).lignes).length, 0);
  cli(dir, ['ajouter', '--projet', PROJET, 'Poser la variable X']);
  const b = cli(dir, ['etat', '--projet', PROJET, 'C-0001', 'bloque-utilisateur', 'attend la clé de l\'utilisateur']);
  assert.equal(b.code, 0, b.err);
  assert.match(vue(dir), /## Bloqué : attend l'utilisateur\n- C-0001 .*état : bloque-utilisateur \| attend la clé de l'utilisateur/);
  const f = cli(dir, ['etat', '--projet', PROJET, 'C-0001', 'fait']);
  assert.notEqual(f.code, 0);
  assert.match(f.err, /aucune commande ne marque « fait »/);
  const e = cli(dir, ['etat', 'C-0001', 'en-cours', 'fait X, reste Y']);
  assert.equal(e.code, 0, e.err);
  assert.equal(etat(dir).lignes['C-0001'].note, 'fait X, reste Y');
  const l = cli(dir, ['lister', '--projet', PROJET]);
  assert.equal(l.code, 0);
  assert.match(l.out, /# Contexte - projet-demo - claude/);
  assert.match(l.out, /C-0001/);
  assert.notEqual(cli(dir, ['inconnue']).code, 0);
});

test('Stop avec stop_hook_active : rien', () => {
  const dir = dossier('stop-actif');
  ups(dir, 'Fais le déploiement');
  const r = hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: 'p-1', stop_hook_active: true, last_assistant_message: '' });
  assert.equal(r.out, '');
});

test('Stop rappelle une seule fois par prompt_id', () => {
  const dir = dossier('stop-une-fois');
  ups(dir, 'Fais le déploiement');
  const stop = (pid, msg = '') => hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: pid, stop_hook_active: false, last_assistant_message: msg });
  const r1 = stop('p-1');
  assert.equal(r1.json.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(contexte(r1), /M-0001/);
  assert.equal(stop('p-1').out, '', 'second Stop du même prompt : aucun rappel');
  // Nouveau message : nouveau rappel ; lignes du tour non citées rappelées, citées non.
  ups(dir, 'Et ajoute un test', { prompt_id: 'p-2' });
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0002', 'Ajouter un test']);
  const r2 = stop('p-2', 'J\'ai commencé.');
  assert.match(contexte(r2), /C-0001 \(ouvert\)/);
  assert.ok(!/encore à trier/.test(contexte(r2)), 'M-0002 converti : plus à trier');
  ups(dir, 'Merci', { prompt_id: 'p-3' });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0003', 'remerciement']);
  assert.equal(stop('p-3', 'Rien à faire.').out, '', 'vieilles lignes non rappelées à chaque tour');
  ups(dir, 'Encore une chose', { prompt_id: 'p-4' });
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0004', 'Chose']);
  assert.equal(stop('p-4', 'C-0002 est ouvert, je continue au prochain tour.').out, '', 'ligne citée : pas de rappel');
});

test('10 processus en parallèle : aucun ID perdu ni dupliqué', async () => {
  const dir = dossier('parallele');
  const taches = [];
  for (let i = 0; i < 10; i++) taches.push(cliAsync(dir, ['ajouter', '--projet', PROJET, `ligne parallèle ${i}`]));
  for (let i = 0; i < 10; i++) {
    taches.push(hookAsync(dir, {
      hook_event_name: 'UserPromptSubmit', session_id: `par-${i}`, prompt_id: `pp-${i}`, cwd: CWD_PROJET, prompt: `message parallèle ${i}`,
    }));
  }
  const res = await Promise.all(taches);
  res.forEach((r, i) => assert.equal(r.code, 0, `processus ${i} : ${r.err || ''}`));
  const e = etat(dir);
  const cs = Object.keys(e.lignes).sort();
  const ms = Object.keys(e.demandes).sort();
  const attendus = p => Array.from({ length: 10 }, (_, i) => `${p}-${String(i + 1).padStart(4, '0')}`);
  assert.deepEqual(cs, attendus('C'));
  assert.deepEqual(ms, attendus('M'));
  assert.equal(new Set(Object.values(e.lignes).map(l => l.texte)).size, 10);
  assert.equal(new Set(Object.values(e.demandes).map(d => d.texte)).size, 10);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.compteur'), 'utf8')), { M: 10, C: 10 });
  const restes = fs.readdirSync(path.join(dir, '.etat')).filter(n => /\.(lock|tmp)$/.test(n));
  assert.deepEqual(restes, []);
});

// Règle des documents opérationnels : le modèle doit la voir à chaque message,
// au démarrage et après compactage, y compris quand la liste est coupée au plafond.
test('règle des découvertes en route : vue au message, au démarrage et après compactage, même au plafond', () => {
  // Texte identique à REGLE_6BIS de l'adaptateur Codex (une seule formulation pour tous les agents).
  const REGLE = 'Règle : un problème trouvé en route et suivi nulle part s\'inscrit ici (ajouter sans --de) ; un travail qui suit un document opérationnel (plan à cases, audit, reste à faire) ne recopie pas ses problèmes ici, le document fait foi et un problème manquant s\'y ajoute en case ; une seule source par problème.';
  const codex = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'codex', 'context-ledger.js'), 'utf8');
  assert.ok(codex.includes(JSON.stringify(REGLE).slice(1, -1).replace(/'/g, "\\'")), 'le texte doit rester identique à celui de Codex');
  const dir = dossier('regle-decouvertes');
  const premier = contexte(ups(dir, 'Analyse le module de paiement'));
  assert.ok(premier.endsWith(REGLE), 'message : ' + premier.slice(-200));
  assert.match(premier, /Nouveau message M-0001\. Avant d'agir/);
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const s = contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: CWD_PROJET, source }));
    assert.ok(s.endsWith(REGLE), `SessionStart ${source} : ` + s.slice(-200));
    assert.match(s, /Ce fichier fait foi pour ce qui reste, pas le résumé de compactage\./);
  }
  avecRacine(dir, () => {
    for (let i = 0; i < 150; i++) core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: `ligne ${i} ` + 'x'.repeat(600), de: null });
  });
  // Au plafond : la règle et les consignes restent, des lignes « - » partent, et leur compte reste annoncé.
  const plein = contexte(ups(dir, 'Second message', { prompt_id: 'p-2' }));
  assert.ok(plein.length <= 9000, `longueur ${plein.length}`);
  assert.ok(plein.endsWith(REGLE));
  assert.match(plein, /Nouveau message M-0002\. Avant d'agir/);
  const annonce = /\((\d+) lignes de plus : node ".*context-ledger\.js" lister --projet projet-demo\)/.exec(plein);
  assert.ok(annonce, 'les lignes omises doivent être annoncées');
  const montrees = plein.split('\n').filter(l => l.startsWith('- ')).length;
  assert.equal(montrees + Number(annonce[1]), 150 + 2, 'lignes montrées + lignes annoncées = 150 lignes C + 2 messages à trier');
  const apres = contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: CWD_PROJET, source: 'compact' }));
  assert.ok(apres.length <= 9000, `SessionStart ${apres.length}`);
  assert.ok(apres.endsWith(REGLE));
  assert.match(apres, /\(\d+ lignes de plus : /);
});

test('sortie additionalContext <= 9 000 caractères, texte long tronqué avec renvoi', () => {
  const dir = dossier('plafond');
  avecRacine(dir, () => {
    for (let i = 0; i < 150; i++) core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: `ligne ${i} ` + 'x'.repeat(600), de: null });
  });
  const long = 'Demande très longue ' + 'y'.repeat(20000);
  const r = ups(dir, long);
  const ctx = contexte(r);
  assert.ok(ctx.length <= 9000, `longueur ${ctx.length}`);
  assert.match(ctx, /lignes de plus : node ".*context-ledger\.js" lister --projet projet-demo\)/);
  assert.match(ctx, /Nouveau message M-0001\. Avant d'agir/);
  assert.equal(etat(dir).demandes['M-0001'].texte, long);
  const s = hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: CWD_PROJET, source: 'compact' });
  const cs = contexte(s);
  assert.ok(cs.length <= 9000, `SessionStart ${cs.length}`);
  assert.match(cs, /Ce fichier fait foi pour ce qui reste, pas le résumé de compactage\./);
  const v = vue(dir);
  const integral = path.join(dir, `${PROJET}.claude`, 'C-0001.txt');
  assert.ok(v.includes(`(texte intégral : ${integral})`));
  assert.equal(fs.readFileSync(integral, 'utf8'), `ligne 0 ` + 'x'.repeat(600));
  assert.ok(fs.existsSync(path.join(dir, `${PROJET}.claude`, 'M-0001.txt')));
});

test('SessionStart : lie la session et réinjecte la vue', () => {
  const dir = dossier('session-start');
  preparerLigne(dir);
  const r = hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-neuve', cwd: CWD_PROJET, source: 'startup' });
  const ctx = contexte(r);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx, /C-0001/);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'claude-sess-neuve.json'), 'utf8'));
  assert.equal(s.projet, PROJET);
  hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-neuve', cwd: 'C:\\tmp', source: 'compact' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'claude-sess-neuve.json'), 'utf8')).projet, PROJET);
});

test('réconciliateur par contenu : seuls les marqueurs apparus depuis le passage précédent', () => {
  const dir = dossier('reconciliateur');
  const base = path.join(dir, 'base-claude');
  fs.mkdirSync(path.join(base, 'history'), { recursive: true });
  const h = path.join(base, 'history', 'p.codex.md');
  avecRacine(dir, () => {
    const c1 = core.ajouterLigne({ projet: PROJET, agent: 'codex', texte: 'un', de: null });
    const c2 = core.ajouterLigne({ projet: PROJET, agent: 'codex', texte: 'deux', de: null });
    fs.writeFileSync(h, `ancien [ctx ${c1}]\n`);
    const r0 = core.reconcilier({ agent: 'codex', base });
    assert.deepEqual(r0.faits, [], 'premier passage : base seulement');
    assert.equal(core.lireLedger(PROJET, 'codex').lignes[c1].statut, 'ouvert');
    fs.appendFileSync(h, `nouveau [ctx ${c2}]\r\n`);
    const r1 = core.reconcilier({ agent: 'codex', base });
    assert.deepEqual(r1.faits, [c2]);
    assert.equal(core.lireLedger(PROJET, 'codex').lignes[c1].statut, 'ouvert');
    const r2 = core.reconcilier({ agent: 'codex', base });
    assert.deepEqual(r2.faits, []);
  });
});

test('agent déduit de l\'emplacement du script', () => {
  assert.equal(core.agentDepuisChemin('C:\\outils\\agent-memory-ledger\\scripts\\claude'), 'claude');
  assert.equal(core.agentDepuisChemin('C:\\outils\\agent-memory-ledger\\scripts\\codex'), 'codex');
  assert.equal(core.agentDepuisChemin('C:\\Users\\demo\\.claude\\plugins\\cache\\x\\agent-memory-ledger\\1.0.0\\scripts\\codex'), 'codex');
  assert.equal(core.agentDepuisChemin('C:\\outils\\agent-memory-ledger\\scripts\\lib'), null);
  assert.equal(core.agentDepuisChemin('C:\\tmp\\x'), null);
});

// ---------------------------------------------------------------------------
// Contournements mesurés sur la version initiale de la garde.

const RACINE_REELLE_TXT = 'C:\\Users\\demo\\.agent-memory-ledger\\contexte';

test('garde : contournements shell refusés (& seul, <( ), ( ).Delete(), rg --pre, cd, ./ ../, 8.3, jokers, cwd)', () => {
  const dir = dossier('garde-contournements');
  const refuses = [
    ['Bash', 'cat ~/.agent-memory-ledger/contexte/x.md & rm ~/.agent-memory-ledger/contexte/x.md'],
    ['Bash', 'node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js" lister --projet x & rm -f ~/.agent-memory-ledger/contexte/.etat/x.claude.json'],
    ['Bash', 'cat <(rm -rf ~/.agent-memory-ledger/contexte)'],
    ['PowerShell', '(Get-Item C:\\Users\\demo\\.agent-memory-ledger\\contexte\\.etat\\x.claude.json).Delete()'],
    ['PowerShell', "Test-Path ([IO.File]::Delete('C:\\Users\\demo\\.agent-memory-ledger\\contexte\\.etat\\x.claude.json'))"],
    ['Bash', 'rg --pre rm . C:/Users/demo/.agent-memory-ledger/contexte'],
    ['Bash', 'cd ~/.agent-memory-ledger && rm -rf contexte'],
    ['Bash', 'rm -rf ~/.agent-memory-ledger/./contexte'],
    ['Bash', 'rm -rf ~/.agent-memory-ledger/history/../contexte'],
    ['Bash', 'rm -rf C:/Users/demo/AGENT-~1/contexte'],
    ['Bash', 'rm -rf ~/.agent-memory-ledger/context*'],
    ['Bash', 'rm -f .etat/projet-demo.claude.json', RACINE_REELLE_TXT],
    ['Bash', 'rm -rf contexte', 'C:\\Users\\demo\\.agent-memory-ledger'],
    ['Bash', 'rm -rf *', 'C:\\Users\\demo\\.agent-memory-ledger'],
  ];
  for (const [outil, command, cwd] of refuses) {
    const r = preTool(dir, outil, { command }, cwd ? { cwd } : {});
    assert.ok(estRefuse(r), `doit être refusé : ${command} (cwd ${cwd || CWD_PROJET}) -> ${r.out}`);
  }
});

test('garde : outils MCP qui visent la racine refusés, les autres non', () => {
  const dir = dossier('garde-mcp');
  assert.ok(estRefuse(preTool(dir, 'mcp__Windows-MCP__FileSystem', { mode: 'delete', path: `${RACINE_REELLE_TXT}\\.etat\\x.claude.json` })));
  assert.ok(estRefuse(preTool(dir, 'mcp__Windows-MCP__MultiEdit', { path: 'C:/Users/demo/.agent-memory-ledger/contexte/.etat/x.claude.json', edits: [] })));
  assert.equal(preTool(dir, 'mcp__Windows-MCP__FileSystem', { mode: 'read', path: 'C:\\travail\\x\\README.md' }).out, '');
});

test('garde : sous-agent, node context-ledger sans .js et require du noyau refusés, banc autorisé', () => {
  const dir = dossier('garde-sous-agent-2');
  const sa = { agent_id: 'a77' };
  assert.ok(estRefuse(preTool(dir, 'Bash', { command: 'cd C:/outils/agent-memory-ledger/scripts/claude && node context-ledger ajouter --projet x "y"' }, sa)));
  assert.ok(estRefuse(preTool(dir, 'Bash', { command: `node -e "require('C:/outils/agent-memory-ledger/scripts/lib/context-ledger-core.js').ajouterLigne({projet:'x',agent:'claude',texte:'y'})"` }, sa)));
  assert.equal(preTool(dir, 'Bash', { command: 'cd C:/outils/agent-memory-ledger && node --test tests/context-ledger-claude.test.js' }, sa).out, '');
  assert.equal(preTool(dir, 'Bash', { command: 'grep -n "gardeOutil" C:/outils/agent-memory-ledger/scripts/lib/context-ledger-core.js' }, sa).out, '');
});

test('garde : lectures, CLI et commandes voisines toujours autorisées après durcissement', () => {
  const dir = dossier('garde-autorises-2');
  const autorises = [
    ['Bash', 'cd C:/Users/demo/.agent-memory-ledger/contexte && node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js" ajouter --projet x --de M-0001 "A & B (c) ; d > e | f"'],
    ['Bash', 'git commit -m "feat(contexte): fichier contexte"'],
    ['Bash', 'rg -n "C-0001" C:/Users/demo/.agent-memory-ledger/contexte'],
    ['Bash', 'node --test tests/context-ledger-claude.test.js', 'C:\\outils\\agent-memory-ledger'],
    ['Bash', 'ls -la *', 'C:\\Users\\demo\\.agent-memory-ledger'],
    ['Bash', 'rm -f contexte-notes.txt', 'C:\\Users\\demo\\.agent-memory-ledger\\history'],
    ['PowerShell', 'Get-ChildItem C:\\Users\\demo\\.agent-memory-ledger\\contexte -Recurse 2>&1'],
  ];
  for (const [outil, command, cwd] of autorises) {
    const r = preTool(dir, outil, { command }, cwd ? { cwd } : {});
    assert.equal(r.out, '', `doit être autorisé : ${command} -> ${r.out}`);
  }
});

test('intégrité : état JSON supprimé par un script, ligne ouverte reconstruite depuis le journal', () => {
  const dir = dossier('integrite-supprime');
  const id = preparerLigne(dir);
  fs.unlinkSync(path.join(dir, '.etat', `${PROJET}.claude.json`));
  ups(dir, 'Autre chose', { prompt_id: 'p-2' });
  const e = etat(dir);
  assert.equal(e.lignes[id].statut, 'ouvert', 'la ligne ouverte doit revenir depuis le journal');
  assert.equal(e.lignes[id].texte, 'Corriger le bouton de paiement');
  assert.ok(e.demandes['M-0002'], 'le nouveau message est aussi enregistré');
  assert.ok(vue(dir).includes(`- ${id} |`));
  assert.ok(journal(dir).some(j => j.evt === 'restauration-etat' && j.ids.includes(id)));
});

test('intégrité : JSON modifié hors commande (fait sans preuve, texte vidé, statut inconnu), lignes revenues', () => {
  const dir = dossier('integrite-modifie');
  preparerLigne(dir);
  cli(dir, ['ajouter', '--projet', PROJET, 'Deuxième ligne']);
  cli(dir, ['ajouter', '--projet', PROJET, 'Troisième ligne']);
  const f = path.join(dir, '.etat', `${PROJET}.claude.json`);
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  e.lignes['C-0001'].statut = 'fait'; e.lignes['C-0001'].preuve = 'faux';
  e.lignes['C-0002'].texte = '';
  e.lignes['C-0003'].statut = 'archive';
  fs.writeFileSync(f, JSON.stringify(e, null, 2));
  hook(dir, { hook_event_name: 'Stop', session_id: 'sess-9', stop_hook_active: false, last_assistant_message: '' });
  const apres = etat(dir);
  assert.equal(apres.lignes['C-0001'].statut, 'ouvert');
  assert.equal(apres.lignes['C-0002'].texte, 'Deuxième ligne');
  assert.equal(apres.lignes['C-0003'].statut, 'ouvert');
  const v = vue(dir);
  for (const id of ['C-0001', 'C-0002', 'C-0003']) assert.ok(v.includes(`- ${id} |`), `${id} doit être dans la vue`);
  // Une vraie preuve reste le seul chemin vers « fait » : elle marche toujours après la réparation.
  assert.match(contexte(postWrite(dir, histoire(dir), '- fini [ctx C-0001]\n')), /Retiré sur preuve/);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'fait');
});

test('intégrité : JSON illisible mis de côté, reconstruit, et le message de l\'utilisateur enregistré', () => {
  const dir = dossier('integrite-illisible');
  const id = preparerLigne(dir);
  fs.writeFileSync(path.join(dir, '.etat', `${PROJET}.claude.json`), '{ "projet": "projet-demo", "lignes": { "C-0001": ');
  const r = ups(dir, 'Message important : déploie la version 3', { prompt_id: 'p-2' });
  assert.match(contexte(r), /Nouveau message M-0002/);
  const e = etat(dir);
  assert.equal(e.demandes['M-0002'].texte, 'Message important : déploie la version 3');
  assert.equal(e.lignes[id].statut, 'ouvert');
  assert.ok(fs.readdirSync(path.join(dir, '.etat')).some(n => n.includes('.json.illisible-')), 'le JSON illisible est gardé de côté');
});

test('intégrité : JSON illisible SANS journal, jamais remplacé par un état vide, message signalé', () => {
  const dir = dossier('integrite-illisible-sans-journal');
  preparerLigne(dir);
  const f = path.join(dir, '.etat', `${PROJET}.claude.json`);
  const casse = '{ "projet": "projet-demo", "lignes": { "C-0001": ';
  fs.writeFileSync(f, casse);
  fs.unlinkSync(path.join(dir, `${PROJET}.claude.journal.log`));
  const r = ups(dir, 'Message pendant la panne', { prompt_id: 'p-2' });
  assert.match(contexte(r), /n'a PAS pu être enregistré.*journal absent/);
  assert.equal(fs.readFileSync(f, 'utf8'), casse, 'le JSON illisible reste en place pour réparation');
  assert.ok(vue(dir).includes('- C-0001 |'), 'la vue garde la ligne');
});

test('compteur remis à zéro : aucune ligne existante écrasée', () => {
  const dir = dossier('compteur-arriere');
  const id = preparerLigne(dir);
  fs.writeFileSync(path.join(dir, '.compteur'), '{"M":0,"C":0}\n');
  const a = cli(dir, ['ajouter', '--projet', PROJET, 'Nouvelle ligne']);
  assert.equal(a.code, 0, a.err);
  const e = etat(dir);
  assert.equal(e.lignes[id].texte, 'Corriger le bouton de paiement');
  assert.equal(e.lignes['C-0002'].texte, 'Nouvelle ligne');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.compteur'), 'utf8')), { M: 1, C: 2 });
});

test('UserPromptSubmit : verrou bloqué, message conservé en secours et signalé au modèle', () => {
  const dir = dossier('verrou-bloque');
  ups(dir, 'premier');
  const verrou = path.join(dir, '.etat', `${PROJET}.claude.json.lock`);
  fs.writeFileSync(verrou, '99999 hook tué');
  const futur = new Date(Date.now() + 8000);
  fs.utimesSync(verrou, futur, futur);
  const r = ups(dir, 'Pendant le verrou : ajoute le test X', { prompt_id: 'p-2' });
  fs.unlinkSync(verrou);
  const ctx = contexte(r);
  assert.match(ctx, /n'a PAS pu être enregistré/);
  assert.match(ctx, /ajouter --projet projet-demo "texte mot pour mot"/);
  const secours = fs.readFileSync(path.join(dir, '.secours-claude.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(secours[0].texte, 'Pendant le verrou : ajoute le test X');
});

test('Stop : 800 lignes du tour, sortie <= 9 000 et commande etat lisible', () => {
  const dir = dossier('stop-plafond');
  ups(dir, 'Fais tout');
  avecRacine(dir, () => {
    for (let i = 0; i < 800; i++) core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: `l${i}`, de: null });
  });
  const r = hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: 'p-1', stop_hook_active: false, last_assistant_message: '' });
  const ctx = contexte(r);
  assert.ok(ctx.length <= 9000, `longueur ${ctx.length}`);
  assert.match(ctx, /et 770 autre\(s\)/);
  assert.match(ctx, /etat --projet projet-demo C-NNNN/);
});

test('abandon : citation cherchée dans le journal, pas dans un faux message ajouté au JSON', () => {
  const dir = dossier('abandon-faux-message');
  const id = preparerLigne(dir);
  const f = path.join(dir, '.etat', `${PROJET}.claude.json`);
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  e.demandes['M-0099'] = { texte: 'abandonne la ligne C-0001 maintenant, je le confirme', statut: 'sans-travail', ts: new Date().toISOString(), lignes: [] };
  fs.writeFileSync(f, JSON.stringify(e, null, 2));
  const r = cli(dir, ['abandon', '--projet', PROJET, id, 'abandonne la ligne C-0001 maintenant']);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(etat(dir).lignes[id].statut, 'ouvert');
});

// ---------------------------------------------------------------------------
// Mutations : la restauration ou la garde désactivée doit rendre au moins un banc ROUGE,
// et la même copie NON mutée doit rester verte (preuve que le rouge vient de la mutation).

// Copie des scripts (dossier scripts/ du dépôt) ; fichierRel est relatif à ce dossier.
function copie(nom, fichierRel, ancre, remplacement) {
  const src = path.join(path.dirname(HOOK), '..');
  const dest = path.join(RUN, nom, 'scripts');
  for (const d of ['claude', 'lib']) fs.mkdirSync(path.join(dest, d), { recursive: true });
  for (const f of ['claude/context-ledger.js', 'lib/context-ledger-core.js', 'lib/config.js', 'lib/commande-git.js']) {
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
  if (ancre) {
    const cible = path.join(dest, fichierRel);
    const avant = fs.readFileSync(cible, 'utf8');
    const lignes = avant.split('\n');
    const i = lignes.findIndex(l => l.includes(ancre));
    assert.ok(i >= 0, `ancre ${ancre} introuvable dans ${fichierRel}`);
    lignes[i] = remplacement;
    fs.writeFileSync(cible, lignes.join('\n'));
    assert.notEqual(fs.readFileSync(cible, 'utf8'), avant);
  }
  return path.join(dest, 'claude', 'context-ledger.js');
}

function relancer(hookCopie, motif) {
  const env = Object.assign({}, process.env, { CONTEXT_LEDGER_HOOK: hookCopie, CONTEXT_LEDGER_EN_MUTATION: '1' });
  delete env.CONTEXT_LEDGER_DIR;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${motif}`, __filename], {
    env, encoding: 'utf8', timeout: 180000, windowsHide: true,
  });
}

test('mutation : restauration désactivée -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-restauration'), 'restaur');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-restauration', 'lib/context-ledger-core.js', 'ancre-mutation:restauration', '    continue; // MUTATION : restauration désactivée');
  const r = relancer(mutant, 'restaur');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - ligne effacée à la main du \.md/);
});

test('mutation : garde désactivée -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-garde'), 'garde');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-garde', 'claude/context-ledger.js', 'ancre-mutation:garde', '  const raison = null; // MUTATION : garde désactivée');
  const r = relancer(mutant, 'garde');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - garde : PreToolUse Edit\/Write du \.md refusé/);
  assert.match(r.stdout, /not ok \d+ - garde : Bash rm/);
  assert.match(r.stdout, /not ok \d+ - garde : sous-agent/);
});

test('mutation : intégrité (journal) désactivée -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-integrite'), 'int.grit.');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-integrite', 'lib/context-ledger-core.js', 'ancre-mutation:integrite', '  const restaures = []; // MUTATION : intégrité désactivée');
  const r = relancer(mutant, 'int.grit.');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - int.grit. : état JSON supprimé par un script/);
  assert.match(r.stdout, /not ok \d+ - int.grit. : JSON modifié hors commande/);
});

test('mutation : règle 6 bis retirée du message ou du démarrage -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-regle-6bis'), 'couvertes en route');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutantMessage = copie('mutation-regle-6bis-message', 'claude/context-ledger.js', 'ancre-mutation:regle-6bis-message', "    '', core.commandes(SCRIPT, r.projet).lister)); // MUTATION : règle retirée du message");
  const r1 = relancer(mutantMessage, 'couvertes en route');
  assert.notEqual(r1.status, 0, 'la mutation (message) doit rendre un banc rouge :\n' + r1.stdout);
  assert.match(r1.stdout, /not ok \d+ - r.gle des d.couvertes en route/);
  const mutantSession = copie('mutation-regle-6bis-session', 'claude/context-ledger.js', 'ancre-mutation:regle-6bis-session', "    '', core.commandes(SCRIPT, projet).lister)); // MUTATION : règle retirée du démarrage");
  const r2 = relancer(mutantSession, 'couvertes en route');
  assert.notEqual(r2.status, 0, 'la mutation (démarrage) doit rendre un banc rouge :\n' + r2.stdout);
  assert.match(r2.stdout, /not ok \d+ - r.gle des d.couvertes en route/);
});

// Verrou tenu par un autre processus pendant ~4,5 s (plus que les 3 s d'attente du noyau) : sans réessai,
// la commande échoue « verrou occupé » ; avec réessai, elle aboutit dès que le verrou se libère.
function verrouTenu(dir, ms) {
  const verrou = path.join(dir, '.etat', `${PROJET}.claude.json.lock`);
  fs.writeFileSync(verrou, '99999 autre session');
  const t = new Date(Date.now() - (10000 - ms)); // périmé (10 s d'âge) dans `ms` millisecondes
  fs.utimesSync(verrou, t, t);
  return verrou;
}

test('verrou occupé plus de 3 s : la CLI et le message réessaient au lieu d\'échouer', () => {
  const dir = dossier('reessai-verrou');
  ups(dir, 'premier');
  verrouTenu(dir, 4500);
  const a = cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Ligne sous charge']);
  assert.equal(a.code, 0, 'la CLI doit réessayer : ' + a.err);
  assert.equal(etat(dir).lignes['C-0001'].texte, 'Ligne sous charge');
  verrouTenu(dir, 4500);
  const r = ups(dir, 'Message envoyé pendant que le verrou est tenu', { prompt_id: 'p-2' });
  const ctx = contexte(r);
  assert.match(ctx, /Nouveau message M-0002\. Avant d'agir/);
  assert.ok(!/n'a PAS pu être enregistré/.test(ctx), 'pas de secours quand un réessai suffit');
  assert.equal(etat(dir).demandes['M-0002'].texte, 'Message envoyé pendant que le verrou est tenu');
  assert.ok(!fs.existsSync(path.join(dir, '.secours-claude.jsonl')));
});

test('mutation : réessai de la CLI ou du message désactivé -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-reessai'), 'verrou occup. plus de 3 s');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutantCli = copie('mutation-reessai-cli', 'claude/context-ledger.js', 'ancre-mutation:cli-reessai', '  while (false) { // MUTATION : réessai de la CLI désactivé');
  const r1 = relancer(mutantCli, 'verrou occup. plus de 3 s');
  assert.notEqual(r1.status, 0, 'la mutation (CLI) doit rendre un banc rouge :\n' + r1.stdout);
  assert.match(r1.stdout, /not ok \d+ - verrou occup. plus de 3 s/);
  const mutantMessage = copie('mutation-reessai-message', 'claude/context-ledger.js', 'ancre-mutation:message-reessai', '      throw e; // MUTATION : réessai du message désactivé');
  const r2 = relancer(mutantMessage, 'verrou occup. plus de 3 s');
  assert.notEqual(r2.status, 0, 'la mutation (message) doit rendre un banc rouge :\n' + r2.stdout);
  assert.match(r2.stdout, /not ok \d+ - verrou occup. plus de 3 s/);
});

// Cas réel : une commande node -e contenant « ([ev, gs]) » était refusée
// dès que le shell était placé dans .claude (crochet non fermé pris pour un joker qui viserait la racine).
test('garde : crochet non fermé depuis .claude autorisé, vrais jokers à crochets toujours refusés', () => {
  const dir = dossier('garde-crochet');
  const CLAUDE = 'C:\\Users\\demo\\.agent-memory-ledger';
  const autorises = [
    ['node -e "const plat=h=>Object.entries(h).flatMap(([ev,gs])=>gs.map(g=>ev))"', CLAUDE],
    ['cd /c/Users/demo/.agent-memory-ledger && node -e "x.map(([a,b])=>a)"', 'C:\\tmp'],
    ['ls hooks/[a', CLAUDE],
  ];
  for (const [command, cwd] of autorises) {
    const r = preTool(dir, 'Bash', { command }, { cwd });
    assert.equal(r.out, '', `doit être autorisé : ${command} (cwd ${cwd}) -> ${r.out}`);
  }
  const refuses = [
    ['rm -r ~/.agent-memory-ledger/[c]ontexte', 'C:\\tmp'],
    ['rm -r conte[x]te', CLAUDE],
    ['rm -r cont*', CLAUDE],
    ['rm -r c?ntexte', CLAUDE],
  ];
  for (const [command, cwd] of refuses) {
    const r = preTool(dir, 'Bash', { command }, { cwd });
    assert.ok(estRefuse(r), `doit être refusé : ${command} (cwd ${cwd}) -> ${r.out}`);
  }
});

test('mutation : crochet non fermé repris pour un joker -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-joker'), 'crochet non ferm');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-joker', 'lib/context-ledger-core.js', 'ancre-mutation:joker-invalide', '  } catch (_) { return true; } // MUTATION : ancien comportement');
  const r = relancer(mutant, 'crochet non ferm');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - garde : crochet non ferm/);
});

// ---------------------------------------------------------------------------
// Messages envoyés PENDANT un tour. Mesuré avec Claude Code 2.1.284, dans deux sessions réelles :
// ils déclenchent UserPromptSubmit avec le prompt_id du tour en cours, et le transcript les range en pièce
// jointe « queued_command » (origin.kind = human, commandMode = prompt). 444 messages de ce type dans une
// seule session de l'utilisateur. Ces bancs couvrent le filet : la lecture du transcript.

function transcriptDe(nom) {
  const d = path.join(RUN, nom + '-transcript');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'session.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'ancien message de début de tour' }, origin: { kind: 'human' } }) + '\n');
  return f;
}

let numeroFile = 0;
function enFile(prompt, extra = {}) {
  numeroFile++;
  return JSON.stringify({
    type: 'attachment', isSidechain: false, uuid: 'u-' + numeroFile,
    attachment: Object.assign({
      type: 'queued_command', prompt, source_uuid: 'src-' + numeroFile, commandMode: 'prompt',
      origin: { kind: 'human' }, timestamp: new Date().toISOString(),
    }, extra),
  }) + '\n';
}

function postBash(dir, transcript) {
  return hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', prompt_id: 'p-1', cwd: CWD_PROJET, transcript_path: transcript,
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {},
  });
}

function stopAvec(dir, transcript, actif = false) {
  return hook(dir, {
    hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: 'p-1', transcript_path: transcript,
    stop_hook_active: actif, last_assistant_message: '',
  });
}

test('message en file pendant un tour : enregistré mot pour mot au PostToolUse, une seule fois, faux messages ignorés', () => {
  const dir = dossier('file');
  const t = transcriptDe('file');
  // Déjà dans le transcript avant le premier passage : sert de base, jamais enregistré.
  fs.appendFileSync(t, enFile('Vieux message en file, antérieur à l\'activation'));
  assert.match(contexte(ups(dir, 'Premier message', { transcript_path: t })), /Nouveau message M-0001/);
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001']);
  // Pendant le tour : un message humain, puis tout ce qui ne doit PAS être pris pour un message de l'utilisateur.
  const texte = 'il faut pas oublié de regler = la cause du trou\r\nligne 2 : « éàü » $HOME `x`';
  fs.appendFileSync(t, enFile(texte));
  fs.appendFileSync(t, enFile('<task-notification>\n<task-id>b1</task-id>', { commandMode: 'task-notification', origin: undefined }));
  fs.appendFileSync(t, enFile('<task-notification>\n<task-id>b2</task-id>', { commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } }));
  fs.appendFileSync(t, enFile('<agent-message from="a1">\nfini', { origin: { kind: 'peer', from: 'a1' } }));
  fs.appendFileSync(t, enFile('The app was quit while you were working. Please continue from where you left off.', { origin: undefined }));
  fs.appendFileSync(t, JSON.stringify({ type: 'attachment', isSidechain: true, attachment: { type: 'queued_command', prompt: 'message dans un sous-agent', commandMode: 'prompt', origin: { kind: 'human' } } }) + '\n');
  const r1 = postBash(dir, t);
  const ctx = contexte(r1);
  assert.equal(r1.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx, /reçu\(s\) pendant ce tour, enregistré\(s\) mot pour mot : M-0002\./);
  assert.match(ctx, /Nouveau message M-0002\. Avant d'agir/);
  assert.ok(ctx.endsWith('une seule source par problème.'), 'la règle 6 bis accompagne le message : ' + ctx.slice(-120));
  const e = etat(dir);
  assert.deepEqual(Object.keys(e.demandes), ['M-0001', 'M-0002']);
  assert.equal(e.demandes['M-0002'].texte, texte);
  assert.equal(e.demandes['M-0002'].statut, 'a-trier');
  // Le tour reste celui du premier message : clé conservée, M-0002 ajouté aux messages du tour.
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'claude-sess-1.json'), 'utf8'));
  assert.ok(String(s.promptCourant).startsWith('p-1:'), 'clé du tour = prompt_id + empreinte du premier message : ' + s.promptCourant);
  assert.deepEqual(s.tourMessages, ['M-0001', 'M-0002']);
  // Deuxième passage sans rien de nouveau : rien.
  assert.equal(postBash(dir, t).out, '');
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001', 'M-0002']);
  // Ligne en cours d'écriture (pas encore de fin de ligne) : attendue, puis enregistrée une fois complète.
  const ligne = enFile('Troisième, écrit en deux fois');
  fs.appendFileSync(t, ligne.slice(0, 60));
  assert.equal(postBash(dir, t).out, '');
  fs.appendFileSync(t, ligne.slice(60));
  assert.match(contexte(postBash(dir, t)), /mot pour mot : M-0003\./);
  assert.equal(etat(dir).demandes['M-0003'].texte, 'Troisième, écrit en deux fois');
  // Message avec image : le texte est gardé, l'image signalée.
  fs.appendFileSync(t, enFile([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'regarde cette capture' }]));
  postBash(dir, t);
  assert.equal(etat(dir).demandes['M-0004'].texte, '[image jointe]\nregarde cette capture');
  // Fin de tour : tous les messages du tour encore à trier sont rappelés.
  assert.match(contexte(stopAvec(dir, t)), /encore à trier : M-0001, M-0002, M-0003, M-0004\./);
});

test('message en file : rattrapé aussi par Stop, UserPromptSubmit et SessionStart, et quand le transcript naît après', () => {
  const dir = dossier('file-evenements');
  const t = transcriptDe('file-evenements');
  ups(dir, 'Premier', { transcript_path: t });
  // Tour sans outil d'écriture : c'est le Stop qui rattrape.
  fs.appendFileSync(t, enFile('Arrivé pendant un tour de lectures seules'));
  assert.match(contexte(stopAvec(dir, t)), /encore à trier : M-0001, M-0002\./);
  assert.equal(etat(dir).demandes['M-0002'].texte, 'Arrivé pendant un tour de lectures seules');
  // Relance après le rappel (stop_hook_active) : enregistré quand même, sans sortie.
  fs.appendFileSync(t, enFile('Arrivé pendant la relance du Stop'));
  assert.equal(stopAvec(dir, t, true).out, '');
  assert.equal(etat(dir).demandes['M-0003'].texte, 'Arrivé pendant la relance du Stop');
  // Juste avant le message suivant : enregistré d'abord (ordre chronologique), puis le nouveau message.
  fs.appendFileSync(t, enFile('Arrivé juste avant le message suivant'));
  const r = contexte(ups(dir, 'Message suivant', { prompt_id: 'p-2', transcript_path: t }));
  assert.match(r, /mot pour mot : M-0004\./);
  assert.match(r, /Nouveau message M-0005\. Avant d'agir/);
  assert.equal(etat(dir).demandes['M-0004'].texte, 'Arrivé juste avant le message suivant');
  assert.equal(etat(dir).demandes['M-0005'].texte, 'Message suivant');
  // Juste avant un compactage : la liste réinjectée le contient.
  fs.appendFileSync(t, enFile('Arrivé juste avant un compactage'));
  const s = contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: CWD_PROJET, source: 'compact', transcript_path: t }));
  assert.match(s, /mot pour mot : M-0006\./);
  assert.match(s, /- M-0006 \| [^|]+ \| « Arrivé juste avant un compactage »/);
  // Session neuve dont le transcript n'existe pas encore au premier événement : rien n'est perdu ensuite.
  const dir2 = dossier('file-absent');
  const t2 = path.join(RUN, 'file-absent-transcript', 'pas-encore.jsonl');
  fs.rmSync(path.dirname(t2), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(t2), { recursive: true });
  ups(dir2, 'Premier', { transcript_path: t2 });
  fs.writeFileSync(t2, enFile('Premier message en file d\'une session neuve'));
  assert.match(contexte(postBash(dir2, t2)), /mot pour mot : M-0002\./);
  assert.equal(etat(dir2).demandes['M-0002'].texte, 'Premier message en file d\'une session neuve');
});

test('mutation : rattrapage des messages en file désactivé -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-file'), 'message en file');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-file', 'claude/context-ledger.js', 'ancre-mutation:file-rattrapage', '  return bilan; // MUTATION : rattrapage désactivé');
  const r = relancer(mutant, 'message en file');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - message en file pendant un tour/);
  assert.match(r.stdout, /not ok \d+ - message en file : rattrap/);
});

// ---------------------------------------------------------------------------
// Deux règles : abandon sur contre-ordre postérieur seulement (test « abandon »
// plus haut) ; copie de secours du journal hors de la racine.

test('mutation : abandon de nouveau possible avec la demande d\'origine -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-abandon'), 'abandon : citation absente');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-abandon', 'lib/context-ledger-core.js', 'ancre-mutation:abandon-posterieur', '  const trouvee = citant[0]; // MUTATION : la demande d\'origine suffit de nouveau');
  const r = relancer(mutant, 'abandon : citation absente');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - abandon : citation absente ou tir/);
});

function avecSecours(secours, fn) {
  const avant = process.env.CONTEXT_LEDGER_SECOURS_DIR;
  process.env.CONTEXT_LEDGER_SECOURS_DIR = secours;
  try { return fn(); } finally {
    if (avant === undefined) delete process.env.CONTEXT_LEDGER_SECOURS_DIR; else process.env.CONTEXT_LEDGER_SECOURS_DIR = avant;
  }
}

test('copie de secours : aucune sans dossier explicite ; chaîne vide = désactivé', () => {
  const dir = dossier('secours-defaut');
  const sauve = process.env.CONTEXT_LEDGER_SECOURS_DIR;
  try {
    delete process.env.CONTEXT_LEDGER_SECOURS_DIR;
    assert.equal(core.racineSecours(), null, 'sans variable : pas de copie de secours');
    process.env.CONTEXT_LEDGER_SECOURS_DIR = '';
    assert.equal(core.racineSecours(), null, 'chaîne vide = désactivé');
    process.env.CONTEXT_LEDGER_SECOURS_DIR = path.join(RUN, 'ailleurs');
    assert.equal(core.racineSecours(), path.join(RUN, 'ailleurs'));
  } finally {
    if (sauve === undefined) delete process.env.CONTEXT_LEDGER_SECOURS_DIR; else process.env.CONTEXT_LEDGER_SECOURS_DIR = sauve;
  }
  // Sans dossier de secours : aucune trace de copie, aucune alerte.
  ups(dir, 'Message sans copie');
  assert.ok(!fs.existsSync(path.join(dir, '.secours-etat.json')));
});

test('copie de secours : chaque écriture du journal est recopiée ; racine effacée ou journal supprimé, tout revient', () => {
  const dir = dossier('secours');
  const secours = path.join(RUN, 'secours-copie');
  fs.rmSync(secours, { recursive: true, force: true });
  const jp = path.join(dir, `${PROJET}.claude.journal.log`);
  const js = path.join(secours, `${PROJET}.claude.journal.log`);
  avecSecours(secours, () => {
    ups(dir, 'Corrige le bouton de paiement');
    cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Corriger le bouton']);
    cli(dir, ['ajouter', '--projet', PROJET, 'Deuxième ligne']);
    postWrite(dir, histoire(dir), '- fini [ctx C-0002]\n');
    assert.equal(fs.readFileSync(js, 'utf8'), fs.readFileSync(jp, 'utf8'), 'la copie est identique au journal');
    assert.ok(fs.readFileSync(js, 'utf8').split('\n').filter(Boolean).length >= 4);
    assert.ok(!fs.existsSync(path.join(dir, '.secours-etat.json')));
    // Sinistre : la racine entière est effacée (état, journal, compteur, sessions).
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = ups(dir, 'Message après le sinistre', { prompt_id: 'p-2', session_id: 'sess-2' });
    const e = etat(dir);
    assert.equal(e.lignes['C-0001'].statut, 'ouvert');
    assert.equal(e.lignes['C-0001'].texte, 'Corriger le bouton');
    assert.equal(e.lignes['C-0002'].statut, 'fait');
    assert.equal(e.demandes['M-0001'].texte, 'Corrige le bouton de paiement');
    assert.equal(e.demandes['M-0002'].texte, 'Message après le sinistre', 'la numérotation reprend sans rien écraser');
    assert.match(contexte(r), /- C-0001 \|/);
    assert.ok(vue(dir).includes('- C-0001 |'));
    assert.ok(journal(dir).some(j => j.evt === 'restauration-journal' && j.raison === 'journal principal absent'));
    // Journal seul supprimé (état intact) : rétabli en entier à l'écriture suivante.
    fs.unlinkSync(jp);
    assert.equal(cli(dir, ['ajouter', '--projet', PROJET, 'Troisième ligne']).code, 0);
    assert.equal(journal(dir).filter(j => j.evt === 'ajout').length, 3, 'les anciens ajouts sont revenus dans le journal principal');
    assert.ok(journal(dir).some(j => j.evt === 'restauration-journal' && j.raison === 'journal principal amputé'));
    assert.equal(fs.readFileSync(js, 'utf8'), fs.readFileSync(jp, 'utf8'));
  });
});

test('copie de secours en panne : l\'écriture principale réussit, la panne est signalée, puis la copie rattrape', () => {
  const dir = dossier('secours-panne');
  const bloque = path.join(RUN, 'secours-bloque');
  fs.rmSync(bloque, { recursive: true, force: true });
  fs.writeFileSync(path.join(RUN, 'secours-bloque-parent'), 'un fichier, pas un dossier');
  const impossible = path.join(RUN, 'secours-bloque-parent', 'copie');
  const demarrage = () => contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: CWD_PROJET, source: 'startup' }));
  avecSecours(impossible, () => {
    assert.match(contexte(ups(dir, 'Message pendant la panne')), /Nouveau message M-0001/);
    assert.equal(etat(dir).demandes['M-0001'].texte, 'Message pendant la panne');
    assert.match(demarrage(), /ATTENTION : la copie de secours du fichier contexte est en panne depuis/);
  });
  avecSecours(bloque, () => {
    assert.equal(cli(dir, ['ajouter', '--projet', PROJET, 'Après réparation']).code, 0);
    assert.equal(
      fs.readFileSync(path.join(bloque, `${PROJET}.claude.journal.log`), 'utf8'),
      fs.readFileSync(path.join(dir, `${PROJET}.claude.journal.log`), 'utf8'), 'la copie rattrape tout le journal');
    assert.ok(!fs.existsSync(path.join(dir, '.secours-etat.json')));
    assert.ok(!/ATTENTION : la copie de secours/.test(demarrage()));
  });
});

test('mutation : copie de secours ou restauration désactivée -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-secours'), 'copie de secours : chaque');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const sansCopie = copie('mutation-secours-copie', 'lib/context-ledger-core.js', 'ancre-mutation:secours-copie', '  return; // MUTATION : copie de secours désactivée');
  const r1 = relancer(sansCopie, 'copie de secours : chaque');
  assert.notEqual(r1.status, 0, 'la mutation (copie) doit rendre un banc rouge :\n' + r1.stdout);
  assert.match(r1.stdout, /not ok \d+ - copie de secours : chaque/);
  const sansRestauration = copie('mutation-secours-restauration', 'lib/context-ledger-core.js', 'ancre-mutation:secours-restauration', '  const perdues = []; // MUTATION : restauration depuis la copie désactivée');
  const r2 = relancer(sansRestauration, 'copie de secours : chaque');
  assert.notEqual(r2.status, 0, 'la mutation (restauration) doit rendre un banc rouge :\n' + r2.stdout);
  assert.match(r2.stdout, /not ok \d+ - copie de secours : chaque/);
});

// ---------------------------------------------------------------------------
// Cause d'une perte de messages, mesurée dans deux sessions réelles : un message envoyé PENDANT un tour déclenche
// UserPromptSubmit avec le prompt_id du tour en cours. Le dédoublonnage par prompt_id seul le jetait ; et la
// lecture du transcript pouvait l'enregistrer une seconde fois (cas réel : deux M pour un seul message).

test('UserPromptSubmit pendant un tour (même prompt_id, texte différent) : enregistré et ajouté au tour', () => {
  const dir = dossier('meme-prompt-id');
  assert.match(contexte(ups(dir, 'Premier message du tour')), /Nouveau message M-0001/);
  const r = ups(dir, 'Second message, envoyé pendant le tour');
  assert.match(contexte(r), /Nouveau message M-0002\. Avant d'agir/);
  const e = etat(dir);
  assert.equal(e.demandes['M-0002'].texte, 'Second message, envoyé pendant le tour');
  // Même prompt_id ET même texte : c'est le même message, un seul M.
  assert.equal(ups(dir, 'Second message, envoyé pendant le tour').out, '');
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001', 'M-0002']);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'claude-sess-1.json'), 'utf8'));
  assert.deepEqual(s.tourMessages, ['M-0001', 'M-0002'], 'le second message s\'ajoute au tour');
  // Tour suivant (nouveau prompt_id) : nouveau tour.
  ups(dir, 'Message du tour suivant', { prompt_id: 'p-2' });
  const s2 = JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'claude-sess-1.json'), 'utf8'));
  assert.deepEqual(s2.tourMessages, ['M-0003']);
});

test('un message, un seul M : transcript puis UserPromptSubmit, et UserPromptSubmit puis transcript', () => {
  const dir = dossier('un-seul-m');
  const t = transcriptDe('un-seul-m');
  ups(dir, 'Premier', { transcript_path: t });
  // Ordre mesuré en réel : le message en file est écrit dans le transcript, PUIS UserPromptSubmit tourne.
  fs.appendFileSync(t, enFile('les futures agents seront des sonnet 5.5'));
  const r = ups(dir, 'les futures agents seront des sonnet 5.5', { transcript_path: t });
  assert.match(contexte(r), /Nouveau message M-0002\. Avant d'agir/);
  assert.equal(postBash(dir, t).out, '', 'la lecture suivante du transcript ne doit rien ré-enregistrer');
  assert.deepEqual(Object.values(etat(dir).demandes).map(d => d.texte), ['Premier', 'les futures agents seront des sonnet 5.5']);
  // Ordre inverse : UserPromptSubmit enregistre d'abord, la pièce jointe apparaît ensuite dans le transcript.
  ups(dir, '2 agents ont fini ne les oublie pas', { transcript_path: t });
  fs.appendFileSync(t, enFile('2 agents ont fini ne les oublie pas'));
  assert.equal(postBash(dir, t).out, '');
  assert.equal(stopAvec(dir, t, true).out, '');
  assert.deepEqual(Object.values(etat(dir).demandes).map(d => d.texte), ['Premier', 'les futures agents seront des sonnet 5.5', '2 agents ont fini ne les oublie pas']);
  // Un même texte renvoyé plus tard dans un AUTRE tour reste un nouveau message.
  ups(dir, 'continue', { prompt_id: 'p-2', transcript_path: t });
  ups(dir, 'continue', { prompt_id: 'p-3', transcript_path: t });
  assert.equal(Object.values(etat(dir).demandes).filter(d => d.texte === 'continue').length, 2);
});

test('--projet indiqué : une ligne d\'un autre projet n\'est jamais modifiée', () => {
  const dir = dossier('projet-strict');
  ups(dir, 'Message du projet de démonstration');
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Ligne du projet de démonstration']);
  cli(dir, ['ajouter', '--projet', '_general', 'Ligne du projet général']);
  const r = cli(dir, ['etat', '--projet', '_general', 'C-0001', 'bloque-utilisateur', 'note posée par erreur']);
  assert.notEqual(r.code, 0, 'devait refuser : ' + r.out);
  assert.match(r.err, /C-0001 n'est pas dans le projet _general : il est dans le projet projet-demo/);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'ouvert');
  assert.equal(etat(dir).lignes['C-0001'].note, null);
  assert.notEqual(cli(dir, ['sans-travail', '--projet', '_general', 'M-0001', 'x']).code, 0);
  // Sans --projet, ou avec le bon projet : accepté.
  assert.equal(cli(dir, ['etat', 'C-0001', 'en-cours', 'ok']).code, 0);
  assert.equal(cli(dir, ['etat', '--projet', '_general', 'C-0002', 'en-cours', 'ok']).code, 0);
});

test('mutation : clé par prompt_id seul, doublon du transcript, ou projet non vérifié -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-cle'), 'pendant un tour .m.me prompt_id|un message, un seul M|--projet indiqu');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const m1 = copie('mutation-cle-message', 'claude/context-ledger.js', 'ancre-mutation:cle-message', '  return input.prompt_id; // MUTATION : ancienne clé (prompt_id seul)');
  const r1 = relancer(m1, 'pendant un tour .m.me prompt_id');
  assert.match(r1.stdout, /not ok \d+ - UserPromptSubmit pendant un tour/);
  assert.notEqual(r1.status, 0, 'la mutation (clé) doit rendre un banc rouge :\n' + r1.stdout);
  const m2 = copie('mutation-file-doublon', 'claude/context-ledger.js', 'ancre-mutation:file-doublon', '    // MUTATION : vérification du doublon retirée');
  const r2 = relancer(m2, 'un message, un seul M');
  assert.notEqual(r2.status, 0, 'la mutation (doublon) doit rendre un banc rouge :\n' + r2.stdout);
  assert.match(r2.stdout, /not ok \d+ - un message, un seul M/);
  const m3 = copie('mutation-projet-strict', 'lib/context-ledger-core.js', 'ancre-mutation:projet-strict', '  // MUTATION : projet indiqué non vérifié');
  const r3 = relancer(m3, '--projet indiqu');
  assert.notEqual(r3.status, 0, 'la mutation (projet) doit rendre un banc rouge :\n' + r3.stdout);
  assert.match(r3.stdout, /not ok \d+ - --projet indiqu/);
});

// ---------------------------------------------------------------------------
// Livraisons des sous-agents. Mesuré dans une session réelle : 443 fins de
// sous-agents, 301 arrivées pendant que l'orchestrateur travaillait, 248 jamais reprises ensuite.
// Formes des payloads : relevées dans les transcripts de Claude Code 2.1.284.

function lancementAgent(dir, agentId, description, extra = {}) {
  return hook(dir, Object.assign({
    hook_event_name: 'PostToolUse', session_id: 'sess-1', prompt_id: 'p-1', cwd: CWD_PROJET, tool_name: 'Agent',
    tool_input: { description, subagent_type: 'general-purpose', prompt: 'fais X', run_in_background: true },
    tool_response: { isAsync: true, status: 'async_launched', agentId, description, outputFile: `C:\\tmp\\tasks\\${agentId}.output` },
  }, extra));
}

function notificationFin(id, statut = 'completed', titre = 'x') {
  return `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:\\tmp\\tasks\\${id}.output</output-file>\n<status>${statut}</status>\n<summary>Agent "${titre}" finished</summary>\n<result>rapport</result>\n</task-notification>`;
}

function finDeTour(dir, t, promptId, reponse, actif = false) {
  return hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: promptId, transcript_path: t, stop_hook_active: actif, last_assistant_message: reponse });
}

test('sous-agent en arrière-plan : une ligne le suit, sa fin la marque « à traiter », le rappel revient à chaque fin de tour', () => {
  const dir = dossier('livraisons');
  const t = transcriptDe('livraisons');
  ups(dir, 'Lance deux agents et continue le reste', { transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'suivi par les lignes des agents']);
  const a = lancementAgent(dir, 'a1111111111111111', 'Lot A : export PDF', { transcript_path: t });
  assert.match(contexte(a), /sous-agent « Lot A : export PDF » suivi par C-0001\./);
  lancementAgent(dir, 'a2222222222222222', 'Lot B : droits', { transcript_path: t });
  assert.equal(lancementAgent(dir, 'a1111111111111111', 'Lot A : export PDF', { transcript_path: t }).out, '', 'le même agent ne crée pas deux lignes');
  let e = etat(dir);
  assert.deepEqual(Object.keys(e.lignes), ['C-0001', 'C-0002']);
  assert.match(e.lignes['C-0001'].texte, /^\[agent\] « Lot A : export PDF » \(general-purpose, a1111111111111111\) : à sa fin, lire son résultat/);
  assert.equal(e.lignes['C-0001'].statut, 'en-cours');
  assert.match(e.lignes['C-0001'].note, /^agent en cours depuis \d{4}-/);
  // Agent synchrone (son résultat revient tout de suite à l'orchestrateur) : pas de ligne.
  assert.equal(hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: CWD_PROJET, transcript_path: t, tool_name: 'Agent',
    tool_input: { description: 'synchrone', prompt: 'x' }, tool_response: { status: 'completed', content: 'fini' },
  }).out, '');
  // Fin de tour, agents encore en cours : rien à traiter, donc pas de rappel de livraison.
  assert.ok(!/Sous-agents TERMINÉS/.test(finDeTour(dir, t, 'p-1', 'Agents lancés.').out));
  // Le premier agent finit pendant que l'orchestrateur travaille : événement SubagentStop.
  assert.equal(hook(dir, {
    hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: 'a1111111111111111', agent_type: 'general-purpose',
    stop_hook_active: false, last_assistant_message: 'rapport', transcript_path: t, agent_transcript_path: 'C:\\tmp\\a1.jsonl',
  }).out, '');
  e = etat(dir);
  assert.equal(e.lignes['C-0001'].statut, 'ouvert');
  assert.match(e.lignes['C-0001'].note, /^TERMINÉ \(terminé\) le \d{4}-[\d: -]+ : résultat à lire, vérifier et intégrer : C:\\tmp\\tasks\\a1111111111111111\.output$/);
  // Le second finit aussi ; seule la notification écrite dans le transcript le dit (filet de SubagentStop).
  fs.appendFileSync(t, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', prompt: notificationFin('a2222222222222222'), commandMode: 'task-notification' } }) + '\n');
  assert.match(contexte(postBash(dir, t)), /Sous-agent\(s\) terminé\(s\), résultat à traiter : C-0002 « Lot B : droits »/);
  assert.match(etat(dir).lignes['C-0002'].note, /^TERMINÉ \(completed\)/);
  // Tour suivant : l'orchestrateur fait autre chose et s'arrête sans avoir traité les livraisons.
  ups(dir, 'Maintenant corrige le readme', { prompt_id: 'p-2', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0002', 'fait dans le tour']);
  const r1 = contexte(finDeTour(dir, t, 'p-2', 'Readme corrigé.'));
  assert.match(r1, /^Sous-agents TERMINÉS dont le résultat n'est pas traité \(2\) : C-0001 « Lot A : export PDF » \(résultat : C:\\tmp\\tasks\\a1111111111111111\.output\) ; C-0002 « Lot B : droits »/);
  assert.match(r1, /cite \[ctx C-NNNN\] dans l'historique/);
  // Relance juste après le rappel (stop_hook_active) : rien, donc pas de boucle.
  assert.equal(finDeTour(dir, t, 'p-2', 'Readme corrigé.', true).out, '');
  // Encore un tour sans les traiter : le rappel REVIENT (une notification, elle, ne revient jamais).
  ups(dir, 'Et le changelog', { prompt_id: 'p-3', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0003', 'fait dans le tour']);
  assert.match(contexte(finDeTour(dir, t, 'p-3', 'Changelog fait.')), /n'est pas traité \(2\) : C-0001/);
  // La première livraison est vérifiée et prouvée : elle sort du rappel.
  postWrite(dir, histoire(dir), '- résultat de Lot A vérifié et intégré [ctx C-0001]\n', { transcript_path: t });
  ups(dir, 'Suite', { prompt_id: 'p-4', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0004', 'fait dans le tour']);
  const r2 = contexte(finDeTour(dir, t, 'p-4', 'Fini.'));
  assert.match(r2, /n'est pas traité \(1\) : C-0002 « Lot B : droits »/);
  assert.ok(!r2.includes('C-0001'));
  // L'orchestrateur dit lui-même à l'utilisateur ce qui reste : pas de rappel en plus.
  ups(dir, 'Suite 2', { prompt_id: 'p-5', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0005', 'fait dans le tour']);
  assert.equal(finDeTour(dir, t, 'p-5', 'Il reste C-0002 à vérifier, je le fais au prochain tour.').out, '');
});

test('livraisons : notification en tour séparé, workflow, agent tué, agent inconnu et lancement par un sous-agent ignorés', () => {
  const dir = dossier('livraisons-2');
  ups(dir, 'Lance un agent et un workflow');
  lancementAgent(dir, 'a3333333333333333', 'Audit des routes');
  const w = hook(dir, {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', cwd: CWD_PROJET, tool_name: 'Workflow', tool_input: { script: 'x' },
    tool_response: { status: 'async_launched', taskId: 'w123abc', taskType: 'local_workflow', workflowName: 'verif-systeme', transcriptDir: 'C:\\tmp\\wf' },
  });
  assert.match(contexte(w), /workflow « verif-systeme » suivi par C-0002\./);
  assert.match(etat(dir).lignes['C-0002'].texte, /^\[agent\] « verif-systeme » \(workflow, w123abc\)/);
  // Tour ouvert par la notification elle-même : pas un message de l'utilisateur, mais la livraison est annoncée.
  const r = ups(dir, notificationFin('a3333333333333333', 'completed', 'Audit des routes'), { prompt_id: 'p-n' });
  assert.match(contexte(r), /Sous-agent\(s\) terminé\(s\), résultat à traiter : C-0001 « Audit des routes » \(résultat : C:\\tmp\\tasks\\a3333333333333333\.output\)/);
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001'], 'une notification n\'est pas un message de l\'utilisateur');
  // Workflow tué : la ligne le dit, elle reste à traiter (constater l'échec ou relancer).
  ups(dir, notificationFin('w123abc', 'killed'), { prompt_id: 'p-n2' });
  assert.match(etat(dir).lignes['C-0002'].note, /^TERMINÉ \(killed\)/);
  assert.equal(etat(dir).lignes['C-0002'].statut, 'ouvert');
  // Agent inconnu (lancé avant l'activation, ou agent interne d'un workflow) : ignoré, aucune ligne.
  assert.equal(hook(dir, { hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: 'a9999999999999999', agent_type: 'x', stop_hook_active: false }).out, '');
  assert.equal(ups(dir, notificationFin('a8888888888888888'), { prompt_id: 'p-n3' }).out, '');
  // Lancement fait PAR un sous-agent (agent_id présent) : ignoré, seul l'orchestrateur tient la liste.
  assert.equal(lancementAgent(dir, 'a7777777777777777', 'imbriqué', { agent_id: 'a3333333333333333' }).out, '');
  assert.deepEqual(Object.keys(etat(dir).lignes), ['C-0001', 'C-0002']);
});

test('sous-agent repris après la clôture de sa ligne : une nouvelle ligne suit le nouveau résultat, une fin relue dans le transcript n\'en crée pas', () => {
  const dir = dossier('livraisons-reprise');
  const t = transcriptDe('livraisons-reprise');
  ups(dir, 'Lance un agent', { transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'suivi par la ligne de l\'agent']);
  lancementAgent(dir, 'a4444444444444444', 'Audit des prix', { transcript_path: t });
  const finEnDirect = () => hook(dir, {
    hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: 'a4444444444444444', agent_type: 'general-purpose',
    stop_hook_active: false, transcript_path: t,
  });
  finEnDirect();
  assert.match(etat(dir).lignes['C-0001'].note, /^TERMINÉ/);
  // Seconde fin alors que la ligne attend encore d'être traitée : une seule ligne par agent.
  finEnDirect();
  assert.deepEqual(Object.keys(etat(dir).lignes), ['C-0001']);
  // Résultat vérifié et prouvé : la ligne est close.
  postWrite(dir, histoire(dir), '- audit des prix intégré [ctx C-0001]\n', { transcript_path: t });
  assert.equal(etat(dir).lignes['C-0001'].statut, 'fait');
  // La notification de cette même fin n'arrive que maintenant dans le transcript : pas de nouvelle ligne.
  fs.appendFileSync(t, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', prompt: notificationFin('a4444444444444444'), commandMode: 'task-notification' } }) + '\n');
  assert.equal(postBash(dir, t).out, '');
  assert.equal(ups(dir, notificationFin('a4444444444444444'), { prompt_id: 'p-n', transcript_path: t }).out, '');
  assert.deepEqual(Object.keys(etat(dir).lignes), ['C-0001']);
  // L'agent est relancé et finit de nouveau (événement reçu en direct) : son nouveau résultat est suivi.
  finEnDirect();
  const e = etat(dir);
  assert.deepEqual(Object.keys(e.lignes), ['C-0001', 'C-0002']);
  assert.match(e.lignes['C-0002'].texte, /^\[agent\] « Audit des prix » \(general-purpose, a4444444444444444\) : nouveau résultat rendu après la clôture de C-0001, à lire, vérifier et intégrer\.$/);
  assert.equal(e.lignes['C-0002'].statut, 'ouvert');
  assert.match(e.lignes['C-0002'].note, /^TERMINÉ \(terminé\)/);
  ups(dir, 'Suite', { prompt_id: 'p-2', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0002', 'fait dans le tour']);
  assert.match(contexte(finDeTour(dir, t, 'p-2', 'Fini.')), /n'est pas traité \(1\) : C-0002 « Audit des prix »/);
});

// ---------------------------------------------------------------------------
// Réponses à un questionnaire (outil AskUserQuestion) : une décision donnée par questionnaire doit être
// enregistrée comme un message. Forme du payload : relevée dans les transcripts de Claude Code.

test('questionnaire : les réponses de l\'utilisateur sont enregistrées mot pour mot, une seule fois, et valent contre-ordre', () => {
  const dir = dossier('questionnaire');
  preparerLigne(dir);
  const payload = {
    hook_event_name: 'PostToolUse', session_id: 'sess-1', prompt_id: 'p-1', cwd: CWD_PROJET, tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q1',
    tool_input: { questions: [{ question: 'On garde le bouton de paiement ?' }] },
    tool_response: { questions: [], answers: { 'On garde le bouton de paiement ?': 'Abandonne le bouton de paiement', 'Quelles pages ?': ['Accueil', 'Contact'] } },
  };
  const r = hook(dir, payload);
  assert.match(contexte(r), /reçu\(s\) pendant ce tour, enregistré\(s\) mot pour mot : M-0002/);
  const e = etat(dir);
  assert.equal(e.demandes['M-0002'].texte, 'Réponses de l\'utilisateur à un questionnaire :\n« On garde le bouton de paiement ? » : « Abandonne le bouton de paiement »\n« Quelles pages ? » : « Accueil ; Contact »');
  assert.equal(e.demandes['M-0002'].statut, 'a-trier');
  assert.equal(hook(dir, payload).out, '', 'le même questionnaire ne crée pas deux M');
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001', 'M-0002']);
  // La décision donnée par questionnaire est écrite après la ligne : elle permet l'abandon.
  const a = cli(dir, ['abandon', '--projet', PROJET, 'C-0001', 'Abandonne le bouton de paiement']);
  assert.equal(a.code, 0, a.err);
  assert.equal(etat(dir).lignes['C-0001'].statut, 'abandon-utilisateur');
  // Questionnaire sans réponse, ou autre outil qui porte des « answers » : rien.
  assert.equal(hook(dir, Object.assign({}, payload, { tool_use_id: 'toolu_q2', tool_response: {} })).out, '');
  assert.equal(hook(dir, Object.assign({}, payload, { tool_use_id: 'toolu_q3', tool_name: 'Bash', tool_input: { command: 'ls' } })).out, '');
  assert.deepEqual(Object.keys(etat(dir).demandes), ['M-0001', 'M-0002']);
});

test('mutation : réponses de questionnaire non enregistrées -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-questionnaire'), '^questionnaire');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const r = relancer(copie('mutation-questionnaire', 'claude/context-ledger.js', 'ancre-mutation:questionnaire', '      const r = null; // MUTATION : réponses non enregistrées'), '^questionnaire');
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - questionnaire : les r/);
});

test('mutation : livraisons non inscrites, fin non marquée, rappel retiré, ou reprise non suivie -> banc rouge', { skip: EN_MUTATION }, () => {
  const motif = 'sous-agent (en arri.re-plan|repris)';
  const temoin = relancer(copie('temoin-livraisons'), motif);
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutations = [
    ['livraison-lancement', '  return null; // MUTATION : aucune ligne créée au lancement', /not ok \d+ - sous-agent en arri.re-plan/],
    ['livraison-fin', '  return null; // MUTATION : fin de sous-agent non marquée', /not ok \d+ - sous-agent en arri.re-plan/],
    ['livraison-rappel', '  const attente = []; // MUTATION : rappel des livraisons retiré', /not ok \d+ - sous-agent en arri.re-plan/],
    ['livraison-reprise', '  return null; // MUTATION : nouveau résultat après clôture non suivi', /not ok \d+ - sous-agent repris/],
  ];
  for (const [ancre, remplacement, rouge] of mutations) {
    const r = relancer(copie('mutation-' + ancre, 'lib/context-ledger-core.js', 'ancre-mutation:' + ancre, remplacement), motif);
    assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
    assert.match(r.stdout, rouge, ancre);
  }
});
