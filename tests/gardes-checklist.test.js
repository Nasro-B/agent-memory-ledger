'use strict';
// Banc du rappel avant commit (scripts/lib/checklist-commit.js, scripts/gardes/checklist-confirmer.js,
// scripts/gardes/checklist-hook-git.js, et la part de scripts/gardes/securite.js qui refuse le commit d'un agent).
// Sur de VRAIS dépôts git temporaires : commit refusé, confirmé, diff modifié donc confirmation caduque, worktree,
// hook git natif. Sans modèle. Lancement : node --test tests/gardes-checklist.test.js
// Les motifs sensibles (variable d'environnement, tâche planifiée) sont construits par morceaux : ce fichier ne se
// déclenche pas lui-même.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { creerMonde } = require('./aide-gardes.js');

const m = creerMonde('checklist');
const securite = require(m.scripts('gardes', 'securite.js'));
const checklist = require(m.scripts('lib', 'checklist-commit.js'));
const gardesConfig = require(m.scripts('lib', 'gardes-config.js'));

const VARIABLE = 'const x = process' + '.env.MA_VARIABLE;\n';
const VARIABLE_DENO = 'const x = Deno' + '.env.get("MA_CLE");\n';
const PLANIFIE = 'select cron' + '.schedule(\'nuit\', \'0 3 * * *\', \'select 1\');\n';
const EXTENSION = 'create extension pg_' + 'cron;\n';
const MAISON = m.maison();

const categories = (gardes) => m.avecMaison(gardes === undefined ? MAISON : m.maison(gardes), () => gardesConfig.charger()).checklist.categories;
const CATS = categories();
const touchees = (depot, cats = CATS) => Object.entries(checklist.detecter(depot, cats).touchees).filter(([, v]) => v).map(([k]) => k);

// Refus du commit par la garde de commandes : { decision, texte }.
function commit(depot, o = {}) {
  const maison = o.maison || MAISON;
  const commande = o.commande || 'git commit -m "x"';
  const charge = { hook_event_name: 'PreToolUse', tool_name: o.agent === 'codex' ? 'exec_command' : 'Bash', cwd: o.cwd || depot, tool_input: { command: commande, cmd: commande } };
  const r = m.avecMaison(maison, () => securite.executer(JSON.stringify(charge), { agent: o.agent || 'claude' }));
  const h = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : {};
  return { decision: h.permissionDecision || 'allow', texte: h.permissionDecisionReason || h.additionalContext || '', code: r.code };
}

