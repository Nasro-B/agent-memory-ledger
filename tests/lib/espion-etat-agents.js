'use strict';
// Préchargé par un banc (NODE_OPTIONS=--require) : note dans le fichier ESPION_ETAT_AGENTS chaque appel de `etatAgents` du
// Régulateur, pour prouver qu'une politique inerte ne lit jamais le ledger des agents (et qu'une politique active le lit).
const fs = require('node:fs');
const Module = require('node:module');

const originale = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = originale.apply(this, arguments);
  if (/regulateur-core\.js$/.test(String(id)) && !m.etatAgents.espionne) {
    const vraie = m.etatAgents;
    m.etatAgents = function () {
      fs.appendFileSync(process.env.ESPION_ETAT_AGENTS, 'appel\n');
      return vraie.apply(this, arguments);
    };
    m.etatAgents.espionne = true;
  }
  return m;
};
