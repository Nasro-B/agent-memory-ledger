'use strict';
// Les modules d'interface de Claude Code et la ligne de commande (scripts/cockpit.js) partagent des FICHIERS D'ÉTAT : une valeur réglée par la ligne de
// commande doit être lue par le module, et l'inverse. Ce banc le prouve sans le moteur de Claude Code, avec de vrais processus de la ligne de commande
// sur un dossier d'état à part, et la logique que le module embarque (mods/<nom>/hooks/<logique>.mjs, la copie du module) :
//   - le dossier : celui que le module calcule (emplacements-logique.mjs) est celui où la ligne de commande écrit, pour COCKPIT_DIR comme pour
//     AGENT_MEMORY_LEDGER_HOME ;
//   - les noms de fichiers : chaque fichier que la ligne de commande écrit porte le nom que le module lit (consignes.json, garde-quota.json,
//     politique-agents.json, pause.json, nuit.json) ;
//   - dans les deux sens : la ligne de commande pose, la copie de la logique du module lit ; la logique du module compose l'état à écrire comme
//     le fait le module, la ligne de commande le lit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const RACINE = path.join(__dirname, '..');
const CLI = process.env.COCKPIT_CLI_TESTE || path.join(RACINE, 'scripts', 'cockpit.js');
const MODS = process.env.MODULES_RACINE || path.join(RACINE, 'mods');
const logique = (module_, nom) => require(path.join(MODS, module_, 'hooks', `${nom}.mjs`));

let n = 0;
let DOSSIER;
let ENV;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `mods-etat-${process.pid}-${++n}-`));
  DOSSIER = path.join(base, 'etat');
  ENV = { ...process.env, COCKPIT_DIR: DOSSIER, AGENT_MEMORY_LEDGER_HOME: path.join(base, 'maison'), COCKPIT_QUOTA_NATIVE: '0' };
  delete ENV.CONTEXT_LEDGER_DIR;
});

const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: ENV, windowsHide: true, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const lireEtat = nom => JSON.parse(fs.readFileSync(path.join(DOSSIER, nom), 'utf8'));
const ecrireEtat = (nom, valeur) => { fs.mkdirSync(DOSSIER, { recursive: true }); fs.writeFileSync(path.join(DOSSIER, nom), JSON.stringify(valeur, null, 2)); };

describe('le dossier d\'état du module est celui de la ligne de commande', () => {
  const emplacements = logique('consignes', 'emplacements-logique');
  const moteur = variables => ({ plugin: { root: process.platform === 'win32' ? 'C:/travail/depot/mods/consignes' : '/opt/depot/mods/consignes' }, env: { get: async nom => variables[nom] } });

  test('COCKPIT_DIR : la ligne de commande y écrit, le module le désigne', async () => {
    assert.equal(cli('consignes', 'ajouter', 'Une consigne').code, 0);
    assert.ok(fs.existsSync(path.join(DOSSIER, 'consignes.json')));
    assert.equal(path.resolve(await emplacements.dossierEtat(moteur({ COCKPIT_DIR: DOSSIER }))), path.resolve(DOSSIER));
  });

  test('sans COCKPIT_DIR : <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME', async () => {
    delete ENV.COCKPIT_DIR;
    assert.equal(cli('consignes', 'ajouter', 'Une consigne').code, 0);
    const attendu = path.join(ENV.AGENT_MEMORY_LEDGER_HOME, 'cockpit');
    assert.ok(fs.existsSync(path.join(attendu, 'consignes.json')));
    assert.equal(path.resolve(await emplacements.dossierEtat(moteur({ AGENT_MEMORY_LEDGER_HOME: ENV.AGENT_MEMORY_LEDGER_HOME }))), path.resolve(attendu));
  });
});

describe('Consignes : consignes.json', () => {
  const l = logique('consignes', 'consignes-logique');

  test('la ligne de commande pose une consigne verrouillée, la logique du module la lit et refuse le push', () => {
    cli('consignes', 'ajouter', 'Pas de push sans mon ordre');
    cli('consignes', 'verrou', '1', 'push');
    const etat = l.normaliserEtat(lireEtat('consignes.json'));
    assert.equal(etat.consignes.length, 1);
    assert.equal(etat.consignes[0].verrou, 'push');
    assert.equal(l.decisionCommande(etat, 'git push origin main').autorise, false);
    assert.equal(l.decisionCommande(etat, 'git status').autorise, true);
  });

  test('le module écrit comme il le fait (l\'état et la date), la ligne de commande le lit', () => {
    const analyse = l.analyserCommande('ajouter Réponds en français', l.normaliserEtat(null));
    ecrireEtat('consignes.json', { ...analyse.etat, maj: new Date().toISOString() });
    const liste = cli('consignes', 'liste');
    assert.equal(liste.code, 0);
    assert.match(liste.out, /1\. \[actif\] Réponds en français/);
  });
});

