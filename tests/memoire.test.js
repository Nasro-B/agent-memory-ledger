'use strict';
// Bancs des hooks de mémoire (scripts/memoire) et de la détection de projet (scripts/lib/config.js), sans modèle.
// Lancement : node --test tests/memoire.test.js
// Jamais dans la vraie maison (~/.agent-memory-ledger) : chaque test a sa propre maison et son propre dépôt git
// jetable sous <dossier temporaire>/aml-tests/memoire. Les sorties destinées à Codex sont validées contre le
// schéma de sortie de codex-cli 0.155 (tests/schema.js).
// Variables internes (tests de mutation, qui relancent ce fichier sur une copie mutée) :
//   AML_SCRIPTS      dossier scripts/ à tester (défaut : ../scripts)
//   AML_EN_MUTATION  '1' = exécution sur une copie (pas de récursion)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');
const { test, before } = require('node:test');
const { erreursSortieCodex } = require('./schema.js');

const SCRIPTS = process.env.AML_SCRIPTS || path.join(__dirname, '..', 'scripts');
const EN_MUTATION = process.env.AML_EN_MUTATION === '1';
const BASE_TESTS = process.env.CONTEXT_LEDGER_BASE_TESTS || path.join(os.tmpdir(), 'aml-tests', 'memoire');
const RUN = path.join(BASE_TESTS, (EN_MUTATION ? 'mut-' : 'run-') + Date.now() + '-' + process.pid);
const VRAIE_MAISON = path.join(os.homedir(), '.agent-memory-ledger');
const PROJET = 'projet-demo';

for (const k of ['CONTEXT_LEDGER_DIR', 'CONTEXT_LEDGER_SECOURS_DIR', 'AGENT_MEMORY_LEDGER_HOME']) delete process.env[k];

before(() => {
  const norm = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  assert.ok(!norm(RUN).startsWith(norm(VRAIE_MAISON)), 'les tests ne doivent jamais viser la vraie maison');
  fs.mkdirSync(RUN, { recursive: true });
});

// Un test = une maison, et un dépôt git « projet-demo » (reconnu par la table des projets de cette maison).
function monde(nom, { depot = true } = {}) {
  const base = path.join(RUN, nom);
  fs.rmSync(base, { recursive: true, force: true });
  const maison = path.join(base, '.agent-memory-ledger');
  fs.mkdirSync(path.join(maison, 'history'), { recursive: true });
  fs.writeFileSync(path.join(maison, 'projets.json'), JSON.stringify({ projets: [{ nom: PROJET, motif: 'projet-demo' }] }));
  const repo = path.join(base, 'projet-demo');
  fs.mkdirSync(repo, { recursive: true });
  const m = { base, maison, repo, sansHooks: path.join(base, 'hooks-vides') };
  if (depot) {
    fs.mkdirSync(m.sansHooks, { recursive: true });
    git(m, ['init', '-q']);
    git(m, ['config', 'user.email', 'banc@example.invalid']);
    git(m, ['config', 'user.name', 'Banc']);
    git(m, ['config', 'core.hooksPath', m.sansHooks]);
    git(m, ['config', 'commit.gpgsign', 'false']);
  }
  return m;
}

