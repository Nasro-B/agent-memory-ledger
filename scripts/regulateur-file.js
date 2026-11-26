#!/usr/bin/env node
'use strict';
// regulateur-file.js : les opérations de la file d'attente du Régulateur en ligne de commande, pour un processus qui ne charge pas le noyau
// (par exemple un panneau d'interface). Un JSON en argument : { "operation": "<nom>", "args": [...] } ; la réponse est { "value": ... } sur la
// sortie standard, code 0. Opérations : mettreEnFile, purgerFile, retirerReconnue, viderFile, lireFile (celles de ./lib/regulateur-core.js,
// dont les écritures prennent le verrou de la file). Une opération inconnue, un argument qui n'est pas une liste ou une panne : le message va sur
// la sortie d'erreur, code 1.
const core = require('./lib/regulateur-core.js');
const operations = new Set(['mettreEnFile', 'purgerFile', 'retirerReconnue', 'viderFile', 'lireFile']);
try {
  const { operation, args } = JSON.parse(process.argv[2] || '{}');
  if (!operations.has(operation) || !Array.isArray(args)) throw new Error('operation de file invalide');
  process.stdout.write(JSON.stringify({ value: core[operation](...args) }));
} catch (e) { process.stderr.write(e.message); process.exitCode = 1; }
