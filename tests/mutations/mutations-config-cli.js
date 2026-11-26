'use strict';
// Preuve par mutation de la commande `cockpit.js config` (scripts/cockpit.js), par le banc cockpit-core.test.js (suite « ligne de commande »).
//   node tests/mutations/mutations-config-cli.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-config-cli.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-config-cli.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Les autres commandes de cockpit.js ne sont pas mutées ici : ligne, instantane et rafraichir-git sont couvertes par des essais réels du banc
// (processus lancés), et les commandes des autres noyaux (politique, quota, consignes, nuit, pause) sont mutées par leurs propres scripts
// (mutations-<module>-cli.js). Le message d'usage de la commande inconnue liste toutes les commandes : cette mutation retire config de la liste.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const APPEL = "const r = options[0] === 'modeles' ? modelesAgents.appliquerCommande(options.slice(1)) : core.appliquerConfig(options.join(' '));\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n`);";

const MUTATIONS = [
  { nom: 'config-cli-arguments-perdus', suite: 'ligne de commande', de: "core.appliquerConfig(options.join(' '))", vers: "core.appliquerConfig('')" },
  { nom: 'config-cli-arguments-sans-espace', suite: 'ligne de commande', de: "core.appliquerConfig(options.join(' '))", vers: "core.appliquerConfig(options.join(''))" },
  { nom: 'config-cli-code-erreur', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('process.exitCode = 2;', 'process.exitCode = 0;') },
  { nom: 'config-cli-erreur-sur-stdout', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('process.stderr.write(`${r.erreur}', 'process.stdout.write(`${r.erreur}') },
  { nom: 'config-cli-message-perdu', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('else process.stdout.write(`${r.message}\\n`);', 'else process.stdout.write(``);') },
  { nom: 'config-cli-erreur-ignoree', suite: 'ligne de commande', de: APPEL, vers: APPEL.replace('if (r.erreur) {', 'if (false) {') },
  { nom: 'config-cli-commande-absente', suite: 'ligne de commande', de: "    case 'config': {", vers: "    case 'configs': {" },
  { nom: 'config-cli-usage-sans-config', suite: 'ligne de commande', de: 'quota, config, consignes', vers: 'quota, consignes' },
];

executer({
  source: path.join(SCRIPTS, 'cockpit.js'),
  banc: path.join(__dirname, '..', 'cockpit-core.test.js'),
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
