import test from 'node:test';
import assert from 'node:assert/strict';

import { modelePourSpawn, normaliserRegles } from '../hooks/modeles-agents-logique.mjs';
import { argumentsDeLancement, demandeDeLancement, mettreEnFile, prochaines } from '../hooks/file-logique.mjs';

test('une demande en file et sa relance gardent le modele resolu', () => {
  const e = { prompt: 'Verifier', description: 'Verifier le lot', subagentType: 'Explore', fork: false };
  const choisi = modelePourSpawn(e, normaliserRegles({ defaut: 'sonnet', parType: { Explore: 'haiku' } }));
  assert.equal(choisi, 'haiku');
  const demande = demandeDeLancement({ ...e, model: choisi });
  const r = mettreEnFile(null, { agent: 'claude', session: 'session-1', description: e.description, demande, maintenant: Date.UTC(2026, 9, 14) });
  assert.equal(r.refus, undefined);
  const prochaine = prochaines(r.etat, 'claude', 'session-1', 1, Date.UTC(2026, 9, 14))[0];
  assert.equal(argumentsDeLancement(prochaine.demande).model, 'haiku');
  assert.equal(modelePourSpawn(e, normaliserRegles({ defaut: 'opus' })), 'opus');
  assert.equal(argumentsDeLancement(prochaine.demande).model, 'haiku');
});
