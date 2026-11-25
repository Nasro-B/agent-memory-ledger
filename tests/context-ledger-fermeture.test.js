'use strict';
// Bancs de la fermeture des lignes : pourquoi une ligne ne se fermait pas après un commit ou un travail fait.
// Mentions de fermeture, commits lus après un changement de dossier ou annoncés par la sortie d'un script,
// rappel après un commit sans mention, preuves partielles répétées, commits des sous-agents, conseils de
// « ajouter », fichiers temporaires. Sans modèle.
// Lancement : node --test tests/context-ledger-fermeture.test.js
// Jamais dans la vraie maison (~/.agent-memory-ledger) : chaque test a sa propre maison
// <dossier de test>/<nom>/.agent-memory-ledger, passée au noyau et au hook par AGENT_MEMORY_LEDGER_HOME.
// Variables internes (tests de mutation, qui relancent ce fichier sur une copie) :
//   CONTEXT_LEDGER_HOOK         script à tester (défaut : ../scripts/claude/context-ledger.js)
//   CONTEXT_LEDGER_EN_MUTATION  '1' = exécution sur une copie mutée (pas de récursion)
//   CONTEXT_LEDGER_BASE_TESTS   dossier de travail des bancs (défaut : <dossier temporaire>/aml-tests/fermeture)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { test, before } = require('node:test');

const HOOK = process.env.CONTEXT_LEDGER_HOOK || path.join(__dirname, '..', 'scripts', 'claude', 'context-ledger.js');
const CORE_PATH = path.join(path.dirname(HOOK), '..', 'lib', 'context-ledger-core.js');
const EN_MUTATION = process.env.CONTEXT_LEDGER_EN_MUTATION === '1';
const DELAI_PROCESSUS_MS = 120000;
const DELAI_RELANCE_MS = 1200000;
const BASE_TESTS = process.env.CONTEXT_LEDGER_BASE_TESTS || path.join(os.tmpdir(), 'aml-tests', 'fermeture');
const RUN = path.join(BASE_TESTS, (EN_MUTATION ? 'mut-' : 'run-') + Date.now() + '-' + process.pid);
const VRAIE_MAISON = path.join(os.homedir(), '.agent-memory-ledger');
const CWD_PROJET = 'C:\\travail\\projet-demo';
const PROJET = 'projet-demo';
const AGENT = 'claude';

for (const k of ['CONTEXT_LEDGER_DIR', 'CONTEXT_LEDGER_SECOURS_DIR', 'CONTEXT_LEDGER_PREUVES_DIR', 'AGENT_MEMORY_LEDGER_HOME']) delete process.env[k];

const core = require(CORE_PATH);

function norm(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }

before(() => {
  assert.ok(!norm(RUN).startsWith(norm(VRAIE_MAISON)), 'les tests ne doivent jamais viser la vraie maison');
  fs.mkdirSync(RUN, { recursive: true });
});

let compteur = 0;

// Crée la maison du test et rend sa racine contexte. La table des projets y déclare « projet-demo ».
function dossier(nom) {
  const base = path.join(RUN, `${nom}-${++compteur}`);
  fs.rmSync(base, { recursive: true, force: true });
  const maison = path.join(base, '.agent-memory-ledger');
  const d = path.join(maison, 'contexte');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(maison, 'projets.json'), JSON.stringify({ projets: [{ nom: PROJET, motif: 'projet-demo' }] }));
  return d;
}

// Exécute fn dans ce processus avec la maison du test (dir = sa racine contexte).
function avecRacine(dir, fn) {
  const avant = process.env.AGENT_MEMORY_LEDGER_HOME;
  process.env.AGENT_MEMORY_LEDGER_HOME = path.dirname(dir);
  try { return fn(); } finally {
    if (avant === undefined) delete process.env.AGENT_MEMORY_LEDGER_HOME; else process.env.AGENT_MEMORY_LEDGER_HOME = avant;
  }
}

// Lance le hook comme Claude Code le fait : l'événement sur l'entrée standard, la sortie JSON sur la sortie standard.
function hook(dir, evenement) {
  const env = Object.assign({ CONTEXT_LEDGER_BUDGET_MS: '600000' }, process.env, { AGENT_MEMORY_LEDGER_HOME: path.dirname(dir) });
  delete env.CONTEXT_LEDGER_DIR;
  delete env.CONTEXT_LEDGER_HOOK;
  delete env.CONTEXT_LEDGER_EN_MUTATION;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(evenement), env, encoding: 'utf8', cwd: dir, timeout: DELAI_PROCESSUS_MS, windowsHide: true,
  });
  assert.equal(r.status, 0, `le hook sort en code ${r.status} : ${r.stderr}`);
  let sortie = null;
  try { sortie = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (_) { sortie = null; }
  return { texte: sortie && sortie.hookSpecificOutput ? String(sortie.hookSpecificOutput.additionalContext || '') : '', brut: r.stdout };
}

