'use strict';
// Preuve par mutation du banc regulateur-file.test.js (point d'entrée en ligne de commande de la file du Régulateur).
//   node tests/mutations/mutations-regulateur-file.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-regulateur-file.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-regulateur-file.js --liste         affiche les noms
//   node tests/mutations/mutations-regulateur-file.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const LISTE = "new Set(['mettreEnFile', 'purgerFile', 'retirerReconnue', 'viderFile', 'lireFile'])";
const SANS = nom => LISTE.replace(`'${nom}', `, '').replace(`, '${nom}'`, '');

const MUTATIONS = [
  // la liste des opérations permises
  { nom: 'file-operation-inconnue-acceptee', suite: 'refus', de: '!operations.has(operation) || ', vers: '' },
  { nom: 'file-operation-ajoutee', suite: 'refus', de: LISTE, vers: LISTE.replace("'lireFile'", "'lireFile', 'ecrireFile'") },
  { nom: 'file-operation-ordonner-ajoutee', suite: 'refus', de: LISTE, vers: LISTE.replace("'lireFile'", "'lireFile', 'ordonner'") },
  { nom: 'file-operation-mettre-retiree', suite: 'opérations', de: LISTE, vers: SANS('mettreEnFile') },
  { nom: 'file-operation-purger-retiree', suite: 'opérations', de: LISTE, vers: SANS('purgerFile') },
  { nom: 'file-operation-retirer-retiree', suite: 'opérations', de: LISTE, vers: SANS('retirerReconnue') },
  { nom: 'file-operation-vider-retiree', suite: 'opérations', de: LISTE, vers: SANS('viderFile') },
  { nom: 'file-operation-lire-retiree', suite: 'opérations', de: LISTE, vers: SANS('lireFile') },
  // les arguments
  { nom: 'file-args-non-liste-acceptes', suite: 'refus', de: ' || !Array.isArray(args)', vers: '' },
  { nom: 'file-args-perdus', suite: 'opérations', de: 'core[operation](...args)', vers: 'core[operation]()' },
  { nom: 'file-args-un-seul', suite: 'opérations', de: 'core[operation](...args)', vers: 'core[operation](args[0])' },
  { nom: 'file-argument-par-defaut', suite: 'refus', de: "JSON.parse(process.argv[2] || '{}')", vers: 'JSON.parse(process.argv[2])' },
  { nom: 'file-toujours-lire', suite: 'opérations', de: 'core[operation](...args)', vers: 'core.lireFile(...args)' },
  // la réponse
  { nom: 'file-valeur-perdue', suite: 'opérations', de: 'JSON.stringify({ value: core[operation](...args) })', vers: 'JSON.stringify({ value: null })' },
  { nom: 'file-cle-renommee', suite: 'opérations', de: 'JSON.stringify({ value: core[operation](...args) })', vers: 'JSON.stringify({ result: core[operation](...args) })' },
  { nom: 'file-valeur-hors-cle', suite: 'opérations', de: 'JSON.stringify({ value: core[operation](...args) })', vers: 'JSON.stringify(core[operation](...args))' },
  // les erreurs
  { nom: 'file-erreur-code-zero', suite: 'refus', de: 'process.stderr.write(e.message); process.exitCode = 1;', vers: 'process.stderr.write(e.message); process.exitCode = 0;' },
  { nom: 'file-erreur-muette', suite: 'refus', de: 'process.stderr.write(e.message); process.exitCode = 1;', vers: 'process.exitCode = 1;' },
  { nom: 'file-erreur-sur-la-sortie-standard', suite: 'refus', de: 'process.stderr.write(e.message); process.exitCode = 1;', vers: 'process.stdout.write(e.message); process.exitCode = 1;' },
  { nom: 'file-erreur-message-change', suite: 'refus', de: "new Error('operation de file invalide')", vers: "new Error('invalide')" },
];

executer({
  source: path.join(SCRIPTS, 'regulateur-file.js'),
  banc: path.join(__dirname, '..', 'regulateur-file.test.js'),
  variable: 'REGULATEUR_FILE_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : son require relatif devient absolu.
  reecritures: [
    ["require('./lib/regulateur-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'regulateur-core.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
