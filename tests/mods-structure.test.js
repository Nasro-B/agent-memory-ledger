'use strict';
// Bancs de la structure des modules d'interface de Claude Code (mods/<nom>) : sans le moteur de Claude Code (les bancs du moteur sont lancés par
// `node scripts/tester-mods.js`). Ce que ce fichier garantit :
//   - chaque module est complet (manifeste, module déclaré, fichiers présents) et porte la version du plugin ;
//   - chaque module est déclaré dans la marketplace du dépôt ;
//   - les copies des logiques communes dans mods/<nom>/hooks sont identiques, à l'octet, à leur source unique (scripts/lib), et leurs déclarations
//     de types ont exactement les exports de la source ;
//   - aucun module ne porte de chemin en dur, de tiret cadratin ni de caractère invisible.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const RACINE = path.join(__dirname, '..');
const MODS = process.env.MODULES_RACINE || path.join(RACINE, 'mods');
const LIB = path.join(RACINE, 'scripts', 'lib');
const sansMarque = t => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const lire = f => sansMarque(fs.readFileSync(f, 'utf8'));
const json = f => JSON.parse(lire(f));
const octets = f => fs.readFileSync(f);

const PLUGIN = json(path.join(RACINE, '.claude-plugin', 'plugin.json'));
const MARKETPLACE = json(path.join(RACINE, '.claude-plugin', 'marketplace.json'));

// Pour chaque module : son module déclaré, son contrat de types (s'il en a un) et les logiques communes dont il embarque une copie.
const MODULES = {
  consignes: { register: 'register.ts', types: false, logiques: ['consignes-logique', 'config-logique'] },
  'garde-quota': { register: 'register.ts', types: false, logiques: ['quota-logique'] },
  regulateur: { register: 'register.ts', types: false, logiques: ['regulateur-logique', 'file-logique', 'modeles-agents-logique'] },
  pause: { register: 'register.tsx', types: true, logiques: ['pause-logique'] },
  nuit: { register: 'register.tsx', types: true, logiques: ['nuit-logique'] },
  cockpit: { register: 'register.tsx', types: true, logiques: [] },
};
const tousLesFichiers = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' ? [] : tousLesFichiers(path.join(d, e.name))) : [path.join(d, e.name)]));
const exportsDe = texte => [...texte.matchAll(/^export (?:async )?(?:const|function) ([A-Za-z0-9_]+)/gm)].map(m => m[1]).sort();

// Les caractères invisibles et de format (la liste de la règle des invisibles du dépôt), par leurs codes : jamais écrits en clair.
const INTERVALLES_INVISIBLES = [[0, 8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0xa0, 0xa0], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x1680, 0x1680], [0x17b4, 0x17b5], [0x180e, 0x180e],
  [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x206f], [0x2800, 0x2800], [0x3000, 0x3000], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffc]];
const premierInvisible = texte => {
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    if (INTERVALLES_INVISIBLES.some(([a, b]) => c >= a && c <= b)) return { code: c, position: i };
  }
  return null;
};
const TIRET_CADRATIN = String.fromCharCode(0x2014);