function git(depot, ...args) {
  return execFileSync('git', args, { cwd: depot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Un dépôt neuf avec un commit qui vient d'être fait (le hook ne lit qu'un HEAD de moins de 90 secondes).
function depotAvecCommit(nom, message, env = null) {
  const d = path.join(RUN, `depot-${nom}-${++compteur}`);
  const sansHooks = path.join(RUN, `sans-hooks-${compteur}`);
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(sansHooks, { recursive: true });
  git(d, 'init', '-q');
  fs.writeFileSync(path.join(d, 'a.txt'), `contenu ${compteur}\n`);
  git(d, 'add', 'a.txt');
  execFileSync('git', ['-c', 'user.name=banc', '-c', 'user.email=banc@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${sansHooks}`, 'commit', '-q', '-m', message], {
    cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: env ? Object.assign({}, process.env, env) : process.env,
  });
  return d;
}

function dossierVide(nom) {
  const d = path.join(RUN, `${nom}-${++compteur}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ------------------------------------------------------------------ textes de machine

test('texte de machine : la demande de message suggéré de l\'application n\'est pas un message de l\'utilisateur', () => {
  assert.equal(core.texteDeMachine('This is an app-generated request for a suggested next user message. The user did not write this message.'), true);
  assert.equal(core.texteDeMachine('  \nThis is an app-generated request for a suggested next user message.'), true);
  assert.equal(core.texteDeMachine('corrige tout'), false);
  assert.equal(core.texteDeMachine('Voici une demande : this is an app-generated request for a suggested next user message.'), false);
  assert.equal(core.texteDeMachine(''), false);
  assert.equal(core.texteDeMachine(undefined), false);
});

test('hook : un texte de machine ne reçoit pas de numéro M, un message de l\'utilisateur en reçoit un', () => {
  const dir = dossier('machine');
  const base = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-machine', cwd: CWD_PROJET };
  hook(dir, { ...base, prompt_id: 'p1', prompt: 'This is an app-generated request for a suggested next user message. The user did not write this message.' });
  assert.equal(Object.keys(avecRacine(dir, () => core.lireLedger(PROJET, AGENT)).demandes).length, 0, 'la demande de l\'application ne doit pas devenir un message à trier');
  const r = hook(dir, { ...base, prompt_id: 'p2', prompt: 'corrige le bug du panier' });
  const demandes = Object.values(avecRacine(dir, () => core.lireLedger(PROJET, AGENT)).demandes).map(d => d.texte);
  assert.deepEqual(demandes, ['corrige le bug du panier']);
  assert.match(r.texte, /Nouveau message M-\d+/);
});

// ------------------------------------------------------------------ mentions

test('mention complète : un mot négatif dans une AUTRE proposition de la ligne ne l\'annule plus', () => {
  const ids = t => core.extraireMarqueurs(t).map(m => `${m.id}${m.partiel ? ' partiel' : ''}`);
  assert.deepEqual(ids('## 2026-11-25 | fix | Garde corrigé ; lint complet non vérifié ; détail dans history/x.md [ctx C-0012] - Agent'), ['C-0012']);
  assert.deepEqual(ids('- Agent du site en cours. Le lot du panier est intégré [ctx C-0013]'), ['C-0013']);
  assert.deepEqual(ids('Lot A fait [ctx C-0014] | lot B à faire'), ['C-0014']);
  assert.deepEqual(ids('Tout est intégré ; preuves rejouées [ctx C-0015] [ctx C-0016, C-0017]'), ['C-0015', 'C-0016', 'C-0017']);
});

test('mention complète : un mot négatif dans SA proposition l\'annule toujours, et « partiel » reste partiel', () => {
  const ids = t => core.extraireMarqueurs(t).map(m => `${m.id}${m.partiel ? ' partiel' : ''}`);
  assert.deepEqual(ids('[ctx C-0012] non terminé'), []);
  assert.deepEqual(ids('reste à faire [ctx C-0012]'), []);
  assert.deepEqual(ids('Lot A intégré ; le lot B est en cours [ctx C-0012]'), []);
  assert.deepEqual(ids('C-0012 pas fait [ctx C-0012] ; autre chose'), []);
  assert.deepEqual(ids('Lot A intégré ; le lot B est en cours [ctx C-0012 partiel]'), ['C-0012 partiel']);
  assert.deepEqual(ids('exemple : [ctx C-0012]'), []);
  assert.deepEqual(ids('> [ctx C-0012]'), []);
  // Bords de mot Unicode, féminin et pluriel : « non terminée », « à vérifier » avec accent.
  assert.deepEqual(ids('livraison non terminée [ctx C-0012]'), []);
  assert.deepEqual(ids('tâches pas finies [ctx C-0012]'), []);
  assert.deepEqual(ids('lot à vérifier [ctx C-0012]'), []);
  assert.deepEqual(ids('le lot est en coursive [ctx C-0012]'), ['C-0012'], 'le mot négatif doit être un mot entier');
});

// ------------------------------------------------------------------ commits

test('commit : la mention est lue quand le commit suit un changement de dossier (session ouverte ailleurs que dans le dépôt)', () => {
  const depot = depotAvecCommit('cd', 'fix(panier): total exact [ctx C-0021]');
  const ailleurs = dossierVide('ailleurs');
  const voir = commande => core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: commande }, cwd: ailleurs });
  const p1 = voir(`Set-Location '${depot}'; git commit -m "fix(panier): total exact [ctx C-0021]"`);
  assert.ok(p1, 'Set-Location puis git commit : le commit doit être trouvé');
  assert.deepEqual(p1.marqueurs, [{ id: 'C-0021', partiel: false }]);
  const p2 = voir(`$d = '${depot}'; git -C $d commit -m "fix(panier): total exact [ctx C-0021]"`);
  assert.ok(p2, 'git -C avec une variable affectée à un littéral : le commit doit être trouvé');
  assert.deepEqual(p2.marqueurs, [{ id: 'C-0021', partiel: false }]);
  const p3 = voir(`git -C "${depot}" commit -m "fix(panier): total exact [ctx C-0021]"`);
  assert.deepEqual(p3 && p3.marqueurs, [{ id: 'C-0021', partiel: false }], 'la forme déjà reconnue reste reconnue');
  assert.equal(voir('git commit -m "x [ctx C-0021]"'), null, 'sans dépôt désigné, un dossier qui n\'est pas un dépôt ne donne aucune preuve');
  assert.equal(voir(`Set-Location '${depot}'; git status`), null, 'une commande qui ne commite pas ne donne aucune preuve');
});

test('commit sans mention : rendu seulement à la demande, et jamais pour une mention écartée', () => {
  const depot = depotAvecCommit('nu', 'fix(panier): total exact');
  const commande = `git -C "${depot}" commit -m "fix(panier): total exact"`;
  assert.equal(core.preuvesDepuisOutil({ toolName: 'Bash', toolInput: { command: commande }, cwd: os.tmpdir() }), null, 'forme d\'avant : rien à appliquer, donc null');
  const p = core.preuvesDepuisOutil({ toolName: 'Bash', toolInput: { command: commande }, cwd: os.tmpdir(), avecCommitNu: true });
  assert.ok(p && p.nu === true, 'avec avecCommitNu, le commit sans mention est rendu');
  assert.deepEqual(p.marqueurs, []);
  assert.match(p.court, /^[0-9a-f]{7}$/);
  const ecarte = depotAvecCommit('ecarte', 'docs: note\n\nexemple : [ctx C-0030]');
  const q = core.preuvesDepuisOutil({ toolName: 'Bash', toolInput: { command: `git -C "${ecarte}" commit -m x` }, cwd: os.tmpdir(), avecCommitNu: true });
  assert.equal(q, null, 'une mention écrite mais écartée n\'est pas un oubli de mention');
});

test('hook : après un commit sans mention, le modèle est prévenu s\'il a des lignes ouvertes, et seulement alors', () => {
  const dir = dossier('rappel');
  const session = 'sess-rappel';
  const depot = depotAvecCommit('rappel', 'fix(panier): total exact');
  const outil = { hook_event_name: 'PostToolUse', session_id: session, cwd: CWD_PROJET, tool_name: 'Bash', tool_input: { command: `git -C "${depot}" commit -m "fix(panier): total exact"` }, tool_response: {} };
  hook(dir, { hook_event_name: 'SessionStart', session_id: session, cwd: CWD_PROJET, source: 'startup' });
  assert.doesNotMatch(hook(dir, outil).texte, /ne porte aucune mention/, 'sans ligne ouverte dans la conversation : aucun rappel');
  const id = avecRacine(dir, () => core.ajouterLigne({ projet: PROJET, agent: AGENT, texte: 'corriger le total du panier', de: null, sessionId: session }));
  const depot2 = depotAvecCommit('rappel2', 'fix(panier): total exact');
  const r = hook(dir, { ...outil, tool_input: { command: `git -C "${depot2}" commit -m "fix(panier): total exact"` } });
  assert.match(r.texte, /ne porte aucune mention \[ctx\]/);
  assert.match(r.texte, /1 ligne\(s\) de cette conversation/);
  assert.equal(avecRacine(dir, () => core.lireLedger(PROJET, AGENT)).lignes[id].statut, 'ouvert', 'le rappel ne ferme rien');
  const depot3 = depotAvecCommit('rappel3', `fix(panier): total exact [ctx ${id}]`);
  const f = hook(dir, { ...outil, tool_input: { command: `git -C "${depot3}" commit -m "x"` } });
  assert.doesNotMatch(f.texte, /ne porte aucune mention/);
  assert.equal(avecRacine(dir, () => core.lireLedger(PROJET, AGENT)).lignes[id].statut, 'fait', 'un commit qui porte la mention ferme la ligne');
});

// ------------------------------------------------------------------ preuves partielles répétées

test('preuves partielles : comptées par ligne, rappelées à la cinquième et à la dixième, rejouées depuis le journal', () => {
  const dir = dossier('partiels');
  avecRacine(dir, () => {
    const id = core.ajouterLigne({ projet: PROJET, agent: AGENT, texte: 'gros travail', de: null, sessionId: 's' });
    const vus = [];
    for (let i = 1; i <= 10; i++) {
      const r = core.appliquerPreuves({ agent: AGENT, marqueurs: [{ id, partiel: true }], preuve: `fichier h${i}.md` });
      assert.deepEqual(r.partiels, [id]);
      vus.push((r.insistants || []).join('|'));
    }
    assert.deepEqual(vus, ['', '', '', '', `${id} (5 fois)`, '', '', '', '', `${id} (10 fois)`]);
    assert.equal(core.lireLedger(PROJET, AGENT).lignes[id].partiels, 10);
    assert.equal(core.rejouerJournal(PROJET, AGENT).lignes[id].partiels, 10, 'le journal rejoué donne le même compte');
    assert.match(core.texteInsistants({ insistants: [`${id} (5 fois)`] }), new RegExp(`Preuves partielles répétées : ${id} \\(5 fois\\)`));
    assert.equal(core.texteInsistants({ insistants: [] }), '');
    assert.equal(core.texteInsistants(null), '');
    const fin = core.appliquerPreuves({ agent: AGENT, marqueurs: [{ id, partiel: false }], preuve: 'fichier fin.md' });
    assert.deepEqual(fin.faits, [id]);
    assert.deepEqual(fin.insistants, []);
  });
});

// ------------------------------------------------------------------ fichiers temporaires

test('fichiers temporaires : seuls ceux d\'une écriture interrompue, vieux de plus d\'une heure, sont retirés', () => {
  const dir = dossier('tmp');
  fs.mkdirSync(path.join(dir, '.etat'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.sessions'), { recursive: true });
  const vieux = Date.now() / 1000 - 2 * 3600;
  const poser = (rel, ancien) => {
    const f = path.join(dir, rel);
    fs.writeFileSync(f, 'x');
    if (ancien) fs.utimesSync(f, vieux, vieux);
    return f;
  };
  const partis = [
    poser('.reconciliation-claude.json.12144.114ed2f2.tmp', true),
    poser(path.join('.etat', 'banc.claude.json.777.0a1b2c3d.tmp'), true),
    poser(path.join('.sessions', 'claude-s.json.5.deadbeef.tmp'), true),
  ];
  const restes = [
    poser('.reconciliation-claude.json.999.aaaaaaaa.tmp', false),
    poser('.reconciliation-claude.json', true),
    poser('notes.tmp', true),
    poser('banc.claude.journal.log', true),
    poser(path.join('.etat', 'banc.claude.json'), true),
  ];
  avecRacine(dir, () => {
    assert.equal(core.nettoyerTemporaires(), 3);
    for (const f of partis) assert.equal(fs.existsSync(f), false, `devait partir : ${f}`);
    for (const f of restes) assert.equal(fs.existsSync(f), true, `devait rester : ${f}`);
    assert.equal(core.nettoyerTemporaires(), 0);
  });
});

// ------------------------------------------------------------------ commits faits par un script

// Sortie que git écrit pour un commit qui n'est pas lancé en silence.
const sortieGit = (depot, titre) => `[main ${git(depot, 'rev-parse', '--short=7', 'HEAD').trim()}] ${titre}\n 1 file changed, 1 insertion(+)\n`;

test('commit fait par un script : sa sortie donne le SHA, le commit est trouvé dans le dépôt que la commande cite', () => {
  const depot = depotAvecCommit('script', 'fix(panier): total exact [ctx C-0041]');
  const ailleurs = dossierVide('ailleurs');
  const script = path.join(depot, 'commiter.ps1');
  fs.writeFileSync(script, '# script du banc\n');
  const commande = `pwsh -NoProfile -File '${script}' -Message 'livraison'`;
  assert.doesNotMatch(commande, /git\s+commit/, 'la commande ne contient pas « git commit »');
  const p = core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: commande }, toolResponse: { stdout: sortieGit(depot, 'fix(panier): total exact [ctx C-0041]'), stderr: '' }, cwd: ailleurs });
  assert.ok(p, 'le commit du script doit être trouvé');
  assert.deepEqual(p.marqueurs, [{ id: 'C-0041', partiel: false }]);
  assert.match(p.preuve, /^commit [0-9a-f]{40} \(/);
  // Forme Codex de la réponse ({ output }) et chaîne nue : la sortie est lue de la même façon.
  assert.ok(core.preuvesDepuisOutil({ toolName: 'Bash', toolInput: { command: commande }, toolResponse: { output: sortieGit(depot, 'x') }, cwd: ailleurs }));
  assert.ok(core.preuvesDepuisOutil({ toolName: 'Bash', toolInput: { command: commande }, toolResponse: sortieGit(depot, 'x'), cwd: ailleurs }));
  // Sans ligne de commit dans la sortie, rien n'est cherché ; avec un SHA que le dépôt cité ne contient pas, rien n'est trouvé.
  assert.equal(core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: commande }, toolResponse: { stdout: 'tout va bien\n' }, cwd: ailleurs }), null);
  assert.equal(core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: commande }, toolResponse: { stdout: '[main 0123abc] autre depot\n' }, cwd: ailleurs }), null);
  assert.deepEqual(core.shasDansSortie('avant\n[main 1a2b3c4] titre\n[detached HEAD 5d6e7f8] autre\n[main (root-commit) 9a8b7c6] premier\npas [main 1111111] en milieu de ligne\n[main 1a2b3c4] titre\n'), ['1a2b3c4', '5d6e7f8', '9a8b7c6']);
});

test('commit fait par un script : dépôt non cité, commit sans mention, commit trop ancien', () => {
  const depot = depotAvecCommit('nu-script', 'fix(panier): sans mention');
  const ailleurs = dossierVide('ailleurs');
  // Dépôt ni cité ni sous le dossier courant : le commit n'est pas retrouvé.
  const sansCitation = core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: 'pwsh -File commiter.ps1' }, toolResponse: { stdout: sortieGit(depot, 'fix(panier): sans mention') }, cwd: ailleurs, avecCommitNu: true });
  assert.equal(sansCitation, null, 'dépôt introuvable : ni cité, ni le dossier courant');
  // Le dossier courant du hook est un dépôt : le commit y est retrouvé même sans citation.
  const appel = extra => core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: 'pwsh -File commiter.ps1' }, toolResponse: { stdout: sortieGit(depot, 'fix(panier): sans mention') }, cwd: depot, ...extra });
  assert.equal(appel({}), null, 'sans mention et sans avecCommitNu : rien à appliquer');
  const nu = appel({ avecCommitNu: true });
  assert.ok(nu && nu.nu === true, 'le commit sans mention du script est rendu pour le rappel');
  assert.match(nu.court, /^[0-9a-f]{7}$/);
  // Un commit de plus de trente minutes n'est pas celui de cet outil.
  const date = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const vieux = depotAvecCommit('vieux', 'vieux [ctx C-0042]', { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
  assert.equal(core.preuvesDepuisOutil({ toolName: 'PowerShell', toolInput: { command: 'pwsh -File commiter.ps1' }, toolResponse: { stdout: sortieGit(vieux, 'vieux [ctx C-0042]') }, cwd: vieux }), null);
});

// ------------------------------------------------------------------ commits faits par un sous-agent

test('hook : le commit d un sous-agent ne ferme rien, il est dit une fois à l orchestrateur avec sa mention', () => {
  const dir = dossier('sous-agent');
  const session = 'sess-parent';
  hook(dir, { hook_event_name: 'SessionStart', session_id: session, cwd: CWD_PROJET, source: 'startup' });
  const id = avecRacine(dir, () => core.ajouterLigne({ projet: PROJET, agent: AGENT, texte: 'corriger le total du panier', de: null, sessionId: session }));
  const depot = depotAvecCommit('agent', `fix(panier): total exact [ctx ${id}]`);
  const court = git(depot, 'rev-parse', '--short=7', 'HEAD').trim();
  const duSousAgent = { hook_event_name: 'PostToolUse', session_id: session, agent_id: 'ag-banc-1', agent_type: 'general-purpose', cwd: CWD_PROJET, tool_name: 'Bash', tool_input: { command: `git -C "${depot}" commit -m "x"` }, tool_response: {} };
  const r1 = hook(dir, duSousAgent);
  assert.doesNotMatch(r1.texte, /Retiré sur preuve/, 'rien n est dit au sous-agent sur la liste');
  assert.equal(avecRacine(dir, () => core.lireLedger(PROJET, AGENT)).lignes[id].statut, 'ouvert', 'le commit d un sous-agent ne ferme pas la ligne du parent');
  hook(dir, duSousAgent); // le même commit vu une seconde fois : toujours une seule annonce
  const outil = { hook_event_name: 'PostToolUse', session_id: session, cwd: CWD_PROJET, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} };
  const r2 = hook(dir, outil);
  assert.match(r2.texte, /Commit\(s\) fait\(s\) par un sous-agent, à rapprocher de ta liste \(1\)/);
  assert.ok(r2.texte.includes(court), 'le SHA court du commit est donné');
  assert.ok(r2.texte.includes(`mentionne ${id} (NON appliquée)`), 'la mention lue est dite, pas appliquée');
  assert.ok(r2.texte.includes('sous-agent ag-banc-1'));
  assert.doesNotMatch(hook(dir, outil).texte, /Commit\(s\) fait\(s\) par un sous-agent/, 'dit une seule fois');
  assert.equal(avecRacine(dir, () => core.lireLedger(PROJET, AGENT)).lignes[id].statut, 'ouvert');
  // Un script lancé par le sous-agent : même traitement, par la sortie.
  const depot2 = depotAvecCommit('agent2', 'chore: sans mention');
  const script = path.join(depot2, 'commiter.ps1');
  fs.writeFileSync(script, '# script du banc\n');
  hook(dir, { ...duSousAgent, tool_name: 'PowerShell', tool_input: { command: `pwsh -File '${script}'` }, tool_response: { stdout: sortieGit(depot2, 'chore: sans mention') } });
  const r3 = hook(dir, outil);
  assert.match(r3.texte, /par sous-agent ag-banc-1, sans mention/);
});

// ------------------------------------------------------------------ une ligne par travail

test('ajouter : un message entier et long, une réponse de questionnaire ou une consigne sont signalés, la ligne est créée quand même', () => {
  const dir = dossier('ajout');
  avecRacine(dir, () => {
    const long = 'Corrige le total du panier quand une remise est appliquée. Ajoute aussi un test pour la remise en pourcentage. Mets à jour la page des tarifs avec le nouveau prix. Puis vérifie le formulaire de contact sur mobile et corrige le bouton qui déborde. Enfin, regarde pourquoi le courriel de confirmation part deux fois et corrige-le, et dis-moi ce que tu as trouvé dans les journaux de la semaine dernière.';
    assert.ok(long.length > 400);
    const m = core.ajouterDemande({ projet: PROJET, agent: AGENT, texte: long, session: 's' });
    const a = core.executerCli(['ajouter', '--projet', PROJET, '--de', m, long], { agent: AGENT, script: HOOK });
    assert.equal(a.code, 0, a.erreur);
    assert.match(a.sortie, /^C-\d{4} ajouté/);
    assert.match(a.sortie, /reprend le message entier/);
    assert.match(a.sortie, /crée une ligne PAR travail/);
    assert.equal(Object.keys(core.lireLedger(PROJET, AGENT).lignes).length, 1, 'un avertissement n est pas un refus');
    const b = core.executerCli(['ajouter', '--projet', PROJET, '--de', m, 'Corrige le total du panier quand une remise est appliquée.'], { agent: AGENT, script: HOOK });
    assert.doesNotMatch(b.sortie, /Attention/, 'une ligne courte, pour un travail : aucun avertissement');
    const q = core.ajouterDemande({ projet: PROJET, agent: AGENT, texte: 'Réponses de l\'utilisateur à un questionnaire :\n« Quel plafond ? » : « 60 »', session: 's' });
    const c = core.executerCli(['ajouter', '--projet', PROJET, '--de', q, 'remettre le plafond à 60'], { agent: AGENT, script: HOOK });
    assert.match(c.sortie, /réponse de l'utilisateur à un questionnaire/);
    assert.match(c.sortie, /DÉCISION/);
    const d = core.executerCli(['ajouter', '--projet', PROJET, 'ne lance aucun sous-agent ni de commande lourde'], { agent: AGENT, script: HOOK });
    assert.match(d.sortie, /ressemble à une consigne/);
    assert.deepEqual(core.avertissementsAjout({ projet: PROJET, agent: AGENT, texte: 'corriger le total du panier', de: null }), []);
    assert.equal(core.avertissementsAjout({ projet: PROJET, agent: AGENT, texte: long, de: null }).length, 1, 'quatre phrases et plus de 400 caractères, même sans message d origine');
  });
});

// ------------------------------------------------------------------ rapport d'un sous-agent, sous-agents finis jamais oubliés

test('message d\'agent : le rapport de fin d\'un sous-agent est reconnu, un message de l\'utilisateur ne l\'est pas', () => {
  assert.equal(core.expediteurMessageAgent('<agent-message from="abc123">\n[Subagent hand-back] The text below is the final report'), 'abc123');
  assert.equal(core.expediteurMessageAgent('  \n<agent-message from="abc123">'), 'abc123');
  assert.equal(core.expediteurMessageAgent('regarde ce texte : <agent-message from="abc123">'), null, 'seulement en tête du message');
  assert.equal(core.expediteurMessageAgent('<agent-message>'), null);
  assert.equal(core.expediteurMessageAgent('<agent-messages from="abc123">'), null);
  assert.equal(core.expediteurMessageAgent('corrige tout'), null);
  assert.equal(core.expediteurMessageAgent(''), null);
  assert.equal(core.expediteurMessageAgent(undefined), null);
});

test('hook : sous-agent fini : son rapport ne reçoit pas de numéro M, et son résultat est redit à chaque nouveau message, au démarrage et après un compactage', () => {
  const dir = dossier('rappel-force');
  const session = 'sess-force';
  const base = { session_id: session, cwd: CWD_PROJET };
  const ledger = () => avecRacine(dir, () => core.lireLedger(PROJET, AGENT));
  hook(dir, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  const ligne = avecRacine(dir, () => core.suivreTache({ agent: AGENT, sessionId: session, cwd: CWD_PROJET, tache: { id: 'ag-force-1', genre: 'general-purpose', titre: 'lot du panier', resultat: 'rapports/resultat-du-lot.jsonl' } }));
  assert.match(ligne, /^C-\d{4}$/);
  const outil = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} };
  const message = (id, texte) => hook(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt: texte });
  const rappel = new RegExp(`Rappel : 1 sous-agent\\(s\\) TERMINÉ\\(S\\) dont le résultat n'est toujours pas traité : ${ligne} « lot du panier »`);
  assert.doesNotMatch(message('p-0', 'première demande').texte, /TERMINÉ\(S\)/, 'un sous-agent encore en cours n\'est pas rappelé comme fini');
  assert.ok(avecRacine(dir, () => core.finirTache({ agent: AGENT, sessionId: session, id: 'ag-force-1', statut: 'terminé', reprise: true })));
  assert.match(hook(dir, outil).texte, /Sous-agent\(s\) terminé\(s\), résultat à traiter/, 'la fin est annoncée au premier outil');
  assert.equal(hook(dir, outil).texte, '', 'un simple outil ne rappelle pas avant le délai : pas de boucle');
  // Le rapport de fin arrive comme un tour de l'utilisateur : aucun numéro M, et ce qui attend est redit.
  const avant = Object.keys(ledger().demandes).length;
  const rapport = message('p-rapport', '<agent-message from="ag-force-1">\n[Subagent hand-back] The text below is the final report of a subagent.\n  fait : le lot du panier');
  assert.equal(Object.keys(ledger().demandes).length, avant, 'le rapport d\'un sous-agent ne doit jamais devenir un message de l\'utilisateur');
  assert.doesNotMatch(rapport.texte, /Nouveau message M-/);
  assert.match(rapport.texte, new RegExp(`Sous-agent\\(s\\) terminé\\(s\\), résultat à traiter : ${ligne} « lot du panier » \\(résultat : rapports/resultat-du-lot\\.jsonl\\)`), 'le rapport reçu est une livraison : elle est annoncée');
  // Le message d'un agent inconnu (autre session) : pas un message de l'utilisateur non plus. Il ne suit aucune
  // tâche, mais un message d'agent qui arrive redit ce qui attend déjà.
  assert.match(message('p-autre', '<agent-message from="session-inconnue">\nbonjour').texte, rappel);
  assert.equal(Object.keys(ledger().demandes).length, avant);
  // La notification de fin d'une autre tâche de fond (une commande, un agent inconnu) : pas un message de l'utilisateur,
  // et pas de rappel non plus (chaque commande de fond qui finit ne doit pas redire toute la liste).
  const notification = message('p-notif', '<task-notification>\n<task-id>autre-tache</task-id>\n<status>completed</status>\n</task-notification>');
  assert.equal(Object.keys(ledger().demandes).length, avant);
  assert.doesNotMatch(notification.texte, /TERMINÉ\(S\)/);
  // Demandes multiples : chaque nouveau message de l'utilisateur redit le sous-agent fini, avec le chemin de son résultat.
  for (const [id, texte] of [['p-2', 'autre demande : corrige le formulaire'], ['p-3', 'et aussi le pied de page']]) {
    const r = message(id, texte);
    assert.match(r.texte, /Nouveau message M-\d+/);
    assert.match(r.texte, rappel, `redit au message ${id}`);
    assert.match(r.texte, /TERMINÉ\(S\)[^\n]*« lot du panier » \(résultat : rapports\/resultat-du-lot\.jsonl\)/, 'le rappel lui-même donne le chemin du résultat');
  }
  assert.equal(Object.keys(ledger().demandes).length, avant + 2);
  // Après un compactage : par le filet du premier outil (PostCompact a posé le drapeau), puis par SessionStart.
  // Le témoin du démarrage de ce test est vieilli : le filet ne sert que si SessionStart n'a pas déjà redonné la
  // liste pour CE compactage (moins de deux minutes d'écart).
  const ancien = Date.now() / 1000 - 600;
  fs.utimesSync(path.join(dir, '.sessions', `reinject-${AGENT}-${session}.vu`), ancien, ancien);
  hook(dir, { ...base, hook_event_name: 'PostCompact', trigger: 'auto' });
  const filet = hook(dir, outil);
  assert.match(filet.texte, /Réinjection après compactage/);
  assert.match(filet.texte, rappel, 'redit avec la liste redonnée après un compactage');
  assert.match(hook(dir, { ...base, hook_event_name: 'SessionStart', source: 'compact' }).texte, rappel, 'redit à la reprise après compactage');
  // Résultat prouvé traité : plus rien à rappeler.
  assert.deepEqual(avecRacine(dir, () => core.appliquerPreuves({ agent: AGENT, marqueurs: [{ id: ligne, partiel: false }], preuve: 'fichier h.md' })).faits, [ligne]);
  assert.doesNotMatch(message('p-4', 'dernier message').texte, /TERMINÉ\(S\)/, 'une ligne fermée sur preuve n\'est plus rappelée');
});

// Un sous-agent relancé après la clôture de sa ligne a rendu un second rapport, et rien ne l'a suivi (sa fin
// arrive sans identifiant ni texte final : même identité que sa fin précédente).
test('hook : sous-agent relancé après la clôture de sa ligne : la relance est suivie, sa fin est une livraison ; sans relance vue, son rapport en est une', () => {
  const dir = dossier('relance');
  const session = 'sess-relance';
  const base = { session_id: session, cwd: CWD_PROJET };
  hook(dir, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  const id = 'ag-relance-1';
  const ledger = () => avecRacine(dir, () => core.lireLedger(PROJET, AGENT));
  const lignes = () => Object.keys(ledger().lignes);
  const l1 = avecRacine(dir, () => core.suivreTache({ agent: AGENT, sessionId: session, cwd: CWD_PROJET, tache: { id, genre: 'general-purpose', titre: 'lot du panier', resultat: 'rapports/sortie.jsonl' } }));
  // Fin telle qu'elle arrive pour un sous-agent qui rend son rapport par l'outil de remise : ni identifiant ni texte.
  const fin = () => hook(dir, { ...base, hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'general-purpose' });
  const outil = extra => hook(dir, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, ...extra });
  const fermer = l => assert.deepEqual(avecRacine(dir, () => core.appliquerPreuves({ agent: AGENT, marqueurs: [{ id: l, partiel: false }], preuve: 'fichier h.md' })).faits, [l]);
  fin();
  assert.match(outil().texte, new RegExp(`Sous-agent\\(s\\) terminé\\(s\\), résultat à traiter : ${l1} `));
  fermer(l1);
  // Un message envoyé à un agent qui tourne encore (pas de resumedAgentId) n'est pas une relance.
  outil({ tool_name: 'SendMessage', tool_input: { to: id, message: 'précision' }, tool_response: { success: true, message: 'Message queued' } });
  assert.deepEqual(lignes(), [l1]);
  // La relance (SendMessage qui fait repartir l'agent) est suivie comme un lancement : nouvelle ligne, tout de suite.
  const relance = outil({ tool_name: 'SendMessage', tool_input: { to: id, message: 'continue avec le lot suivant' }, tool_response: { success: true, message: 'Resuming agent', resumedAgentId: id } });
  assert.equal(lignes().length, 2, 'une nouvelle ligne suit le sous-agent relancé');
  const l2 = lignes().find(x => x !== l1);
  assert.match(relance.texte, new RegExp(`sous-agent « lot du panier » relancé, suivi par ${l2} \\(nouvelle ligne`));
  assert.equal(ledger().lignes[l2].statut, 'en-cours');
  assert.match(ledger().lignes[l2].texte, new RegExp(`relancé après la clôture de ${l1}`));
  // Sa fin, toujours sans identifiant ni texte, est maintenant une livraison : marquée, puis annoncée.
  fin();
  assert.match(ledger().lignes[l2].note, /^TERMINÉ/);
  assert.match(outil().texte, new RegExp(`Sous-agent\\(s\\) terminé\\(s\\), résultat à traiter : ${l2} `));
  fermer(l2);
  // Relance que le hook n'a pas vue (faite par l'utilisateur lui-même) : le rapport reçu suffit à créer la ligne.
  const avant = Object.keys(ledger().demandes).length;
  const prompt = `<agent-message from="${id}">\n[Subagent hand-back] The text below is the final report of a subagent.\n  second lot fait`;
  const rapport = hook(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt_id: 'p-rapport-2', prompt });
  assert.equal(Object.keys(ledger().demandes).length, avant, 'toujours aucun numéro M');
  assert.equal(lignes().length, 3, 'le rapport d\'un sous-agent dont la ligne est close crée une nouvelle ligne');
  const l3 = lignes().find(x => x !== l1 && x !== l2);
  assert.match(rapport.texte, new RegExp(`Sous-agent\\(s\\) terminé\\(s\\), résultat à traiter : ${l3} `));
  // Le même rapport relu ne crée rien de plus ; le rapport d'un agent inconnu non plus.
  hook(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt_id: 'p-rapport-2', prompt });
  hook(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt_id: 'p-rapport-3', prompt: '<agent-message from="ag-inconnu">\nbonjour' });
  assert.equal(lignes().length, 3);
});

