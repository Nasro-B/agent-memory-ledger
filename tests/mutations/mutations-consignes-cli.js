'use strict';
// Preuve par mutation de la commande `cockpit.js consignes` (scripts/cockpit.js), par le banc consignes-core.test.js (suite « ligne de commande »).
//   node tests/mutations/mutations-consignes-cli.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-consignes-cli.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-consignes-cli.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Les autres commandes de cockpit.js (ligne, instantane, rafraichir-git, politique, quota) sont mutées par leurs propres scripts.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const APPEL = "const r = consignes.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n`);";

const MUTATIONS = [
  { nom: 'consignes-cli-arguments-perdus', suite: 'ligne de commande', de: "consignes.appliquerCommande(options.join(' '))", vers: "consignes.appliquerCommande('')" },
  { nom: 'consignes-cli-arguments-sans-espace', suite: 'ligne de commande', de: "consignes.appliquerCommande(options.join(' '))", vers: "consignes.appliquerCommande(options.join(''))" },
  { nom: 'consignes-cli-code-erreur', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('process.exitCode = 2;', 'process.exitCode = 0;') },
  { nom: 'consignes-cli-erreur-sur-stdout', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('process.stderr.write(`${r.erreur}', 'process.stdout.write(`${r.erreur}') },
  { nom: 'consignes-cli-message-perdu', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('else process.stdout.write(`${r.message}\\n`);', 'else process.stdout.write(``);') },
  { nom: 'consignes-cli-erreur-ignoree', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('if (r.erreur) {', 'if (false) {') },
  { nom: 'consignes-cli-commande-absente', suite: 'ligne de commande', de: "    case 'consignes': {", vers: "    case 'consigne': {" },
];

executer({
  source: path.join(SCRIPTS, 'cockpit.js'),
  banc: path.join(__dirname, '..', 'consignes-core.test.js'),
  variable: 'COCKPIT_CLI_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('./lib/cockpit-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'cockpit-core.js'))})`],
    ["require('./lib/regulateur-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'regulateur-core.js'))})`],
    ["require('./lib/quota-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'quota-core.js'))})`],
    ["require('./lib/consignes-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'consignes-core.js'))})`],
    ["require('./lib/nuit-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'nuit-core.js'))})`],
    ["require('./lib/pause-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'pause-core.js'))})`],
    ["require('./lib/modeles-agents-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'modeles-agents-core.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
