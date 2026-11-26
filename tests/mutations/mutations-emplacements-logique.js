'use strict';
// Preuve par mutation du banc emplacements-logique.test.js (où un module d'interface trouve l'état du Cockpit et les scripts du plugin : scripts/lib/emplacements-logique.mjs).
//   node tests/mutations/mutations-emplacements-logique.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-emplacements-logique.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-emplacements-logique.js --liste         affiche les noms
//   node tests/mutations/mutations-emplacements-logique.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const m = (nom, de, vers) => ({ nom: `emp-${nom}`, suite: '.', de, vers });
const FIN = String.raw`chemin.replace(/[\\/]+$/, '')`;
const WINDOWS = String.raw`return /^[A-Za-z]:|^\\\\/.test(String($.plugin.root));`;
const UTILISATEUR = "const utilisateur = sousWindows($) ? (chaineNonVide(profil) ? profil : dossier) : (chaineNonVide(dossier) ? dossier : profil);";
const SCRIPT_EXPLICITE = "if (chaineNonVide(explicite)) return `${sansFin(explicite.trim())}/scripts/${nom}`;";
const SCRIPT_DEPOT = "if (parent !== '' && await existe($, `${parent}/scripts/${nom}`)) return `${parent}/scripts/${nom}`;";
const SCRIPT_VERSION = "if (await existe($, `${installe}/${version}/scripts/${nom}`)) return `${installe}/${version}/scripts/${nom}`;";
const LISTE = 'try { entrees = await $.fs.list(installe); } catch (_) { entrees = []; }';

const MUTATIONS = [
  // les valeurs lues
  m('vide-accepte', "typeof v === 'string' && v.trim() !== '';", "typeof v === 'string' && v !== '';"),
  m('type-non-verifie', "const chaineNonVide = v => typeof v === 'string' && v.trim() !== '';", "const chaineNonVide = v => v.trim() !== '';"),
  m('fin-garde', FIN, 'chemin'),
  m('fin-un-seul-separateur', FIN, String.raw`chemin.replace(/[\\/]$/, '')`),
  m('lecture-panne-propagee', 'try { return await lecture(); } catch (_) { return undefined; }', 'return await lecture();'),
  m('existe-panne-propagee', 'try { return (await $.fs.exists(chemin)) === true; } catch (_) { return false; }', 'return (await $.fs.exists(chemin)) === true;'),
  m('existe-non-strict', '(await $.fs.exists(chemin)) === true', '(await $.fs.exists(chemin)) !== undefined'),
  // la plateforme
  m('windows-sans-reseau', WINDOWS, String.raw`return /^[A-Za-z]:/.test(String($.plugin.root));`),
  m('windows-toujours', WINDOWS, 'return true;'),
  m('windows-jamais', WINDOWS, 'return false;'),
  // le dossier d'état
  m('cockpit-dir-ignore', "const direct = await lire(() => $.env.get('COCKPIT_DIR'));", 'const direct = undefined;'),
  m('maison-ignoree', "const maison = await lire(() => $.env.get('AGENT_MEMORY_LEDGER_HOME'));", 'const maison = undefined;'),
  m('maison-non-rognee', '`${sansFin(maison.trim())}/cockpit`', '`${sansFin(maison)}/cockpit`'),
  m('maison-sous-dossier', '`${sansFin(maison.trim())}/cockpit`', '`${sansFin(maison.trim())}/cockpit2`'),
  m('home-sous-dossier', '/.agent-memory-ledger/cockpit`', '/.agent-memory/cockpit`'),
  m('home-non-rogne', '`${sansFin(utilisateur.trim())}/.agent-memory-ledger/cockpit`', '`${sansFin(utilisateur)}/.agent-memory-ledger/cockpit`'),
  m('home-posix-sans-home', UTILISATEUR, UTILISATEUR.replace('(chaineNonVide(dossier) ? dossier : profil)', 'profil')),
  m('home-windows-sans-profil', UTILISATEUR, UTILISATEUR.replace('(chaineNonVide(profil) ? profil : dossier)', 'dossier')),
  m('home-windows-sans-repli', UTILISATEUR, UTILISATEUR.replace('(chaineNonVide(profil) ? profil : dossier)', 'profil')),
  m('home-posix-sans-repli', UTILISATEUR, UTILISATEUR.replace('(chaineNonVide(dossier) ? dossier : profil)', 'dossier')),
  m('home-inconnu-sans-erreur', "  if (!chaineNonVide(utilisateur)) throw new Error('dossier de l\\'utilisateur introuvable : poser COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME');\n", ''),
  m('home-inconnu-sans-cause', 'poser COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME', 'poser une variable'),
  // les versions
  m('versions-texte', '.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))', '.sort((a, b) => b.localeCompare(a))'),
  m('versions-ancienne-d-abord', 'b.localeCompare(a, undefined, { numeric: true })', 'a.localeCompare(b, undefined, { numeric: true })'),
  // le script du plugin
  m('script-explicite-ignore', SCRIPT_EXPLICITE, ''),
  m('script-explicite-sans-dossier-scripts', SCRIPT_EXPLICITE, SCRIPT_EXPLICITE.replace('/scripts/${nom}', '/${nom}')),
  m('script-depot-ignore', SCRIPT_DEPOT, ''),
  m('script-depot-sans-existence', SCRIPT_DEPOT, "if (parent !== '') return `${parent}/scripts/${nom}`;"),
  m('script-parent-un-niveau', "const parent = parties.slice(0, -2).join('/');", "const parent = parties.slice(0, -1).join('/');"),
  m('script-installe-nom', '`${parent}/agent-memory-ledger`', '`${parent}/aml`'),
  m('script-version-sans-existence', SCRIPT_VERSION, 'return `${installe}/${version}/scripts/${nom}`;'),
  m('script-liste-panne-propagee', LISTE, 'entrees = await $.fs.list(installe);'),
  m('script-entrees-non-filtrees', 'e && typeof e.name === \'string\'', 'true'),
  m('script-introuvable-sans-variable', 'poser AML_PLUGIN_DIR (le dossier du plugin', 'poser une variable (le dossier du plugin'),
  m('script-introuvable-sans-nom', '`${nom} introuvable : poser AML_PLUGIN_DIR', '`script introuvable : poser AML_PLUGIN_DIR'),
];

executer({
  source: path.join(__dirname, '..', '..', 'scripts', 'lib', 'emplacements-logique.mjs'),
  banc: path.join(__dirname, '..', 'emplacements-logique.test.js'),
  variable: 'EMPLACEMENTS_LOGIQUE_TESTE',
  mutations: MUTATIONS,
  argv: process.argv.slice(2),
  concurrence: 4,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
