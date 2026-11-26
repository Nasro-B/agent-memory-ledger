'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/lib/modeles-agents-core.js');

const CLI = path.join(__dirname, '..', 'scripts', 'cockpit.js');
const run = () => fs.mkdtempSync(path.join(os.tmpdir(), 'modeles-agents-test-'));
const nettoyer = dir => {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('repertoire temporaire invalide');
  fs.rmSync(dir, { recursive: true, force: true });
};

test('le store garde les modeles separes de config.json', t => {
  const dir = run();
  t.after(() => nettoyer(dir));
  const fichier = path.join(dir, 'modeles-agents.json');
  assert.deepEqual(store.lireRegles(fichier).regles, { defaut: null, parType: {} });
  assert.equal(fs.existsSync(fichier), false);
  assert.equal(store.appliquerCommande(['defaut', 'sonnet'], fichier).erreur, undefined);
  assert.equal(store.appliquerCommande(['type', 'Explore', 'haiku'], fichier).erreur, undefined);
  assert.equal(store.appliquerCommande(['type', 'general-purpose', 'heritage'], fichier).erreur, undefined);
  assert.deepEqual(store.lireRegles(fichier).regles, { defaut: 'sonnet', parType: { Explore: 'haiku', 'general-purpose': null } });
  assert.equal(store.appliquerCommande(['retirer', 'Explore'], fichier).erreur, undefined);
  assert.equal(store.appliquerCommande(['defaut', 'heritage'], fichier).erreur, undefined);
  assert.deepEqual(store.lireRegles(fichier).regles, { defaut: null, parType: { 'general-purpose': null } });
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('les erreurs et un JSON corrompu ne modifient pas le fichier', t => {
  const dir = run();
  t.after(() => nettoyer(dir));
  const fichier = path.join(dir, 'modeles-agents.json');
  fs.writeFileSync(fichier, '{invalide');
  const avant = fs.readFileSync(fichier);
  assert.match(store.appliquerCommande(['defaut', 'opus'], fichier).erreur, /illisible/);
  assert.deepEqual(fs.readFileSync(fichier), avant);
  fs.writeFileSync(fichier, 'null');
  assert.match(store.appliquerCommande(['defaut', 'opus'], fichier).erreur, /invalide/);
  assert.equal(fs.readFileSync(fichier, 'utf8'), 'null');
  fs.writeFileSync(fichier, JSON.stringify({ defaut: 'haiku', parType: {} }));
  const valide = fs.readFileSync(fichier);
  assert.match(store.appliquerCommande(['type', 'Explore', 'modele avec espaces'], fichier).erreur, /invalide/);
  assert.deepEqual(fs.readFileSync(fichier), valide);
});

test('la commande CLI renvoie du JSON sans ecrire puis modifie le seul fichier de modeles', t => {
  const dir = run();
  t.after(() => nettoyer(dir));
  const appel = (...args) => spawnSync(process.execPath, [CLI, 'config', 'modeles', ...args], { env: { ...process.env, COCKPIT_DIR: dir }, encoding: 'utf8' });
  const lecture = appel('json');
  assert.equal(lecture.status, 0, lecture.stderr);
  assert.deepEqual(JSON.parse(lecture.stdout), { defaut: null, parType: {} });
  assert.equal(fs.existsSync(path.join(dir, 'modeles-agents.json')), false);
  const ecriture = appel('defaut', 'sonnet');
  assert.equal(ecriture.status, 0, ecriture.stderr);
  assert.equal(JSON.parse(appel('json').stdout).defaut, 'sonnet');
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});