function confirmer(depot, args, maison = MAISON) {
  const r = spawnSync(process.execPath, [m.scripts('gardes', 'checklist-confirmer.js'), ...args], { cwd: depot, encoding: 'utf8', env: m.env(maison), windowsHide: true, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ------------------------------------------------------------------ détection

test('checklist : détection par catégorie, fichiers et lignes ajoutées, voisins sans catégorie', () => {
  const cas = [
    ['supabase/migrations/001_init.sql', 'select 1;\n', ['migrations']],
    ['migrations/002.sql', 'select 1;\n', ['migrations']],
    ['db/migrations/003.sql', 'select 1;\n', ['migrations']],
    ['migrations/LISEZMOI.md', 'notes\n', []],
    ['data/seed.sql', 'select 1;\n', []],
    ['supabase/functions/envoi/index.ts', 'export {};\n', ['fonctions']],
    ['src/functions/envoi.ts', 'export {};\n', []],
    ['src/a.js', VARIABLE, ['variables']],
    ['src/b.ts', VARIABLE_DENO, ['variables']],
    ['src/c.js', 'const e = process' + '.env;\n', []],
    ['src/d.js', 'const e = "process env MA_VARIABLE";\n', []],
    ['sql/e.sql', PLANIFIE, ['taches']],
    ['sql/f.sql', EXTENSION, ['taches']],
    ['sql/g.sql', 'select 1; -- crontab et cron seuls\n', []],
    ['LISEZMOI.md', 'texte\n', []],
  ];
  for (const [fichier, contenu, attendu] of cas) {
    const d = m.depot('detection');
    m.preparer(d, fichier, contenu);
    assert.deepEqual(touchees(d), attendu, fichier);
  }
  const d = m.depot('retrait');
  fs.writeFileSync(path.join(d, 'v.js'), VARIABLE);
  m.git(d, 'add', 'v.js');
  m.git(d, 'commit', '-q', '-m', 'v');
  fs.writeFileSync(path.join(d, 'v.js'), 'const x = 1;\n');
  m.git(d, 'add', 'v.js');
  assert.deepEqual(touchees(d), [], 'une variable RETIRÉE n\'est pas une variable ajoutée');
  const plusieurs = m.depot('plusieurs');
  m.preparer(plusieurs, 'supabase/migrations/1.sql', 'select 1;\n');
  m.preparer(plusieurs, 'src/a.js', VARIABLE);
  assert.deepEqual(touchees(plusieurs), ['migrations', 'variables']);
  const accents = m.depot('accents');
  m.preparer(accents, 'migrations/é-été.sql', 'select 1;\n');
  assert.deepEqual(touchees(accents), ['migrations'], 'un nom de fichier accentué est lu tel quel');
});

// ------------------------------------------------------------------ refus, confirmation, caducité

test('checklist : le commit est refusé, la commande de confirmation est donnée, puis le commit passe', () => {
  const d = m.depot('refus');
  m.preparer(d, 'supabase/migrations/1.sql', 'select 1;\n');
  m.preparer(d, 'src/a.js', VARIABLE);
  const r = commit(d);
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 2);
  for (const motif of [/COMMIT REFUSE/, /migrations\s+: migrations de base de données/, /variables\s+: nouvelle\(s\) variable/, /schéma appliqué en réel sur la bonne base/, /--migrations=oui --variables=oui/, /commande SEULE|lance SEULE cette commande/, /dans une commande séparée/]) assert.match(r.texte, motif);
  const script = /node "([^"]+checklist-confirmer\.js)"/.exec(r.texte);
  assert.ok(script && fs.existsSync(script[1]), 'le chemin du script de confirmation est réel : ' + (script && script[1]));
  assert.match(r.texte, /--cwd="[^"]+"/);
  // Une confirmation partielle ne débloque pas, une réponse manquante est refusée.
  const manque = confirmer(d, ['--migrations=oui']);
  assert.equal(manque.code, 1);
  assert.match(manque.err, /SANS réponse : variables/);
  assert.equal(commit(d).decision, 'deny');
  const ok = confirmer(d, ['--migrations=oui', '--variables=na']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Confirmation enregistrée/);
  assert.match(ok.out, /Tout est oui ou na/);
  assert.equal(commit(d).decision, 'allow');
  assert.equal(commit(d, { agent: 'codex' }).decision, 'allow');
  m.git(d, 'commit', '-q', '-m', 'migration et variable');
  assert.equal(m.git(d, 'log', '-1', '--format=%s').trim(), 'migration et variable');
});

test('checklist : « non » documente l\'état sans rien débloquer', () => {
  const d = m.depot('non');
  m.preparer(d, 'migrations/1.sql', 'select 1;\n');
  const r = confirmer(d, ['--migrations=non']);
  assert.equal(r.code, 0);
  assert.match(r.out, /reste en NON/);
  const c = commit(d);
  assert.equal(c.decision, 'deny');
  assert.match(c.texte, /migrations/);
  assert.equal(confirmer(d, ['--migrations=NA']).code, 0, 'les réponses ne sont pas sensibles à la casse');
  assert.equal(commit(d).decision, 'allow');
});

test('checklist : toute modification de l\'index rend la confirmation caduque (liste des fichiers ET contenu)', () => {
  const d = m.depot('caduque');
  m.preparer(d, 'supabase/migrations/1.sql', 'select 1;\n');
  assert.equal(confirmer(d, ['--migrations=oui']).code, 0);
  assert.equal(commit(d).decision, 'allow');
  const avant = checklist.detecter(d, CATS).empreinte;
  m.preparer(d, 'supabase/migrations/1.sql', 'select 2;\n');
  assert.notEqual(checklist.detecter(d, CATS).empreinte, avant, 'même fichier, contenu changé : empreinte changée');
  assert.equal(commit(d).decision, 'deny', 'contenu modifié : reconfirmation exigée');
  assert.equal(confirmer(d, ['--migrations=oui']).code, 0);
  assert.equal(commit(d).decision, 'allow');
  m.preparer(d, 'LISEZMOI.md', 'autre fichier\n');
  assert.equal(commit(d).decision, 'deny', 'fichier ajouté : reconfirmation exigée');
  assert.equal(confirmer(d, ['--migrations=oui']).code, 0);
  assert.equal(commit(d).decision, 'allow');
  m.git(d, 'reset', '-q', 'LISEZMOI.md');
  assert.equal(commit(d).decision, 'deny', 'fichier retiré de l\'index : reconfirmation exigée');
});

