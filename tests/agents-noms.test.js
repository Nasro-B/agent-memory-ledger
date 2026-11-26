'use strict';
// Bancs de la conversion des noms d'agents (scripts/lib/agents-noms.js) : la file d'attente, la boîte de la Nuit et les fichiers
// quota-<agent>.json n'acceptent que des clés ; les noms d'agents du dépôt (scripts/lib/config.js) sont convertis par cette seule fonction.
// Lancement : node --test tests/agents-noms.test.js
// Variable interne (preuves par mutation) : AGENTS_NOMS_TESTE = module à tester (défaut : ../scripts/lib/agents-noms.js)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const noms = require(process.env.AGENTS_NOMS_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'agents-noms.js'));
const { AGENTS } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.js'));

test('chaque agent du dépôt a une clé valide : claude et codex inchangés, deepseek_H devient deepseek-h', () => {
  for (const agent of AGENTS) {
    const cle = noms.cleAgent(agent);
    assert.ok(cle !== null && noms.FORME_CLE.test(cle), agent);
  }
  assert.equal(noms.cleAgent('claude'), 'claude');
  assert.equal(noms.cleAgent('codex'), 'codex');
  assert.equal(noms.cleAgent('deepseek_H'), 'deepseek-h');
});

test('une clé déjà valide est gardée telle quelle, même pour un agent que le dépôt ne connaît pas', () => {
  for (const cle of ['deepseek-h', 'autre-agent', 'a', 'x1-y2', 'a'.repeat(32)]) assert.equal(noms.cleAgent(cle), cle, cle);
});

test('un nom qui n est ni un agent du dépôt ni une clé reste refusé : aucun chemin ne se construit sur un nom libre', () => {
  for (const nom of ['Claude', 'CLAUDE', 'deepseek_h', 'Deepseek_H', 'deepseek_H ', ' claude', 'x y', '../x', 'a_b', '1abc', '-a', '', 'a'.repeat(33), 5, null, undefined, {}, ['claude'], true]) {
    assert.equal(noms.cleAgent(nom), null, JSON.stringify(nom));
  }
});

test('la clé a au plus 32 caractères, commence par une lettre minuscule, et ne contient que minuscules, chiffres et tirets', () => {
  assert.equal(noms.cleAgent('a'.repeat(32)), 'a'.repeat(32));
  assert.equal(noms.cleAgent('a'.repeat(33)), null);
  assert.equal(noms.cleAgent('z'), 'z');
  assert.equal(noms.cleAgent('Z'), null);
  assert.equal(noms.cleAgent('0'), null);
  assert.equal(noms.cleAgent('a-0-z'), 'a-0-z');
  assert.equal(noms.cleAgent('a.b'), null);
});

test('nomsListe donne la clé et les noms du dépôt qui la portent, sous la forme où la liste de travail les connaît', () => {
  assert.deepEqual(noms.nomsListe('deepseek_H'), ['deepseek-h', 'deepseek_H']);
  assert.deepEqual(noms.nomsListe('deepseek-h'), ['deepseek-h', 'deepseek_H']);
  assert.deepEqual(noms.nomsListe('claude'), ['claude']);
  assert.deepEqual(noms.nomsListe('autre-agent'), ['autre-agent']);
});

test('nomsListe ne rend rien pour un nom refusé, et jamais deux fois le même nom', () => {
  for (const nom of ['Claude', 'deepseek_h', '../x', '', 5, null, undefined]) assert.deepEqual(noms.nomsListe(nom), [], JSON.stringify(nom));
  for (const agent of AGENTS) {
    const liste = noms.nomsListe(agent);
    assert.equal(new Set(liste).size, liste.length, agent);
    assert.ok(liste.includes(agent), `${agent} est dans sa propre liste`);
  }
});
