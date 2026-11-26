'use strict';
// Preuve par mutation de la commande `cockpit.js quota` (scripts/cockpit.js), par le banc quota-core.test.js (suite « ligne de commande »).
//   node tests/mutations/mutations-quota-cli.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-quota-cli.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-quota-cli.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Les autres commandes de cockpit.js (ligne, instantane, rafraichir-git, politique) sont mutées par leurs propres scripts.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

const MUTATIONS = [
  { nom: 'quota-cli-arguments-perdus', suite: 'ligne de commande', de: "quota.appliquerCommande(options.join(' '))", vers: "quota.appliquerCommande('')" },
  { nom: 'quota-cli-code-erreur', suite: 'ligne de commande', de: "const r = quota.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; }", vers: "const r = quota.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 1; }" },
  { nom: 'quota-cli-erreur-sur-stdout', suite: 'ligne de commande', de: "const r = quota.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stderr.write(", vers: "const r = quota.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stdout.write(" },
  { nom: 'quota-cli-message-perdu', suite: 'ligne de commande', de: "const r = quota.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n`);", vers: "const r = quota.appliquerCommande(options.join(' '));\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write('');" },
  { nom: 'quota-cli-commande-absente', suite: 'ligne de commande', de: "    case 'quota': {", vers: "    case 'quotas': {" },
];

executer({
  source: path.join(SCRIPTS, 'cockpit.js'),
  banc: path.join(__dirname, '..', 'quota-core.test.js'),
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
  concurrence: 4,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
