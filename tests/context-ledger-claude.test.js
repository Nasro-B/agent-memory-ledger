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
  // CONTEXT_LEDGER_BUDGET_MS : les bancs saturent eux-mêmes la machine (un processus par hook) ; le budget
  // de temps réel d'un hook n'est mesuré que par le test qui lui est dédié.
  const env = Object.assign({ CONTEXT_LEDGER_BUDGET_MS: '600000' }, process.env, { AGENT_MEMORY_LEDGER_HOME: path.dirname(dir) });
  delete env.CONTEXT_LEDGER_DIR;
  delete env.CONTEXT_LEDGER_HOOK;
  delete env.CONTEXT_LEDGER_EN_MUTATION;
  return env;
}

// plus : { node: options de node avant le script, env: variables propres à cet appel } (voir sousVerrou).
function hook(dir, payload, plus = null) {
  const r = spawnSync(process.execPath, [...(plus ? plus.node : []), HOOK], {
    input: JSON.stringify(payload), env: Object.assign(envPour(dir), plus ? plus.env : {}), encoding: 'utf8', cwd: dir, timeout: 30000, windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  return { code: r.status, out, err: r.stderr, json: out ? JSON.parse(out) : null };
}

function cli(dir, args, plus = null) {
  if (args[0] === 'ajouter' && !args.includes('--session')) args = [...args, '--session', 'sess-1'];
  const r = spawnSync(process.execPath, [...(plus ? plus.node : []), HOOK, ...args], {
    env: Object.assign(envPour(dir), plus ? plus.env : {}), encoding: 'utf8', cwd: dir, timeout: 30000, windowsHide: true,
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

function ups(dir, prompt, extra = {}, plus = null) {
  return hook(dir, Object.assign({
    hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt_id: 'p-1', cwd: CWD_PROJET, prompt,
  }, extra), plus);
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
  // Un sous-agent peut lire ce texte sans en être le destinataire (chez Codex il démarre avec une copie de
  // la conversation du parent) : la deuxième ligne dit à qui il s'adresse.
  assert.match(ctx, /^Fichier contexte \(projet projet-demo, agent claude\) : .+\nPour l'orchestrateur seulement \(un sous-agent qui lit ceci s'en tient à sa mission\)\.\n/);
  assert.ok(ctx.includes(`ajouter --projet ${PROJET} --session sess-1 --de M-0001 "texte mot pour mot"`));
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

test('sous-agent (agent_id) : son message n\'est pas un message de l\'utilisateur, sa preuve ne ferme rien, il ne reçoit jamais la liste', () => {
  const dir = dossier('sous-agent');
  // Son démarrage n'a pas été vu : son premier événement lui donne sa consigne (une fois), jamais la liste.
  const consigne = /^Fichier contexte : tu es un sous-agent\. Ta fiche : /;
  const r = ups(dir, 'message de sous-agent', { agent_id: 'a123' });
  assert.match(contexte(r), consigne);
  assert.ok(!/Nouveau message M-|À trier :|Ouvert :/.test(contexte(r)), 'ni message enregistré, ni liste');
  assert.ok(!fs.existsSync(path.join(dir, '.etat')), 'aucun message enregistré');
  const id = preparerLigne(dir);
  const p = postWrite(dir, histoire(dir), `- fini [ctx ${id}]\n`, { agent_id: 'a123' });
  assert.equal(p.out, '');
  assert.equal(etat(dir).lignes[id].statut, 'ouvert');
  const debut = contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 's-x', cwd: CWD_PROJET, source: 'startup', agent_id: 'a1' }));
  assert.match(debut, consigne);
  assert.ok(!/Ouvert :|bouton de paiement/.test(debut), 'jamais la liste de l\'orchestrateur');
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

// Règle : un sous-agent n'ÉCRIT jamais dans la liste de travail. La garde lui refusait aussi la lecture :
// mesuré dans des sessions réelles, 19 refus dans 7 sous-agents Codex et le même refus dans 23 sous-agents
// Claude Code, tous pour lire la liste ou le texte intégral d'une ligne. Commandes ci-dessous : formes
// relevées dans ces sessions.
test('garde : sous-agent : écriture et commandes d\'écriture de la CLI refusées, lecture de la racine permise', () => {
  const dir = dossier('garde-sous-agent');
  const sa = { agent_id: 'a42' };
  const R = 'C:\\Users\\demo\\.agent-memory-ledger\\contexte';
  const S = 'node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js"';
  const cmdCli = `${S} ajouter --projet x "y"`;
  const r = preTool(dir, 'Bash', { command: cmdCli }, sa);
  assert.ok(estRefuse(r), r.out);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /^Seul l'orchestrateur écrit dans le fichier contexte\. Toi, sous-agent, tu peux le LIRE/);
  // Écritures : toujours refusées, quelle que soit la forme.
  for (const cmd of [
    `Set-Content -LiteralPath '${R}\\projet-demo.claude.md' -Value x`,
    `echo x > '${R}\\projet-demo.claude.md'`,
    `rm '${R}\\projet-demo.claude.md'`,
    `$p='${R}\\x.md'; Remove-Item $p`,
    `Get-Content '${R}\\x.md' | Out-File '${R}\\y.md'`,
    `rg --pre cmd.exe x '${R}'`,
    `Get-ChildItem '${R}' | ForEach-Object { Remove-Item $_ }`,
    `Get-ChildItem '${R}' | ForEach-Object Delete`,
    `Get-ChildItem '${R}' | ForEach-Object { $_.Delete() }`,
    `Get-Content '${R}\\x.md' | ForEach-Object { $_.Line } | Set-Content '${R}\\y.md'`,
    `${S} etat --projet x C-0001 ouvert`,
    `${S} sans-travail --projet x M-0001 "raison"`,
    `${S} abandon --projet x C-0001 "citation"`,
    `git status; ${S} ajouter --projet x "y"`,
    `cat ~/.agent-memory-ledger/contexte/x.md; ${S} ajouter --projet x "y"`,
    `${S} note --fiche a99 "note dans la fiche d'un autre"`,
    `${S} note "note sans fiche"`,
  ]) assert.ok(estRefuse(preTool(dir, 'Bash', { command: cmd }, sa)), `devait refuser : ${cmd}`);
  assert.ok(estRefuse(preTool(dir, 'Write', { file_path: `${R}\\x.md`, content: '' }, sa)));
  assert.ok(estRefuse(preTool(dir, 'Edit', { file_path: `${R}\\projet-demo.claude\\fiches\\a.md`, old_string: 'a', new_string: 'b' }, sa)), 'une fiche ne se modifie que par la commande note');
  // Lectures : permises (c'est ce que la garde refusait à tort).
  for (const cmd of [
    'cat ~/.agent-memory-ledger/contexte/x.md',
    `Get-Content -LiteralPath '${R}\\projet-demo.claude.md' -TotalCount 4`,
    `$p='${R}\\projet-demo.claude.md'; Get-Content -LiteralPath $p -TotalCount 4`,
    `$root='${R}\\projet-demo.claude.md'; Select-String -LiteralPath $root -Pattern 'LGPL|fpdf2' | Select-Object -First 50`,
    `rg -n -i -l --glob 'C-*.txt' 'domain_tlds' '${R}\\projet-demo.claude'`,
    `Get-Content -LiteralPath '${R}\\projet-demo.claude\\C-0297.txt'`,
    `Get-Item -LiteralPath 'D:\\x\\a.md' | Select-Object FullName,Length; Get-ChildItem -LiteralPath '${R}' -Force | Select-Object -First 8 Name,Mode`,
    `cat "C:/Users/demo/.agent-memory-ledger/contexte/x.md" | grep -i sms | head -20`,
    `Get-Content -LiteralPath '${R}\\projet-demo.claude.md' | Select-String 'C-0461' | ForEach-Object { $_.Line }`,
    `Get-Content -LiteralPath '${R}\\projet-demo.claude.md' | Select-String -Pattern 'C-0180' | % { $_.LineNumber }`,
    `${S} lister --projet x`,
    `${S} chercher --projet x "domain_tlds" "LGPL"`,
    `${S} fiche a42`,
    `${S} note --fiche a42 "fait : lots B01 à B05 lus"`,
    `git status; ${S} lister`,
    'npm test',
  ]) assert.equal(preTool(dir, 'Bash', { command: cmd }, sa).out, '', `devait permettre : ${cmd}`);
  // Sans agent_id, la CLI d'écriture passe (l'orchestrateur).
  assert.equal(preTool(dir, 'Bash', { command: cmdCli }).out, '');
});

// Le 2026-10-02, 91 lectures restaient refusées à 12 sous-agents Codex (rejouées une à une dans la
// garde). Formes sans effet permises depuis ; celles qui peuvent exécuter autre chose restent refusées.
// Commandes ci-dessous : formes réelles, ou leur variante dangereuse.
test('garde : sous-agent : sous-expressions de lecture, blocs sans effet, Where-Object et help permis ; méthodes, appels et variables après un | refusés', () => {
  const dir = dossier('garde-sous-agent-formes');
  const R = 'C:\\Users\\demo\\.agent-memory-ledger\\contexte';
  const F = `${R}\\_general.codex\\fiches\\default-c336a1a71d78.md`;
  const S = 'node "C:/outils/agent-memory-ledger/scripts/codex/context-ledger.js"';
  const garde = command => avecRacine(dir, () => core.gardeOutil({ input: { hook_event_name: 'PreToolUse', agent_id: 'a42', tool_name: 'Bash', tool_input: { command }, cwd: CWD_PROJET } }));
  for (const cmd of [
    `$p='${F}'; (Get-Content -LiteralPath $p).Count; Get-Content -LiteralPath $p -Raw`,
    `(Get-Content -LiteralPath '${F}' | Measure-Object -Line).Lines`,
    `(Get-Content -LiteralPath '${R}\\projet-demo.claude.md' | Select-String -SimpleMatch 'B07-AI-12').Line`,
    `(Get-Content -LiteralPath '${F}')[0]`,
    `Get-Item -LiteralPath (Join-Path '${R}' 'projet-demo.claude.md') | Select-Object FullName,Length,LastWriteTime`,
    `Select-String -LiteralPath '${R}\\projet-demo.claude.md' -Pattern 'C-0130' | ForEach-Object { '{0}: {1}' -f $_.LineNumber,$_.Line }`,
    `Get-Content -LiteralPath '${F}' -ReadCount 0 | ForEach-Object { $_ }`,
    `Get-ChildItem -LiteralPath '${R}\\projet-demo.claude' -Name | Where-Object { $_ -match '^C-04' } | Sort-Object`,
    `Get-ChildItem -LiteralPath '${R}' -Directory | Where-Object Name -like '*projet*' | Select-Object -ExpandProperty FullName`,
    `Format-Hex -LiteralPath '${R}\\projet-demo.claude\\C-0121.txt' | Select-Object -First 8`,
    `Get-Content -LiteralPath '${F}' -Raw; Get-Location`,
    `& 'C:\\Program Files\\Git\\usr\\bin\\wc.exe' -l '${R}\\projet-demo.claude.md'`,
    `Get-Content '${R}\\x.md' | Select-Object -First 5 2>$null`,
    // Caractère hors du plan de base : les segments restent alignés sur la commande.
    `cat '${R}\\${String.fromCodePoint(0x1F600)} x.md' | grep -i sms`,
    `${S} help`,
  ]) assert.equal(garde(cmd), null, `devait permettre : ${cmd}`);
  for (const cmd of [
    `(Get-Item '${R}\\x.md').Delete()`,
    `Get-Item -LiteralPath $f.MoveTo(Join-Path '${R}' 'y.md')`,
    `& (Get-Content '${R}\\x.md')`,
    `&(Get-Content '${R}\\x.md')`,
    `. (Get-Content '${R}\\x.md')`,
    `(Remove-Item '${R}\\x.md')`,
    `Test-Path ([IO.File]::Delete('${R}\\x.md'))`,
    `Get-ChildItem '${R}' | Where-Object { Remove-Item $_ }`,
    `Get-ChildItem '${R}' | Where-Object $sb`,
    `Get-ChildItem '${R}' | Sort-Object $sb`,
    `Get-ChildItem '${R}' | Get-Content -Path $sb`,
    `Get-ChildItem '${R}' | Select-Object -Property (Get-Content variable:sb)`,
    `Sort-Object -InputObject (Get-ChildItem '${R}') -Property $sb`,
    `Get-Content '${R}\\x.md' | ForEach-Object { '{0}' -f (Remove-Item x) }`,
    `Get-Content '${R}\\x.md' | % { $_.Delete() }`,
    `foreach($i in 1,2){ Get-Content '${R}\\x.md' }`,
    `$x = Get-Content '${R}\\x.md'`,
    `'${R}\\x.md'`,
    `"cat x" '${R}\\x.md'`,
    `& 'C:\\Program Files\\x\\rm.exe' '${R}\\x.md'`,
    `(Get-Content '${R}\\x.md') > y.txt`,
    `cat '${R}\\x.md' ${String.fromCharCode(1)}`,
  ]) assert.ok(garde(cmd), `devait refuser : ${cmd}`);
  // Bout en bout : l'aide se lit, et le refus dit comment lire sans boucle.
  assert.equal(preTool(dir, 'Bash', { command: `${S} help` }, { agent_id: 'a42' }).out, '');
  const r = preTool(dir, 'Bash', { command: `foreach($i in 1,2){ Get-Content '${R}\\x.md' }` }, { agent_id: 'a42' });
  assert.ok(estRefuse(r), r.out);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /une par lecture, sans boucle ni script/);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /chercher C-0151 C-0152 rend ces lignes entières ; --agent claude ou --agent codex pour la liste d'un autre agent/);
  const h = cli(dir, ['help']);
  assert.equal(h.code, 0, h.err);
  assert.match(h.out, /^Usage : node context-ledger\.js <commande>/);
  assert.match(h.out, /un identifiant \(chercher C-0151 C-0152 M-0042\) rend la ligne ou le message entier/);
});

// Constat réel du 2026-10-07 : 6 écritures refusées chez 5 sous-agents qui écrivaient LEUR rapport, hors de
// la racine, parce que son texte citait la liste de travail ou la commande context-ledger ; chacun y a perdu
// un tour, trois ont écrit à l'orchestrateur. Formes ci-dessous : les commandes relevées (chemins et textes
// remplacés) et leurs variantes dangereuses. Un here-string littéral n'est inerte qu'en PowerShell, et ses
// limites sont celles de l'analyseur de PowerShell 7.6, consulté sans rien exécuter : il se ferme aussi sur
// une apostrophe typographique ou après un retour chariot seul, et collé à un mot il n'en est plus un.
test('garde : sous-agent : son rapport, écrit en PowerShell par un here-string littéral qui cite la liste, passe ; sans preuve du shell, ou si le texte ou la commande servent à autre chose, refus', () => {
  const dir = dossier('garde-rapport');
  const R = 'C:\\Users\\demo\\.agent-memory-ledger\\contexte';
  const S = 'node "C:/outils/agent-memory-ledger/scripts/codex/context-ledger.js"';
  const RAPPORT = 'D:\\travail\\rapports\\controle-g03.md';
  const TEXTE = [
    '# Contrôle G03', '',
    `- Suivi : \`C-0352\` dans \`${R}\\projet-demo.claude\\C-0352.txt\`, l'état est « bloqué » ; l\u2019interdiction tient.`,
    `- Commande : \`${S} chercher --projet projet-demo --agent claude C-0352\`.`,
    `> ${R}\\projet-demo.claude.md:322 : ligne citée ; $env:USERPROFILE et $(Get-Date) restent du texte.`,
  ].join('\n');
  const H = `@'\n${TEXTE}\n'@`;
  const juge = (tool_name, command, qui = { agent_id: 'a42' }, powershell) => avecRacine(dir, () => core.gardeOutil({
    input: Object.assign({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, cwd: CWD_PROJET }, qui), powershell,
  }));
  const permises = [
    // Les cinq formes relevées : variable puis Set-Content suivi de lectures de contrôle, garde-fou avant
    // d'écrire, here-string donné par un tube, cible nommée dans la commande.
    `$out='${RAPPORT}'; $body=${H}; Set-Content -LiteralPath $out -Value $body -Encoding utf8; Write-Output '--- WRITTEN TARGET ---'; Get-Item -LiteralPath $out | Select-Object FullName,Length; Write-Output '--- LINE COUNT ---'; & wc.exe -l $out; Get-Content -LiteralPath $out -TotalCount 1`,
    `$p = '${RAPPORT}'; if (Test-Path -LiteralPath $p) { throw 'Le rapport cible existe déjà, écriture annulée.' }; $content = ${H}; Set-Content -LiteralPath $p -Value $content -Encoding utf8; Get-Item -LiteralPath $p | Select-Object FullName,Length; (Get-Content -LiteralPath $p | Measure-Object -Line).Lines`,
    `$p='${RAPPORT}'; ${H} | Add-Content -LiteralPath $p -Encoding utf8`,
    `${H} | Add-Content -LiteralPath '${RAPPORT}' -Encoding UTF8`,
    // Variantes sans plus d'effet : valeur donnée en argument, Out-File, garde-fou sur le dossier, fins de ligne
    // Windows, et une lecture de la liste dans la même commande.
    `Set-Content -LiteralPath "${RAPPORT}" -Value ${H} -Encoding utf8 -NoNewline`,
    `${H} | Out-File -FilePath '${RAPPORT}' -Encoding utf8 -Append`,
    `$d='D:\\travail\\rapports'; if (-not (Test-Path -LiteralPath $d -PathType Container)) { throw "dossier absent" }\r\n${H} | Set-Content -LiteralPath '${RAPPORT}' -ErrorAction Stop`,
    `@'\r\n${TEXTE.replace(/\n/g, '\r\n')}\r\n'@ | Add-Content -LiteralPath '${RAPPORT}'`,
    `${H} | Add-Content -LiteralPath '${RAPPORT}'; ${S} chercher --projet projet-demo C-0352; Get-Content -LiteralPath '${R}\\projet-demo.claude\\C-0352.txt'`,
  ];
  for (const cmd of permises) {
    const court = cmd.replace(TEXTE, '<texte>').replace(TEXTE.replace(/\n/g, '\r\n'), '<texte>');
    assert.equal(juge('PowerShell', cmd), null, `devait permettre : ${court}`);
    assert.equal(juge('mcp__Windows-MCP__PowerShell', cmd), null, `devait permettre (outil MCP) : ${court}`);
    assert.equal(juge('Bash', cmd, undefined, true), null, `devait permettre (adaptateur qui prouve PowerShell) : ${court}`);
    assert.equal(juge('PowerShell', cmd, {}), null, `devait permettre à l'orchestrateur : ${court}`);
    // En bash, les mêmes caractères seraient du code : sans preuve du shell, refus comme avant.
    assert.ok(juge('Bash', cmd), `sans preuve du shell, devait refuser : ${court}`);
    assert.ok(juge('Bash', cmd, {}), `sans preuve du shell, devait refuser à l'orchestrateur : ${court}`);
  }
  const refusees = [
    // Le texte, la cible ou le reste de la commande visent la racine.
    [`${H} | Set-Content -LiteralPath '${R}\\projet-demo.claude.md'`, 'cible dans la racine'],
    [`$p='${RAPPORT}'; $p='${R}\\x.md'; ${H} | Set-Content -LiteralPath $p`, 'cible affectée deux fois'],
    [`$s=@'\n${R}\\x.md\n'@; Remove-Item -LiteralPath $s`, 'le texte sert de chemin'],
    [`$s=${H}; Set-Content -LiteralPath '${RAPPORT}' -Value $s; Invoke-Expression $s`, 'le texte est exécuté'],
    [`${H} | Set-Content -LiteralPath '${RAPPORT}'; Get-Content -LiteralPath '${RAPPORT}' | Invoke-Expression`, 'le fichier écrit est exécuté'],
    [`${H} | Set-Content -LiteralPath '${RAPPORT}'; Remove-Item -LiteralPath '${R}\\x.md'`, 'le reste efface dans la racine'],
    [`${H} | Set-Content -LiteralPath '${RAPPORT}'; ${S} ajouter --projet x "y"`, 'le reste écrit par la CLI', 'permis à l\'orchestrateur'],
    [`Set-Content -LiteralPath ${H} -Value 'x'`, 'le texte sert de cible'],
    // La cible n'est pas un fichier de texte nommé en toutes lettres.
    [`${H} | Set-Content -LiteralPath 'D:\\travail\\rapports\\suite.ps1'`, 'script'],
    [`${H} | Set-Content -LiteralPath 'rapport.md'`, 'chemin relatif'],
    [`${H} | Set-Content -LiteralPath 'Variable:\\x.md'`, 'lecteur de fournisseur'],
    [`${H} | Set-Content -Path 'D:\\travail\\*\\rapport.md'`, 'joker'],
    [`${H} | Set-Content -LiteralPath "$env:USERPROFILE\\rapport.md"`, 'variable dans le chemin'],
    [`${H} | Set-Content -LiteralPath 'D:\\travail\\rapport.md:flux.md'`, 'flux'],
    [`${H} | Set-Content -LiteralPath '\\\\serveur\\partage\\rapport.md'`, 'chemin réseau'],
    [`$p=Join-Path 'D:\\travail' 'rapport.md'; ${H} | Set-Content -LiteralPath $p`, 'cible calculée'],
    // La forme n'est pas celle qui est prouvée.
    [`@"\n${TEXTE}\n"@ | Set-Content -LiteralPath '${RAPPORT}'`, 'here-string développé'],
    [`${H} | Set-Content '${RAPPORT}'`, 'chemin sans nom de paramètre'],
    [`$s=${H}; Set-Content -LiteralPath '${RAPPORT}' -Value $s -PassThru | Invoke-Expression`, 'écriture qui continue'],
    [`${H} | ForEach-Object { $_ } | Set-Content -LiteralPath '${RAPPORT}'`, 'texte transformé avant l\'écriture'],
    [`${H} | Set-Content -LiteralPath '${RAPPORT}'; ${H} | Add-Content -LiteralPath '${RAPPORT}'`, 'deux here-strings'],
    [`Write-Output a${H} | Set-Content -LiteralPath '${RAPPORT}'`, 'here-string collé à un mot'],
    [`${H} | Set-Content -LiteralPath '${RAPPORT}' # l'ancien rapport`, 'commentaire'],
    [`[System.IO.File]::AppendAllText('${RAPPORT}', ${H})`, 'méthode .NET (forme relevée, non prouvée : l\'outil de fichier la remplace)'],
    // Ce que PowerShell lit autrement qu'une lecture naïve : pour lui, chacune de ces commandes efface x.md.
    [`Write-Output a # l'ancien\nRemove-Item '${R}\\x.md' # d'avant\n${H} | Set-Content -LiteralPath '${RAPPORT}'`, 'commentaires dont les apostrophes cachent une commande'],
    [`Write-Output 'a \u2019 ; Remove-Item -LiteralPath '${R}\\x.md' ; \u2018 b'; ${H} | Set-Content -LiteralPath '${RAPPORT}'`, 'guillemet typographique hors du texte'],
    [`${H} | Set-Content -LiteralPath 'D:\\travail\\a\u2019 ; Invoke-Expression z ; \u2018b.md'`, 'guillemet typographique dans la cible : pour PowerShell, une commande de plus'],
    [`$p='${RAPPORT}'; $s=@'\nA\n\u2019@; Remove-Item -LiteralPath '${R}\\x.md'; $t='\n'@; Set-Content -LiteralPath $p -Value $s`, 'here-string fermé par une apostrophe typographique'],
    [`$p='${RAPPORT}'; $s=@'\rA\r'@; Remove-Item -LiteralPath '${R}\\x.md'; $t='\n'@; Set-Content -LiteralPath $p -Value $s`, 'here-string fermé après un retour chariot seul'],
  ];
  for (const [cmd, pourquoi, orchestrateur] of refusees) {
    assert.ok(juge('PowerShell', cmd), `devait refuser (${pourquoi}) : ${cmd.replace(TEXTE, '<texte>')}`);
    if (orchestrateur) assert.equal(juge('PowerShell', cmd, {}), null, `${orchestrateur} (${pourquoi})`);
    else assert.ok(juge('PowerShell', cmd, {}), `devait refuser à l'orchestrateur (${pourquoi})`);
  }
  // Bout en bout par le vrai hook : l'outil PowerShell passe, l'outil Bash refuse et dit quoi faire.
  assert.equal(preTool(dir, 'PowerShell', { command: permises[2] }, { agent_id: 'a42' }).out, '');
  const r = preTool(dir, 'Bash', { command: permises[2] }, { agent_id: 'a42' });
  assert.ok(estRefuse(r), r.out);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /Si tu écrivais un fichier à toi \(rapport, notes\) dont le texte cite ce dossier ou cette commande : passe par l'outil de fichier \(apply_patch, Write\)/);
  const o = preTool(dir, 'Bash', { command: permises[2] });
  assert.ok(estRefuse(o), o.out);
  assert.match(o.json.hookSpecificOutput.permissionDecisionReason, /^Sur la racine contexte, le shell ne sert qu'à lire.*here-string littéral donné tel quel à l'écriture/);
});

// Trouvé en corrigeant le test précédent, et vérifié avec l'analyseur de PowerShell 7.6 sans rien exécuter :
// il prend une apostrophe typographique pour une apostrophe (elle ouvre et ferme une chaîne), et ne lit pas
// dans un commentaire l'apostrophe qui, pour la garde, ouvrait une chaîne et cachait la ligne suivante. Une
// commande qui avait l'air d'une lecture pouvait donc porter une écriture. Mesuré avant de refuser ces
// formes : sur 5 447 commandes exécutées par un agent en trois jours, dont 510 regardées par la garde,
// aucune ne change de verdict.
test('garde : sous-agent : ce que PowerShell lit autrement (guillemet typographique, commentaire) est refusé ; l\'apostrophe typographique d\'une note entre guillemets doubles passe', () => {
  const dir = dossier('garde-ambigue');
  const R = 'C:\\Users\\demo\\.agent-memory-ledger\\contexte';
  const S = 'node "C:/outils/agent-memory-ledger/scripts/codex/context-ledger.js"';
  const juge = (command, qui = { agent_id: 'a42' }) => avecRacine(dir, () => core.gardeOutil({ input: Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: CWD_PROJET }, qui) }));
  for (const [cmd, pourquoi] of [
    // Pour PowerShell, chacune de ces commandes efface x.md ou écrit dans la liste.
    [`Write-Output 'a \u2019 ; Remove-Item -LiteralPath '${R}\\x.md' ; \u2018 b'`, 'chaîne fermée par une apostrophe typographique'],
    [`Get-Content '${R}\\y.md' ; Write-Output \u2018a\u2019`, 'apostrophe typographique hors de toute chaîne'],
    [`Get-Content '${R}\\y.md' | Select-String "a \u201D ; Remove-Item '${R}\\x.md' ; \u201C b"`, 'chaîne fermée par un guillemet double typographique'],
    [`Get-Content '${R}\\y.md' # l'ancien\nRemove-Item '${R}\\x.md' # d'avant`, 'commentaires dont les apostrophes cachent une commande'],
  ]) {
    assert.ok(juge(cmd), `devait refuser (${pourquoi}) : ${cmd}`);
    assert.ok(juge(cmd, {}), `devait refuser à l'orchestrateur (${pourquoi})`);
  }
  // Appel de la CLI seul, sans viser la racine : la même ruse y cachait une écriture de la liste.
  assert.ok(juge(`${S} chercher --projet x 'a \u2019 ; ${S} ajouter --projet x y ; \u2018 b'`), 'CLI : chaîne fermée par une apostrophe typographique');
  // Sans effet dans les deux lectures, donc permis : le texte français d'une note ou d'un motif.
  for (const cmd of [
    `${S} note --fiche a42 "fait : l\u2019audit est lu, l\u2019\u00e9tat tient"`,
    `Get-Content -LiteralPath '${R}\\y.md' | Select-String "l\u2019\u00e9tat"`,
    `Get-Content -LiteralPath '${R}\\y.md' | Select-String '\u201Ccit\u00e9\u201D'`,
    `Select-String -LiteralPath '${R}\\y.md' -Pattern '^# Titre'`,
  ]) assert.equal(juge(cmd), null, `devait permettre : ${cmd}`);
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
  // Nouveau message non trié : nouveau rappel, pour ce message seulement.
  ups(dir, 'Et ajoute un test', { prompt_id: 'p-2' });
  const r2 = stop('p-2', 'J\'ai commencé.');
  assert.match(contexte(r2), /encore à trier : M-0002\./);
  ups(dir, 'Merci', { prompt_id: 'p-3' });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0003', 'remerciement']);
  assert.equal(stop('p-3', 'Rien à faire.').out, '', 'message trié : aucun rappel');
});

// Constaté dans des sessions réelles (2026-10-07) : le rappel « lignes créées ou modifiées pendant ce tour,
// ni faites ni citées dans ta réponse » revenait à presque chaque tour (5 tours sur 7 dans une conversation
// de dépannage, où la ligne était tenue à jour à chaque message) ; l'agent donnait une seconde réponse sans
// rien changer. La ligne reste dans la liste, qui fait foi : la fin de tour ne relance plus pour cela.
test('fin de tour : une ligne créée ou tenue à jour pendant le tour ne relance pas l\'agent, qu\'elle soit citée ou non', () => {
  const dir = dossier('stop-lignes-du-tour');
  const stop = (pid, msg = '') => hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: pid, stop_hook_active: false, last_assistant_message: msg });
  ups(dir, 'Mon partage de connexion ne marche pas');
  assert.equal(cli(dir, ['ajouter', '--projet', PROJET, '--session', 'sess-1', '--de', 'M-0001', 'Mon partage de connexion ne marche pas']).code, 0);
  assert.equal(stop('p-1', 'Vérifie d\'abord l\'adresse IP du second poste.').out, '', 'ligne ouverte du tour, non citée : pas de relance');
  ups(dir, 'toujours rien', { prompt_id: 'p-2' });
  assert.equal(cli(dir, ['sans-travail', '--projet', PROJET, 'M-0002', 'retour sur le dépannage en cours']).code, 0);
  assert.equal(cli(dir, ['etat', '--projet', PROJET, 'C-0001', 'en-cours', 'attend le résultat de ipconfig']).code, 0);
  assert.equal(stop('p-2', 'Envoie-moi le résultat de ipconfig.').out, '', 'ligne tenue à jour pendant le tour, non citée : pas de relance');
  assert.equal(stop('p-2', 'Envoie-moi le résultat de ipconfig.').out, '');
  // Rien n'est perdu : la ligne est toujours dans la liste, avec son état et sa note.
  assert.equal(etat(dir).lignes['C-0001'].statut, 'en-cours');
  assert.equal(etat(dir).lignes['C-0001'].note, 'attend le résultat de ipconfig');
  assert.match(cli(dir, ['lister', '--projet', PROJET, '--session', 'sess-1']).out, /C-0001/);
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
  // Sous très forte charge, un processus peut épuiser ses réessais sur un verrou occupé. Ce n'est pas une
  // perte : la CLI le dit et n'écrit rien, un message est gardé mot pour mot en copie de secours. Le banc
  // vérifie donc ce contrat (tout est écrit ou gardé, rien en double, numéros sans trou), au lieu d'exiger que
  // les vingt aboutissent du premier coup : constat du 2026-10-03, machine chargée, 1 message sur 10 en
  // secours, rien de perdu, banc rouge à tort.
  const clis = res.slice(0, 10);
  const hooks = res.slice(10);
  clis.forEach((r, i) => assert.ok(r.code === 0 || /verrou occupé/.test(r.err || ''), `CLI ${i} : ${r.err || ''}`));
  hooks.forEach((r, i) => assert.equal(r.code, 0, `hook ${i}`));
  const nC = clis.filter(r => r.code === 0).length;
  const fSecours = path.join(dir, '.secours-claude.jsonl');
  const secours = fs.existsSync(fSecours) ? fs.readFileSync(fSecours, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).texte) : [];
  const e = etat(dir);
  const cs = Object.keys(e.lignes).sort();
  const ms = Object.keys(e.demandes).sort();
  const attendus = (p, n) => Array.from({ length: n }, (_, i) => `${p}-${String(i + 1).padStart(4, '0')}`);
  assert.deepEqual(cs, attendus('C', nC), 'une ligne par commande aboutie, numéros sans trou');
  assert.deepEqual(ms, attendus('M', 10 - secours.length), 'un M par message enregistré, numéros sans trou');
  assert.equal(new Set(Object.values(e.lignes).map(l => l.texte)).size, nC);
  const messages = Object.values(e.demandes).map(d => d.texte).concat(secours).sort();
  assert.deepEqual(messages, Array.from({ length: 10 }, (_, i) => `message parallèle ${i}`).sort(), 'chaque message est enregistré ou gardé en secours, une seule fois');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.compteur'), 'utf8')), { M: 10 - secours.length, C: nC });
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
    for (let i = 0; i < 150; i++) core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: `ligne ${i} ` + 'x'.repeat(600), de: null, sessionId: 'sess-1' });
  });
  // Au plafond : la règle et les consignes restent, des lignes « - » partent, et leur compte reste annoncé.
  const plein = contexte(ups(dir, 'Second message', { prompt_id: 'p-2' }));
  assert.ok(plein.length <= 9000, `longueur ${plein.length}`);
  assert.ok(plein.endsWith(REGLE));
  assert.match(plein, /Nouveau message M-0002\. Avant d'agir/);
  const annonce = /\((\d+) lignes de plus : node ".*context-ledger\.js" lister --projet projet-demo --session sess-1\)/.exec(plein);
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
    for (let i = 0; i < 150; i++) core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: `ligne ${i} ` + 'x'.repeat(600), de: null, sessionId: 'sess-1' });
  });
  const long = 'Demande très longue ' + 'y'.repeat(20000);
  const r = ups(dir, long);
  const ctx = contexte(r);
  assert.ok(ctx.length <= 9000, `longueur ${ctx.length}`);
  assert.match(ctx, /lignes de plus : node ".*context-ledger\.js" lister --projet projet-demo --session sess-1\)/);
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
  assert.ok(!ctx.includes('- C-0001 |'), 'une nouvelle conversation ne reprend pas une autre mission');
  assert.equal(cli(dir, ['reprendre', '--projet', PROJET, '--session', 'sess-neuve', 'C-0001']).code, 0);
  assert.match(contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-neuve', cwd: CWD_PROJET, source: 'resume' })), /C-0001/);
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
  assert.match(ctx, /ajouter --projet projet-demo --session sess-1 "texte mot pour mot"/);
  const secours = fs.readFileSync(path.join(dir, '.secours-claude.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(secours[0].texte, 'Pendant le verrou : ajoute le test X');
});

test('Stop : message à trier et 800 lignes ouvertes pendant le tour, sortie <= 9 000 et commande de tri lisible', () => {
  const dir = dossier('stop-plafond');
  ups(dir, 'Fais tout');
  avecRacine(dir, () => {
    for (let i = 0; i < 800; i++) core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: `l${i}`, de: null, sessionId: 'sess-1' });
  });
  const r = hook(dir, { hook_event_name: 'Stop', session_id: 'sess-1', prompt_id: 'p-1', stop_hook_active: false, last_assistant_message: '' });
  const ctx = contexte(r);
  assert.ok(ctx.length <= 9000, `longueur ${ctx.length}`);
  assert.match(ctx, /encore à trier : M-0001\./);
  assert.match(ctx, /ajouter --projet projet-demo --session sess-1 --de M-0001/);
  assert.ok(!/créées ou modifiées pendant ce tour/.test(ctx), 'les lignes du tour ne sont plus énumérées en fin de tour');
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
    // Ancre entière et unique : « x » ne doit jamais désigner la ligne de « x-suite ».
    const porte = l => { const k = l.indexOf(ancre); return k >= 0 && !/[\w-]/.test(l[k + ancre.length] || ''); };
    const i = lignes.findIndex(porte);
    assert.ok(i >= 0, `ancre ${ancre} introuvable dans ${fichierRel}`);
    assert.equal(lignes.filter(porte).length, 1, `ancre ${ancre} présente plusieurs fois dans ${fichierRel}`);
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

// Verrou tenu par un autre processus pendant 5,5 s (plus que les 3 s d'attente du noyau) : sans réessai,
// la commande échoue « verrou occupé » ; avec réessai, elle aboutit dès que le verrou se libère.
// Les 5,5 s courent depuis la PREMIÈRE tentative du processus testé (aide préchargée), pas depuis son
// lancement : sans réessai l'échec tombe à 3 s, avec réessai le message abandonnerait vers 6,1 s
// (DELAI_MESSAGE_MS = 6 s). Avant, le banc posait le verrou puis lançait le processus : sous forte charge
// (2026-10-02 puis 2026-10-03, clone neuf), node démarrait après la fin du verrou et la mutation « réessai
// du message désactivé » restait verte.
const AIDE_VERROU = path.join(__dirname, 'verrou-au-premier-essai.js');
function sousVerrou(dir, ms) {
  return { node: ['--require', AIDE_VERROU], env: { AML_TEST_VERROU: path.join(dir, '.etat', `${PROJET}.claude.json.lock`), AML_TEST_VERROU_MS: String(ms) } };
}

test('verrou occupé plus de 3 s : la CLI et le message réessaient au lieu d\'échouer', () => {
  const dir = dossier('reessai-verrou');
  ups(dir, 'premier');
  const a = cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Ligne sous charge'], sousVerrou(dir, 5500));
  assert.equal(a.code, 0, 'la CLI doit réessayer : ' + a.err);
  assert.equal(etat(dir).lignes['C-0001'].texte, 'Ligne sous charge');
  const r = ups(dir, 'Message envoyé pendant que le verrou est tenu', { prompt_id: 'p-2' }, sousVerrou(dir, 5500));
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
    assert.ok(!contexte(r).includes('- C-0001 |'), 'restauree sur disque, sans assigner la mission a une nouvelle conversation');
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

// Constaté le 2026-10-07 : le dossier de la copie de secours (un disque lent) était relu à chaque événement de
// hook, pour retrouver un projet effacé de la racine. Sa liste est gardée dans la racine ; le dossier n'est
// relu que si elle manque (racine effacée), si elle vieillit, ou si le dossier de secours a changé.
test('copie de secours : son dossier n\'est pas relu à chaque événement, sa liste est gardée dans la racine ; liste ou racine effacée, il est relu', () => {
  const dir = dossier('secours-liste');
  const secours = path.join(RUN, 'secours-liste-copie');
  fs.rmSync(secours, { recursive: true, force: true });
  const gardee = path.join(dir, '.secours-projets.claude.json');
  const sansPrefixe = d => norm(String(d).replace(/^\\\\\?\\/, ''));
  // Nombre de lectures du dossier de secours faites par le noyau, dans ce processus, pendant fn.
  const lectures = fn => {
    const origine = fs.readdirSync;
    let n = 0;
    fs.readdirSync = function (d, ...reste) { if (sansPrefixe(d) === norm(secours)) n++; return origine.call(this, d, ...reste); };
    try { avecRacine(dir, fn); } finally { fs.readdirSync = origine; }
    return n;
  };
  avecSecours(secours, () => {
    ups(dir, 'Corrige le bouton de paiement');
    assert.equal(cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Corriger le bouton']).code, 0);
    // Sans liste gardée : le dossier est lu une fois ; ensuite plus du tout.
    fs.rmSync(gardee, { force: true });
    assert.equal(lectures(() => core.assurerVues('claude')), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(gardee, 'utf8')).projets, [PROJET]);
    assert.equal(lectures(() => { core.assurerVues('claude'); core.assurerVues('claude'); core.listerProjetsTous('claude'); }), 0, 'liste gardée : aucune lecture du dossier de secours');
    // Un projet qui entre dans la copie est ajouté à la liste gardée, sans relire le dossier.
    ups(dir, 'Question hors projet', { cwd: 'C:\\travail\\autre-chose', session_id: 'sess-9', prompt_id: 'p-9' });
    assert.deepEqual(JSON.parse(fs.readFileSync(gardee, 'utf8')).projets, ['_general', PROJET]);
    // État et journal supprimés par un script : retrouvés par la liste gardée, toujours sans relire le dossier.
    fs.unlinkSync(path.join(dir, '.etat', `${PROJET}.claude.json`));
    fs.unlinkSync(path.join(dir, `${PROJET}.claude.journal.log`));
    assert.equal(lectures(() => core.assurerVues('claude')), 0);
    assert.equal(etat(dir).lignes['C-0001'].texte, 'Corriger le bouton', 'ligne revenue depuis la copie de secours');
    // Liste trop ancienne : le dossier est relu.
    const c = JSON.parse(fs.readFileSync(gardee, 'utf8'));
    fs.writeFileSync(gardee, JSON.stringify(Object.assign(c, { le: new Date(Date.now() - 11 * 60 * 1000).toISOString() })));
    assert.equal(lectures(() => core.listerProjetsTous('claude')), 1);
    assert.equal(lectures(() => core.listerProjetsTous('claude')), 0);
  });
  // Un autre dossier de secours : la liste gardée pour le premier ne vaut pas pour lui.
  const autre = path.join(RUN, 'secours-liste-autre');
  fs.mkdirSync(autre, { recursive: true });
  avecSecours(autre, () => assert.deepEqual(avecRacine(dir, () => core.listerProjetsTous('claude')), ['_general', PROJET]));
  assert.deepEqual(JSON.parse(fs.readFileSync(gardee, 'utf8')).projets, []);
});

test('mutation : copie de secours ou restauration désactivée, ou dossier de secours relu à chaque événement -> banc rouge', { skip: EN_MUTATION }, () => {
  const temoin = relancer(copie('temoin-secours'), 'copie de secours : (chaque|son dossier)');
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  for (const [ancre, remplacement] of [
    ['secours-liste-gardee', '  // MUTATION : dossier de secours relu à chaque événement'],
    ['secours-liste-ajout', '    // MUTATION : un projet qui entre dans la copie n\'est pas ajouté à la liste gardée'],
  ]) {
    const r = relancer(copie('mutation-' + ancre, 'lib/context-ledger-core.js', 'ancre-mutation:' + ancre, remplacement), 'copie de secours : son dossier');
    assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
    assert.match(r.stdout, /not ok \d+ - copie de secours : son dossier/, ancre);
  }
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

test('sous-agent en arrière-plan : une ligne le suit, sa fin la marque « à traiter », un état inchangé ne bloque pas chaque tour', () => {
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
  assert.match(e.lignes['C-0001'].note, /^TERMINÉ \(terminé\) le \d{4}-[\d: -]+ : résultat à lire, vérifier et intégrer : C:\\tmp\\a1\.jsonl$/);
  // SubagentStop ne dit rien à l'orchestrateur : la fin lui est annoncée à son prochain outil, une seule fois.
  assert.match(contexte(postBash(dir, t)), /^Sous-agent\(s\) terminé\(s\), résultat à traiter : C-0001 « Lot A : export PDF » \(résultat : C:\\tmp\\a1\.jsonl\)\. Ne les oublie pas/);
  assert.equal(postBash(dir, t).out, '');
  // Le second finit aussi ; seule la notification écrite dans le transcript le dit (filet de SubagentStop).
  fs.appendFileSync(t, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', prompt: notificationFin('a2222222222222222'), commandMode: 'task-notification' } }) + '\n');
  assert.match(contexte(postBash(dir, t)), /Sous-agent\(s\) terminé\(s\), résultat à traiter : C-0002 « Lot B : droits »/);
  assert.match(etat(dir).lignes['C-0002'].note, /^TERMINÉ \(completed\)/);
  // Tour suivant : l'orchestrateur fait autre chose et s'arrête sans avoir traité les livraisons.
  ups(dir, 'Maintenant corrige le readme', { prompt_id: 'p-2', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0002', 'fait dans le tour']);
  const r1 = contexte(finDeTour(dir, t, 'p-2', 'Readme corrigé.'));
  assert.match(r1, /^Sous-agents TERMINÉS dont le résultat n'est pas traité \(2\) : C-0001 « Lot A : export PDF » \(résultat : C:\\tmp\\a1\.jsonl\) ; C-0002 « Lot B : droits »/);
  assert.match(r1, /cite \[ctx C-NNNN\] dans l'historique/);
  // Relance juste après le rappel (stop_hook_active) : rien, donc pas de boucle.
  assert.equal(finDeTour(dir, t, 'p-2', 'Readme corrigé.', true).out, '');
  // Encore un tour sans les traiter : le rappel REVIENT (une notification, elle, ne revient jamais).
  ups(dir, 'Et le changelog', { prompt_id: 'p-3', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0003', 'fait dans le tour']);
  assert.equal(finDeTour(dir, t, 'p-3', 'Changelog fait.').out, '', 'livraison inchangee : pas de nouvelle relance');
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
  // Lancement fait PAR un sous-agent (agent_id présent) : ignoré, seul l'orchestrateur tient la liste. Ce
  // sous-agent, dont le démarrage n'a pas été vu, reçoit à ce premier événement sa consigne, et rien d'autre.
  const imbrique = lancementAgent(dir, 'a7777777777777777', 'imbriqué', { agent_id: 'a3333333333333333' });
  assert.match(contexte(imbrique), /^Fichier contexte : tu es un sous-agent \(ligne C-0001 de l'orchestrateur\)\. Ta fiche : /);
  assert.ok(!/suivi par C-/.test(contexte(imbrique)), 'aucune ligne pour le sous-agent d\'un sous-agent');
  assert.equal(lancementAgent(dir, 'a7777777777777778', 'imbriqué 2', { agent_id: 'a3333333333333333' }).out, '');
  assert.deepEqual(Object.keys(etat(dir).lignes), ['C-0001', 'C-0002']);
});

test('sous-agent repris après la clôture de sa ligne : une nouvelle ligne suit le nouveau résultat, une fin relue dans le transcript n\'en crée pas', () => {
  const dir = dossier('livraisons-reprise');
  const t = transcriptDe('livraisons-reprise');
  ups(dir, 'Lance un agent', { transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'suivi par la ligne de l\'agent']);
  lancementAgent(dir, 'a4444444444444444', 'Audit des prix', { transcript_path: t });
  const finEnDirect = (tour = 'tour-1') => hook(dir, {
    hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: 'a4444444444444444', agent_type: 'general-purpose',
    stop_hook_active: false, transcript_path: t, last_assistant_message: tour,
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
  finEnDirect('tour-2');
  const e = etat(dir);
  assert.deepEqual(Object.keys(e.lignes), ['C-0001', 'C-0002']);
  assert.match(e.lignes['C-0002'].texte, /^\[agent\] « Audit des prix » \(general-purpose, a4444444444444444\) : nouveau résultat rendu après la clôture de C-0001, à lire, vérifier et intégrer\.$/);
  assert.equal(e.lignes['C-0002'].statut, 'ouvert');
  assert.match(e.lignes['C-0002'].note, /^TERMINÉ \(terminé\)/);
  ups(dir, 'Suite', { prompt_id: 'p-2', transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0002', 'fait dans le tour']);
  assert.match(contexte(finDeTour(dir, t, 'p-2', 'Fini.')), /n'est pas traité \(1\) : C-0002 « Audit des prix »/);
});

// Trou trouvé dans une session réelle (22 sous-agents, un tour de plus de 4 heures) : une fin marquée par
// SubagentStop n'était dite à l'orchestrateur qu'à sa fin de tour, et aucun rappel n'existait pendant le
// tour. 7 résultats ont attendu sans que rien ne le lui redise.
function avecDelaiRappel(minutes, fn) {
  const avant = process.env.CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN;
  process.env.CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN = String(minutes);
  try { return fn(); } finally {
    if (avant === undefined) delete process.env.CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN; else process.env.CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN = avant;
  }
}

test('sous-agent fini pendant un tour long : annoncé au prochain outil, une seule fois, puis rappelé tant que le résultat attend', () => {
  const dir = dossier('livraisons-en-cours');
  const t = transcriptDe('livraisons-en-cours');
  ups(dir, 'Lance un agent et continue le reste', { transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'suivi par la ligne de l\'agent']);
  lancementAgent(dir, 'a5555555555555555', 'Audit des taxes', { transcript_path: t });
  lancementAgent(dir, 'a6666666666666666', 'Audit des stocks', { transcript_path: t });
  const finEnDirect = id => hook(dir, {
    hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: id, agent_type: 'general-purpose', stop_hook_active: false, transcript_path: t,
  });
  assert.equal(finEnDirect('a5555555555555555').out, '');
  // Comme dans la session réelle : la fin date de deux heures quand l'orchestrateur l'apprend enfin.
  const ilYA2h = () => new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  avecRacine(dir, () => core.modifierSession('claude', 'sess-1', x => { x.taches.a5555555555555555.fini = ilYA2h(); }));
  // Prochain outil de l'orchestrateur : la fin lui est dite, sans attendre la notification ni la fin du tour.
  assert.match(contexte(postBash(dir, t)), /^Sous-agent\(s\) terminé\(s\), résultat à traiter : C-0001 « Audit des taxes » \(résultat : C:\\tmp\\tasks\\a5555555555555555\.output\)\. Ne les oublie pas/);
  // Une seule fois : ni à l'outil suivant, ni quand la notification de cette même fin arrive ensuite. Et pas
  // de rappel dans la foulée : le délai court depuis l'annonce, pas depuis la fin.
  assert.equal(postBash(dir, t).out, '');
  fs.appendFileSync(t, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', prompt: notificationFin('a5555555555555555'), commandMode: 'task-notification' } }) + '\n');
  assert.equal(postBash(dir, t).out, '');
  assert.equal(ups(dir, notificationFin('a5555555555555555'), { prompt_id: 'p-n', transcript_path: t }).out, '');
  // Le tour continue sans fin de tour. Vingt minutes après l'annonce (délai par défaut), le rappel revient...
  avecRacine(dir, () => core.modifierSession('claude', 'sess-1', x => { x.taches.a5555555555555555.annonce = ilYA2h(); }));
  const rappel = contexte(postBash(dir, t));
  assert.match(rappel, /^Rappel : 1 sous-agent\(s\) TERMINÉ\(S\) dont le résultat n'est toujours pas traité : C-0001 « Audit des taxes »\. N'attends pas la fin du tour/);
  assert.match(rappel, /Encore en cours : 1 \(C-0002\)\.$/);
  // ... une seule fois par délai, et une valeur illisible du réglage garde le défaut.
  assert.equal(postBash(dir, t).out, '');
  assert.equal(avecDelaiRappel('abc', () => postBash(dir, t)).out, '');
  // Une nouvelle fin pendant qu'un rappel est dû : le rappel complet la contient, pas de double annonce.
  finEnDirect('a6666666666666666');
  const rappel2 = avecDelaiRappel(0, () => contexte(postBash(dir, t)));
  assert.match(rappel2, /^Rappel : 2 sous-agent\(s\) TERMINÉ\(S\) dont le résultat n'est toujours pas traité : C-0001 « Audit des taxes » ; C-0002 « Audit des stocks »\./);
  assert.ok(!rappel2.includes('Sous-agent(s) terminé(s)'));
  assert.equal(postBash(dir, t).out, '');
  // La preuve du premier résultat arrive par cet outil : il n'est plus rappelé, l'autre l'est encore.
  const apres = avecDelaiRappel(0, () => contexte(postWrite(dir, histoire(dir), '- audit des taxes vérifié et intégré [ctx C-0001]\n', { transcript_path: t })));
  assert.match(apres, /^Rappel : 1 sous-agent\(s\) TERMINÉ\(S\) dont le résultat n'est toujours pas traité : C-0002 « Audit des stocks »\./);
  // Tout est prouvé : plus rien à rappeler, même délai passé.
  postWrite(dir, histoire(dir), '- audit des stocks vérifié et intégré [ctx C-0002]\n', { transcript_path: t });
  assert.equal(avecDelaiRappel(0, () => postBash(dir, t)).out, '');
});

test('fin de tour : le rappel vaut annonce, la fin n\'est pas redite à l\'outil suivant', () => {
  const dir = dossier('livraisons-stop-annonce');
  const t = transcriptDe('livraisons-stop-annonce');
  ups(dir, 'Lance un agent', { transcript_path: t });
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'suivi par la ligne de l\'agent']);
  lancementAgent(dir, 'a7777777777777777', 'Audit des frais', { transcript_path: t });
  hook(dir, { hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: 'a7777777777777777', agent_type: 'general-purpose', stop_hook_active: false, transcript_path: t });
  assert.match(contexte(finDeTour(dir, t, 'p-1', 'Agent lancé.')), /Sous-agents TERMINÉS dont le résultat n'est pas traité \(1\) : C-0001 « Audit des frais »/);
  ups(dir, 'Suite', { prompt_id: 'p-2', transcript_path: t });
  assert.equal(postBash(dir, t).out, '');
  // Délai compté depuis ce rappel de fin de tour : il vient d'avoir lieu, donc rien avant 20 minutes.
  const s = avecRacine(dir, () => core.lireSession('claude', 'sess-1'));
  assert.ok(s.rappelLivraisons && s.taches.a7777777777777777.annonce);
});

// ---------------------------------------------------------------------------
// Réponses à un questionnaire (outil AskUserQuestion) : une décision donnée par questionnaire doit être
// enregistrée comme un message. Forme du payload : relevée dans les transcripts de Claude Code.

// Fiches des sous-agents (un second fichier de contexte, propre à chaque
// sous-agent et signé par son ID de travail). Mesuré la même nuit dans 372 transcripts : 51 sous-agents
// Claude compactés (81 compactages), et après son compactage un sous-agent recevait la liste de
// l'orchestrateur à la place de sa mission (18 fois).
// Formes relevées (Claude Code 2.1.284) : transcript d'un sous-agent =
// <dossier>/<session>/subagents/agent-<id>.jsonl, première ligne = son brief ; compactage = ligne
// { type: 'system', subtype: 'compact_boundary' }, écrite APRÈS les hooks SessionStart du compactage.

const SESSION_FICHE = '11111111-2222-3333-4444-555555555555';

function scene(nom) {
  const dir = dossier(nom);
  const projets = path.join(RUN, nom + '-projets');
  fs.rmSync(projets, { recursive: true, force: true });
  fs.mkdirSync(path.join(projets, SESSION_FICHE, 'subagents'), { recursive: true });
  const t = path.join(projets, SESSION_FICHE + '.jsonl');
  fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: 'début' } }) + '\n');
  return {
    dir, t,
    tSA: id => path.join(projets, SESSION_FICHE, 'subagents', `agent-${id}.jsonl`),
    base: { session_id: SESSION_FICHE, cwd: CWD_PROJET, transcript_path: t },
  };
}
const briefDe = (id, mission) => JSON.stringify({ type: 'user', isSidechain: true, agentId: id, message: { role: 'user', content: mission } }) + '\n';
const COMPACTAGE = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }) + '\n';
// Ce que Claude Code écrit dans le transcript quand le texte d'un hook parvient au modèle (forme relevée le
// 2026-10-03 : 52 lignes dans une session réelle, SubagentStart et PostToolUse compris).
const injectee = (texte, evenement = 'SubagentStart') => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [texte], hookName: evenement, hookEvent: evenement } }) + '\n';
const indexFiche = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, '.fiches', `claude-${id}.json`), 'utf8'));

test('fiche de sous-agent : mission copiée mot pour mot au lancement, notes du sous-agent, fiche rendue après SON compactage', () => {
  const { dir, tSA, base } = scene('fiche');
  const ID = 'a1b2c3d4e5f6a7b8c';
  const MISSION = 'MISSION : vérifier les lots B01 à B05.\nPrix « $1 » et motif $& à garder tels quels.\nRends un tableau des restes.';
  hook(dir, Object.assign({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1', prompt: 'Lance un agent de vérification' }, base));
  cli(dir, ['sans-travail', '--projet', PROJET, 'M-0001', 'suivi par la ligne de l\'agent']);
  const lancement = hook(dir, Object.assign({
    hook_event_name: 'PostToolUse', prompt_id: 'p-1', tool_name: 'Agent',
    tool_input: { description: 'Vérification des lots B01 à B05', subagent_type: 'general-purpose', prompt: MISSION, run_in_background: true },
    tool_response: { isAsync: true, status: 'async_launched', agentId: ID, outputFile: `C:\\tmp\\tasks\\${ID}.output` },
  }, base));
  assert.match(contexte(lancement), /suivi par C-0001\./);
  const index = indexFiche(dir, ID);
  assert.equal(index.ligne, 'C-0001');
  assert.equal(index.mission, true);
  assert.equal(index.projet, PROJET);
  assert.equal(index.session, SESSION_FICHE);
  const fiche = () => fs.readFileSync(index.fiche, 'utf8');
  assert.ok(fiche().includes(`## Mission (mot pour mot)\n\n${MISSION}\n`), 'mission mot pour mot, caractères $ compris');
  assert.ok(fiche().includes(`- ID de travail : ${ID} (general-purpose)`));
  assert.ok(fiche().includes(`- Orchestrateur : claude, session ${SESSION_FICHE}, projet ${PROJET}`));
  assert.ok(fiche().includes('- Ligne de suivi dans la liste de l\'orchestrateur : C-0001 (lecture seule pour le sous-agent)'));
  // « Fiche créée le » : la fiche peut naître en cours de route, pas forcément au lancement.
  assert.match(fiche(), /\n- Fiche créée le \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.equal(fiche().split('\n')[0], '# Fiche du sous-agent « Vérification des lots B01 à B05 »');
  // Démarrage du sous-agent : il apprend où est sa fiche, comment y noter, et ce qui lui est fermé.
  fs.writeFileSync(tSA(ID), briefDe(ID, MISSION));
  const sa = { agent_id: ID, agent_type: 'general-purpose' };
  const consigne = contexte(hook(dir, Object.assign({ hook_event_name: 'SubagentStart' }, base, sa)));
  fs.appendFileSync(tSA(ID), injectee(consigne));
  assert.match(consigne, /^Fichier contexte : tu es un sous-agent \(ligne C-0001 de l'orchestrateur\)\. Ta fiche : /);
  assert.ok(consigne.includes(index.fiche));
  assert.match(consigne, /Elle contient ta mission, mot pour mot\./);
  // La mission prime sur la fiche : il la lit d'abord, et n'écrit rien dans sa fiche si elle l'interdit
  // (constaté le 2026-10-07 : dix sous-agents arrêtés parce que la consigne leur avait fait écrire leur fiche
  // alors que leur mission limitait l'écriture à un dossier).
  assert.match(consigne, /\nLis d'abord ta mission\. Ta fiche est un carnet de suivi, hors de ton travail : une mission qui t'attribue des fichiers, ou qui t'interdit de modifier le dépôt \(lecture seule\), ne t'interdit pas d'y noter\. Mais si elle t'interdit expressément toute écriture ailleurs que dans ses livrables \(« n'écris nulle part ailleurs »\), elle prime : n'écris rien dans cette fiche, ni mission, ni note, ni signalement, et dis-le dans ton rapport\. Sinon, note dans ta fiche ton avancement et ce que tu trouves/);
  assert.match(consigne, /context-ledger\.js" note --fiche a1b2c3d4e5f6a7b8c "fait : /);
  assert.match(consigne, /elle ne se modifie pas : ajouter, etat, sans-travail et abandon lui sont réservés\./);
  // Il sait lire des lignes par leur identifiant et la liste d'un autre agent.
  assert.match(consigne, /un identifiant, chercher C-0151 C-0152, rend ces lignes entières ; --agent claude ou --agent codex pour la liste d'un autre agent/);
  // Le sous-agent ne dévie pas de sa mission, et une ligne ouverte de la
  // liste n'est pas une tâche « pas faite » ; s'il la constate faite, il la signale au lieu de la fermer.
  assert.match(consigne, /\nTa mission est celle de ton lancement, rien d'autre : les messages de l'utilisateur, les « À trier » et les lignes ouvertes que tu as pu hériter de l'orchestrateur ou lire dans sa liste s'adressent à lui, ils ne te donnent aucun travail\.\n/);
  assert.match(consigne, /« ouvert » veut dire « pas encore prouvé fait », pas « pas fait »/);
  assert.match(consigne, /note --fiche a1b2c3d4e5f6a7b8c --genre deja-fait "C-NNNN : la preuve"`, l'orchestrateur vérifiera\./);
  // Outil du sous-agent : rien à dire tant que son contexte n'est pas compacté (premier passage : base).
  const outil = () => hook(dir, Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base, sa));
  assert.equal(outil().out, '');
  // Il note son avancement dans SA fiche : texte gardé tel quel, daté, jamais réécrit.
  const n = cli(dir, ['note', '--fiche', ID, '--genre', 'fait', 'B01 et B02 lus en entier ; reste : B03 à B05']);
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /^Noté dans .+ \(1 note\(s\)\)\./);
  assert.match(fiche(), /\n- \d{4}-\d\d-\d\d \d\d:\d\d \| fait \| B01 et B02 lus en entier ; reste : B03 à B05\n$/);
  assert.equal(cli(dir, ['note', '--fiche', 'inconnu', 'x']).code, 1, 'sous-agent sans fiche : erreur dite');
  assert.equal(cli(dir, ['note', '--fiche', ID]).code, 1, 'note vide : erreur dite');
  assert.equal(indexFiche(dir, ID).notes, 1);
  // Son contexte est compacté : au prochain outil sa fiche lui est rendue (mission et notes), une seule fois.
  fs.appendFileSync(tSA(ID), COMPACTAGE);
  const reprise = contexte(outil());
  assert.match(reprise, /^Fichier contexte : ton contexte de sous-agent vient d'être compacté\. Voici ta fiche \(/);
  assert.ok(reprise.includes(MISSION), 'la mission lui revient mot pour mot');
  assert.ok(reprise.includes('| fait | B01 et B02 lus en entier ; reste : B03 à B05'), 'ses notes aussi');
  assert.ok(!/À trier :|Ouvert :|Bloqué : attend l'utilisateur/.test(reprise), 'jamais la liste de l\'orchestrateur');
  assert.match(reprise, /Ta mission est celle de ton lancement, rien d'autre/);
  assert.equal(outil().out, '', 'pas de seconde reprise pour le même compactage');
  // Un résultat d'outil qui CITE le marqueur de compactage n'est pas un compactage.
  const vuAvant = indexFiche(dir, ID).transcriptVu;
  fs.appendFileSync(tSA(ID), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '{"type":"system","subtype":"compact_boundary"}' }] } }) + '\n');
  assert.equal(outil().out, '');
  // L'octet déjà vu n'avance que par paliers d'un mégaoctet : pas d'écriture de l'index à chaque outil.
  assert.equal(indexFiche(dir, ID).transcriptVu, vuAvant);
  // Un second compactage, plus tard : la fiche est rendue de nouveau.
  const f = path.join(dir, '.fiches', `claude-${ID}.json`);
  const i2 = indexFiche(dir, ID);
  i2.repriseLe = new Date(Date.now() - 20 * 60000).toISOString();
  fs.writeFileSync(f, JSON.stringify(i2));
  fs.appendFileSync(tSA(ID), COMPACTAGE);
  assert.match(contexte(outil()), /^Fichier contexte : ton contexte de sous-agent vient d'être compacté/);
  assert.equal(indexFiche(dir, ID).reprises, 2);
  // Sa fin est annoncée à l'orchestrateur avec sa fiche et le nombre de notes.
  hook(dir, Object.assign({ hook_event_name: 'SubagentStop', stop_hook_active: false }, base, sa));
  const annonce = contexte(hook(dir, Object.assign({ hook_event_name: 'PostToolUse', prompt_id: 'p-1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base)));
  assert.ok(annonce.includes(`sa fiche, 1 note(s) : ${index.fiche}`), annonce);
  assert.equal(cli(dir, ['fiche', ID]).out.trim(), fiche().trim());
});

test('fiche de sous-agent : démarrage avant le retour de l\'outil de lancement, sous-agent jamais vu, et mission recopiée par le sous-agent', () => {
  const { dir, tSA, base } = scene('fiche-ordre');
  const ID = 'a0000000000000001';
  const sa = { agent_id: ID, agent_type: 'Explore' };
  const MISSION = 'Cherche où est calculée la TVA.';
  // Le sous-agent démarre AVANT que l'orchestrateur ait reçu le retour de l'outil de lancement : la fiche
  // naît sans ligne, avec la mission lue dans son transcript ; la ligne s'y ajoute ensuite.
  fs.writeFileSync(tSA(ID), briefDe(ID, MISSION));
  const c = contexte(hook(dir, Object.assign({ hook_event_name: 'SubagentStart' }, base, sa)));
  assert.match(c, /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
  assert.equal(indexFiche(dir, ID).mission, true);
  assert.equal(indexFiche(dir, ID).ligne, null);
  // Titre de repli faute de mieux, marqué comme tel (constaté le 2026-10-03 : il restait dans la fiche).
  assert.equal(indexFiche(dir, ID).titre, 'sous-agent Explore');
  assert.equal(indexFiche(dir, ID).titreRepli, true);
  hook(dir, Object.assign({
    hook_event_name: 'PostToolUse', prompt_id: 'p-1', tool_name: 'Agent',
    tool_input: { description: 'Recherche TVA', subagent_type: 'Explore', prompt: MISSION, run_in_background: true },
    tool_response: { isAsync: true, status: 'async_launched', agentId: ID, outputFile: '' },
  }, base));
  const index = indexFiche(dir, ID);
  assert.equal(index.ligne, 'C-0001', 'la ligne de suivi rejoint la fiche');
  const texte = fs.readFileSync(index.fiche, 'utf8');
  assert.ok(texte.includes('orchestrateur : C-0001 (lecture seule'));
  assert.equal(texte.split(MISSION).length - 1, 1, 'la mission n\'est écrite qu\'une fois');
  // Le vrai titre (description du lancement) remplace le titre de repli, en tête de la fiche et dans l'index.
  assert.equal(texte.split('\n')[0], '# Fiche du sous-agent « Recherche TVA »');
  assert.equal(index.titre, 'Recherche TVA');
  assert.equal(index.titreRepli, undefined);
  // Sous-agent lancé avant le branchement (aucun démarrage vu) : sa fiche naît à son premier outil, qui lui
  // donne aussi sa consigne.
  const ID2 = 'a0000000000000002';
  fs.writeFileSync(tSA(ID2), briefDe(ID2, 'Audite les routes publiques.'));
  const c2 = contexte(hook(dir, Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base, { agent_id: ID2, agent_type: 'security-auditor' })));
  assert.match(c2, /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
  fs.appendFileSync(tSA(ID2), injectee(c2, 'PostToolUse'));
  assert.ok(fs.readFileSync(indexFiche(dir, ID2).fiche, 'utf8').includes('Audite les routes publiques.'));
  // Mission illisible par le hook (cas de Codex : message de lancement chiffré) : la consigne demande au
  // sous-agent de la recopier, et la commande note --genre mission la met à sa place.
  const ID3 = 'a0000000000000003';
  avecRacine(dir, () => core.creerFiche({ agent: 'claude', sessionId: SESSION_FICHE, id: ID3, projet: PROJET, titre: 'sans transcript', genre: 'worker' }));
  const c3 = avecRacine(dir, () => core.texteConsigneSousAgent({ agent: 'claude', id: ID3, script: HOOK }));
  // Il lit sa mission d'abord : la recopie n'est plus le premier geste, et elle n'a pas lieu si la mission
  // interdit d'écrire ailleurs que dans ses livrables.
  assert.match(c3, /Ta fiche : .+\. Ta mission n'a pas pu y être copiée automatiquement\.\n/);
  assert.match(c3, /\nLis d'abord ta mission\. Ta fiche est un carnet de suivi, hors de ton travail : .+ Mais si elle t'interdit expressément toute écriture ailleurs que dans ses livrables .+ elle prime : n'écris rien dans cette fiche, ni mission, ni note, ni signalement, et dis-le dans ton rapport\. Sinon, recopie ta mission mot pour mot avec `node ".+" note --fiche a0000000000000003 --genre mission "\.\.\."`, puis note dans ta fiche ton avancement/);
  assert.ok(!/commence par la recopier/.test(c3));
  assert.ok(fs.readFileSync(indexFiche(dir, ID3).fiche, 'utf8').includes(core.MISSION_ABSENTE));
  const r3 = avecRacine(dir, () => core.texteRepriseSousAgent({ agent: 'claude', id: ID3, script: HOOK }));
  // « Redemande-la avant de continuer » n'a été suivi par aucun sous-agent ; le brief en fichier, si.
  assert.match(r3, /Ta mission n'y a pas été copiée : reprends-la de ton brief en fichier si l'orchestrateur t'en a donné un \(sinon du résumé\) et dis dans ton rapport qu'elle a été reprise ainsi ; recopie-la dans ta fiche \(note --genre mission\) sauf si ta mission t'interdit expressément toute écriture ailleurs que dans ses livrables\./);
  assert.ok(!/redemande-la/.test(r3));
  // La fiche rendue garde la même réserve, et dit qu'une tâche plus récente (une relance) remplace celle du lancement.
  assert.match(r3, /pas le résumé de compactage\. Si l'orchestrateur t'a relancé depuis avec une nouvelle tâche, c'est cette tâche qui vaut\./);
  assert.match(r3, /\nContinue à y noter ton avancement, sauf si ta mission t'interdit expressément toute écriture ailleurs que dans ses livrables : `node ".+" note --fiche a0000000000000003 "\.\.\."`\./);
  assert.equal(cli(dir, ['note', '--fiche', ID3, '--genre', 'mission', 'Relire les 35 rapports, ligne à ligne.']).code, 0);
  const t3 = fs.readFileSync(indexFiche(dir, ID3).fiche, 'utf8');
  assert.ok(t3.includes('## Mission (mot pour mot)\n\nRelire les 35 rapports, ligne à ligne.\n'));
  assert.ok(!t3.includes(core.MISSION_ABSENTE));
  assert.equal(indexFiche(dir, ID3).mission, true);
  assert.equal(indexFiche(dir, ID3).notes, 0, 'la mission n\'est pas une note');
  // Compactage annoncé par son propre événement (PostCompact porte l'identité du sous-agent : mesuré dans
  // Codex) : rien ne peut être injecté à ce moment, la fiche est rendue à son prochain outil, une fois.
  const sa2 = { agent_id: ID2, agent_type: 'security-auditor' };
  const outil2 = () => hook(dir, Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base, sa2));
  assert.equal(outil2().out, '');
  assert.equal(hook(dir, Object.assign({ hook_event_name: 'PostCompact', trigger: 'auto' }, base, sa2)).out, '');
  assert.match(contexte(outil2()), /^Fichier contexte : ton contexte de sous-agent vient d'être compacté\. Voici ta fiche \(/);
  assert.equal(outil2().out, '');
});

// Mesuré le 2026-10-02 dans Codex : la consigne du démarrage n'est arrivée qu'à 2 sous-agents sur 22 (hook de
// démarrage tué par son délai, ou jamais déclenché). Filet : le premier événement du sous-agent la donne.
test('fiche de sous-agent : consigne donnée au premier outil quand le démarrage ne l\'a pas donnée, une seule fois', () => {
  const { dir, tSA, base } = scene('fiche-consigne');
  const outil = sa => hook(dir, Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base, sa));
  const nouveau = (id, mission) => { fs.writeFileSync(tSA(id), briefDe(id, mission)); return { agent_id: id, agent_type: 'general-purpose' }; };
  // Démarrage jamais vu : la consigne arrive avec son premier outil, puis plus jamais.
  const A = nouveau('a000000000000000a', 'Relis le module de paiement.');
  const c = contexte(outil(A));
  assert.match(c, /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
  assert.match(c, /Elle contient ta mission, mot pour mot\./);
  assert.match(c, /\nTa mission est celle de ton lancement, rien d'autre : /);
  assert.ok(indexFiche(dir, A.agent_id).consigneLe);
  fs.appendFileSync(tSA(A.agent_id), injectee(c, 'PostToolUse'));
  assert.equal(outil(A).out, '', 'la consigne n\'est donnée qu\'une fois');
  // Démarrage vu : la consigne a été donnée là (et écrite dans son transcript), le premier outil ne la redit pas.
  const B = nouveau('a000000000000000b', 'Relis le module de livraison.');
  const cB = contexte(hook(dir, Object.assign({ hook_event_name: 'SubagentStart' }, base, B)));
  assert.match(cB, /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
  fs.appendFileSync(tSA(B.agent_id), injectee(cB));
  assert.ok(indexFiche(dir, B.agent_id).consigneLe);
  assert.equal(outil(B).out, '');
  // Fiche rendue après un compactage avant toute consigne : elle vaut consigne.
  const C = nouveau('a000000000000000c', 'Relis le module de stock.');
  assert.equal(hook(dir, Object.assign({ hook_event_name: 'PostCompact', trigger: 'auto' }, base, C)).out, '');
  assert.match(contexte(outil(C)), /^Fichier contexte : ton contexte de sous-agent vient d'être compacté/);
  assert.equal(outil(C).out, '');
});

// Constaté le 2026-10-02 dans Codex : le hook de démarrage d'un sous-agent a posé sa
// marque puis a été tué par son délai, sortie jetée ; le filet du premier outil ne redonnait rien, la marque
// étant posée. Depuis : marque posée mais consigne absente de son transcript = redonnée, une fois.
test('fiche de sous-agent : consigne marquée au démarrage mais absente de son transcript : redonnée au premier outil, une fois', () => {
  const { dir, tSA, base } = scene('fiche-consigne-absente');
  const outil = sa => hook(dir, Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base, sa));
  const demarrer = (id, mission) => {
    fs.writeFileSync(tSA(id), briefDe(id, mission));
    const sa = { agent_id: id, agent_type: 'general-purpose' };
    return { sa, consigne: contexte(hook(dir, Object.assign({ hook_event_name: 'SubagentStart' }, base, sa))) };
  };
  // Consigne parvenue (écrite dans son transcript) : le premier outil ne la redit pas, et ne la cherche plus.
  const A = demarrer('a00000000000000d1', 'Relis le module de paiement.');
  fs.appendFileSync(tSA(A.sa.agent_id), injectee(A.consigne));
  assert.equal(outil(A.sa).out, '');
  const iA = indexFiche(dir, A.sa.agent_id);
  assert.equal(iA.consigneVue, true);
  assert.ok(iA.consigneVerifieeLe);
  assert.equal(outil(A.sa).out, '');
  assert.equal(indexFiche(dir, A.sa.agent_id).consigneVerifieeLe, iA.consigneVerifieeLe, 'cherchée une seule fois');
  // Hook de démarrage tué après sa marque : rien dans son transcript, la consigne est redonnée, une fois.
  const B = demarrer('a00000000000000d2', 'Relis le module de livraison.');
  assert.ok(indexFiche(dir, B.sa.agent_id).consigneLe);
  const c = contexte(outil(B.sa));
  assert.match(c, /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
  assert.ok(c.includes('note --fiche a00000000000000d2 '));
  assert.equal(indexFiche(dir, B.sa.agent_id).consigneVue, false);
  assert.equal(outil(B.sa).out, '', 'redonnée une seule fois');
  // Ne comptent pas : son brief qui cite la phrase de la consigne (forme mesurée chez Claude le 2026-10-03), ni
  // la consigne injectée d'un autre sous-agent.
  const C = demarrer('a00000000000000d3', 'Fichier contexte : tu es un sous-agent. Note avec note --fiche a00000000000000d3 "x".');
  fs.appendFileSync(tSA(C.sa.agent_id), injectee(A.consigne));
  assert.match(contexte(outil(C.sa)), /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
  // Transcript introuvable : redonnée aussi (une redite coûte moins qu'une consigne perdue).
  const D = demarrer('a00000000000000d4', 'Relis le module de stock.');
  fs.rmSync(tSA(D.sa.agent_id));
  assert.match(contexte(outil(D.sa)), /^Fichier contexte : tu es un sous-agent\. Ta fiche : /);
});

test('compactage d\'un sous-agent vu par SessionStart sans agent_id : il reçoit sa fiche, jamais la liste de l\'orchestrateur', () => {
  const { dir, t, tSA, base } = scene('fiche-session-start');
  const ID = 'a9f8e7d6c5b4a3f2e';
  hook(dir, Object.assign({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1', prompt: 'Corrige le bouton de paiement, il ne répond plus' }, base));
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Corriger le bouton de paiement']);
  fs.writeFileSync(tSA(ID), briefDe(ID, 'MISSION : auditer les droits des tables.'));
  // Défaut mesuré le 2026-10-02 : cet événement ne porte pas agent_id, et le hook injectait au sous-agent la
  // liste de l'orchestrateur. Le chemin de son transcript (dossier subagents) le fait reconnaître.
  const debutSA = { hook_event_name: 'SessionStart', session_id: SESSION_FICHE, cwd: CWD_PROJET, transcript_path: tSA(ID), source: 'compact' };
  const r = contexte(hook(dir, debutSA));
  assert.match(r, /^Fichier contexte : ton contexte de sous-agent vient d'être compacté/);
  assert.ok(r.includes('MISSION : auditer les droits des tables.'));
  assert.ok(!r.includes('Corriger le bouton de paiement'), 'jamais la liste de l\'orchestrateur');
  // Le marqueur de ce même compactage est écrit dans son transcript juste après : pas de seconde reprise.
  fs.appendFileSync(tSA(ID), COMPACTAGE);
  assert.equal(hook(dir, Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base, { agent_id: ID, agent_type: 'x' })).out, '');
  // L'orchestrateur, lui, reçoit toujours sa liste après SON compactage.
  const o = contexte(hook(dir, Object.assign({ hook_event_name: 'SessionStart', source: 'compact' }, base)));
  assert.match(o, /Ce fichier fait foi pour ce qui reste, pas le résumé de compactage\./);
  assert.match(o, /Corriger le bouton de paiement/);
  // Et l'octet déjà vu de SON transcript n'a pas été remplacé par celui du transcript du sous-agent.
  assert.equal(avecRacine(dir, () => core.lireSession('claude', SESSION_FICHE)).transcriptVu, fs.statSync(t).size);
});

// Cas à couvrir : « si un autre agent voit dans un fichier contexte du parent qu'une tâche
// n'est pas faite alors qu'elle est faite mais pas supprimée ». Le sous-agent ne ferme rien : il signale.
test('signalement d\'un sous-agent (déjà fait, bloqué, question) : dit à l\'orchestrateur à son prochain outil, une fois, sans attendre la fin', () => {
  const { dir, base } = scene('fiche-signalement');
  const ID = 'a5ca1e0000000001a';
  hook(dir, Object.assign({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1', prompt: 'Corrige le bouton de paiement, il ne répond plus' }, base));
  cli(dir, ['ajouter', '--projet', PROJET, '--de', 'M-0001', 'Corriger le bouton de paiement']);
  hook(dir, Object.assign({
    hook_event_name: 'PostToolUse', prompt_id: 'p-1', tool_name: 'Agent',
    tool_input: { description: 'Audit du tunnel de commande', subagent_type: 'general-purpose', prompt: 'Audite le tunnel.', run_in_background: true },
    tool_response: { isAsync: true, status: 'async_launched', agentId: ID, outputFile: '' },
  }, base));
  const outil = () => hook(dir, Object.assign({ hook_event_name: 'PostToolUse', prompt_id: 'p-1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }, base));
  assert.equal(outil().out, '', 'rien à signaler');
  // Le sous-agent constate que C-0001 est déjà corrigé : il ne peut pas fermer la ligne, il le signale.
  const n = cli(dir, ['note', '--fiche', ID, '--genre', 'Déjà fait', 'C-0001 : corrigé par le commit abc1234 (BoutonPaiement.tsx:42)']);
  assert.equal(n.code, 0, n.err);
  cli(dir, ['note', '--fiche', ID, 'note ordinaire, sans signalement']);
  const o = contexte(outil());
  assert.match(o, /^Signalement du sous-agent C-0002 « Audit du tunnel de commande » \(deja-fait\) : « C-0001 : corrigé par le commit abc1234 \(BoutonPaiement\.tsx:42\) »\. Vérifie dans le code ou l'historique : si c'est exact, ferme la ligne par une preuve \[ctx C-NNNN\] ; sinon réponds-lui\. Sa fiche : /);
  assert.ok(!o.includes('note ordinaire'), 'une note ordinaire n\'est pas un signalement');
  assert.equal(outil().out, '', 'un signalement n\'est dit qu\'une fois');
  assert.equal(etat(dir).lignes['C-0001'].statut, 'ouvert', 'la ligne ne se ferme que sur la preuve de l\'orchestrateur');
  // Question et blocage : dits aussi, avec ce que l'orchestrateur doit faire.
  cli(dir, ['note', '--fiche', ID, '--genre', 'question', 'Quelle branche pour le correctif ?']);
  cli(dir, ['note', '--fiche', ID, '--genre', 'bloque', 'pas d\'accès à la base de préproduction']);
  const o2 = contexte(outil());
  assert.match(o2, /\(question\) : « Quelle branche pour le correctif \? »\. Réponds-lui\. Sa fiche : /);
  assert.match(o2, /\(bloque\) : « pas d'accès à la base de préproduction »\. Débloque-le ou réponds-lui : il attend\. Sa fiche : /);
  assert.equal(outil().out, '');
  assert.equal(indexFiche(dir, ID).notes, 4);
  assert.equal(indexFiche(dir, ID).signalements.length, 3);
});

// Un agent principal qui voit dans la liste d'un AUTRE agent une ligne déjà faite ne la modifie pas ;
// il la signale dans la boîte de cet agent, qui vérifie et ferme par sa preuve.
test('signalement entre agents principaux : déposé par signaler, dit une fois à l\'agent qui tient la liste, rappelé tant que la ligne reste ouverte', () => {
  const dir = dossier('signalement-agents');
  preparerLigne(dir);
  // Codex signale une ligne de la liste de Claude (ce que fait sa commande signaler, avec de = codex).
  avecRacine(dir, () => core.signalerAgent({ de: 'codex', vers: 'claude', projet: PROJET, ligne: 'C-0001', genre: 'Déjà fait', texte: 'corrigé par le commit abc1234 (Bouton.tsx:42)' }));
  const outil = () => hook(dir, { hook_event_name: 'PostToolUse', session_id: 'sess-1', prompt_id: 'p-1', cwd: CWD_PROJET, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} });
  const a = contexte(outil());
  assert.match(a, /^Signalement de codex sur ta ligne C-0001 \(deja-fait, \d{4}-\d\d-\d\d \d\d:\d\d ; état de la ligne : ouvert\) : « corrigé par le commit abc1234 \(Bouton\.tsx:42\) »\. Vérifie dans le code ou l'historique : si c'est exact, ferme la ligne par une preuve \[ctx C-0001\]/);
  assert.equal(outil().out, '', 'dit une seule fois');
  assert.equal(etat(dir).lignes['C-0001'].statut, 'ouvert', 'le signalement ne ferme rien');
  // Tant que la ligne est ouverte, il revient avec la liste (démarrage, reprise, compactage).
  const reprise = () => contexte(hook(dir, { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: CWD_PROJET, source: 'resume' }));
  assert.match(reprise(), /\nSignalements d'autres agents sur des lignes encore ouvertes \(1\) : C-0001 \(de codex, deja-fait, .+\) : « corrigé par le commit abc1234/);
  // Claude vérifie et ferme la ligne par sa preuve : le signalement ne revient plus.
  postWrite(dir, histoire(dir), '- bouton de paiement : corrigé par abc1234, vérifié [ctx C-0001]\n');
  assert.equal(etat(dir).lignes['C-0001'].statut, 'fait');
  assert.ok(!/Signalements d'autres agents/.test(reprise()));
  // Dans l'autre sens, par la CLI : Claude signale une question sur une ligne de la liste de Codex.
  const idCodex = avecRacine(dir, () => core.ajouterLigne({ projet: PROJET, agent: 'codex', texte: 'Ligne tenue par Codex', de: null }));
  const r = cli(dir, ['signaler', '--agent', 'codex', '--projet', PROJET, idCodex, '--genre', 'question', 'Quelle branche pour ce correctif ?']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^Signalement S-[a-z0-9]+-[0-9a-f]{6} déposé pour codex sur ${idCodex} \\(projet ${PROJET}, question\\)`));
  const boite = avecRacine(dir, () => core.lireBoite('codex', 0)).signalements;
  assert.deepEqual(boite.map(s => [s.de, s.ligne, s.genre, s.texte]), [['claude', idCodex, 'question', 'Quelle branche pour ce correctif ?']]);
  assert.deepEqual(Object.keys(etat(dir, PROJET, 'codex').lignes), [idCodex], 'la liste de Codex n\'est pas modifiée');
  // Refus : sa propre liste, une ligne absente ou close, sans destinataire, texte vide.
  for (const args of [
    ['--agent', 'claude', '--projet', PROJET, 'C-0001', 'x'],
    ['--agent', 'codex', '--projet', PROJET, 'C-9999', 'x'],
    ['--projet', PROJET, idCodex, 'x'],
    ['--agent', 'codex', '--projet', PROJET, idCodex],
  ]) assert.equal(cli(dir, ['signaler', ...args]).code, 1, `devait refuser : ${args.join(' ')}`);
  // Un sous-agent ne signale pas à un autre agent : il signale dans sa fiche, à son orchestrateur.
  const S = 'node "C:/outils/agent-memory-ledger/scripts/claude/context-ledger.js"';
  assert.ok(core.gardeOutil({ input: { hook_event_name: 'PreToolUse', agent_id: 'a42', tool_name: 'Bash', tool_input: { command: `${S} signaler --agent codex --projet x C-0001 "y"` }, cwd: CWD_PROJET } }));
});

test('transcript d\'un sous-agent : jamais lu avec l\'octet déjà vu de l\'orchestrateur (Claude : dossier subagents ; Codex : autre fil)', () => {
  const dir = dossier('transcript-sous-agent');
  const S = '01a0f9c2-ee5a-78c2-8f76-422e0199aea6';
  const d = path.join(RUN, 'transcript-sous-agent-fichiers');
  fs.mkdirSync(path.join(d, S, 'subagents'), { recursive: true });
  const ligne = JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n';
  const racineClaude = path.join(d, `${S}.jsonl`);
  const enfantClaude = path.join(d, S, 'subagents', 'agent-a1.jsonl');
  const racineCodex = path.join(d, `rollout-2026-10-02T00-18-16-${S}.jsonl`);
  const enfantCodex = path.join(d, 'rollout-2026-10-02T00-33-32-01a0f9d0-e693-7861-bb33-434fd1182af0.jsonl');
  for (const f of [racineClaude, enfantClaude, racineCodex, enfantCodex]) fs.writeFileSync(f, ligne);
  const suite = (agent, fichier) => avecRacine(dir, () => core.suiteTranscript({ agent, sessionId: S, fichier, surLigne: () => {} }));
  assert.deepEqual(suite('claude', racineClaude), { vu: ligne.length, base: true });
  assert.equal(suite('claude', enfantClaude), null);
  assert.deepEqual(suite('codex', racineCodex), { vu: ligne.length, base: true });
  assert.equal(suite('codex', enfantCodex), null);
  // Claude : un transcript au nom inattendu n'est pas pris pour un sous-agent (l'orchestrateur ne se tait jamais).
  assert.equal(core.transcriptDUnSousAgent(enfantCodex, S, 'claude'), false);
  assert.equal(core.idDepuisTranscript(enfantClaude), 'a1');
});

test('chercher : lecture seule, plusieurs mots, liste d\'un autre agent', () => {
  const dir = dossier('chercher');
  preparerLigne(dir, 'Corriger le bouton de paiement du tunnel de commande');
  cli(dir, ['ajouter', '--projet', PROJET, 'Arbitrer la licence LGPL de fpdf2']);
  cli(dir, ['etat', '--projet', PROJET, 'C-0002', 'bloque-utilisateur', 'attend la décision sur la licence']);
  const photo = () => {
    const out = [];
    const voir = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) voir(p); else { const s = fs.statSync(p); out.push(`${p}|${s.size}|${s.mtimeMs}`); } } };
    voir(dir);
    return out.sort();
  };
  const avant = photo();
  const r = cli(dir, ['chercher', '--projet', PROJET, 'paiement', 'lgpl', 'décision sur la licence', 'introuvable']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Recherche dans projet-demo\.claude \(2 lignes C, 1 messages M\) :/);
  assert.match(r.out, /« paiement » : 2 résultat\(s\)\n {2}C-0001 \| ouvert \| Corriger le bouton de paiement du tunnel de commande\n {2}M-0001 \| converti \| /);
  assert.match(r.out, /« lgpl » : 1 résultat\(s\)\n {2}C-0002 \| bloque-utilisateur \| Arbitrer la licence LGPL de fpdf2/);
  assert.match(r.out, /« décision sur la licence » : 1 résultat\(s\)\n {2}C-0002 \| bloque-utilisateur \| note : attend la décision sur la licence/);
  assert.match(r.out, /« introuvable » : 0 résultat\(s\)/);
  assert.match(r.out, /\nRappel : « ouvert » veut dire « pas encore prouvé fait », pas « pas fait » : avant d'agir sur une ligne ou de la dire non faite, mesure dans le code ou l'historique\. Une ligne que tu constates déjà faite se signale à celui qui tient la liste/);
  assert.deepEqual(photo(), avant, 'chercher n\'écrit rien');
  assert.match(cli(dir, ['chercher', '--agent', 'codex', 'paiement']).out, /^Aucun fichier contexte pour l'agent codex\./);
  assert.equal(cli(dir, ['chercher', '--agent', 'inconnu', 'x']).code, 1);
  assert.equal(cli(dir, ['chercher', '--projet', PROJET]).code, 1, 'aucun mot : erreur dite');
  // Un identifiant rend la ligne ou le message ENTIER (besoin relevé le 2026-10-02 : boucles de
  // sous-agents sur plusieurs C-NNNN.txt) ; un texte très long est borné, avec le chemin du texte entier.
  cli(dir, ['ajouter', '--projet', PROJET, 'Texte long. '.repeat(600)]);
  const parId = cli(dir, ['chercher', '--projet', PROJET, 'C-0002', 'm-0001', 'C-0003', 'C-9999']);
  assert.equal(parId.code, 0, parId.err);
  assert.match(parId.out, /\nC-0002 \| \d{4}-\d\d-\d\d \d\d:\d\d \| bloque-utilisateur\n {2}texte : Arbitrer la licence LGPL de fpdf2\n {2}note : attend la décision sur la licence\n/);
  assert.match(parId.out, /\nM-0001 \| .+ \| converti \| lignes C-0001\n {2}texte : Corrige le bouton de paiement, il ne répond plus\n/);
  assert.match(parId.out, /\nC-0003 \| .+ \| ouvert\n {2}texte : (Texte long\. ){500} \[…\] \(texte entier : .+C-0003\.txt\)\n/);
  assert.match(parId.out, /\n« C-9999 » : absent de cette liste\n/);
});

// Environ 1,3 % des PreToolUse de sous-agents Codex ne laissaient aucune trace dans la capture : sa
// ligne s'écrit à la sortie du processus, jamais quand le hook est tué. Une ligne courte au début le mesure.
test('capture de diagnostic : une ligne au début du hook, une à la fin ; un hook tué ne laisse que la première', () => {
  const dir = dossier('capture');
  const tmp = path.join(RUN, 'capture-tmp');
  const capture = path.join(tmp, 'agent-memory-ledger', 'capture-hooks');
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, 'actif'), '');
  const env = Object.assign(envPour(dir), { TEMP: tmp, TMP: tmp });
  const lire = f => (fs.existsSync(path.join(capture, f)) ? fs.readFileSync(path.join(capture, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const payload = { hook_event_name: 'PreToolUse', session_id: 's', agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'echo contenu-jamais-capture' }, cwd: CWD_PROJET };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const debuts = lire('claude.debuts.jsonl');
  assert.equal(debuts.length, 1, 'une ligne au début');
  // La session sert à écarter les hooks lancés par des bancs quand on compte les hooks tués.
  assert.deepEqual([debuts[0].evt, debuts[0].session_id, debuts[0].agent_id, debuts[0].tool_name], ['PreToolUse', 's', 'a1', 'Bash']);
  assert.ok(debuts[0].pid > 0 && debuts[0].demarrage_ms >= 0);
  const fins = lire('claude.jsonl');
  assert.equal(fins.length, 1, 'une ligne à la fin');
  assert.equal(fins[0].pid, debuts[0].pid);
  assert.ok(!JSON.stringify([debuts, fins]).includes('contenu-jamais-capture'), 'aucun contenu capturé');
  // Hook tué comme par son délai (fin brutale du processus) : la ligne de début reste, celle de fin manque.
  const tue = spawnSync(process.execPath, ['-e', `const core = require(${JSON.stringify(CORE_PATH)}); core.capturerEvenement({ agent: 'claude', input: { hook_event_name: 'PreToolUse', agent_id: 'a2' }, octets: 1 }); process.kill(process.pid, 'SIGKILL');`], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(tue.status, 0);
  assert.deepEqual(lire('claude.debuts.jsonl').map(x => x.agent_id), ['a1', 'a2']);
  assert.deepEqual(lire('claude.jsonl').map(x => x.agent_id), ['a1']);
});

// Mesuré le 2026-10-07 avec cette capture : un agent donne au hook la commande seule ({ command: "texte" }),
// sans dire quel shell la lancera. La capture garde la FORME de l'entrée d'un outil, jamais son contenu.
test('capture de diagnostic : la forme de l\'entrée d\'un outil (champs, type de la commande, shell nommé), jamais son contenu', () => {
  const tmp = path.join(RUN, 'capture-forme-tmp');
  const capture = path.join(tmp, 'agent-memory-ledger', 'capture-hooks');
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, 'actif'), '');
  const entrees = [
    { tool_name: 'Bash', tool_input: { command: 'echo contenu-jamais-capture', description: 'contenu-jamais-capture' } },
    { tool_name: 'Bash', tool_input: { command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoProfile', '-Command', 'echo contenu-jamais-capture', 'contenu-jamais-capture'] } },
    { tool_name: 'Bash', tool_input: { command: ['/usr/bin/bash', '-lc', 'echo contenu-jamais-capture'] } },
    { tool_name: 'Bash', tool_input: { command: ['git', 'contenu-jamais-capture'] } },
    { tool_name: 'exec_command', tool_input: { cmd: 'echo contenu-jamais-capture', shell: 'powershell', workdir: 'D:\\travail\\contenu-jamais-capture' } },
    { tool_name: 'apply_patch', tool_input: '*** Begin Patch contenu-jamais-capture' },
    { tool_name: 'Bash' },
  ];
  const code = `
    const core = require(${JSON.stringify(CORE_PATH)});
    for (const e of ${JSON.stringify(entrees)}) core.capturerEvenement({ agent: 'forme', input: Object.assign({ hook_event_name: 'PreToolUse' }, e), octets: 1 });`;
  const env = Object.assign({}, process.env, { TEMP: tmp, TMP: tmp });
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const brut = fs.readFileSync(path.join(capture, 'forme.jsonl'), 'utf8') + fs.readFileSync(path.join(capture, 'forme.debuts.jsonl'), 'utf8');
  assert.ok(!brut.includes('contenu-jamais-capture'), 'aucun contenu capturé : ' + brut);
  const fins = fs.readFileSync(path.join(capture, 'forme.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(fins.map(f => [f.outil_cles, f.outil_commande, f.outil_shell, f.outil_type]), [
    [['command', 'description'], 'string', undefined, undefined],
    [['command'], ['pwsh.exe', '-NoProfile', '-Command'], undefined, undefined],
    [['command'], ['bash', '-lc'], undefined, undefined],
    [['command'], ['git'], undefined, undefined],
    [['cmd', 'shell', 'workdir'], 'string', 'powershell', undefined],
    [undefined, undefined, undefined, 'string'],
    [undefined, undefined, undefined, undefined],
  ]);
});

// Constaté le 2026-10-07 : un hook de 21 s et un autre coupé à 30 s, node démarré en 41 ms dans les deux cas,
// et rien dans la capture pour dire quelle étape avait attendu. La ligne de fin porte maintenant la durée de
// chaque étape qui a pris du temps (attente d'un verrou, copie de secours, transcript, preuves).
test('capture de diagnostic : la ligne de fin dit où le temps est passé (ici l\'attente d\'un verrou)', () => {
  const dir = dossier('capture-jalons');
  const tmp = path.join(RUN, 'capture-jalons-tmp');
  const capture = path.join(tmp, 'agent-memory-ledger', 'capture-hooks');
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, 'actif'), '');
  fs.mkdirSync(path.join(dir, '.sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sessions', 'claude-s-jalons.json.lock'), 'tenu');
  // Le verrou de la session est tenu : le noyau l'attend jusqu'à l'échéance (0,8 s), puis renonce.
  const code = `
    const core = require(${JSON.stringify(CORE_PATH)});
    core.capturerEvenement({ agent: 'claude', input: { hook_event_name: 'Stop', session_id: 's-jalons' }, octets: 1 });
    core.fixerBudget(Math.round(process.uptime() * 1000) + 800);
    try { core.modifierSession('claude', 's-jalons', x => { x.vu = 1; }); } catch (_) { /* verrou tenu jusqu'à l'échéance */ }`;
  const env = Object.assign({}, process.env, { CONTEXT_LEDGER_DIR: dir, TEMP: tmp, TMP: tmp });
  delete env.CONTEXT_LEDGER_BUDGET_MS;
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const fin = JSON.parse(fs.readFileSync(path.join(capture, 'claude.jsonl'), 'utf8').trim());
  assert.ok(fin.verrou_ms >= 500 && fin.verrou_ms <= fin.dur_ms, `attente du verrou mesurée : ${fin.verrou_ms} ms sur ${fin.dur_ms} ms`);
  assert.equal(fin.secours_ms, undefined, 'une étape qui n\'a pris aucun temps n\'est pas écrite');
  assert.equal(fin.transcript_ms, undefined);
});

// Constaté dans une session réelle : « Fichier contexte : rappel de fin de tour, hook timed out after 10s ».
// Mesuré : le hook prend moins d'une seconde au repos ; sous forte charge, le démarrage de node et l'attente
// d'un verrou occupé le font dépasser. Un hook tué ne rend rien : les attentes s'arrêtent donc à l'échéance.
test('budget de temps : l\'attente d\'un verrou s\'arrête à l\'échéance du hook, démarrage compris', () => {
  const dir = dossier('budget');
  fs.mkdirSync(path.join(dir, '.sessions'), { recursive: true });
  const code = budget => `
    const core = require(${JSON.stringify(CORE_PATH)});
    const fs = require('fs'); const path = require('path');
    fs.writeFileSync(path.join(process.env.CONTEXT_LEDGER_DIR, '.sessions', 'claude-s-budget.json.lock'), 'tenu');
    ${budget ? `core.fixerBudget(${budget});` : ''}
    const d = Date.now(); let e = '';
    try { core.modifierSession('claude', 's-budget', x => { x.vu = 1; }); } catch (x) { e = x.message; }
    process.stdout.write(JSON.stringify({ ms: Date.now() - d, e, reste: core.tempsRestant() }));`;
  const lancer = budget => {
    const env = Object.assign({}, process.env, { CONTEXT_LEDGER_DIR: dir });
    delete env.CONTEXT_LEDGER_BUDGET_MS;
    return JSON.parse(spawnSync(process.execPath, ['-e', code(budget)], { env, encoding: 'utf8', timeout: 60000, windowsHide: true }).stdout);
  };
  const sans = lancer(0);
  assert.match(sans.e, /verrou occupé/);
  assert.ok(sans.ms >= 2500, `sans budget, l'attente normale d'un verrou dure 3 s (mesuré : ${sans.ms} ms)`);
  assert.equal(sans.reste, null, 'sans budget : pas d\'échéance (Infinity)');
  const avec = lancer(1);
  assert.match(avec.e, /verrou occupé/);
  assert.ok(avec.ms < 1500, `budget épuisé : aucune attente (mesuré : ${avec.ms} ms)`);
  assert.ok(avec.reste < 0);
});

test('mutation : fiches de sous-agents, lecture de la liste, signalements, budget de temps -> banc rouge', { skip: EN_MUTATION }, () => {
  const motif = '^(fiche de sous-agent|compactage d.un sous-agent|signalement d.un sous-agent|signalement entre agents|transcript d.un sous-agent|chercher|budget de temps|garde : sous-agent|message humain|capture de diagnostic)';
  const temoin = relancer(copie('temoin-fiches'), motif);
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const NOYAU = 'lib/context-ledger-core.js';
  const ADAPTATEUR = 'claude/context-ledger.js';
  // Chaque mutation ne rejoue que le test qui doit rougir (le témoin, lui, les a tous rejoués verts).
  const FICHE = '^fiche de sous-agent : mission';
  const COMPACT = '^compactage d.un sous-agent';
  const GARDE = '^garde : sous-agent : ';
  const mutations = [
    ['fiche-creation', '      // MUTATION : fiche jamais écrite', /not ok \d+ - fiche de sous-agent : mission copiée/, NOYAU, FICHE],
    ['fiche-mission', '    // MUTATION : mission jamais copiée dans la fiche', /not ok \d+ - fiche de sous-agent : mission copiée/, NOYAU, FICHE],
    ['fiche-note', '    // MUTATION : note du sous-agent perdue', /not ok \d+ - fiche de sous-agent : mission copiée/, NOYAU, FICHE],
    ['fiche-compactage', '      // MUTATION : compactage du sous-agent jamais vu', /not ok \d+ - fiche de sous-agent : mission copiée/, NOYAU, FICHE],
    ['fiche-annonce-par-evenement', '  // MUTATION : compactage annoncé par son événement ignoré', /not ok \d+ - fiche de sous-agent : démarrage avant/, NOYAU, '^fiche de sous-agent : d.marrage'],
    ['consigne-ne-devie-pas', "    '', // MUTATION : la consigne ne dit plus au sous-agent de s'en tenir à sa mission", /not ok \d+ - fiche de sous-agent : mission copiée/, NOYAU, FICHE],
    // La mission prime sur la fiche : réserve retirée de la consigne ou de la fiche rendue, relance oubliée.
    ['consigne-reserve', "    'Note dans ta fiche ton avancement et ce que tu trouves : ' + commandeNote(script, index.id, '\"fait : ... ; reste : ... ; à inscrire : ...\"') + '.', // MUTATION : écriture de la fiche demandée même quand la mission l'interdit", /not ok \d+ - fiche de sous-agent : mission copiée/, NOYAU, FICHE],
    ['reprise-reserve', "    'Continue à y noter ton avancement : ' + commandeNote(script, f.index.id, '\"...\"') + '. ' + NE_DEVIE_PAS + ' ' + texteLectureSeule(script, f.index.projet), // MUTATION : fiche rendue sans la réserve", /not ok \d+ - fiche de sous-agent : démarrage avant/, NOYAU, '^fiche de sous-agent : d.marrage'],
    ['reprise-relance', "  const relance = ''; // MUTATION : la fiche rendue ne dit plus qu'une tâche plus récente remplace celle du lancement", /not ok \d+ - fiche de sous-agent : démarrage avant/, NOYAU, '^fiche de sous-agent : d.marrage'],
    ['reprise-sous-agent', '  // MUTATION : fiche jamais rendue au sous-agent', /not ok \d+ - fiche de sous-agent : mission copiée/, ADAPTATEUR, FICHE],
    ['consigne-filet', '  // MUTATION : consigne jamais donnée quand le démarrage du sous-agent n\'a pas été vu', /not ok \d+ - fiche de sous-agent : consigne donnée/, ADAPTATEUR, '^fiche de sous-agent : consigne'],
    ['fiche-reprise-unique', '  const rendre = trouve || !!annonce; // MUTATION : la fiche est rendue deux fois pour un même compactage', /not ok \d+ - compactage d.un sous-agent vu par SessionStart/, NOYAU, COMPACT],
    ['sous-agent-par-transcript', '  // MUTATION : sous-agent sans agent_id pris pour l\'orchestrateur', /not ok \d+ - compactage d.un sous-agent vu par SessionStart/, ADAPTATEUR, COMPACT],
    ['fiche-signalement', '    continue; // MUTATION : signalements des sous-agents jamais dits', /not ok \d+ - signalement d.un sous-agent/, NOYAU, '^signalement d.un sous-agent'],
    ['pour-orchestrateur', '  const entete = `Fichier contexte (projet ${projet}, agent ${agent}) : ${chemins(projet, agent).md}`; // MUTATION : destinataire non dit', /not ok \d+ - message humain/, NOYAU, '^message humain'],
    ['chercher-rappel', '  // MUTATION : rappel « ouvert n\'est pas pas fait » retiré', /not ok \d+ - chercher/, NOYAU, '^chercher'],
    ['lecture-sous-agent', '      if (touche) return RAISON_SOUS_AGENT; // MUTATION : lecture de nouveau refusée au sous-agent', /not ok \d+ - garde : sous-agent : écriture/, NOYAU, GARDE],
    ['cli-sous-agent', '  if (RE_CLI_SEGMENT.test(s)) return true; // MUTATION : toute la CLI ouverte au sous-agent', /not ok \d+ - garde : sous-agent : écriture/, NOYAU, GARDE],
    ['note-propre-fiche', '  return true; // MUTATION : un sous-agent note dans la fiche d\'un autre', /not ok \d+ - garde : sous-agent : écriture/, NOYAU, GARDE],
    ['transcript-sous-agent', '  // MUTATION : le transcript d\'un sous-agent est lu avec l\'octet de l\'orchestrateur', /not ok \d+ - transcript d.un sous-agent/, NOYAU, '^transcript d.un sous-agent'],
    ['echeance-verrou', '  const limite = Date.now() + DELAI_VERROU_MS; // MUTATION : attente sans échéance', /not ok \d+ - budget de temps/, NOYAU, '^budget de temps'],
    // Consigne marquée mais absente du transcript du sous-agent.
    ['consigne-vue', '      vue = true; // MUTATION : toute ligne qui cite la consigne compte, brief compris', /not ok \d+ - fiche de sous-agent : consigne marquée/, NOYAU, '^fiche de sous-agent : consigne marquée'],
    ['consigne-redonnee', '      return false; // MUTATION : consigne absente du transcript jamais redonnée', /not ok \d+ - fiche de sous-agent : consigne marquée/, NOYAU, '^fiche de sous-agent : consigne marquée'],
    ['capture-debut', '    // MUTATION : pas de ligne au début du hook', /not ok \d+ - capture de diagnostic : une ligne/, NOYAU, '^capture de diagnostic'],
    // Durée des étapes : jamais mesurée, ou absente de la ligne de fin.
    ['jalons', '  return fn(); // MUTATION : durée des étapes jamais mesurée', /not ok \d+ - capture de diagnostic : la ligne de fin/, NOYAU, '^capture de diagnostic'],
    ['capture-jalons', '      // MUTATION : durée des étapes absente de la ligne de fin', /not ok \d+ - capture de diagnostic : la ligne de fin/, NOYAU, '^capture de diagnostic'],
    ['capture-forme-outil', '      ligne.outil_commande = c.map(x => chaine(x)); // MUTATION : la commande entière dans la capture', /not ok \d+ - capture de diagnostic : la forme/, NOYAU, '^capture de diagnostic'],
    // Rapport d'un sous-agent dont le texte cite la liste : chaque condition de la forme prouvée.
    ['texte-powershell', '    const texte = qui => ecritureDeTexteLitteral(cmd, dossier, qui); // MUTATION : écriture de texte reconnue sans preuve du shell', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['texte-hors-racine', '  if (cible === null) return false; // MUTATION : la cible de l\'écriture n\'est plus contrôlée', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['cible-affectee-une-fois', '  // MUTATION : une cible affectée plusieurs fois est acceptée', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['texte-reste-lecture', '  return true; // MUTATION : le reste de la commande n\'est plus jugé', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['texte-cible-complete', '  // MUTATION : chemin relatif, réseau ou lecteur de fournisseur accepté', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['texte-cible-nommee', '  // MUTATION : joker, variable, nom court ou flux accepté dans la cible', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['texte-cible-extension', '  // MUTATION : toute extension acceptée, script compris', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    ['texte-ambigu', '  // MUTATION : guillemet typographique accepté dans la cible ou les arguments de l\'écriture', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    // Ce que PowerShell lit autrement que la garde : accepté de nouveau dans une lecture, ou dans un appel de la CLI.
    ['lecture-ambigue', '  // MUTATION : guillemet typographique et commentaire acceptés dans une lecture', /not ok \d+ - garde : sous-agent : ce que PowerShell lit autrement/, NOYAU, GARDE],
    ['cli-ambigue', '  // MUTATION : guillemet typographique et commentaire acceptés dans un appel de la CLI', /not ok \d+ - garde : sous-agent : ce que PowerShell lit autrement/, NOYAU, GARDE],
    ['texte-fermeture', '  const reFermeture = /\\n\'@/g; // MUTATION : fermeture du here-string lue en ASCII seulement', /not ok \d+ - garde : sous-agent : son rapport/, NOYAU, GARDE],
    // Titre de repli, mission absente, chercher par identifiant, aide, formes de lecture de la garde.
    ['fiche-titre', '      if (false) { // MUTATION : titre de repli jamais remplacé', /not ok \d+ - fiche de sous-agent : démarrage avant/, NOYAU, '^fiche de sous-agent : d.marrage'],
    ['reprise-sans-mission', "  const sansMission = f.index.mission ? '' : ' Ta mission n\\'y a pas été copiée : si le résumé ne te la rend pas mot pour mot, redemande-la à l\\'orchestrateur avant de continuer, puis recopie-la dans ta fiche (note --genre mission).'; // MUTATION : ancienne formulation", /not ok \d+ - fiche de sous-agent : démarrage avant/, NOYAU, '^fiche de sous-agent : d.marrage'],
    ['chercher-id', '      const t = null; // MUTATION : un identifiant cherché comme un simple mot', /not ok \d+ - chercher/, NOYAU, '^chercher'],
    ['cli-help', '    // MUTATION : help inconnue de la CLI', /not ok \d+ - garde : sous-agent : sous-expressions/, NOYAU, GARDE],
    ['blocs-surs', '  let masque = masquerChaines(c); // MUTATION : blocs sans effet refusés comme avant', /not ok \d+ - garde : sous-agent : sous-expressions/, NOYAU, GARDE],
    ['sous-expression-collee', '      // MUTATION : parenthèse collée à un nom (méthode) remplacée aussi', /not ok \d+ - garde : sous-agent : sous-expressions/, NOYAU, GARDE],
    ['sous-expression-appel', '    // MUTATION : & (x) accepté', /not ok \d+ - garde : sous-agent : sous-expressions/, NOYAU, GARDE],
    ['variable-pipeline', '    // MUTATION : variable acceptée après un |', /not ok \d+ - garde : sous-agent : sous-expressions/, NOYAU, GARDE],
    ['masque-utf16', '  const masque = [...c]; // MUTATION : masque par points de code, segments décalés', /not ok \d+ - garde : sous-agent : sous-expressions/, NOYAU, GARDE],
    // Boîte de signalements entre agents principaux.
    ['signaler-boite', '  // MUTATION : boîte jamais écrite', /not ok \d+ - signalement entre agents/, NOYAU, '^signalement entre agents'],
    ['signalements-agents', '  // MUTATION : signalements d\'autres agents jamais dits', /not ok \d+ - signalement entre agents/, NOYAU, '^signalement entre agents'],
    ['signalements-attente', '  // MUTATION : signalements en attente absents de la liste réinjectée', /not ok \d+ - signalement entre agents/, NOYAU, '^signalement entre agents'],
  ];
  for (const [ancre, remplacement, rouge, fichier, seul] of mutations) {
    const r = relancer(copie('mutation-' + ancre, fichier, 'ancre-mutation:' + ancre, remplacement), seul);
    assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
    assert.match(r.stdout, rouge, ancre);
  }
});

// ---------------------------------------------------------------------------
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

test('mutation : livraisons non inscrites, fin non marquée, rappel retiré, reprise non suivie, fin jamais annoncée, ou rappel en cours de tour retiré -> banc rouge', { skip: EN_MUTATION }, () => {
  const motif = 'sous-agent (en arri.re-plan|repris|fini pendant)';
  const temoin = relancer(copie('temoin-livraisons'), motif);
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const NOYAU = 'lib/context-ledger-core.js';
  const mutations = [
    ['livraison-lancement', '  return null; // MUTATION : aucune ligne créée au lancement', /not ok \d+ - sous-agent en arri.re-plan/, NOYAU],
    ['livraison-fin', '  return null; // MUTATION : fin de sous-agent non marquée', /not ok \d+ - sous-agent en arri.re-plan/, NOYAU],
    ['livraison-rappel-fin-de-tour', '  const attente = []; // MUTATION : rappel des livraisons retiré', /not ok \d+ - sous-agent en arri.re-plan/, NOYAU],
    ['livraison-reprise', '  return null; // MUTATION : nouveau résultat après clôture non suivi', /not ok \d+ - sous-agent repris/, NOYAU],
    ['livraison-annonce', '  const nouvelles = []; // MUTATION : fin marquée en silence jamais annoncée', /not ok \d+ - sous-agent fini pendant/, NOYAU],
    ['livraison-rappel-en-cours', '  const rappeler = false; // MUTATION : rappel en cours de tour retiré', /not ok \d+ - sous-agent fini pendant/, NOYAU],
    ['livraison-rappel-en-cours', '  const rappeler = age(s.rappelLivraisons) >= delai && etat.attente.some(t => t.annonce && age(t.fini) >= delai); // MUTATION : délai compté depuis la fin, rappel dans la foulée de l\'annonce', /not ok \d+ - sous-agent fini pendant/, NOYAU],
    ['suivi-en-cours', "  return ''; // MUTATION : suivi en cours de tour débranché de l'adaptateur", /not ok \d+ - sous-agent fini pendant/, 'claude/context-ledger.js'],
  ];
  for (const [ancre, remplacement, rouge, fichier] of mutations) {
    const r = relancer(copie('mutation-' + ancre, fichier, 'ancre-mutation:' + ancre, remplacement), motif);
    assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
    assert.match(r.stdout, rouge, ancre);
  }
});

test('mutation : lignes du tour de nouveau rappelées en fin de tour -> banc rouge', { skip: EN_MUTATION }, () => {
  const motif = 'ligne cr..e ou tenue . jour pendant le tour';
  const temoin = relancer(copie('temoin-stop-lignes'), motif);
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutant = copie('mutation-stop-lignes', 'lib/context-ledger-core.js', 'ancre-mutation:stop-lignes-du-tour',
    '  if (!aTrier.length && !trierIds(etat.lignes).some(id => etat.lignes[id].maj >= s.tourDebut && !TERMINAUX.includes(etat.lignes[id].statut))) return null; // MUTATION : lignes du tour de nouveau rappelées');
  const r = relancer(mutant, motif);
  assert.notEqual(r.status, 0, 'la mutation doit rendre un banc rouge :\n' + r.stdout);
  assert.match(r.stdout, /not ok \d+ - fin de tour : une ligne cr..e ou tenue . jour pendant le tour/);
});