function git(m, args) { return execFileSync('git', args, { cwd: m.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function envPour(m) { return Object.assign({}, process.env, { AGENT_MEMORY_LEDGER_HOME: m.maison }); }

function lancer(m, script, args, payload, extraEnv) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    input: payload === undefined ? '' : JSON.stringify(payload), env: Object.assign(envPour(m), extraEnv || {}), encoding: 'utf8', cwd: m.base, timeout: 30000, windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  let json = null;
  try { json = out ? JSON.parse(out) : null; } catch (_) { json = null; }
  return { code: r.status, out, err: r.stderr || '', json };
}

const hook = (m, script, agent, payload, extraEnv) => lancer(m, path.join('memoire', script), ['--agent', agent], payload, extraEnv);
const ctx = r => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext : '');
const histoire = (m, agent = 'claude') => path.join(m.maison, 'history', `${PROJET}.${agent}.md`);
const lire = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const resume = m => lire(path.join(m.maison, 'Memory-Auto.md'));
const marqueur = m => { const f = path.join(m.maison, 'etat', '.session-pending-' + PROJET); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };

function horo(decalageMs = 0) {
  const d = new Date(Date.now() + decalageMs);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function commiter(m, fichier, message) {
  fs.writeFileSync(path.join(m.repo, fichier), 'contenu ' + Date.now());
  git(m, ['add', fichier]);
  git(m, ['commit', '-q', '-m', message]);
  return git(m, ['log', '-1', '--format=%h']).trim();
}

// ---------------------------------------------------------------------------
// Détection de projet

test('projet : table des projets, puis dépôt git (worktree compris), sinon aucun ; noms rendus sûrs', () => {
  const m = monde('projet');
  const config = require(path.join(SCRIPTS, 'lib', 'config.js'));
  const avant = { h: process.env.AGENT_MEMORY_LEDGER_HOME, t: process.env.TEMP, t2: process.env.TMP };
  try {
    process.env.AGENT_MEMORY_LEDGER_HOME = m.maison;
    assert.equal(config.detecterProjet('C:\\travail\\Projet-Demo\\src\\a.js'), PROJET, 'la table reconnaît le chemin, sans tenir compte de la casse');
    assert.equal(config.detecterProjet(''), null);
    assert.equal(config.nomSur('Mon projet (v2) !'), 'Mon-projet-v2');
    assert.equal(config.nomSur('..'), null);
    // Dépôt hors de la table : son dossier racine donne le nom, depuis n'importe quel sous-dossier.
    const autre = path.join(m.base, 'Autre Depot');
    fs.mkdirSync(path.join(autre, '.git'), { recursive: true });
    fs.mkdirSync(path.join(autre, 'src', 'lib'), { recursive: true });
    assert.equal(config.racineDepot(path.join(autre, 'src', 'lib')), autre);
    // Worktree : « .git » est un fichier qui pointe vers <dépôt>/.git/worktrees/<nom>.
    const wt = path.join(m.base, 'wt-1');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.join(autre, '.git', 'worktrees', 'wt-1') + '\n');
    assert.equal(config.racineDepot(wt), autre, 'un worktree compte pour son dépôt');
    // Un dépôt jetable sous le dossier temporaire n'est pas un projet...
    assert.equal(config.detecterProjet(path.join(autre, 'src')), null);
    // ... le même dépôt ailleurs en est un.
    process.env.TEMP = path.join(m.base, 'tmp-ailleurs'); process.env.TMP = process.env.TEMP;
    fs.mkdirSync(process.env.TEMP, { recursive: true });
    if (!path.resolve(autre).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
      assert.equal(config.detecterProjet(path.join(autre, 'src')), 'Autre-Depot');
      assert.equal(config.detecterProjet(wt), 'Autre-Depot');
    }
    // La maison elle-même n'est jamais un projet.
    fs.mkdirSync(path.join(m.maison, '.git'), { recursive: true });
    assert.equal(config.detecterProjet(path.join(m.maison, 'history')), null);
  } finally {
    for (const [k, v] of [['AGENT_MEMORY_LEDGER_HOME', avant.h], ['TEMP', avant.t], ['TMP', avant.t2]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---------------------------------------------------------------------------
// Démarrage

test('démarrage : règles, résumé, journaux (le sien d\'abord), alerte ; sortie sous le plafond ; hors projet et sous-agent : rien', () => {
  const m = monde('demarrage', { depot: false });
  fs.writeFileSync(path.join(m.maison, 'history', `${PROJET}.rules.md`), '- Toujours lancer les tests avant de commiter\n');
  fs.writeFileSync(histoire(m, 'claude'), `# Historique\n\n---\n\n## ${horo()} | fix | bouton réparé | Claude\n\n- détail claude\n`);
  fs.writeFileSync(histoire(m, 'codex'), `# Historique\n\n---\n\n## ${horo()} | feat | export ajouté | Codex\n\n- détail codex\n`);
  fs.writeFileSync(path.join(m.maison, 'history', 'autre-projet.claude.md'), '# Historique\n\n---\n\n## 2020-01-01 10:00 | fix | hors sujet | Claude\n');
  fs.writeFileSync(path.join(m.maison, 'Memory-Auto.md'), `# Memory-Auto\n\n### autre-projet\n- 2020-01-01 10:00 | fix | hors sujet | Claude\n\n### ${PROJET}\n- ${horo()} | fix | bouton réparé | Claude\n`);
  fs.mkdirSync(path.join(m.maison, 'etat'), { recursive: true });
  fs.writeFileSync(path.join(m.maison, 'etat', '.session-pending-' + PROJET), JSON.stringify({ ts: new Date(Date.now() - 5 * 60000).toISOString(), lastFile: path.join(m.repo, 'a.js'), count: 3 }));

  const r = hook(m, 'demarrage.js', 'claude', { hook_event_name: 'SessionStart', session_id: 's1', cwd: m.repo, source: 'startup' });
  assert.equal(r.code, 0, r.err);
  const c = ctx(r);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(c, /^## Attention : session précédente non documentée\n- 3 fichier\(s\) modifié\(s\) sans commit/, 'l\'alerte passe en premier');
  assert.match(c, /## Règles et réflexes : projet-demo[^\n]*\n- Toujours lancer les tests/);
  assert.match(c, /## Memory-Auto \| projet-demo \(12 dernières\)\n- .* bouton réparé/);
  assert.ok(c.indexOf('projet-demo.claude.md (récent)') < c.indexOf('projet-demo.codex.md (récent)'), 'le journal de cet agent d\'abord');
  assert.ok(!c.includes('hors sujet'), 'rien des autres projets');
  assert.match(c, /PROTOCOLE-MEMOIRE\.md/);
  assert.ok(c.length <= 9000);
  assert.match(r.json.systemMessage, /Mémoire projet-demo chargée/);

  // Codex : même contenu, sortie strictement conforme (aucun champ en plus), son propre journal en premier.
  const rc = hook(m, 'demarrage.js', 'codex', { hook_event_name: 'SessionStart', session_id: 's1', cwd: m.repo, source: 'startup' });
  assert.deepEqual(erreursSortieCodex('SessionStart', rc.out), []);
  assert.deepEqual(Object.keys(rc.json), ['hookSpecificOutput']);
  assert.ok(ctx(rc).indexOf('projet-demo.codex.md (récent)') < ctx(rc).indexOf('projet-demo.claude.md (récent)'));

  // Journal très long : coupé, avec le chemin du texte complet.
  fs.writeFileSync(histoire(m, 'claude'), '# Historique\n\n---\n' + Array.from({ length: 25 }, (_, i) => `\n## ${horo()} | fix | entrée ${i} ` + 'x'.repeat(700)).join('\n'));
  const long = ctx(hook(m, 'demarrage.js', 'claude', { hook_event_name: 'SessionStart', session_id: 's1', cwd: m.repo, source: 'startup' }));
  assert.ok(long.length <= 9000, 'taille ' + long.length);
  assert.match(long, /\[\.\.\. tronqué : texte complet dans .*projet-demo\.claude\.md\]/);

  assert.equal(hook(m, 'demarrage.js', 'claude', { hook_event_name: 'SessionStart', session_id: 's1', cwd: m.base, source: 'startup' }).out, '', 'hors projet : rien');
  assert.equal(hook(m, 'demarrage.js', 'claude', { hook_event_name: 'SessionStart', session_id: 's1', cwd: m.repo, source: 'startup', agent_id: 'a1' }).out, '', 'sous-agent : rien');
  assert.equal(lancer(m, path.join('memoire', 'demarrage.js'), [], { hook_event_name: 'SessionStart', cwd: m.repo }).out, '', 'sans --agent : rien');
});

// ---------------------------------------------------------------------------
// Commits

test('commit : entrée signée dans le journal et le résumé, marqueur retiré, jamais deux fois ; une citation n\'est pas un commit', () => {
  const m = monde('commit');
  hook(m, 'marqueur.js', 'claude', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Write', tool_input: { file_path: path.join(m.repo, 'a.txt'), content: 'x' } });
  assert.equal(marqueur(m).count, 1);
  commiter(m, 'premier.txt', 'chore: base');
  const sha = commiter(m, 'a.txt', 'fix(paiement): bouton réparé');
  // Une commande qui CITE « git commit » : rien, même avec un commit frais dans le dépôt.
  for (const command of ['rg "git commit" docs', 'echo "à faire : tests && git commit"']) {
    const cite = hook(m, 'commit.js', 'claude', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '' } });
    assert.equal(cite.out, '', command);
  }
  assert.equal(lire(histoire(m)), '', 'une citation ne journalise rien');
  const payload = { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "fix(paiement): bouton réparé"' }, tool_response: { stdout: `[main ${sha}] fix(paiement): bouton réparé` } };
  const r = hook(m, 'commit.js', 'claude', payload);
  assert.match(r.json.systemMessage, /Entrée signée Claude/);
  const h = lire(histoire(m));
  assert.match(h, new RegExp(`^# Historique projet-demo \\| Claude\\n\\nEntrées les plus récentes en haut\\.\\n\\n---\\n\\n## \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d \\| fix \\| bouton réparé \\(commit ${sha}\\) \\| Claude\\n\\n- a\\.txt`));
  assert.match(resume(m), new RegExp(`### projet-demo\\n- \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d \\| fix \\| bouton réparé \\(commit ${sha}\\) \\| Claude`));
  assert.equal(marqueur(m), null, 'le commit documente le travail : marqueur retiré');
  // Même commit vu une seconde fois (autre hook, relance) : aucune seconde entrée.
  hook(m, 'commit.js', 'claude', payload);
  assert.equal(lire(histoire(m)).split(`(commit ${sha})`).length - 1, 1);
  assert.equal(resume(m).split(`(commit ${sha})`).length - 1, 1);
  // Commit suivant : sa nouvelle entrée passe en tête du journal ; `cd <dépôt> && git commit -F`, cwd ailleurs.
  fs.writeFileSync(path.join(m.base, 'msg.txt'), 'feat: export PDF\n\nCorps du message\n');
  fs.writeFileSync(path.join(m.repo, 'b.txt'), 'b');
  git(m, ['add', 'b.txt']);
  git(m, ['commit', '-q', '-F', path.join(m.base, 'msg.txt')]);
  const sha2 = git(m, ['log', '-1', '--format=%h']).trim();
  hook(m, 'commit.js', 'claude', { hook_event_name: 'PostToolUse', cwd: m.base, tool_name: 'PowerShell', tool_input: { command: `cd "${m.repo}" && git commit -F ../msg.txt` } });
  const h2 = lire(histoire(m));
  assert.ok(h2.indexOf(`(commit ${sha2})`) < h2.indexOf(`(commit ${sha})`), 'la plus récente en haut');
  assert.match(h2, /- Corps du message/);
  // Commande en échec : rien.
  commiter(m, 'c.txt', 'fix: troisième');
  const avant = lire(histoire(m));
  hook(m, 'commit.js', 'claude', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, tool_response: { stdout: '', stderr: 'error: gpg failed to sign the data', exit_code: 1 } });
  assert.equal(lire(histoire(m)), avant);
});

test('commit : git ne répond pas à temps -> rien n\'est écrit, mais le modèle est prévenu (jamais d\'oubli silencieux)', () => {
  const m = monde('commit-delai');
  commiter(m, 'premier.txt', 'chore: base');
  commiter(m, 'a.txt', 'fix: lent');
  const payload = { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "fix: lent"' }, tool_response: { stdout: '' } };
  const r = hook(m, 'commit.js', 'claude', payload, { AML_DELAI_GIT_MS: '1' });
  assert.match(ctx(r), /^Mémoire : ce commit n'a pas pu être journalisé \(git n'a pas répondu en \d+ s\)\. Écris toi-même son entrée dans .*projet-demo\.claude\.md/);
  assert.equal(lire(histoire(m)), '');
  // Côté Codex : même signalement, conforme au schéma de sortie.
  const rc = hook(m, 'commit.js', 'codex', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'exec_command', tool_input: { cmd: 'git commit -m "fix: lent"', workdir: m.repo }, tool_response: { output: 'ok' } }, { AML_DELAI_GIT_MS: '1' });
  assert.deepEqual(erreursSortieCodex('PostToolUse', rc.out), []);
  assert.match(ctx(rc), /n'a pas pu être journalisé/);
  // Avec le délai normal, le même commit est journalisé.
  hook(m, 'commit.js', 'claude', payload);
  assert.match(lire(histoire(m)), /\| fix \| lent \(commit [0-9a-f]+\) \| Claude/);
});

test('commit et marqueur côté Codex : commande directe, code qui appelle exec_command, apply_patch ; journal signé Codex', () => {
  const m = monde('commit-codex');
  const patch = `*** Begin Patch\n*** Update File: ${path.join(m.repo, 'src', 'a.js')}\n@@\n+x\n*** Add File: ${path.join(m.repo, 'node_modules', 'x', 'index.js')}\n+y\n*** End Patch`;
  const rm = hook(m, 'marqueur.js', 'codex', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: { output: 'Success' } });
  assert.equal(rm.out, '');
  assert.equal(marqueur(m).count, 1, 'un fichier compté, node_modules ignoré');
  assert.match(marqueur(m).lastFile, /src[\\/]a\.js$/);
  commiter(m, 'premier.txt', 'chore: base');
  const sha = commiter(m, 'a.txt', 'feat: premier');
  const r = hook(m, 'commit.js', 'codex', { hook_event_name: 'PostToolUse', cwd: m.base, tool_name: 'exec_command', tool_input: { cmd: 'git commit -m "feat: premier"', workdir: m.repo }, tool_response: { output: 'ok' } });
  assert.equal(r.out, '', 'Codex : aucune sortie (schéma strict)');
  assert.match(lire(histoire(m, 'codex')), new RegExp(`\\| feat \\| premier \\(commit ${sha}\\) \\| Codex`));
  assert.equal(marqueur(m), null);
  const sha2 = commiter(m, 'b.txt', 'fix: second');
  const code = `const r = await tools.exec_command({ cmd: "git commit -m \\"fix: second\\"", workdir: ${JSON.stringify(m.repo)} });\ntext(r.output);`;
  hook(m, 'commit.js', 'codex', { hook_event_name: 'PostToolUse', cwd: m.base, tool_name: 'exec', tool_input: { code }, tool_response: { output: 'ok' } });
  assert.match(lire(histoire(m, 'codex')), new RegExp(`\\(commit ${sha2}\\) \\| Codex`));
  assert.equal(lire(histoire(m, 'claude')), '', 'chaque agent écrit dans SON journal');
  assert.match(resume(m), /\| Codex/);
});

test('marqueur : compte les fichiers du projet, ignore les fichiers générés et ce qui est hors projet', () => {
  const m = monde('marqueur');
  const ecrit = f => hook(m, 'marqueur.js', 'claude', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Edit', tool_input: { file_path: f, old_string: 'a', new_string: 'b' } });
  ecrit(path.join(m.repo, 'src', 'a.js'));
  ecrit(path.join(m.repo, 'src', 'b.js'));
  assert.equal(marqueur(m).count, 2);
  assert.match(marqueur(m).lastFile, /b\.js$/);
  ecrit(path.join(m.repo, 'node_modules', 'x', 'index.js'));
  ecrit(path.join(m.repo, 'package-lock.json'));
  ecrit(path.join(m.repo, '.git', 'config'));
  ecrit(path.join(m.base, 'ailleurs', 'c.js'));
  assert.equal(marqueur(m).count, 2);
});

// ---------------------------------------------------------------------------
// Fin de session, point de contrôle, compactage

test('fin de session : travail non commité -> une entrée wip, une seule par état ; dépôt propre -> marqueur retiré, rien d\'écrit', () => {
  const m = monde('fin-session');
  commiter(m, 'premier.txt', 'chore: base');
  const fin = () => hook(m, 'fin-session.js', 'claude', { hook_event_name: 'SessionEnd', session_id: 's1', cwd: m.repo });
  assert.equal(fin().out, '');
  assert.equal(lire(histoire(m)), '', 'sans marqueur : rien');
  fs.writeFileSync(path.join(m.repo, 'en-cours.js'), 'travail');
  hook(m, 'marqueur.js', 'claude', { hook_event_name: 'PostToolUse', cwd: m.repo, tool_name: 'Write', tool_input: { file_path: path.join(m.repo, 'en-cours.js'), content: 'travail' } });
  fin();
  const h = lire(histoire(m));
  assert.match(h, /\| wip \| session terminée : 1 fichier\(s\) modifié\(s\) NON commité\(s\) \(dernier : en-cours\.js\), à documenter \| Claude/);
  assert.match(h, /- Fichiers modifiés \(git status\) : \?\? en-cours\.js/);
  assert.match(resume(m), /\| wip \| session terminée : 1 fichier/);
  fin();
  assert.equal(lire(histoire(m)).split('| wip |').length - 1, 1, 'même état : pas de seconde entrée');
  assert.ok(marqueur(m), 'le marqueur reste tant que rien n\'est commité');
  // Le travail est commité hors hook : le marqueur est périmé.
  git(m, ['add', 'en-cours.js']);
  git(m, ['commit', '-q', '-m', 'feat: fini']);
  const avant = lire(histoire(m));
  fin();
  assert.equal(marqueur(m), null);
  assert.equal(lire(histoire(m)), avant);
});

test('point de contrôle : rien avant deux heures, puis l\'état du dépôt dans le journal, sans jamais bloquer', () => {
  const m = monde('checkpoint');
  commiter(m, 'premier.txt', 'chore: base');
  const stop = agent => hook(m, 'checkpoint.js', agent, { hook_event_name: 'Stop', session_id: 's1', cwd: m.repo, stop_hook_active: false });
  assert.equal(stop('claude').out, '');
  assert.equal(stop('claude').out, '');
  assert.equal(lire(histoire(m)), '');
  const f = path.join(m.maison, 'etat', `.checkpoint-${PROJET}-claude`);
  fs.writeFileSync(f, JSON.stringify({ ts: new Date(Date.now() - 3 * 3600000).toISOString(), sessionId: 's1' }));
  const r = stop('claude');
  assert.ok(r.json && r.json.systemMessage && !r.json.decision, 'invitation, jamais un blocage');
  assert.match(lire(histoire(m)), /\| checkpoint \| Point de contrôle automatique \(3h0\d\) \| Claude\n\n- \[(main|master)\] [0-9a-f]+ chore: base : 0 modifié\(s\), 0 non suivi\(s\)/);
  assert.equal(stop('claude').out, '', 'la fenêtre de deux heures repart');
  // Codex : même entrée dans son journal, sortie vide (conforme au schéma de Stop).
  stop('codex');
  fs.writeFileSync(path.join(m.maison, 'etat', `.checkpoint-${PROJET}-codex`), JSON.stringify({ ts: new Date(Date.now() - 3 * 3600000).toISOString(), sessionId: 's1' }));
  const rc = stop('codex');
  assert.equal(rc.out, '');
  assert.deepEqual(erreursSortieCodex('Stop', rc.out), []);
  assert.match(lire(histoire(m, 'codex')), /\| checkpoint \| .* \| Codex/);
});

test('avant compactage : branche, dernier commit et travail en vol écrits dans le journal', () => {
  const m = monde('avant-compactage');
  commiter(m, 'premier.txt', 'chore: base');
  fs.writeFileSync(path.join(m.repo, 'en-vol.js'), 'x');
  const r = hook(m, 'avant-compactage.js', 'claude', { hook_event_name: 'PreCompact', session_id: 's1', cwd: m.repo, trigger: 'auto' });
  assert.equal(r.out, '');
  assert.match(lire(histoire(m)), /\| precompact \| État sauvé avant compactage automatique \| Claude\n\n- Écrit juste avant[^\n]*\n- \*\*projet-demo\*\* \[(main|master)\] : 0 modifié\(s\), 1 non suivi\(s\)\n {2}dernier commit : [0-9a-f]+ chore: base/);
  const d = lancer(m, path.join('memoire', 'avant-compactage.js'), ['--agent', 'codex', '--dry'], { hook_event_name: 'PreCompact', cwd: m.repo, trigger: 'manual' });
  assert.match(d.out, /^\[dry\] .*projet-demo\.codex\.md <-\n## .* compactage demandé \| Codex/);
  assert.equal(lire(histoire(m, 'codex')), '', '--dry n\'écrit rien');
});

// ---------------------------------------------------------------------------
// Rappel des 12 dernières heures

function semer(m) {
  fs.writeFileSync(histoire(m, 'claude'), `# Historique\n\n---\n\n## ${horo()} | fix | récent du projet | Claude\n\n- détail récent\n\n## ${horo(-48 * 3600000)} | fix | vieux de deux jours | Claude\n\n- détail ancien\n`);
  fs.writeFileSync(path.join(m.maison, 'history', 'autre-projet.codex.md'), `# Historique\n\n---\n\n## ${horo()} | feat | récent ailleurs | Codex\n\n- autre\n`);
  fs.writeFileSync(path.join(m.maison, 'Memory-Auto.md'), `# Memory-Auto\n\n### ${PROJET}\n- ${horo()} | fix | récent du projet | Claude\n- ${horo(-48 * 3600000)} | fix | vieux de deux jours | Claude\n`);
}

test('rappel (Claude) : après compactage, les entrées de moins de 12 h, projet courant d\'abord ; démarrage : les autres projets ; reprise : rien', () => {
  const m = monde('rappel', { depot: false });
  semer(m);
  const ss = source => hook(m, 'rappel.js', 'claude', { hook_event_name: 'SessionStart', session_id: 's1', cwd: m.repo, source });
  const c = ctx(ss('compact'));
  assert.match(c, /^APRÈS COMPACTAGE : consulte la mémoire et l'historique des 12 dernières heures AVANT de continuer\. 3 entrée\(s\) réinjectée\(s\)/);
  assert.ok(c.includes('récent du projet') && c.includes('récent ailleurs') && !c.includes('vieux de deux jours'));
  assert.ok(c.indexOf('history/projet-demo.claude.md') < c.indexOf('history/autre-projet.codex.md'), 'projet courant d\'abord');
  assert.ok(c.length <= 9000);
  const d = ctx(ss('startup'));
  assert.match(d, /^DÉMARRAGE : rappel des autres projets/);
  assert.ok(d.includes('récent ailleurs') && !d.includes('### history/projet-demo.claude.md'));
  assert.equal(ss('resume').out, '');
  assert.match(ctx(ss('clear')), /^APRÈS \/clear/);
});

test('rappel (Codex) : PostCompact pose un drapeau, le prochain message l\'injecte une seule fois, même avec dix hooks en parallèle', async () => {
  const m = monde('rappel-codex', { depot: false });
  semer(m);
  const base = { session_id: 'sess-a', cwd: m.repo, model: 'gpt', transcript_path: null, permission_mode: 'default', turn_id: 't1' };
  const pc = hook(m, 'rappel.js', 'codex', Object.assign({ hook_event_name: 'PostCompact', trigger: 'auto' }, base));
  assert.equal(pc.out, '', 'PostCompact ne peut rien injecter');
  assert.deepEqual(erreursSortieCodex('PostCompact', pc.out), []);
  assert.equal(hook(m, 'rappel.js', 'codex', Object.assign({ hook_event_name: 'UserPromptSubmit', prompt: 'Message Type: NEW_TASK\nfais X' }, base)).out, '', 'tâche d\'un sous-agent : le drapeau reste');
  assert.equal(hook(m, 'rappel.js', 'codex', Object.assign({ hook_event_name: 'UserPromptSubmit', prompt: 'x', agent_id: 'a1', agent_type: 'worker' }, base)).out, '', 'sous-agent : le drapeau reste');
  const jobs = Array.from({ length: 10 }, () => new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(SCRIPTS, 'memoire', 'rappel.js'), '--agent', 'codex'], { env: envPour(m), cwd: m.base, windowsHide: true });
    let out = '';
    p.stdout.on('data', x => (out += x));
    p.on('close', () => resolve(out.trim()));
    p.stdin.end(JSON.stringify(Object.assign({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, base)));
  }));
  const sorties = (await Promise.all(jobs)).filter(Boolean);
  assert.equal(sorties.length, 1, 'une seule injection');
  assert.deepEqual(erreursSortieCodex('UserPromptSubmit', sorties[0]), []);
  const c = JSON.parse(sorties[0]).hookSpecificOutput.additionalContext;
  assert.match(c, /^APRÈS COMPACTAGE/);
  assert.ok(c.includes('récent du projet') && !c.includes('vieux de deux jours'));
  assert.equal(hook(m, 'rappel.js', 'codex', Object.assign({ hook_event_name: 'UserPromptSubmit', prompt: 'suite' }, base)).out, '', 'drapeau consommé');
  // Démarrage et reprise : rien pour Codex (demarrage.js s'en charge) ; compact en SessionStart : injection directe.
  assert.equal(hook(m, 'rappel.js', 'codex', Object.assign({}, base, { hook_event_name: 'SessionStart', source: 'startup', turn_id: undefined })).out, '');
  const direct = hook(m, 'rappel.js', 'codex', { hook_event_name: 'SessionStart', session_id: 'sess-a', cwd: m.repo, model: 'gpt', transcript_path: null, permission_mode: 'default', source: 'compact' });
  assert.deepEqual(erreursSortieCodex('SessionStart', direct.out), []);
  assert.match(ctx(direct), /^APRÈS COMPACTAGE/);
});

// ---------------------------------------------------------------------------
// Installation dans Codex

test('installateur Codex : montre sans écrire, ajoute en fin d\'événement sans toucher l\'existant, ne double jamais, sait retirer', () => {
  const m = monde('installer', { depot: false });
  const home = path.join(m.base, 'config-codex');
  fs.mkdirSync(home, { recursive: true });
  const cible = path.join(home, 'hooks.json');
  const existant = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node C:/outils/garde.js', timeout: 10 }] }], Stop: [{ hooks: [{ type: 'command', command: 'node C:/outils/fin.js' }] }] } };
  fs.writeFileSync(cible, JSON.stringify(existant, null, 2) + '\n');
  const installer = args => lancer(m, 'installer-codex.js', ['--home', home, ...args]);

  const essai = installer([]);
  assert.equal(essai.code, 0, essai.err);
  assert.match(essai.out, /Rien n'a été écrit\. Relance avec --appliquer pour ajouter ces (\d+) hook\(s\)\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(cible, 'utf8')), existant, 'sans --appliquer : fichier intact');

  const pose = installer(['--appliquer']);
  assert.equal(pose.code, 0, pose.err);
  const apres = JSON.parse(fs.readFileSync(cible, 'utf8'));
  assert.deepEqual(apres.hooks.PreToolUse[0], existant.hooks.PreToolUse[0], 'hook existant inchangé, même groupe, même rang');
  assert.deepEqual(apres.hooks.Stop[0], existant.hooks.Stop[0]);
  assert.equal(apres.hooks.PreToolUse.length, 2, 'les nouveaux hooks sont dans un groupe à part, à la fin');
  const racine = path.resolve(SCRIPTS, '..').replace(/\\/g, '/');
  const commandes = Object.values(apres.hooks).flat().flatMap(g => g.hooks.map(h => h.command));
  const nouvelles = commandes.filter(c => c.includes(racine + '/scripts/'));
  assert.ok(nouvelles.length >= 15, 'hooks ajoutés : ' + nouvelles.length);
  assert.ok(nouvelles.every(c => !c.includes('{{') && /^node "[^"]+\.js"( --agent codex)?$/.test(c)), 'chemins absolus, entre guillemets');
  for (const evt of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SubagentStop']) {
    assert.ok((apres.hooks[evt] || []).some(g => g.hooks.some(h => h.command.includes('/scripts/'))), 'événement branché : ' + evt);
  }
  assert.ok(fs.readdirSync(home).some(n => n.startsWith('hooks.json.avant-agent-memory-ledger-')), 'copie de sauvegarde faite');
  for (const c of nouvelles) assert.ok(fs.existsSync(/^node "([^"]+)"/.exec(c)[1]), 'le script appelé existe : ' + c);

  const encore = installer(['--appliquer']);
  assert.match(encore.out, /déjà en place : rien à faire/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cible, 'utf8')), apres, 'relancer n\'ajoute rien');

  assert.match(installer(['--retirer']).out, /Rien n'a été écrit/);
  installer(['--retirer', '--appliquer']);
  assert.deepEqual(JSON.parse(fs.readFileSync(cible, 'utf8')), existant, 'retrait : le fichier revient à son contenu d\'origine');

  // Fichier illisible : jamais écrasé.
  fs.writeFileSync(cible, '{ "hooks": ');
  const casse = installer(['--appliquer']);
  assert.equal(casse.code, 2);
  assert.equal(fs.readFileSync(cible, 'utf8'), '{ "hooks": ');
  // Aucun fichier : il est créé.
  const neuf = path.join(m.base, 'config-codex-neuve');
  const r = lancer(m, 'installer-codex.js', ['--home', neuf, '--appliquer']);
  assert.equal(r.code, 0, r.err);
  assert.ok(JSON.parse(fs.readFileSync(path.join(neuf, 'hooks.json'), 'utf8')).hooks.SubagentStop);
});

// ---------------------------------------------------------------------------
// Fichiers de configuration du plugin

test('plugin : les hooks déclarés pour Claude Code et pour Codex appellent des scripts qui existent', () => {
  const racine = path.join(__dirname, '..');
  const claude = JSON.parse(fs.readFileSync(path.join(racine, 'hooks', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(racine, 'codex', 'hooks.modele.json'), 'utf8'));
  let n = 0;
  for (const [cfg, jeton] of [[claude, '${CLAUDE_PLUGIN_ROOT}'], [codex, '{{RACINE}}']]) {
    for (const groupes of Object.values(cfg.hooks)) for (const g of groupes) for (const h of g.hooks) {
      const mm = /^node "([^"]+)"( --agent (claude|codex))?$/.exec(h.command);
      assert.ok(mm && mm[1].startsWith(jeton + '/scripts/'), 'commande inattendue : ' + h.command);
      assert.ok(fs.existsSync(path.join(racine, mm[1].slice(jeton.length))), 'script absent : ' + h.command);
      assert.ok(Number.isInteger(h.timeout) && h.timeout > 0, 'délai explicite : ' + h.command);
      n++;
    }
  }
  assert.ok(n >= 25, 'hooks déclarés : ' + n);
  const plugin = JSON.parse(fs.readFileSync(path.join(racine, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marche = JSON.parse(fs.readFileSync(path.join(racine, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(plugin.name, 'agent-memory-ledger');
  assert.equal(marche.plugins[0].name, plugin.name);
  assert.equal(marche.plugins[0].version, plugin.version);
});

// ---------------------------------------------------------------------------
// Mutations : une copie mutée des scripts doit rendre le banc visé ROUGE ; la copie non mutée reste verte.

function copie(nom, fichierRel, ancre, remplacement) {
  const dest = path.join(RUN, nom, 'scripts');
  fs.cpSync(SCRIPTS, dest, { recursive: true });
  // L'installateur lit ../codex/hooks.modele.json : même place relative dans la copie.
  fs.cpSync(path.join(SCRIPTS, '..', 'codex'), path.join(RUN, nom, 'codex'), { recursive: true });
  if (ancre) {
    const cible = path.join(dest, fichierRel);
    const lignes = fs.readFileSync(cible, 'utf8').split('\n');
    const i = lignes.findIndex(l => l.includes(ancre));
    assert.ok(i >= 0, `ancre ${ancre} introuvable dans ${fichierRel}`);
    lignes[i] = remplacement;
    fs.writeFileSync(cible, lignes.join('\n'));
  }
  return dest;
}

function relancer(scripts, motif) {
  const env = Object.assign({}, process.env, { AML_SCRIPTS: scripts, AML_EN_MUTATION: '1' });
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${motif}`, __filename], { env, encoding: 'utf8', timeout: 240000, windowsHide: true });
}

test('mutation : citation prise pour un commit, marqueur gardé après commit, entrée doublée, drapeau pris par tous -> banc rouge', { skip: EN_MUTATION }, () => {
  const motif = '^commit : entr|^commit : git|^rappel \\(Codex\\)';
  const temoin = relancer(copie('temoin'), motif);
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const mutations = [
    ['citation', path.join('lib', 'commande-git.js'), '  const masked = texte; // MUTATION : citations non masquées', /not ok \d+ - commit : entr/],
    ['commit-marqueur', path.join('memoire', 'commit.js'), '    // MUTATION : marqueur gardé après le commit', /not ok \d+ - commit : entr/],
    ['journal-doublon', path.join('lib', 'memoire.js'), '  // MUTATION : dédoublonnage du journal retiré', /not ok \d+ - commit : entr/],
    ['rappel-drapeau', path.join('memoire', 'rappel.js'), '    const d = {}; // MUTATION : drapeau non vérifié', /not ok \d+ - rappel \(Codex\)/],
    ['commit-delai', path.join('memoire', 'commit.js'), '      if (false) { // MUTATION : délai dépassé passé sous silence', /not ok \d+ - commit : git ne r/],
  ];
  for (const [ancre, fichier, remplacement, rouge] of mutations) {
    const r = relancer(copie('mutation-' + ancre, fichier, 'ancre-mutation:' + ancre, remplacement), motif);
    assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
    assert.match(r.stdout, rouge, ancre);
  }
});
