'use strict';
// Préchargé par un banc (NODE_OPTIONS=--require) : fait lever la mesure du quota dans le processus du hook, pour prouver
// qu'une panne du Garde-quota reste silencieuse (le lancement n'est pas bloqué, le bloc du Cockpit n'est pas perdu).
const Module = require('node:module');

const originale = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = originale.apply(this, arguments);
  if (/quota-core\.js$/.test(String(id))) {
    for (const nom of ['decisionAgentCodex', 'fenetresCourantes', 'mesurerCodex', 'suivreCodex']) {
      m[nom] = () => { throw new Error(`panne simulee de ${nom}`); };
    }
  }
  return m;
};
