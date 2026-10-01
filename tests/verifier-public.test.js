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
    'README.md': 'Exemple : C:\\travail\\projet-demo, C:/Users/demo/.agent-memory-ledger, ~/.agent-memory-ledger\nContact : equipe@example.com\n',
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
    'a.md': 'Chemin : C:' + '\\Users\\' + 'marie' + '\\projets\\x\nAutre : /home/' + 'paul' + '/code\nDisque : D:' + '\\Archives\\2024\n',
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
  assert.ok(!r.out.includes(jeton) && !r.out.includes(cleApi), 'un secret n\'est jamais affiché en entier');
  assert.match(r.out, /3 fichier\(s\) contrôlé\(s\).* constat\(s\)\./);
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

test('ce dépôt lui-même passe le contrôle', () => {
  const r = controler(path.join(__dirname, '..'));
  assert.equal(r.code, 0, r.out);
});
