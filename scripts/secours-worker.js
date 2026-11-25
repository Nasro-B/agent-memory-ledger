'use strict';
// Travailleur détaché de la copie de secours : lancé par un hook de la liste de travail (jamais à la main) avec le
// jeton du verrou que ce hook a réservé. Il recopie les journaux jalonnés dans le dossier de secours, qui peut
// être sur un disque lent, pour que le hook n'attende pas ce disque. Voir synchroniserSecours dans
// lib/context-ledger-core.js.

const core = require('./lib/context-ledger-core.js');
const token = process.argv[2];

if (!token || !/^[0-9a-f]{32}$/.test(token)) {
  process.exitCode = 1;
} else {
  try { core.traiterSecoursEnAttente(token); } catch (_) { process.exitCode = 1; }
}
