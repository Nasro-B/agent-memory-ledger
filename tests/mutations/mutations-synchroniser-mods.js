'use strict';
// Preuve par mutation du banc synchroniser-mods.test.js (outil de synchronisation des logiques communes).
//   node tests/mutations/mutations-synchroniser-mods.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-synchroniser-mods.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-synchroniser-mods.js --liste         affiche les noms
//   node tests/mutations/mutations-synchroniser-mods.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

const MUTATIONS = [
  { nom: 'synchro-copie-modifiee', suite: 'outil', de: 'fs.writeFileSync(cible, source);', vers: "fs.writeFileSync(cible, source.toString('utf8').trimEnd());" },
  { nom: 'synchro-verifier-ecrit', suite: 'outil', de: 'const identique = fs.readFileSync(cible).equals(source);', vers: 'fs.writeFileSync(cible, source); const identique = fs.readFileSync(cible).equals(source);' },
  { nom: 'synchro-toujours-identique', suite: 'outil', de: 'const identique = fs.readFileSync(cible).equals(source);', vers: 'const identique = true;' },
  { nom: 'synchro-absente-ignoree', suite: 'outil', de: "process.stdout.write(`${d} : copie absente\\n`); probleme = true; continue;", vers: "process.stdout.write(`${d} : copie absente\\n`); continue;" },
  { nom: 'synchro-difference-ignoree', suite: 'outil', de: 'if (!identique) probleme = true;', vers: '' },
  { nom: 'synchro-dossier-non-module-accepte', suite: 'outil', de: "if (!ok) return erreur(`${d} : pas un module (pas de dossier hooks)`);", vers: '' },
  { nom: 'synchro-aucun-dossier-accepte', suite: 'outil', de: "if (!dossiers.length) return erreur('au moins un dossier de module est requis');", vers: '' },
  { nom: 'synchro-message-identique', suite: 'outil', de: "copie ${identique ? 'identique' : 'différente'}", vers: "copie ${identique ? 'différente' : 'identique'}" },
  { nom: 'synchro-mauvais-nom-de-copie', suite: 'outil', de: "const NOM_DEFAUT = 'regulateur-logique.mjs';", vers: "const NOM_DEFAUT = 'logique.mjs';" },
  { nom: 'synchro-code-de-sortie', suite: 'outil', de: 'if (probleme) process.exitCode = 1;', vers: '' },
  // option --nom
  { nom: 'synchro-nom-ignore', suite: 'option --nom', de: 'const NOM = iNom >= 0 ? argv[iNom + 1] : NOM_DEFAUT;', vers: 'const NOM = NOM_DEFAUT;' },
  { nom: 'synchro-nom-valeur-prise-pour-dossier', suite: 'option --nom', de: '(i === iNom || i === iNom + 1)', vers: '(i === iNom)' },
  { nom: 'synchro-nom-sans-motif', suite: 'option --nom', de: "!/^[a-z][a-z0-9-]*-logique\\.mjs$/.test(NOM) || ", vers: '' },
  { nom: 'synchro-nom-inexistant-accepte', suite: 'option --nom', de: ' || !fs.existsSync(SOURCE)', vers: '' },
  { nom: 'synchro-nom-premier-dossier-perdu', suite: 'option --nom', de: '!(iNom >= 0 && (i === iNom', vers: '!(true && (i === iNom' },
  { nom: 'synchro-nom-erreur-muette', suite: 'option --nom', de: 'nom de logique invalide : ${JSON.stringify(NOM)}', vers: 'nom invalide' },
];

executer({
  source: path.join(SCRIPTS, 'synchroniser-mods.js'),
  banc: path.join(__dirname, '..', 'synchroniser-mods.test.js'),
  variable: 'SYNCHRONISER_MODS_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : la source de la logique y devient un chemin absolu.
  reecritures: [["path.join(__dirname, 'lib', String(NOM))", `path.join(${JSON.stringify(SCRIPTS)}, 'lib', String(NOM))`]],
  argv: process.argv.slice(2),
  concurrence: 4,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
