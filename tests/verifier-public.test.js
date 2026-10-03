'use strict';
// Bancs du contrôle avant publication (scripts/verifier-public.js).
// Lancement : node --test tests/verifier-public.test.js
// Les faux secrets sont assemblés à l'exécution : aucun motif de clé n'est écrit tel quel dans ce fichier.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verifier-public.js');
const RUN = path.join(os.tmpdir(), 'aml-tests', 'verifier', 'run-' + Date.now() + '-' + process.pid);

function controler(dossier, extra = []) {
  const env = Object.assign({}, process.env);
  delete env.AML_TERMES_PRIVES;
  const r = spawnSync(process.execPath, [SCRIPT, '--dossier', dossier, ...extra], { encoding: 'utf8', env, windowsHide: true });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function depot(nom, fichiers) {
  const d = path.join(RUN, nom);
  fs.rmSync(d, { recursive: true, force: true });
  for (const [rel, contenu] of Object.entries(fichiers)) {
    const f = path.join(d, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, contenu);
  }
  return d;
}

test('dépôt propre : rien à signaler, les exemples admis passent', () => {
  const d = depot('propre', {
    'README.md': 'Exemple : C:\\travail\\projet-demo, C:/Users/demo/.agent-memory-ledger, ~/.agent-memory-ledger\nContact : equipe@example.com\nOutil : & \'C:\\Program Files\\Git\\usr\\bin\\wc.exe\' -l x\n',
    'src/a.js': "const horaire = /^\\d\\d:\\d\\d$/; // pas un chemin\nconst cle = process.env.API_KEY;\n",
    '.git/config': 'url = https://jeton-secret@exemple\n',
    'node_modules/x/index.js': 'C:' + '\\Users\\' + 'quelquun\\secret\n',
  });
  const r = controler(d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 fichier\(s\) contrôlé\(s\).* rien à signaler\./);
});

test('profil personnel, chemin absolu, adresse, clés, clé privée et secret en clair : tous signalés, jamais affichés en entier', () => {
  const jeton = 'gh' + 'p_' + 'a1B2'.repeat(9);
  const cleApi = 's' + 'k-' + 'Zx9'.repeat(8);
  const d = depot('sale', {
    'a.md': 'Chemin : C:' + '\\Users\\' + 'marie' + '\\projets\\x\nAutre : /home/' + 'paul' + '/code\nDisque : D:' + '\\Archives\\2024\nProgrammes : C:' + '\\ProgramData\\perso et C:' + '\\Program\\perso\n',
    'b.js': `const t = "${jeton}";\nconst k = '${cleApi}';\nconst MOT_DE_PASSE_${'PASSWORD'} = ${'"azerty123456"'};\n`,
    'c.txt': 'Écrire à ' + 'jean.dupont' + '@' + 'entreprise.fr' + '\n-----BEGIN RSA ' + 'PRIVATE KEY-----\n',
  });
  const r = controler(d);
  assert.equal(r.code, 1);
  for (const attendu of [
    /a\.md:1 : profil personnel/, /a\.md:2 : profil personnel/, /a\.md:3 : chemin absolu Windows/,
    /b\.js:1 : clé ou jeton/, /b\.js:2 : clé ou jeton/, /b\.js:3 : secret en clair/,
    /c\.txt:1 : adresse électronique/, /c\.txt:2 : clé privée/,
  ]) assert.match(r.out, attendu);
  // Ligne 4 : « ProgramData » et « Program » suivi d'un sous-dossier, deux constats (seul « Program Files » est admis).
  assert.equal((r.out.match(/a\.md:4 : chemin absolu Windows/g) || []).length, 2, r.out);
  assert.ok(!r.out.includes(jeton) && !r.out.includes(cleApi), 'un secret n\'est jamais affiché en entier');
  assert.match(r.out, /3 fichier\(s\) contrôlé\(s\).* constat\(s\)\./);
});

test('caractère invisible écrit tel quel : signalé, sauf la marque d\'ordre des octets en tout début de fichier', () => {
  const marque = String.fromCharCode(0xFEFF);
  const largeurNulle = String.fromCharCode(0x200B);
  const d = depot('invisibles', {
    'debut.js': marque + "'use strict';\nconst a = 1;\n",
    'milieu.js': "'use strict';\nconst t = texte.replace(/^" + marque + "/, '');\nconst b = 'a" + largeurNulle + "b';\n",
  });
  const r = controler(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /milieu\.js:2 : caractère invisible : U\+FEFF/);
  assert.match(r.out, /milieu\.js:3 : caractère invisible : U\+200B/);
  assert.ok(!/debut\.js/.test(r.out), 'une marque en tête de fichier est admise');
});

test('termes privés : chaque occurrence est une erreur, y compris dans un nom de fichier ; la liste doit rester hors du dépôt', () => {
  const d = depot('termes', { 'doc/projet-dupont.md': 'Fait pour la société Dupont.\nRien ici.\nDUPONT encore.\n', 'ok.md': 'rien\n' });
  const termes = path.join(RUN, 'termes-prives.txt');
  fs.writeFileSync(termes, '# commentaire\n\ndupont\nmartin(?!-pub)\n');
  const r = controler(d, ['--termes', termes]);
  assert.equal(r.code, 1);
  assert.match(r.out, /doc\/projet-dupont\.md:1 : terme privé : Dupont/);
  assert.match(r.out, /doc\/projet-dupont\.md:3 : terme privé : DUPONT/);
  assert.match(r.out, /doc\/projet-dupont\.md : terme privé dans le nom du fichier/);
  assert.match(r.out, /2 terme\(s\) privé\(s\)/);
  assert.equal(controler(d).code, 0, 'sans la liste : rien à signaler');
  // Liste rangée dans le dépôt : refus, elle serait publiée.
  fs.writeFileSync(path.join(d, 'termes.txt'), 'dupont\n');
  const dedans = controler(d, ['--termes', path.join(d, 'termes.txt')]);
  assert.equal(dedans.code, 2);
  assert.match(dedans.err, /DANS le dépôt/);
});

// Claude Code garde une installation sur la copie de la version installée tant que la chaîne « version » ne
// change pas : constaté sur ce dépôt, trois correctifs poussés sans changer la version n'atteignaient personne.
test('version du plugin : la même partout, et changée dès que le code publié change', () => {
  const ecrire = (d, manifeste, place, paquet) => {
    fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: manifeste }));
    fs.writeFileSync(path.join(d, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'demo', plugins: [{ name: 'demo', source: './', version: place }] }));
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'demo', version: paquet }));
  };
  const d = depot('version', { '.claude-plugin/plugin.json': '{}', 'scripts/a.js': 'console.log(1);\n', 'README.md': 'demo\n' });
  ecrire(d, '1.0.0', '0.9.0', '1.0.1');
  let r = controler(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /package\.json : version 1\.0\.1, le manifeste du plugin dit 1\.0\.0/);
  assert.match(r.out, /marketplace\.json : version 0\.9\.0, le manifeste du plugin dit 1\.0\.0/);
  ecrire(d, '1.0.0', '1.0.0', '1.0.0');
  assert.equal(controler(d).code, 0, 'versions accordées, pas de dépôt git : rien à signaler');
  // Publié sur une branche amont, puis le code change sans que la version change : signalé.
  const git = (cwd, ...a) => {
    const x = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(x.status, 0, `git ${a.join(' ')} : ${x.stderr}`);
  };
  const amont = path.join(RUN, 'version-amont.git');
  fs.mkdirSync(amont, { recursive: true });
  git(amont, 'init', '--bare', '-q');
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  git(d, '-c', 'user.name=banc', '-c', 'user.email=banc@example.com', 'commit', '-q', '-m', 'publication');
  git(d, 'remote', 'add', 'origin', amont);
  git(d, 'push', '-q', '-u', 'origin', 'HEAD');
  assert.equal(controler(d).code, 0, 'rien n\'a changé depuis la publication');
  fs.writeFileSync(path.join(d, 'README.md'), 'demo, documentation complétée\n');
  assert.equal(controler(d).code, 0, 'la documentation seule ne demande pas de nouvelle version');
  fs.writeFileSync(path.join(d, 'scripts', 'a.js'), 'console.log(2);\n');
  r = controler(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /version : 1 fichier\(s\) du plugin ont changé depuis la dernière publication \(origin\/\S+\) mais la version est restée 1\.0\.0/);
  ecrire(d, '1.1.0', '1.1.0', '1.1.0');
  assert.equal(controler(d).code, 0, 'version changée : rien à signaler');
});

test('ce dépôt lui-même passe le contrôle', () => {
  const r = controler(path.join(__dirname, '..'));
  assert.equal(r.code, 0, r.out);
});
