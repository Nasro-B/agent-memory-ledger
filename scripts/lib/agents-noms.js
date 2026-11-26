'use strict';
// Le nom d'un agent dans les états du Cockpit : une seule fonction, partagée par tous les noyaux.
//
// Les agents que le dépôt connaît (config.js : claude, codex, deepseek_H) peuvent avoir des majuscules et des tirets bas ; la liste de
// travail les nomme ainsi (<projet>.<agent>.json). Mais la file d'attente du Régulateur, la boîte de la Nuit et les fichiers
// quota-<agent>.json n'acceptent que des clés : minuscules, chiffres et tirets, une lettre en tête, 32 caractères au plus. Un nom du
// dépôt qui n'a pas cette forme est donc converti à l'entrée de chaque noyau : deepseek_H devient deepseek-h.
//
//   cleAgent(nom)    la clé d'état de l'agent, ou null quand le nom n'est ni un agent du dépôt ni déjà une clé valide
//   nomsListe(nom)   les noms sous lesquels la liste de travail connaît l'agent de cette clé : la clé, et chaque agent du dépôt qui la porte
//
// Un nom libre qui n'a pas la forme d'une clé reste refusé (Claude, deepseek_h, « ../x ») : aucun nom ne construit un chemin sans passer ici.

const { AGENTS } = require('./config.js');

const FORME_CLE = /^[a-z][a-z0-9-]{0,31}$/;

function cleAgent(nom) {
  if (typeof nom !== 'string') return null;
  const cle = AGENTS.includes(nom) ? nom.toLowerCase().replace(/_/g, '-') : nom;
  return FORME_CLE.test(cle) ? cle : null;
}

function nomsListe(nom) {
  const cle = cleAgent(nom);
  if (cle === null) return [];
  return [...new Set([cle, ...AGENTS.filter(a => cleAgent(a) === cle)])];
}

module.exports = { FORME_CLE, cleAgent, nomsListe };
