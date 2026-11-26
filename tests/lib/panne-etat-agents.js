'use strict';
// Préchargé par un banc (NODE_OPTIONS=--require) : fait lever `etatAgents` du Régulateur dans le processus du hook, pour
// prouver qu'une panne interne reste silencieuse (sortie vide, code 0) au lieu de bloquer ou de bruiter.
const Module = require('node:module');

const originale = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = originale.apply(this, arguments);
  if (/regulateur-core\.js$/.test(String(id))) m.etatAgents = () => { throw new Error('panne simulee de etatAgents'); };
  return m;
};
