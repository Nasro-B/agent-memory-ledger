'use strict';
// Préchargé par un banc (NODE_OPTIONS=--require) : fait lever la réservation d'une demande de la file et son acquittement
// (`reserverReconnue`, `acquitter`) dans le processus du hook, pour prouver qu'une panne de la file ne bloque jamais un lancement autorisé.
const Module = require('node:module');

const originale = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = originale.apply(this, arguments);
  if (/regulateur-core\.js$/.test(String(id))) {
    for (const nom of ['reserverReconnue', 'acquitter']) m[nom] = () => { throw new Error(`panne simulee de ${nom}`); };
  }
  return m;
};
