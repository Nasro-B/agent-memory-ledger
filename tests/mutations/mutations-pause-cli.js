'use strict';
// Preuve par mutation des commandes `cockpit.js pause`, `reprendre` et `pause-hook` (scripts/cockpit.js), par le banc pause-core.test.js (suite « ligne de commande »).
//   node tests/mutations/mutations-pause-cli.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-pause-cli.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-pause-cli.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutation équivalente écartée : `(choix.valeur ?? '')` devenu `choix.valeur` : une option --session sans valeur donne alors une référence
// absente au lieu d'une référence vide, et les deux disent la même chose (« Aucune session désignée »).
// Les autres commandes de cockpit.js sont mutées par leurs propres scripts.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const m = (nom, de, vers) => ({ nom: `pcli-${nom}`, suite: 'ligne de commande', de, vers });
const SUITE_PAUSE = "{ sessionRef: choix.present ? (choix.valeur ?? '') : undefined });\n      if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n`);";

const MUTATIONS = [
  // pause et reprendre
  m('pause-absente', "    case 'pause':\n    case 'reprendre': {", "    case 'pauses':\n    case 'reprendre': {"),
  m('reprendre-absente', "    case 'pause':\n    case 'reprendre': {", "    case 'pause':\n    case 'reprendres': {"),
  m('option-session', "extraireOption(options, '--session');\n      const r = pauseCore", "extraireOption(options, '--sessions');\n      const r = pauseCore"),
  m('mots', "choix.mots.join(' '), { sessionRef", "choix.mots.join(''), { sessionRef"),
  m('mots-perdus', "choix.mots.join(' '), { sessionRef", "options.join(' '), { sessionRef"),
  m('sens', 'pauseCore.appliquerCommande(commande,', "pauseCore.appliquerCommande('pause',"),
  m('ref-toujours', "choix.present ? (choix.valeur ?? '') : undefined", "choix.valeur ?? ''"),
  m('ref-jamais', "choix.present ? (choix.valeur ?? '') : undefined", 'undefined'),
  m('ref-valeur', "choix.present ? (choix.valeur ?? '') : undefined", "choix.present ? (choix.mots[0] ?? '') : undefined"),
  m('erreur-sortie', SUITE_PAUSE, SUITE_PAUSE.replace('process.stderr.write(`${r.erreur}', 'process.stdout.write(`${r.erreur}')),
  m('erreur-code', SUITE_PAUSE, SUITE_PAUSE.replace('process.exitCode = 2;', 'process.exitCode = 1;')),
  m('erreur-sans-code', SUITE_PAUSE, SUITE_PAUSE.replace('process.exitCode = 2;', '')),
  m('message-sortie', SUITE_PAUSE, SUITE_PAUSE.replace('else process.stdout.write(`${r.message}', 'else process.stderr.write(`${r.message}')),
  m('message-ligne', SUITE_PAUSE, SUITE_PAUSE.replace('else process.stdout.write(`${r.message}\\n`)', 'else process.stdout.write(`${r.message}`)')),
  m('erreur-ligne', SUITE_PAUSE, SUITE_PAUSE.replace('process.stderr.write(`${r.erreur}\\n`)', 'process.stderr.write(`${r.erreur}`)')),
  m('erreur-inversee', SUITE_PAUSE, SUITE_PAUSE.replace('if (r.erreur)', 'if (!r.erreur)')),

  // pause-hook
  m('hook-absent', "    case 'pause-hook': {", "    case 'pause-hooks': {"),
  m('hook-lecture', "entree = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { entree = undefined; }\n      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : await pauseCore", "entree = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { entree = {}; }\n      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : await pauseCore"),
  m('hook-illisible', "entree === undefined ? { erreur: 'entrée illisible' } : await pauseCore", "entree === undefined ? {} : await pauseCore"),
  m('hook-illisible-texte', "{ erreur: 'entrée illisible' } : await pauseCore", "{ erreur: 'illisible' } : await pauseCore"),
  m('hook-illisible-test', "entree === undefined ? { erreur: 'entrée illisible' } : await pauseCore", "false ? { erreur: 'entrée illisible' } : await pauseCore"),
  m('hook-operation', 'await pauseCore.executerHook(options[0], entree)', 'await pauseCore.executerHook(options[1], entree)'),
  m('hook-await', 'await pauseCore.executerHook(options[0], entree)', 'pauseCore.executerHook(options[0], entree)'),
  m('hook-json', 'process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: \'entrée illisible\' } : await pauseCore', 'process.stdout.write(`${String(entree === undefined ? { erreur: \'entrée illisible\' } : await pauseCore'),
  m('hook-ligne', 'pauseCore.executerHook(options[0], entree))}\\n`);', 'pauseCore.executerHook(options[0], entree))}`);'),

  // usage
  m('usage-pause', 'nuit, nuit-hook, pause, reprendre, pause-hook)', 'nuit, nuit-hook, reprendre, pause-hook)'),
  m('usage-reprendre', 'nuit, nuit-hook, pause, reprendre, pause-hook)', 'nuit, nuit-hook, pause, pause-hook)'),
  m('usage-pause-hook', 'nuit, nuit-hook, pause, reprendre, pause-hook)', 'nuit, nuit-hook, pause, reprendre)'),
];

executer({
  source: path.join(SCRIPTS, 'cockpit.js'),
  banc: path.join(__dirname, '..', 'pause-core.test.js'),
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
