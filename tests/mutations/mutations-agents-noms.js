'use strict';
// Preuve par mutation du banc agents-noms.test.js (conversion des noms d'agents : scripts/lib/agents-noms.js).
//   node tests/mutations/mutations-agents-noms.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-agents-noms.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-agents-noms.js --liste         affiche les noms
//   node tests/mutations/mutations-agents-noms.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib');
const m = (nom, de, vers) => ({ nom: `noms-${nom}`, suite: '.', de, vers });
const CONVERSION = "AGENTS.includes(nom) ? nom.toLowerCase().replace(/_/g, '-') : nom";

const MUTATIONS = [
  m('sans-conversion', CONVERSION, 'nom'),
  m('tout-converti', CONVERSION, "nom.toLowerCase().replace(/_/g, '-')"),
  m('sans-minuscules', CONVERSION, "AGENTS.includes(nom) ? nom.replace(/_/g, '-') : nom"),
  m('tiret-bas-garde', CONVERSION, 'AGENTS.includes(nom) ? nom.toLowerCase() : nom'),
  m('tiret-bas-en-espace', CONVERSION, "AGENTS.includes(nom) ? nom.toLowerCase().replace(/_/g, ' ') : nom"),
  m('forme-longueur-longue', '{0,31}', '{0,63}'),
  m('forme-longueur-courte', '{0,31}', '{0,30}'),
  m('forme-lettre-seule', '/^[a-z][a-z0-9-]{0,31}$/', '/^[a-z0-9][a-z0-9-]{0,31}$/'),
  m('forme-majuscules', '/^[a-z][a-z0-9-]{0,31}$/', '/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/'),
  m('forme-tiret-bas', '/^[a-z][a-z0-9-]{0,31}$/', '/^[a-z][a-z0-9_-]{0,31}$/'),
  m('forme-chiffres', '/^[a-z][a-z0-9-]{0,31}$/', '/^[a-z][a-z-]{0,31}$/'),
  m('forme-tirets', '/^[a-z][a-z0-9-]{0,31}$/', '/^[a-z][a-z0-9]{0,31}$/'),
  m('forme-debut', '/^[a-z][a-z0-9-]{0,31}$/', '/[a-z][a-z0-9-]{0,31}$/'),
  m('forme-fin', '/^[a-z][a-z0-9-]{0,31}$/', '/^[a-z][a-z0-9-]{0,31}/'),
  m('type-non-verifie', "  if (typeof nom !== 'string') return null;\n", ''),
  m('type-refus-total', "if (typeof nom !== 'string') return null;", 'if (true) return null;'),
  m('liste-invalide', '  if (cle === null) return [];\n', ''),
  m('liste-sans-cle', '[...new Set([cle, ...AGENTS.filter(a => cleAgent(a) === cle)])]', '[...new Set([...AGENTS.filter(a => cleAgent(a) === cle)])]'),
  m('liste-sans-agents', '[...new Set([cle, ...AGENTS.filter(a => cleAgent(a) === cle)])]', '[...new Set([cle])]'),
  m('liste-doublons', '[...new Set([cle, ...AGENTS.filter(a => cleAgent(a) === cle)])]', '[cle, ...AGENTS.filter(a => cleAgent(a) === cle)]'),
  m('liste-tous-les-agents', '[...new Set([cle, ...AGENTS.filter(a => cleAgent(a) === cle)])]', '[...new Set([cle, ...AGENTS])]'),
  m('liste-nom-donne', '[...new Set([cle, ...AGENTS.filter(a => cleAgent(a) === cle)])]', '[...new Set([nom, ...AGENTS.filter(a => cleAgent(a) === cle)])]'),
  m('non-exporte', 'module.exports = { FORME_CLE, cleAgent, nomsListe };', 'module.exports = { FORME_CLE, cleAgent };'),
];

executer({
  source: path.join(LIB, 'agents-noms.js'),
  banc: path.join(__dirname, '..', 'agents-noms.test.js'),
  variable: 'AGENTS_NOMS_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : son require relatif devient absolu.
  reecritures: [
    ["require('./config.js')", `require(${JSON.stringify(path.join(LIB, 'config.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
