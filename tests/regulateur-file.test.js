'use strict';
// Bancs du point d'entrée en ligne de commande de la file du Régulateur : scripts/regulateur-file.js
// Lancement : node --test tests/regulateur-file.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variable interne (preuves par mutation) : REGULATEUR_FILE_TESTE = script à tester (défaut : ../scripts/regulateur-file.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const SCRIPT = process.env.REGULATEUR_FILE_TESTE || path.join(__dirname, '..', 'scripts', 'regulateur-file.js');
const regulateur = require(path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-core.js'));

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `regulateur-file-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
});

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const demande = (numero = 1) => ({ message: `Fais le travail ${numero}`, agent_type: 'default' });
const fichierFile = () => path.join(process.env.COCKPIT_DIR, 'file-agents.json');

// Le script, comme un processus qui ne charge pas le noyau l'appelle : un JSON en argument.
function lancer(operation, args, { brut } = {}) {
  const argument = brut === undefined ? JSON.stringify({ operation, args }) : brut;
  const r = spawnSync(process.execPath, [SCRIPT, ...(argument === null ? [] : [argument])], { encoding: 'utf8', env: { ...process.env }, timeout: 60000 });
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

describe('opérations de la file', () => {
  test('mettreEnFile écrit dans la file du noyau et rend la valeur du noyau, sur la sortie standard', () => {
    const r = lancer('mettreEnFile', [{ agent: 'codex', session: 'S1', description: 'travail 1', demande: demande(1), maintenant: T0 }]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(Object.keys(r.json), ['value']);
    assert.equal(r.json.value.position, 1);
    assert.equal(r.json.value.total, 1);
    const f = regulateur.lireFile();
    assert.deepEqual(f.entrees.map(e => [e.agent, e.session, e.statut, e.description]), [['codex', 'S1', 'en-attente', 'travail 1']]);
    assert.deepEqual(f.entrees[0].demande, demande(1));
  });

  test('un nom d agent du dépôt est converti en clé d état par le noyau', () => {
    lancer('mettreEnFile', [{ agent: 'deepseek_H', session: 'S1', description: 'x', demande: demande(1), maintenant: T0 }]);
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.agent), ['deepseek-h']);
    assert.equal(lancer('retirerReconnue', ['deepseek_H', 'S1', demande(1)]).json.value, true);
    assert.deepEqual(regulateur.lireFile().entrees, []);
  });

  test('retirerReconnue, viderFile et purgerFile rendent leur valeur et ne retirent que ce qui doit l être', () => {
    for (const numero of [1, 2, 3]) regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(numero), maintenant: T0 });
    regulateur.mettreEnFile({ agent: 'codex', session: 'S2', description: 'x', demande: demande(4), maintenant: T0 });
    assert.equal(lancer('retirerReconnue', ['codex', 'S1', demande(2)]).json.value, true);
    assert.equal(lancer('retirerReconnue', ['codex', 'S1', demande(2)]).json.value, false, 'déjà retirée');
    assert.equal(lancer('viderFile', ['codex', 'S2']).json.value, 1, 'seulement ce fil');
    assert.equal(lancer('purgerFile', [T0 + 60 * 1000]).json.value, 0, 'rien de plus de six heures');
    assert.equal(lancer('purgerFile', [T0 + 7 * 60 * 60 * 1000]).json.value, 2, 'les deux restantes ont plus de six heures');
    assert.deepEqual(regulateur.lireFile().entrees, []);
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(5), maintenant: T0 });
    assert.equal(lancer('viderFile', []).json.value, 1, 'sans portée : toute la file');
  });

  test('lireFile rend la file et n écrit rien', () => {
    const vide = lancer('lireFile', []);
    assert.equal(vide.status, 0, vide.stderr);
    assert.deepEqual(vide.json.value.entrees, []);
    assert.equal(fs.existsSync(fichierFile()), false, 'une lecture ne crée pas le fichier');
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: T0 });
    const avant = fs.readFileSync(fichierFile(), 'utf8');
    assert.equal(lancer('lireFile', []).json.value.entrees.length, 1);
    assert.equal(fs.readFileSync(fichierFile(), 'utf8'), avant);
  });
});

describe('refus', () => {
  const refuse = (r, motif) => {
    assert.equal(r.status, 1, `code de sortie : ${r.stdout}`);
    assert.equal(r.stdout, '', 'rien sur la sortie standard');
    assert.match(r.stderr, motif);
  };

  test('une opération qui n est pas de la liste est refusée, sans rien écrire', () => {
    for (const operation of ['ecrireFile', 'ordonner', 'appliquerCommande', 'constructor', '__proto__', 'toString', '', 5, null]) {
      refuse(lancer(operation, []), /operation de file invalide/);
    }
    assert.equal(fs.existsSync(fichierFile()), false);
  });

  test('des arguments qui ne sont pas une liste, ou une entrée qui n est pas du JSON, sont refusés', () => {
    for (const args of [undefined, null, 'x', 5, { a: 1 }]) refuse(lancer('viderFile', args), /operation de file invalide/);
    refuse(lancer('viderFile', [], { brut: 'pas du json' }), /JSON|Unexpected|token/i);
    refuse(lancer('viderFile', [], { brut: '{}' }), /operation de file invalide/);
    refuse(lancer('viderFile', [], { brut: null }), /operation de file invalide/);
  });

  test('une panne du noyau est dite sur la sortie d erreur, code 1, rien sur la sortie standard', () => {
    fs.mkdirSync(fichierFile(), { recursive: true }); // un dossier occupe la place du fichier : l écriture échoue
    const r = lancer('mettreEnFile', [{ agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: T0 }]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.notEqual(r.stderr, '');
  });
});
