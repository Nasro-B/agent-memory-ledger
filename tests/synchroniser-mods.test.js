'use strict';
// Bancs de l'outil de synchronisation des logiques communes : scripts/synchroniser-mods.js
// Et la garde de dérive : la copie embarquée dans un module d'interface doit rester identique, à l'octet, à la source unique. Les modules
// se cherchent dans <racine du dépôt>/mods/<nom>/hooks (ou le dossier de MODULES_RACINE) ; tant que ce dossier n'existe pas, les tests de
// dérive et de déclarations de types sont ignorés (ils s'activent dès que les modules sont là).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const OUTIL = process.env.SYNCHRONISER_MODS_TESTE || path.join(__dirname, '..', 'scripts', 'synchroniser-mods.js');
const SOURCE = path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-logique.mjs');
const RACINE_MODULES = process.env.MODULES_RACINE || path.join(__dirname, '..', 'mods');
const SANS_MODULES = fs.existsSync(RACINE_MODULES) ? false : "aucun module d'interface dans ce dépôt";
const MODULE_REGULATEUR = path.join(RACINE_MODULES, 'regulateur');

let n = 0;
let RUN;
beforeEach(() => { RUN = fs.mkdtempSync(path.join(os.tmpdir(), `regulateur-synchro-${process.pid}-${++n}-`)); });

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const outil = (...args) => spawnSync(process.execPath, [OUTIL, ...args], { encoding: 'utf8' });

function faireModule(nom, contenu) {
  const dossier = path.join(RUN, nom);
  fs.mkdirSync(path.join(dossier, 'hooks'), { recursive: true });
  if (contenu !== null) fs.writeFileSync(path.join(dossier, 'hooks', 'regulateur-logique.mjs'), contenu);
  return dossier;
}

describe('outil', () => {
  test('--verifier : 0 quand la copie est identique à la source', () => {
    const d = faireModule('a', fs.readFileSync(SOURCE));
    const r = outil('--verifier', d);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /identique/);
  });

  test('--verifier : 1 et le dossier nommé quand la copie diffère, sans rien modifier', () => {
    const d = faireModule('b', 'export const x = 1;\n');
    const r = outil('--verifier', d);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /différente/);
    assert.ok(r.stdout.includes(d));
    assert.equal(fs.readFileSync(path.join(d, 'hooks', 'regulateur-logique.mjs'), 'utf8'), 'export const x = 1;\n');
  });

  test('--verifier : 1 quand la copie est absente', () => {
    const r = outil('--verifier', faireModule('c', null));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /absente/);
  });

  test('sans option : recopie la source, octet pour octet, dans chaque dossier', () => {
    const a = faireModule('d1', 'vieux');
    const b = faireModule('d2', null);
    const r = outil(a, b);
    assert.equal(r.status, 0, r.stderr);
    for (const d of [a, b]) assert.equal(sha(path.join(d, 'hooks', 'regulateur-logique.mjs')), sha(SOURCE), d);
    assert.equal(outil('--verifier', a, b).status, 0);
  });

  test('refuse un dossier qui n est pas un module (pas de dossier hooks)', () => {
    const d = path.join(RUN, 'vide');
    fs.mkdirSync(d);
    const r = outil(d);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /pas un module/);
    assert.deepEqual(fs.readdirSync(d), []);
  });

  test('refuse un dossier qui n existe pas', () => {
    const r = outil('--verifier', path.join(RUN, 'nulle-part'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /pas un module/);
  });

  test('refuse un appel sans aucun dossier, avec ou sans --verifier', () => {
    for (const args of [[], ['--verifier']]) {
      const r = outil(...args);
      assert.notEqual(r.status, 0, args.join(' '));
      assert.match(r.stderr, /au moins un dossier/);
    }
  });
});