describe('chaque module est complet', () => {
  for (const [nom, m] of Object.entries(MODULES)) {
    const dossier = path.join(MODS, nom);

    test(`${nom} : manifeste, version du plugin, description, auteur, licence`, () => {
      const p = json(path.join(dossier, '.claude-plugin', 'plugin.json'));
      assert.equal(p.name, nom);
      assert.equal(p.version, PLUGIN.version, 'la version du module est celle du plugin');
      assert.ok(typeof p.description === 'string' && p.description.length > 40);
      assert.deepEqual(p.author, PLUGIN.author);
      assert.equal(p.license, PLUGIN.license);
      assert.equal(p.homepage, PLUGIN.homepage);
      assert.equal(p.types, m.types ? './types/index.d.ts' : undefined, 'le contrat de types est déclaré quand le module garde un état');
    });

    test(`${nom} : hooks/hooks.json déclare le module, qui existe et appelle les emplacements communs`, () => {
      assert.deepEqual(json(path.join(dossier, 'hooks', 'hooks.json')), { modules: [`./${m.register}`] });
      const source = lire(path.join(dossier, 'hooks', m.register));
      assert.match(source, /from '\.\/emplacements-logique\.mjs'/, 'les chemins viennent des emplacements communs, jamais d\'un chemin écrit en dur');
      assert.match(source, /export const register: Register/);
    });

    test(`${nom} : README, bancs du moteur et contrat de types présents`, () => {
      assert.ok(fs.existsSync(path.join(dossier, 'README.md')));
      assert.ok(fs.readdirSync(path.join(dossier, 'tests')).some(f => /\.test\.tsx?$/.test(f)), 'au moins un banc du moteur');
      assert.ok(fs.existsSync(path.join(dossier, 'tests', 'emplacements.test.ts')), 'le banc des emplacements');
      if (m.types) assert.ok(fs.existsSync(path.join(dossier, 'types', 'index.d.ts')));
      assert.ok(fs.existsSync(path.join(RACINE, 'tests', 'mutations', `mutations-${nom}-mod.js`)), 'le script de mutation du module');
    });
  }

  test('aucun module de plus que ceux que ce banc connaît', () => {
    assert.deepEqual(fs.readdirSync(MODS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(), Object.keys(MODULES).sort());
  });
});

describe('la marketplace du dépôt déclare chaque module', () => {
  const plugins = Object.fromEntries(MARKETPLACE.plugins.map(p => [p.name, p]));

  test('le plugin principal et les six modules, chacun à la version du plugin', () => {
    assert.deepEqual(Object.keys(plugins).sort(), ['agent-memory-ledger', ...Object.keys(MODULES)].sort());
    for (const p of Object.values(plugins)) assert.equal(p.version, PLUGIN.version, p.name);
  });

  test('chaque module a pour source son dossier, relatif à la racine du dépôt', () => {
    assert.equal(plugins['agent-memory-ledger'].source, './');
    for (const nom of Object.keys(MODULES)) {
      assert.equal(plugins[nom].source, `./mods/${nom}`, nom);
      assert.ok(fs.existsSync(path.join(RACINE, plugins[nom].source, '.claude-plugin', 'plugin.json')), nom);
    }
  });

  test('la description de la marketplace est celle du module', () => {
    for (const nom of Object.keys(MODULES)) assert.equal(plugins[nom].description, json(path.join(MODS, nom, '.claude-plugin', 'plugin.json')).description, nom);
  });
});

describe('les copies des logiques communes sont celles de la source unique', () => {
  for (const [nom, m] of Object.entries(MODULES)) {
    for (const logique of [...m.logiques, 'emplacements-logique']) {
      test(`${nom}/${logique}.mjs identique à scripts/lib/${logique}.mjs`, () => {
        const copie = path.join(MODS, nom, 'hooks', `${logique}.mjs`);
        assert.ok(fs.existsSync(copie), `copie absente : lancer node scripts/synchroniser-mods.js --nom ${logique}.mjs mods/${nom}`);
        assert.ok(octets(copie).equals(octets(path.join(LIB, `${logique}.mjs`))), `copie différente : lancer node scripts/synchroniser-mods.js --nom ${logique}.mjs mods/${nom}`);
      });

      test(`${nom}/${logique}.d.mts déclare exactement les exports de ${logique}.mjs`, () => {
        const d = lire(path.join(MODS, nom, 'hooks', `${logique}.d.mts`));
        const declares = [...d.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)].map(x => x[1]).sort();
        assert.deepEqual(declares, exportsDe(lire(path.join(LIB, `${logique}.mjs`))));
      });
    }
  }

  test('les déclarations de types de emplacements-logique.mjs sont les mêmes dans les six modules', () => {
    const textes = new Set(Object.keys(MODULES).map(nom => lire(path.join(MODS, nom, 'hooks', 'emplacements-logique.d.mts'))));
    assert.equal(textes.size, 1);
  });

  test('la logique de la vue de la Nuit est propre au module : elle n\'est pas dans scripts/lib', () => {
    assert.ok(fs.existsSync(path.join(MODS, 'nuit', 'hooks', 'nuit-vue-logique.mjs')));
    assert.ok(!fs.existsSync(path.join(LIB, 'nuit-vue-logique.mjs')));
  });
});

describe('rien de privé ni d\'invisible dans les modules', () => {
  const fichiers = tousLesFichiers(MODS);

  test('aucun tiret cadratin ni caractère invisible écrit tel quel', () => {
    for (const f of fichiers) {
      const t = fs.readFileSync(f, 'utf8');
      assert.ok(!t.includes(TIRET_CADRATIN), `tiret cadratin : ${path.relative(RACINE, f)}`);
      const i = premierInvisible(t);
      assert.equal(i, null, `caractère invisible U+${i && i.code.toString(16).toUpperCase()} : ${path.relative(RACINE, f)}`);
    }
  });

  test('aucun chemin de machine écrit en dur dans les modules (lecteur Windows hors exemples, dossier de profil)', () => {
    const ADMIS = /^[A-Za-z]:[\\/]+(?:travail|outils|tmp|x|chemin|Users[\\/]+demo|Windows|Program Files)(?:[\\/]|$)/i;
    for (const f of fichiers.filter(x => /\.(ts|tsx|mjs|json|md)$/.test(x))) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/(?<![\\\w])[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.~-][^\s"'`<>|)*,;]*/g)) assert.ok(ADMIS.test(m[0].replace(/\\\\/g, '\\')), `${path.relative(RACINE, f)} : ${m[0]}`);
      assert.ok(!/\/\.claude|\.claude[\\/]/.test(t), `dossier de profil : ${path.relative(RACINE, f)}`);
    }
  });

  test('chaque module s\'appuie sur un dossier d\'état calculé, jamais sur un dossier écrit en dur', () => {
    for (const [nom, m] of Object.entries(MODULES)) {
      const source = lire(path.join(MODS, nom, 'hooks', m.register));
      assert.ok(!/['"`][A-Za-z]:[\\/]/.test(source) && !/['"`]\/(?:home|Users)\//.test(source), nom);
    }
  });
});
