'use strict';
// Préchargé par un banc (NODE_OPTIONS=--require) : fait lever la lecture des consignes dans le processus du hook, pour prouver
// qu'une panne des Consignes en vigueur reste silencieuse (le bloc du Cockpit n'est pas perdu).
const Module = require('node:module');

const originale = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = originale.apply(this, arguments);
  if (/consignes-core\.js$/.test(String(id))) {
    for (const nom of ['texteInjection', 'lireEtat', 'lireFichier']) {
      m[nom] = () => { throw new Error(`panne simulee de ${nom}`); };
    }
  }
  return m;
};
