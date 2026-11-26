'use strict';
// Bancs de scripts/lib/emplacements-logique.mjs : où un module d'interface trouve l'état du Cockpit et les scripts du plugin.
// Le moteur de Claude Code n'est pas lancé ici : `$` est une doublure qui répond comme lui (variables d'environnement, existence et liste de fichiers,
// dossier du module). Le dernier groupe compare le dossier d'état au calcul du noyau (cockpit-core.js : racine) pour les mêmes variables.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const LOGIQUE = process.env.EMPLACEMENTS_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'emplacements-logique.mjs');
const CORE = process.env.COCKPIT_CORE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js');
const logique = require(LOGIQUE);
const cockpitCore = require(CORE);

// Une doublure de `$` : `env` (variables), `fichiers` (chemins qui existent), `listes` (contenu des dossiers), `racine` (le dossier du module).
function faux({ env = {}, fichiers = [], listes = {}, racine = 'C:/travail/depot/mods/pause', pannes = {} } = {}) {
  const appels = { env: [], existe: [], liste: [] };
  const $ = {
    plugin: { root: racine },
    env: {
      get: async nom => {
        appels.env.push(nom);
        if (pannes.env === nom) throw new Error('refused: no implementation');
        return env[nom];
      },
    },
    fs: {
      exists: async chemin => {
        appels.existe.push(chemin);
        if (pannes.exists) throw new Error('indisponible');
        return fichiers.includes(chemin);
      },
      list: async chemin => {
        appels.liste.push(chemin);
        if (pannes.list) throw new Error('indisponible');
        if (!(chemin in listes)) throw new Error('ENOENT');
        return listes[chemin].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }));
      },
    },
  };
  return { $, appels };
}

