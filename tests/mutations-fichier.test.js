'use strict';
// Banc du moteur de preuve par mutation d'un fichier (lib/mutations-fichier.js) : sa garde contre les faux « tuées ».
// Une copie mutée vit dans un dossier temporaire : un require relatif qui n'est pas réécrit en chemin absolu y échoue, et le banc rougit
// pour une raison sans rapport avec la mutation (toutes les mutations seraient « tuées » à tort). Le moteur doit le refuser d'avance.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, beforeEach, afterEach } = require('node:test');

const { executer } = require(process.env.MUTATIONS_FICHIER_TESTE || path.join(__dirname, 'lib', 'mutations-fichier.js'));

let RUN;
let sortie;
let erreur;
let ecritureStdout;
let ecritureStderr;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'mutations-fichier-banc-'));
  sortie = '';
  erreur = '';
  ecritureStdout = process.stdout.write;
  ecritureStderr = process.stderr.write;
  process.stdout.write = chunk => { sortie += chunk; return true; };
  process.stderr.write = chunk => { erreur += chunk; return true; };
});
afterEach(() => {
  process.stdout.write = ecritureStdout;
  process.stderr.write = ecritureStderr;
  fs.rmSync(RUN, { recursive: true, force: true });
});

const source = texte => {
  const f = path.join(RUN, 'source.js');
  fs.writeFileSync(f, texte);
  return f;
};
const lancer = (texte, extra = {}) => executer({
  source: source(texte),
  banc: path.join(RUN, 'banc.js'),
  variable: 'BANC_TESTE',
  mutations: [{ nom: 'm1', suite: 'x', de: 'const A = 1;', vers: 'const A = 2;' }],
  argv: ['--ancres'],
  ...extra,
});

describe('require relatif non réécrit', () => {
  test('une source sans require relatif passe', async () => {
    assert.equal(await lancer("const fs = require('node:fs');\nconst p = require('path');\nconst A = 1;\n"), 0);
    assert.equal(erreur, '');
  });

  test('un require relatif sans réécriture est refusé, avec son nom, avant tout essai', async () => {
    assert.equal(await lancer("const lib = require('./lib/outil.js');\nconst A = 1;\n"), 2);
    assert.match(erreur, /require relatif non réécrit/);
    assert.ok(erreur.includes("require('./lib/outil.js')"), erreur);
  });

  test('les guillemets doubles, les apostrophes inverses et les chemins parents sont vus aussi', async () => {
    for (const ligne of ['require("./a.js")', 'require(`./a.js`)', "require('../lib/a.js')", "require( './a.js' )"]) {
      erreur = '';
      assert.equal(await lancer(`const x = ${ligne};\nconst A = 1;\n`), 2, ligne);
      assert.match(erreur, /require relatif non réécrit/, ligne);
    }
  });

  test('chaque require relatif non réécrit est nommé une seule fois', async () => {
    assert.equal(await lancer("const a = require('./a.js');\nconst b = require('./b.js');\nconst c = require('./a.js');\nconst A = 1;\n"), 2);
    assert.equal(erreur.split("require('./a.js')").length - 1, 1);
    assert.ok(erreur.includes("require('./b.js')"));
  });

  test('une réécriture déclarée qui le remplace par un chemin absolu le rend acceptable', async () => {
    const absolu = JSON.stringify(path.join(RUN, 'a.js'));
    assert.equal(await lancer("const a = require('./a.js');\nconst A = 1;\n", { reecritures: [["require('./a.js')", `require(${absolu})`]] }), 0);
    assert.equal(erreur, '');
  });

  test('une réécriture partielle laisse refuser le require relatif restant', async () => {
    const absolu = JSON.stringify(path.join(RUN, 'a.js'));
    assert.equal(await lancer("const a = require('./a.js');\nconst b = require('./b.js');\nconst A = 1;\n", { reecritures: [["require('./a.js')", `require(${absolu})`]] }), 2);
    assert.ok(erreur.includes("require('./b.js')"));
    assert.ok(!erreur.includes("require('./a.js')"));
  });

  test('le refus passe avant le contrôle des ancres et avant le témoin', async () => {
    const r = await lancer("const a = require('./a.js');\n", { argv: [] });
    assert.equal(r, 2);
    assert.doesNotMatch(sortie, /TEMOIN/);
  });
});