test('checklist : sans catégorie sensible, rien à confirmer et le commit n\'est pas refusé', () => {
  const d = m.depot('rien');
  m.preparer(d, 'LISEZMOI.md', 'texte\n');
  assert.equal(commit(d).decision, 'allow');
  const r = confirmer(d, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /Aucune catégorie sensible/);
  assert.equal(fs.existsSync(checklist.cheminMarqueur(checklist.racineGit(d))), false, 'aucun marqueur écrit');
});

test('checklist : le dépôt visé est celui de la commande (git -C, cd), les citations ne sont pas des commits, amend exclu', () => {
  const d = m.depot('vise');
  m.preparer(d, 'migrations/1.sql', 'select 1;\n');
  const ailleurs = m.maison();
  assert.equal(commit(d, { cwd: ailleurs, commande: `git -C "${d}" commit -m "x"` }).decision, 'deny');
  assert.equal(commit(d, { cwd: ailleurs, commande: `cd "${d}" && git commit -m "x"` }).decision, 'deny');
  assert.equal(commit(d, { cwd: ailleurs, commande: 'git commit -m "x"' }).decision, 'allow', 'le dossier courant n\'est pas un dépôt : rien à contrôler');
  assert.equal(commit(d, { commande: 'echo "git commit -m x"' }).decision, 'allow', 'un commit cité n\'est pas un commit');
  assert.equal(commit(d, { commande: 'git status && git log -1' }).decision, 'allow');
  assert.equal(commit(d, { commande: 'git commit --amend --no-edit' }).decision, 'allow', 'amend : l\'index est déjà figé');
  assert.equal(commit(d, { commande: 'git status; git commit -m "x"' }).decision, 'deny', 'commit après un autre segment');
  assert.equal(commit(d, { commande: 'git.exe commit -m x' }).decision, 'deny');
});

// ------------------------------------------------------------------ worktree, marqueur

test('checklist : un worktree a sa propre confirmation, écrite dans son dossier git et jamais dans l\'arbre de travail', () => {
  const d = m.depot('principal');
  const wt = path.join(m.run, 'worktree-secondaire');
  m.git(d, 'worktree', 'add', '-q', wt, '-b', 'autre');
  m.preparer(wt, 'supabase/migrations/1.sql', 'select 1;\n');
  m.preparer(d, 'supabase/migrations/1.sql', 'select 1;\n');
  assert.equal(commit(wt).decision, 'deny');
  const r = confirmer(wt, ['--migrations=oui']);
  assert.equal(r.code, 0, r.err);
  assert.equal(commit(wt).decision, 'allow', 'le worktree est confirmé');
  assert.equal(commit(d).decision, 'deny', 'le dépôt principal ne l\'est pas : même diff, autre confirmation');
  const marqueur = checklist.cheminMarqueur(checklist.racineGit(wt));
  assert.match(marqueur.replace(/\\/g, '/'), /\/\.git\/worktrees\/[^/]+\/agent-memory-ledger-checklist\.json$/);
  assert.ok(fs.existsSync(marqueur));
  assert.equal(fs.existsSync(path.join(wt, checklist.NOM_MARQUEUR)), false);
  assert.equal(m.git(wt, 'status', '--porcelain').split('\n').filter(l => l.includes('checklist')).length, 0, 'rien de visible pour git');
  m.git(wt, 'commit', '-q', '-m', 'dans le worktree');
});

// ------------------------------------------------------------------ hook git natif

function installerHookGit(depot, nom) {
  const dossier = path.join(m.run, 'hooks-' + nom);
  fs.mkdirSync(dossier, { recursive: true });
  const script = m.scripts('gardes', 'checklist-hook-git.js').replace(/\\/g, '/');
  fs.writeFileSync(path.join(dossier, 'pre-commit'), `#!/bin/sh\nnode "${script}" || exit 1\n`, { mode: 0o755 });
  m.git(depot, 'config', 'core.hooksPath', dossier);
}