// ---------------------------------------------------------------------------
// Mutations : chaque comportement ci-dessus, défait dans une copie des scripts, doit rendre au moins un banc
// ROUGE, et la même copie NON mutée doit rester verte (preuve que le rouge vient de la mutation).

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
    env, encoding: 'utf8', timeout: DELAI_RELANCE_MS, windowsHide: true,
  });
}

test('mutation : mentions, commits lus (dossiers, sortie), commit sans mention, partiels, textes de machine, sous-agents, conseils de « ajouter », temporaires -> banc rouge', { skip: EN_MUTATION }, () => {
  const motif = '^(texte de machine|hook : un texte de machine|mention complète|commit|hook : après un commit|preuves partielles|fichiers temporaires|hook : le commit d un sous-agent|ajouter : un message entier|message d.agent|hook : sous-agent fini|hook : sous-agent relancé)';
  const temoin = relancer(copie('temoin-fermeture'), motif);
  assert.equal(temoin.status, 0, 'copie non mutée doit être verte :\n' + temoin.stdout);
  const NOYAU = 'lib/context-ledger-core.js';
  const ADAPTATEUR = 'claude/context-ledger.js';
  const mutations = [
    ['filtre-proposition', '    const ligne = t.slice(debut, fin < 0 ? t.length : fin); // MUTATION : le filtre regarde la ligne entière', /not ok \d+ - mention complète : un mot négatif dans une AUTRE/, NOYAU, '^mention complète'],
    ['texte-de-machine', '  return false; // MUTATION : tout texte est un message de l\'utilisateur', /not ok \d+ - texte de machine/, NOYAU, '^texte de machine'],
    ['machine-non-enregistree', '  if (false) { // MUTATION : le texte de machine est enregistré comme un message', /not ok \d+ - hook : un texte de machine/, ADAPTATEUR, '^hook : un texte de machine'],
    ['commit-dossiers', '  for (const dossier of [rc.gitCwd]) { // MUTATION : seul le dossier d\'avant', /not ok \d+ - commit : la mention est lue quand le commit suit un changement de dossier/, NOYAU, '^commit : la mention'],
    ['sortie-sha', '    // MUTATION : SHA de la sortie jamais retenu', /not ok \d+ - commit fait par un script : sa sortie/, NOYAU, '^commit fait par un script : sa sortie'],
    ['commits-par-sortie', '  return []; // MUTATION : la sortie de la commande est ignorée', /not ok \d+ - commit fait par un script : sa sortie/, NOYAU, '^commit fait par un script : sa sortie'],
    ['sortie-fraicheur', '  if (!Number.isFinite(ct) || !complet.startsWith(sha)) return null; // MUTATION : aucune fraîcheur exigée', /not ok \d+ - commit fait par un script : dépôt non cité/, NOYAU, '^commit fait par un script : dépôt non cité'],
    ['commit-nu', '    return null; // MUTATION : un commit sans mention n\'est jamais rendu', /not ok \d+ - commit sans mention : rendu seulement/, NOYAU, '^commit sans mention'],
    ['rappel-commit-nu', '  // MUTATION : aucun rappel après un commit sans mention', /not ok \d+ - hook : après un commit sans mention/, ADAPTATEUR, '^hook : après un commit'],
    ['partiels-insistants', '          // MUTATION : jamais de rappel des preuves partielles répétées', /not ok \d+ - preuves partielles/, NOYAU, '^preuves partielles'],
    ['temporaires-forme', '      if (!/\\.tmp$/.test(n)) continue; // MUTATION : tout fichier .tmp est retiré', /not ok \d+ - fichiers temporaires/, NOYAU, '^fichiers temporaires'],
    ['commit-agent-doublon', '      // MUTATION : un même commit est noté plusieurs fois', /not ok \d+ - hook : le commit d un sous-agent/, NOYAU, '^hook : le commit d un sous-agent'],
    ['commits-agents-annonce', '  // MUTATION : les commits des sous-agents ne sont jamais dits', /not ok \d+ - hook : le commit d un sous-agent/, NOYAU, '^hook : le commit d un sous-agent'],
    ['commit-sous-agent', '  // MUTATION : le commit d\'un sous-agent n\'est jamais noté', /not ok \d+ - hook : le commit d un sous-agent/, ADAPTATEUR, '^hook : le commit d un sous-agent'],
    ['ajout-avertissements', '        // MUTATION : « ajouter » ne donne aucun conseil', /not ok \d+ - ajouter : un message entier/, NOYAU, '^ajouter : un message entier'],
    ['ajout-plusieurs-travaux', '  if (false) { // MUTATION : une ligne longue n\'est jamais signalée', /not ok \d+ - ajouter : un message entier/, NOYAU, '^ajouter : un message entier'],
    ['ajout-questionnaire', '  if (false) { // MUTATION : une réponse de questionnaire n\'est jamais signalée', /not ok \d+ - ajouter : un message entier/, NOYAU, '^ajouter : un message entier'],
    ['ajout-consigne', '  if (false) { // MUTATION : une consigne n\'est jamais signalée', /not ok \d+ - ajouter : un message entier/, NOYAU, '^ajouter : un message entier'],
    // Rapport d'un sous-agent et sous-agents finis jamais oubliés.
    ['message-d-agent', '  const m = null; // MUTATION : le rapport d\'un sous-agent n\'est plus reconnu', /not ok \d+ - message d.agent/, NOYAU, '^message d.agent'],
    ['agent-message-non-enregistre', '  if (false) { // MUTATION : le rapport d\'un sous-agent est enregistré comme un message', /not ok \d+ - hook : sous-agent fini/, ADAPTATEUR, '^hook : sous-agent fini'],
    ['livraison-rappel-force', '  const complet = rappeler; // MUTATION : le rappel complet attend toujours son délai', /not ok \d+ - hook : sous-agent fini/, NOYAU, '^hook : sous-agent fini'],
    ['rappel-force-message', '  const enFile = [texteMessagesEnFile(file), suiviEnCours(input)].filter(Boolean).join(\'\\n\'); // MUTATION : un nouveau message ne redit pas le sous-agent fini', /not ok \d+ - hook : sous-agent fini/, ADAPTATEUR, '^hook : sous-agent fini'],
    ['rappel-force-rapport', '    sortir(\'UserPromptSubmit\', [texteMessagesEnFile(file), suiviEnCours(input)].filter(Boolean).join(\'\\n\')); // MUTATION : le rapport ne redit pas ce qui attend', /not ok \d+ - hook : sous-agent fini/, ADAPTATEUR, '^hook : sous-agent fini'],
    ['rappel-force-filet', '  const courts = [suivi, commitNu, suiviEnCours(input)].filter(Boolean).join(\'\\n\'); // MUTATION : la liste redonnée après un compactage ne redit pas le sous-agent fini', /not ok \d+ - hook : sous-agent fini/, ADAPTATEUR, '^hook : sous-agent fini'],
    ['rappel-force-demarrage', '    [texteMessagesEnFile(file), suiviEnCours(input), core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id })].filter(Boolean).join(\'\\n\'), // MUTATION : le démarrage ne redit pas le sous-agent fini', /not ok \d+ - hook : sous-agent fini/, ADAPTATEUR, '^hook : sous-agent fini'],
    // Relance d'un sous-agent après la clôture de sa ligne.
    ['livraison-relance-identite', '  return hashCourt(JSON.stringify(base)); // MUTATION : le rang de la relance n\'entre plus dans l\'identité de la fin', /not ok \d+ - hook : sous-agent relancé/, NOYAU, '^hook : sous-agent relancé'],
    ['livraison-relance', '    ligne = t.ligne; // MUTATION : la relance ne crée pas de nouvelle ligne', /not ok \d+ - hook : sous-agent relancé/, NOYAU, '^hook : sous-agent relancé'],
    ['relance-suivie', '      const r = null; // MUTATION : la relance n\'est pas suivie', /not ok \d+ - hook : sous-agent relancé/, ADAPTATEUR, '^hook : sous-agent relancé'],
    ['rapport-nouvelle-livraison', '      core.finirTache({ agent: AGENT, sessionId: input.session_id, id: expediteur, statut: \'terminé\', reprise: false, // MUTATION : le rapport reçu n\'est plus une livraison en direct', /not ok \d+ - hook : sous-agent relancé/, ADAPTATEUR, '^hook : sous-agent relancé'],
    ['chemin-du-resultat', '  const liste = etat.attente.slice(0, MAX_LIVRAISONS).map(t => `${t.ligne} « ${t.titre} »`).join(\' ; \'); // MUTATION : le rappel ne donne pas le chemin du résultat', /not ok \d+ - hook : sous-agent fini/, NOYAU, '^hook : sous-agent fini'],
  ];
  for (const [ancre, remplacement, rouge, fichier, seul] of mutations) {
    const r = relancer(copie('mutation-' + ancre, fichier, 'ancre-mutation:' + ancre, remplacement), seul);
    assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
    assert.match(r.stdout, rouge, ancre);
  }
});
