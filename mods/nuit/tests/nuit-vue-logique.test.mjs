import { test } from 'node:test'
import assert from 'node:assert/strict'

import { choisirEntree, commandeReponse, compteursBoite, filtrerBoite, normaliserTexteLibre, optionsEntrees } from '../hooks/nuit-vue-logique.mjs'

const entree = (id, statut = 'en-attente', type = 'question') => ({
  id, agent: 'claude', session: 'S1', type, ajoute: '2026-03-09T00:00:00.000Z',
  titre: `Question ${id}`, details: '', options: [{ label: 'Autoriser', description: '' }, { label: 'Refuser', description: '' }],
  statut, reponse: statut === 'repondue' ? 'Autoriser' : null, traite: statut === 'en-attente' ? null : '2026-03-09T01:00:00.000Z',
})

test('filtre et compte sans modifier les entrées', () => {
  const boite = { prochain: 5, entrees: [entree(3, 'ecartee'), entree(2), entree(1, 'repondue'), entree(4)] }
  const avant = JSON.stringify(boite)
  assert.deepEqual(compteursBoite(boite), { attente: 2, traitees: 2, total: 4 })
  assert.deepEqual(filtrerBoite(boite, 'attente').map(e => e.id), [2, 4])
  assert.deepEqual(filtrerBoite(boite, 'historique').map(e => e.id), [1, 3])
  assert.deepEqual(filtrerBoite(boite, 'toutes').map(e => e.id), [2, 4, 1, 3])
  assert.equal(JSON.stringify(boite), avant)
})

test('la sélection est conservée ou retombe sur la première entrée réelle', () => {
  const visibles = [entree(2), entree(5)]
  assert.equal(choisirEntree(visibles, 5)?.id, 5)
  assert.equal(choisirEntree(visibles, 8)?.id, 2)
  assert.equal(choisirEntree([], 5), null)
  assert.deepEqual(filtrerBoite({ entrees: [] }, 'attente'), [])
  assert.deepEqual(filtrerBoite({ entrees: [] }, 'historique'), [])
  assert.deepEqual(filtrerBoite({ entrees: [] }, 'toutes'), [])
})

test('cinquante entrées gardent cinquante choix, sans cinquante détails', () => {
  const boite = { entrees: Array.from({ length: 50 }, (_, i) => entree(i + 1)) }
  const visibles = filtrerBoite(boite, 'attente')
  assert.equal(visibles.length, 50)
  assert.equal(optionsEntrees(visibles).length, 50)
  assert.equal(choisirEntree(visibles, 50)?.id, 50)
  assert.ok(optionsEntrees(visibles).every(o => o.label.length <= 72))
})

test('question libre, action à option exacte et historique sans commande', () => {
  assert.deepEqual(commandeReponse(entree(1), null, ' réponse libre '), ['repondre', '1', 'réponse libre'])
  assert.deepEqual(commandeReponse(entree(1), 'Autoriser', ''), ['repondre', '1', 'Autoriser'])
  assert.deepEqual(commandeReponse(entree(2, 'en-attente', 'action'), 'Autoriser', 'texte libre'), ['repondre', '2', 'Autoriser'])
  assert.equal(commandeReponse(entree(2, 'en-attente', 'action'), null, 'Autoriser'), null)
  assert.equal(commandeReponse(entree(2, 'en-attente', 'action'), 'oui', ''), null)
  assert.equal(commandeReponse(entree(3, 'repondue'), 'Autoriser', ''), null)
  assert.equal(commandeReponse(null, 'Autoriser', ''), null)
  assert.deepEqual(normaliserTexteLibre(' x  y '), { valeur: 'x y', erreur: null })
  assert.ok(normaliserTexteLibre('x'.repeat(601)).erreur)
})