function commitGit(depot, maison = MAISON) {
  const r = spawnSync('git', ['commit', '-q', '-m', 'essai'], { cwd: depot, encoding: 'utf8', env: m.env(maison), windowsHide: true, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('checklist : le hook git natif refuse le vrai commit, quel que soit l\'outil, puis le laisse passer une fois confirmé', () => {
  const d = m.depot('natif');
  installerHookGit(d, 'natif');
  m.preparer(d, 'supabase/migrations/1.sql', 'select 1;\n');
  const refus = commitGit(d);
  assert.notEqual(refus.code, 0, 'git lui-même refuse');
  assert.match(refus.err, /COMMIT REFUSE/);
  assert.match(refus.err, /--migrations=oui/);
  assert.equal(m.git(d, 'log', '--oneline').trim().split('\n').length, 1, 'aucun commit créé');
  assert.equal(confirmer(d, ['--migrations=oui']).code, 0);
  assert.equal(commitGit(d).code, 0, 'confirmé : le commit passe');
  assert.equal(m.git(d, 'log', '--oneline').trim().split('\n').length, 2);
  // Un commit sans catégorie sensible n'est jamais gêné.
  m.preparer(d, 'LISEZMOI.md', 'texte\n');
  assert.equal(commitGit(d).code, 0);
  // Réglage éteint : le hook laisse passer.
  const eteint = m.maison({ checklist: { actif: false } });
  m.preparer(d, 'migrations/2.sql', 'select 2;\n');
  assert.notEqual(commitGit(d).code, 0);
  assert.equal(commitGit(d, eteint).code, 0, 'checklist.actif false : le hook ne refuse plus');
});

test('checklist : une vérification en panne refuse le commit, au hook git comme à la garde de commandes', () => {
  const d = m.depot('panne');
  m.preparer(d, 'LISEZMOI.md', 'texte\n');
  fs.writeFileSync(path.join(d, '.git', 'index'), 'index illisible');
  const hook = spawnSync(process.execPath, [m.scripts('gardes', 'checklist-hook-git.js')], { cwd: d, encoding: 'utf8', env: m.env(MAISON), windowsHide: true, timeout: 60000 });
  assert.equal(hook.status, 1);
  assert.match(hook.stderr, /n'a pas pu être vérifié/);
  const garde = commit(d);
  assert.equal(garde.decision, 'deny');
  assert.match(garde.texte, /Rappel avant commit NON VÉRIFIÉ/);
  const hors = m.maison();
  const ok = spawnSync(process.execPath, [m.scripts('gardes', 'checklist-hook-git.js')], { cwd: hors, encoding: 'utf8', env: m.env(MAISON), windowsHide: true, timeout: 60000 });
  assert.equal(ok.status, 0, 'hors d\'un dépôt : rien à contrôler');
});

// ------------------------------------------------------------------ arguments de la commande de confirmation

test('checklist : la commande de confirmation refuse ce qu\'elle ne comprend pas', () => {
  const d = m.depot('arguments');
  m.preparer(d, 'migrations/1.sql', 'select 1;\n');
  assert.equal(confirmer(d, ['--migrations=peut-etre']).code, 1, 'valeur inconnue');
  assert.equal(confirmer(d, ['--migrations=oui', '--pas-une-categorie=oui']).code, 1, 'catégorie inconnue');
  assert.match(confirmer(d, ['--migrations=oui', '--pas-une-categorie=oui']).err, /Catégorie\(s\) inconnue\(s\) : pas-une-categorie/);
  assert.equal(confirmer(d, ['migrations']).code, 1, 'argument sans forme');
  assert.equal(confirmer(d, []).code, 1, 'aucune réponse');
  assert.equal(commit(d).decision, 'deny', 'rien n\'a été confirmé');
  const hors = m.maison();
  const r = confirmer(hors, ['--migrations=oui']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Pas un dépôt git/);
  assert.equal(confirmer(hors, ['--migrations=oui', `--cwd=${d}`]).code, 0, '--cwd désigne le dépôt');
  assert.equal(commit(d).decision, 'allow');
});

// ------------------------------------------------------------------ configuration

test('checklist : configuration : la garde éteinte ne refuse plus aucun commit, la commande le dit', () => {
  const eteint = m.maison({ checklist: { actif: false } });
  const d = m.depot('eteint');
  m.preparer(d, 'migrations/1.sql', 'select 1;\n');
  assert.equal(commit(d, { maison: eteint }).decision, 'allow');
  assert.equal(commit(d).decision, 'deny', 'la même maison sans réglage refuse');
  const r = confirmer(d, ['--migrations=oui'], eteint);
  assert.equal(r.code, 0);
  assert.match(r.out, /désactivé/);
  assert.equal(commit(d).decision, 'deny', 'rien n\'a été écrit');
});

test('checklist : configuration : catégorie ajoutée, catégorie désactivée, motif remplacé', () => {
  const gardes = {
    checklist: {
      categories: [
        { nom: 'secrets', fichiers: '(^|/)secrets/', contenu: 'SECRET_[A-Z_]+', libelle: 'secrets du coffre', question: 'secret(s) créé(s) dans le coffre ?' },
        { nom: 'variables', actif: false },
        { nom: 'migrations', fichiers: '(^|/)schema/.*\\.sql$' },
      ],
    },
  };
  const maison = m.maison(gardes);
  const cats = categories(gardes);
  assert.deepEqual(cats.map(c => c.nom), ['migrations', 'fonctions', 'taches', 'secrets']);
  const d = m.depot('config');
  m.preparer(d, 'secrets/a.txt', 'x\n');
  const r = commit(d, { maison });
  assert.equal(r.decision, 'deny');
  assert.match(r.texte, /secrets\s+: secrets du coffre -> secret\(s\) créé\(s\) dans le coffre \?/);
  assert.match(r.texte, /--secrets=oui/);
  assert.equal(confirmer(d, ['--secrets=oui'], maison).code, 0);
  assert.equal(commit(d, { maison }).decision, 'allow');
  const e = m.depot('config-contenu');
  m.preparer(e, 'src/a.js', 'const cle = "SECRET_JETON";\n');
  assert.equal(commit(e, { maison }).decision, 'deny', 'motif de contenu de la catégorie ajoutée');
  const v = m.depot('config-variables');
  m.preparer(v, 'src/a.js', VARIABLE);
  assert.equal(commit(v, { maison }).decision, 'allow', 'variables désactivée');
  assert.equal(commit(v).decision, 'deny', 'activée par défaut');
  const s = m.depot('config-schema');
  m.preparer(s, 'supabase/migrations/1.sql', 'select 1;\n');
  assert.equal(commit(s, { maison }).decision, 'allow', 'le motif de migrations est remplacé');
  m.preparer(s, 'schema/1.sql', 'select 1;\n');
  assert.equal(commit(s, { maison }).decision, 'deny');
  assert.match(commit(s, { maison }).texte, /migrations de base de données/, 'le libellé par défaut est gardé');
  const inconnue = confirmer(d, ['--secrets=oui', '--variables=oui'], maison);
  assert.equal(inconnue.code, 1, 'une catégorie désactivée n\'est plus une réponse admise');
  assert.match(inconnue.err, /Catégorie\(s\) inconnue\(s\) : variables/);
});

test('checklist : configuration : un motif invalide garde le défaut, une catégorie sans motif est ignorée, et la garde le dit', () => {
  const gardes = { checklist: { categories: [{ nom: 'migrations', fichiers: '[pas-fermé' }, { nom: 'vide' }, { nom: 'Mauvais Nom', fichiers: 'x' }, { nom: 'ok-2', contenu: 'MOT_CLE' }] } };
  const cfg = m.avecMaison(m.maison(gardes), () => gardesConfig.charger());
  assert.deepEqual(cfg.checklist.categories.map(c => c.nom), ['migrations', 'fonctions', 'variables', 'taches', 'ok-2']);
  const dit = gardesConfig.dire(cfg);
  for (const motif of [/le motif « fichiers » de « migrations » est invalide, le motif par défaut est gardé/, /« vide » n'a ni motif/, /doit avoir un « nom »/]) assert.match(dit, motif);
  const maison = m.maison(gardes);
  const d = m.depot('invalide');
  m.preparer(d, 'migrations/1.sql', 'select 1;\n');
  const r = commit(d, { maison });
  assert.equal(r.decision, 'deny', 'le motif par défaut s\'applique encore');
  assert.match(r.texte, /Réglage des gardes/, 'la garde dit l\'écart');
  const z = m.depot('invalide-2');
  m.preparer(z, 'src/a.js', 'const m = "MOT_CLE";\n');
  assert.equal(commit(z, { maison }).decision, 'deny', 'la catégorie valide du même fichier est retenue');
});

test('checklist : configuration : un gardes.json illisible ne désarme pas le rappel', () => {
  const maison = m.maison('{ pas du json');
  const d = m.depot('illisible');
  m.preparer(d, 'migrations/1.sql', 'select 1;\n');
  const r = commit(d, { maison });
  assert.equal(r.decision, 'deny');
  assert.match(r.texte, /illisible/);
  installerHookGit(d, 'illisible');
  const c = commitGit(d, maison);
  assert.notEqual(c.code, 0);
  assert.match(c.err, /illisible/);
  assert.match(c.err, /COMMIT REFUSE/);
});

// ------------------------------------------------------------------ mutations

test('mutation : chaque protection du rappel avant commit, défaite dans une copie des scripts, rend son banc rouge', { skip: m.EN_MUTATION }, () => {
  const LIB = 'lib/checklist-commit.js';
  const rouge = nom => new RegExp('not ok \\d+ - checklist : ' + nom);
  m.mutations(__filename, '^checklist', [
    ['categorie-fichiers', '      false || // MUTATION : les fichiers ne déclenchent plus aucune catégorie', rouge('détection par catégorie'), LIB, '^checklist : détection par catégorie'],
    ['categorie-contenu', '      false // MUTATION : les lignes ajoutées ne déclenchent plus aucune catégorie', rouge('détection par catégorie'), LIB, '^checklist : détection par catégorie'],
    ['empreinte-diff', '    .update(\'\') // MUTATION : le texte du diff n\'entre plus dans l\'empreinte', rouge('toute modification de l.index'), LIB, '^checklist : toute modification'],
    ['marqueur-empreinte', '  const reponses = marqueur && marqueur.reponses ? marqueur.reponses : {}; // MUTATION : une confirmation vaut pour tout diff', rouge('toute modification de l.index'), LIB, '^checklist : toute modification'],
    ['non-debloque', '  const attente = detectees.filter(c => !reponses[c.nom]); // MUTATION : « non » débloque', rouge('« non » documente'), LIB, '^checklist : « non »'],
    ['checklist-panne', '    } catch (e) { /* MUTATION : une vérification en panne laisse passer */ }', rouge('une vérification en panne'), 'gardes/securite.js', '^checklist : une vérification en panne'],
    ['hook-refus', '    process.exit(0); // MUTATION : le hook git ne refuse plus', rouge('le hook git natif refuse'), 'gardes/checklist-hook-git.js', '^checklist : le hook git natif'],
    ['hook-panne', '  process.exit(0); // MUTATION : une panne laisse passer le commit', rouge('une vérification en panne'), 'gardes/checklist-hook-git.js', '^checklist : une vérification en panne'],
    ['confirmer-manquantes', '  if (false) { // MUTATION : une catégorie sans réponse est enregistrée', rouge('le commit est refusé, la commande de confirmation'), 'gardes/checklist-confirmer.js', '^checklist : le commit est refusé'],
    ['confirmer-inconnues', '  if (false) { // MUTATION : une catégorie inconnue est acceptée', rouge('la commande de confirmation refuse'), 'gardes/checklist-confirmer.js', '^checklist : la commande de confirmation refuse'],
    ['categorie-desactivee', '    if (c.actif === false) { continue; } // MUTATION : une catégorie désactivée reste active', rouge('configuration : catégorie ajoutée'), 'lib/gardes-config.js', '^checklist : configuration : catégorie ajoutée'],
    ['categorie-ajoutee', '    /* MUTATION : une catégorie ajoutée n\'est jamais retenue */', rouge('configuration : catégorie ajoutée'), 'lib/gardes-config.js', '^checklist : configuration : catégorie ajoutée'],
  ]);
});