describe('dossierEtat : le calcul de cockpit-core.js', () => {
  test('COCKPIT_DIR prime sur tout, sans son séparateur final', async () => {
    const { $ } = faux({ env: { COCKPIT_DIR: 'C:/travail/etat/', AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison', USERPROFILE: 'C:/Users/demo' } });
    assert.equal(await logique.dossierEtat($), 'C:/travail/etat');
    const antislash = faux({ env: { COCKPIT_DIR: 'C:\\travail\\etat\\\\' } });
    assert.equal(await logique.dossierEtat(antislash.$), 'C:\\travail\\etat');
  });

  test('sans COCKPIT_DIR, <maison>/cockpit où la maison est AGENT_MEMORY_LEDGER_HOME (rognée)', async () => {
    const { $ } = faux({ env: { AGENT_MEMORY_LEDGER_HOME: '  C:/travail/maison/  ', USERPROFILE: 'C:/Users/demo' } });
    assert.equal(await logique.dossierEtat($), 'C:/travail/maison/cockpit');
  });

  test('une variable vide ou faite d\'espaces compte comme absente', async () => {
    const { $ } = faux({ env: { COCKPIT_DIR: '   ', AGENT_MEMORY_LEDGER_HOME: '', USERPROFILE: 'C:/Users/demo' } });
    assert.equal(await logique.dossierEtat($), 'C:/Users/demo/.agent-memory-ledger/cockpit');
  });

  test('sans rien, le dossier de l\'utilisateur : USERPROFILE sous Windows, HOME ailleurs', async () => {
    const windows = faux({ env: { USERPROFILE: 'C:/Users/demo', HOME: '/home/demo' }, racine: 'C:/travail/depot/mods/pause' });
    assert.equal(await logique.dossierEtat(windows.$), 'C:/Users/demo/.agent-memory-ledger/cockpit');
    const reseau = faux({ env: { USERPROFILE: '//serveur/demo', HOME: '/home/demo' }, racine: '\\\\serveur\\depot\\mods\\pause' });
    assert.equal(await logique.dossierEtat(reseau.$), '//serveur/demo/.agent-memory-ledger/cockpit');
    const posix = faux({ env: { USERPROFILE: 'C:/Users/demo', HOME: '/home/demo/' }, racine: '/opt/depot/mods/pause' });
    assert.equal(await logique.dossierEtat(posix.$), '/home/demo/.agent-memory-ledger/cockpit');
  });

  test('le dossier de l\'utilisateur est rogné de ses espaces et de son séparateur final', async () => {
    const { $ } = faux({ env: { HOME: '  /home/demo/  ' }, racine: '/opt/depot/mods/pause' });
    assert.equal(await logique.dossierEtat($), '/home/demo/.agent-memory-ledger/cockpit');
  });

  test('l\'autre variable sert de repli quand celle de la plateforme manque', async () => {
    assert.equal(await logique.dossierEtat(faux({ env: { HOME: '/home/demo' }, racine: 'C:/travail/depot/mods/pause' }).$), '/home/demo/.agent-memory-ledger/cockpit');
    assert.equal(await logique.dossierEtat(faux({ env: { USERPROFILE: 'C:/Users/demo' }, racine: '/opt/depot/mods/pause' }).$), 'C:/Users/demo/.agent-memory-ledger/cockpit');
  });

  test('aucun dossier connu : une erreur qui dit quelles variables poser', async () => {
    await assert.rejects(() => logique.dossierEtat(faux().$), /COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME/);
  });

  test('une lecture de variable qui échoue vaut une variable absente', async () => {
    const { $ } = faux({ env: { AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison', COCKPIT_DIR: 'C:/travail/etat' }, pannes: { env: 'COCKPIT_DIR' } });
    assert.equal(await logique.dossierEtat($), 'C:/travail/maison/cockpit');
  });

  test('ne lit que ce qu\'il faut : COCKPIT_DIR seul quand il est posé', async () => {
    const { $, appels } = faux({ env: { COCKPIT_DIR: 'C:/travail/etat' } });
    await logique.dossierEtat($);
    assert.deepEqual(appels.env, ['COCKPIT_DIR']);
  });
});

describe('dossierEtat : le même dossier que le noyau, pour les mêmes variables', () => {
  const VARIABLES = ['COCKPIT_DIR', 'AGENT_MEMORY_LEDGER_HOME', 'USERPROFILE', 'HOME'];
  const racineModule = process.platform === 'win32' ? 'C:/travail/depot/mods/pause' : '/opt/depot/mods/pause';
  const CAS = [
    {},
    { COCKPIT_DIR: path.resolve(os.tmpdir(), 'etat-cockpit') },
    { COCKPIT_DIR: `${path.resolve(os.tmpdir(), 'etat-cockpit')}${path.sep}` },
    { AGENT_MEMORY_LEDGER_HOME: path.resolve(os.tmpdir(), 'maison-ledger') },
    { AGENT_MEMORY_LEDGER_HOME: `  ${path.resolve(os.tmpdir(), 'maison-ledger')}${path.sep}  ` },
    { COCKPIT_DIR: path.resolve(os.tmpdir(), 'etat-cockpit'), AGENT_MEMORY_LEDGER_HOME: path.resolve(os.tmpdir(), 'maison-ledger') },
    { COCKPIT_DIR: '   ', AGENT_MEMORY_LEDGER_HOME: path.resolve(os.tmpdir(), 'maison-ledger') },
    { COCKPIT_DIR: '', AGENT_MEMORY_LEDGER_HOME: '' },
  ];
  for (const [i, cas] of CAS.entries()) {
    test(`cas ${i} : ${JSON.stringify(cas).slice(0, 90)}`, async () => {
      const avant = Object.fromEntries(VARIABLES.map(v => [v, process.env[v]]));
      try {
        for (const v of VARIABLES) delete process.env[v];
        // Le dossier de l'utilisateur est celui de la machine : la doublure rend la variable que Node lit pour os.homedir().
        const profil = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
        process.env[profil] = avant[profil] || os.homedir();
        for (const [v, valeur] of Object.entries(cas)) process.env[v] = valeur;
        const { $ } = faux({ env: { ...process.env }, racine: racineModule });
        assert.equal(path.resolve(await logique.dossierEtat($)), cockpitCore.racine());
      } finally {
        for (const v of VARIABLES) { if (avant[v] === undefined) delete process.env[v]; else process.env[v] = avant[v]; }
      }
    });
  }
});

describe('cheminScript : où est scripts/<nom> du plugin principal', () => {
  test('AML_PLUGIN_DIR prime, sans rien chercher sur le disque', async () => {
    const { $, appels } = faux({ env: { AML_PLUGIN_DIR: 'C:/outils/ledger/' } });
    assert.equal(await logique.cheminScript($, 'cockpit.js'), 'C:/outils/ledger/scripts/cockpit.js');
    assert.deepEqual(appels.existe, []);
    assert.deepEqual(appels.liste, []);
  });

  test('un dépôt cloné : le module est dans mods/<nom>, le script dans scripts/ à la racine du dépôt', async () => {
    const { $ } = faux({ racine: 'C:/travail/depot/mods/pause', fichiers: ['C:/travail/depot/scripts/cockpit.js'] });
    assert.equal(await logique.cheminScript($, 'cockpit.js'), 'C:/travail/depot/scripts/cockpit.js');
  });

  test('une racine en barres obliques inverses se lit de la même façon', async () => {
    const { $ } = faux({ racine: 'C:\\travail\\depot\\mods\\pause\\', fichiers: ['C:/travail/depot/scripts/regulateur-file.js'] });
    assert.equal(await logique.cheminScript($, 'regulateur-file.js'), 'C:/travail/depot/scripts/regulateur-file.js');
  });

  test('un plugin installé : la version la plus récente qui a le script, les nombres comparés comme des nombres', async () => {
    const cache = 'C:/Users/demo/.claude/plugins/cache/agent-memory-ledger';
    const { $ } = faux({
      racine: `${cache}/pause/0.13.0`,
      listes: { [`${cache}/agent-memory-ledger`]: ['0.9.0', '0.12.0', '0.13.0', '0.14.0'] },
      fichiers: [`${cache}/agent-memory-ledger/0.9.0/scripts/cockpit.js`, `${cache}/agent-memory-ledger/0.13.0/scripts/cockpit.js`],
    });
    assert.equal(await logique.cheminScript($, 'cockpit.js'), `${cache}/agent-memory-ledger/0.13.0/scripts/cockpit.js`);
  });

  test('une liste aux entrées abîmées (vide, sans nom, nom qui n\'est pas du texte) est ignorée : la version lisible est trouvée', async () => {
    const cache = 'C:/Users/demo/.claude/plugins/cache/agent-memory-ledger';
    const { $ } = faux({ racine: `${cache}/pause/0.13.0`, fichiers: [`${cache}/agent-memory-ledger/0.1.0/scripts/cockpit.js`] });
    $.fs.list = async () => [null, {}, { name: 12 }, { name: '0.1.0' }];
    assert.equal(await logique.cheminScript($, 'cockpit.js'), `${cache}/agent-memory-ledger/0.1.0/scripts/cockpit.js`);
  });

  test('0.10.0 est plus récente que 0.9.0', () => {
    assert.deepEqual(logique.versionsRecentes(['0.9.0', '0.10.0', '0.2.1']), ['0.10.0', '0.9.0', '0.2.1']);
  });

  test('aucun script trouvé : une erreur qui nomme le script et la variable à poser', async () => {
    const { $ } = faux({ racine: 'C:/travail/cache/agent-memory-ledger/pause/0.13.0', listes: { 'C:/travail/cache/agent-memory-ledger/agent-memory-ledger': ['0.13.0'] } });
    await assert.rejects(() => logique.cheminScript($, 'cockpit.js'), /cockpit\.js introuvable : poser AML_PLUGIN_DIR/);
    const sansListe = faux({ racine: 'C:/travail/cache/agent-memory-ledger/pause/0.13.0' });
    await assert.rejects(() => logique.cheminScript(sansListe.$, 'cockpit.js'), /introuvable/);
  });

  test('un disque qui répond mal ne fait pas tomber : le script est dit introuvable', async () => {
    const { $ } = faux({ racine: 'C:/travail/depot/mods/pause', pannes: { exists: true, list: true } });
    await assert.rejects(() => logique.cheminScript($, 'cockpit.js'), /introuvable/);
  });

  test('une lecture d\'AML_PLUGIN_DIR qui échoue vaut une variable absente', async () => {
    const { $ } = faux({ env: { AML_PLUGIN_DIR: 'C:/outils/ledger' }, pannes: { env: 'AML_PLUGIN_DIR' }, racine: 'C:/travail/depot/mods/pause', fichiers: ['C:/travail/depot/scripts/cockpit.js'] });
    assert.equal(await logique.cheminScript($, 'cockpit.js'), 'C:/travail/depot/scripts/cockpit.js');
  });

  test('le plugin principal du dépôt a bien le script que les modules lancent', () => {
    const fs = require('node:fs');
    for (const nom of ['cockpit.js', 'regulateur-file.js']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', nom)), nom);
  });
});