describe('Garde-quota : garde-quota.json', () => {
  const l = logique('garde-quota', 'quota-logique');

  test('la ligne de commande règle les seuils, la logique du module les lit', () => {
    assert.equal(cli('quota', '70', '85').code, 0);
    const config = l.normaliserConfig(lireEtat('garde-quota.json'));
    assert.equal(config.attention, 70);
    assert.equal(config.critique, 85);
  });

  test('le module écrit ses réglages, la ligne de commande les dit', () => {
    const analyse = l.analyserCommande('bloquer off', null);
    ecrireEtat('garde-quota.json', { ...analyse.config, maj: new Date().toISOString() });
    assert.match(cli('quota').out, /Blocage des agents : non/);
  });

  test('la mesure que le module écrit (quota-claude.json) est celle que le Cockpit lit', () => {
    ecrireEtat('quota-claude.json', { fenetres: [{ nom: '7 j', pct: 71 }], mesureA: new Date().toISOString(), source: 'garde-quota' });
    const r = cli('instantane', '--json');
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out).quota.claude.fenetres, [{ nom: '7 j', pct: 71 }]);
  });
});

describe('Régulateur : politique-agents.json', () => {
  const l = logique('regulateur', 'regulateur-logique');

  test('la ligne de commande pose le plafond et la pause, la logique du module les lit et refuse', () => {
    cli('politique', '3');
    cli('politique', 'pause');
    const politique = l.normaliserPolitique(lireEtat('politique-agents.json'));
    assert.equal(politique.max, 3);
    assert.equal(politique.pause, true);
    assert.equal(l.decisionLancement(politique, 0).autorise, false);
  });

  test('le module écrit la politique, la ligne de commande la dit', () => {
    const analyse = l.analyserCommande('5', l.politiqueParDefaut(), 0);
    ecrireEtat('politique-agents.json', { ...analyse.politique, maj: new Date().toISOString() });
    assert.match(cli('politique').out, /maximum 5/);
  });
});

describe('Pause : pause.json (écrit par le noyau, que le module relit)', () => {
  const l = logique('pause', 'pause-logique');

  test('la ligne de commande met une session en pause, la logique du module décide d\'attendre', () => {
    const battement = spawnSync(process.execPath, [CLI, 'pause-hook', 'battre'], { input: JSON.stringify({ session: 'S1', titre: 'atelier', agents: [] }), encoding: 'utf8', env: ENV, windowsHide: true, timeout: 60000 });
    assert.equal(battement.status, 0, battement.stderr);
    assert.equal(cli('pause', '--session', 'S1').code, 0);
    const etat = lireEtat('pause.json');
    assert.equal(l.doitAttendre(etat, 'S1', undefined).attendre, true);
    assert.equal(cli('reprendre', '--session', 'S1').code, 0);
    assert.equal(l.doitAttendre(lireEtat('pause.json'), 'S1', undefined).attendre, false);
  });
});

describe('Nuit : nuit.json (écrit par le noyau, que le module relit)', () => {
  const l = logique('nuit', 'nuit-logique');

  test('la ligne de commande commence la nuit, la logique du module la dit active ; /nuit off la termine', () => {
    assert.equal(cli('nuit', 'on', '--agent', 'claude', '--session', 'S1').code, 0);
    assert.equal(l.estActive(lireEtat('nuit.json'), Date.now()), true);
    assert.equal(cli('nuit', 'off', '--agent', 'claude', '--session', 'S1').code, 0);
    assert.equal(l.estActive(lireEtat('nuit.json'), Date.now()), false);
  });
});

describe('Régulateur : la file (scripts/regulateur-file.js, le script que le module lance)', () => {
  test('la file que le script écrit dans le dossier d\'état est celle que le Cockpit mesure', () => {
    const file = path.join(RACINE, 'scripts', 'regulateur-file.js');
    const demande = { agent: 'claude', session: 'S1', description: 'travail A', demande: { prompt: 'Fais le travail A', description: 'travail A', subagentType: 'general-purpose' }, maintenant: Date.now() };
    const r = spawnSync(process.execPath, [file, JSON.stringify({ operation: 'mettreEnFile', args: [demande] })], { encoding: 'utf8', env: ENV, windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(DOSSIER, 'file-agents.json')));
    assert.equal(JSON.parse(cli('instantane', '--json').out).file.enAttente, 1);
  });
});