describe('option --nom (une autre logique commune, par exemple celle du Garde-quota)', () => {
  const QUOTA = path.join(__dirname, '..', 'scripts', 'lib', 'quota-logique.mjs');

  test('recopie la logique nommée, et elle seule, dans hooks/ de chaque module', () => {
    const d = faireModule('q1', 'regulateur intact');
    const r = outil('--nom', 'quota-logique.mjs', d);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sha(path.join(d, 'hooks', 'quota-logique.mjs')), sha(QUOTA));
    assert.equal(fs.readFileSync(path.join(d, 'hooks', 'regulateur-logique.mjs'), 'utf8'), 'regulateur intact');
    assert.match(r.stdout, /copie mise à jour/);
  });

  test('--verifier --nom compare la copie de cette logique : identique, différente ou absente', () => {
    const d = faireModule('q2', 'x');
    assert.match(outil('--verifier', '--nom', 'quota-logique.mjs', d).stdout, /copie absente/);
    assert.equal(outil('--verifier', '--nom', 'quota-logique.mjs', d).status, 1);
    fs.writeFileSync(path.join(d, 'hooks', 'quota-logique.mjs'), 'autre');
    assert.match(outil('--verifier', '--nom', 'quota-logique.mjs', d).stdout, /copie différente/);
    outil('--nom', 'quota-logique.mjs', d);
    const r = outil('--verifier', '--nom', 'quota-logique.mjs', d);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /copie identique/);
  });

  test('sans --nom, c est la logique du Régulateur, comme avant', () => {
    const d = faireModule('q3', 'vieux');
    outil(d);
    assert.equal(sha(path.join(d, 'hooks', 'regulateur-logique.mjs')), sha(SOURCE));
    assert.equal(fs.existsSync(path.join(d, 'hooks', 'quota-logique.mjs')), false);
  });

  test('refuse un nom qui n est pas une logique commune existante, sans rien écrire', () => {
    const d = faireModule('q4', 'x');
    for (const nom of ['../evil.mjs', 'quota-logique.js', 'inconnu-logique.mjs', '..\\quota-logique.mjs', 'sous/quota-logique.mjs', '', 'QUOTA-logique.mjs']) {
      const r = outil('--nom', nom, d);
      assert.notEqual(r.status, 0, JSON.stringify(nom));
      assert.match(r.stderr, /nom de logique invalide/, JSON.stringify(nom));
    }
    const sans = outil('--nom');
    assert.notEqual(sans.status, 0);
    assert.match(sans.stderr, /nom de logique invalide/);
    assert.deepEqual(fs.readdirSync(path.join(d, 'hooks')), ['regulateur-logique.mjs']);
  });
});

describe('déclarations de types des logiques communes dans les modules', () => {
  // Chaque module qui embarque une copie d'une logique en déclare les types à la main (le moteur n'importe que du JavaScript,
  // `tsc` veut des types) : le jeu de noms doit rester celui des exports de la source.
  const exportsDe = texte => [...texte.matchAll(/^export (?:async )?(?:const|function) ([A-Za-z0-9_]+)/gm)].map(m => m[1]).sort();
  const declaresDe = texte => [...texte.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)].map(m => m[1]).sort();
  for (const [dossier, nom] of [['regulateur', 'regulateur-logique'], ['regulateur', 'file-logique'], ['garde-quota', 'quota-logique'], ['consignes', 'consignes-logique'], ['consignes', 'config-logique'], ['nuit', 'nuit-logique'], ['pause', 'pause-logique']]) {
    test(`${nom}.d.mts déclare exactement les exports de ${nom}.mjs`, { skip: SANS_MODULES }, () => {
      const d = fs.readFileSync(path.join(RACINE_MODULES, dossier, 'hooks', `${nom}.d.mts`), 'utf8');
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', `${nom}.mjs`), 'utf8');
      assert.ok(exportsDe(source).length > 5, 'la source a bien des exports');
      assert.deepEqual(declaresDe(d), exportsDe(source));
    });
  }
});

describe('garde de dérive', () => {
  test('la copie du module Garde-quota est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(RACINE_MODULES, 'garde-quota', 'hooks', 'quota-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(path.join(__dirname, '..', 'scripts', 'lib', 'quota-logique.mjs')), 'lancer : node scripts/synchroniser-mods.js --nom quota-logique.mjs <dossier du module>');
  });

  test('la copie du module Consignes est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(RACINE_MODULES, 'consignes', 'hooks', 'consignes-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(path.join(__dirname, '..', 'scripts', 'lib', 'consignes-logique.mjs')), 'lancer : node scripts/synchroniser-mods.js --nom consignes-logique.mjs <dossier du module>');
  });

  test('la copie de la logique des réglages dans le module Consignes est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(RACINE_MODULES, 'consignes', 'hooks', 'config-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(path.join(__dirname, '..', 'scripts', 'lib', 'config-logique.mjs')), 'lancer : node scripts/synchroniser-mods.js --nom config-logique.mjs <dossier du module>');
  });

  test('la copie de la file d agents dans le module Régulateur est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(MODULE_REGULATEUR, 'hooks', 'file-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(path.join(__dirname, '..', 'scripts', 'lib', 'file-logique.mjs')), 'lancer : node scripts/synchroniser-mods.js --nom file-logique.mjs <dossier du module>');
  });

  test('la copie du module Nuit est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(RACINE_MODULES, 'nuit', 'hooks', 'nuit-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(path.join(__dirname, '..', 'scripts', 'lib', 'nuit-logique.mjs')), 'lancer : node scripts/synchroniser-mods.js --nom nuit-logique.mjs <dossier du module>');
  });

  test('la copie du module Pause est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(RACINE_MODULES, 'pause', 'hooks', 'pause-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(path.join(__dirname, '..', 'scripts', 'lib', 'pause-logique.mjs')), 'lancer : node scripts/synchroniser-mods.js --nom pause-logique.mjs <dossier du module>');
  });

  test('la copie du module Régulateur est identique à la source unique', { skip: SANS_MODULES }, () => {
    const copie = path.join(MODULE_REGULATEUR, 'hooks', 'regulateur-logique.mjs');
    assert.ok(fs.existsSync(copie), `copie absente : ${copie}`);
    assert.equal(sha(copie), sha(SOURCE), 'lancer : node scripts/synchroniser-mods.js');
  });
});
