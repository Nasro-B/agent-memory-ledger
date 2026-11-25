'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliserRegles, modelePourSpawn, validerModele, validerType } = require('../scripts/lib/modeles-agents-logique.mjs');

const spawn = (extra = {}) => ({ subagentType: 'Explore', fork: false, ...extra });

test('absence de regles et defaut nul laissent le modele natif', () => {
  assert.deepEqual(normaliserRegles(null), { defaut: null, parType: {} });
  assert.equal(modelePourSpawn(spawn(), normaliserRegles(null)), null);
});

test('le defaut, le type exact et heritage ont la bonne priorite', () => {
  const regles = normaliserRegles({ defaut: 'sonnet', parType: { Explore: 'haiku', 'general-purpose': null } });
  assert.equal(modelePourSpawn(spawn(), regles), 'haiku');
  assert.equal(modelePourSpawn(spawn({ subagentType: 'autre' }), regles), 'sonnet');
  assert.equal(modelePourSpawn(spawn({ subagentType: 'general-purpose' }), regles), null);
  assert.equal(modelePourSpawn(spawn({ model: 'opus' }), regles), null);
});

test('fork, workflow et equipe ne sont jamais reecrits', () => {
  const regles = normaliserRegles({ defaut: 'sonnet' });
  assert.equal(modelePourSpawn(spawn({ fork: true }), regles), null);
  assert.equal(modelePourSpawn(spawn({ workflow: { runId: 'wf_1', agentIndex: 1 } }), regles), null);
  assert.equal(modelePourSpawn(spawn({ isTeammate: true }), regles), null);
});

test('une regle corrompue ne donne aucun modele', () => {
  assert.equal(normaliserRegles({ defaut: 'sonnet', parType: { Explore: 'mauvais modele' } }), null);
  assert.equal(modelePourSpawn(spawn(), normaliserRegles({ defaut: 'sonnet', parType: { Explore: 'mauvais modele' } })), null);
  assert.equal(validerModele('a'.repeat(129)), false);
  assert.equal(validerModele('haiku\n'), false);
  assert.equal(validerType('x'.repeat(81)), false);
});
