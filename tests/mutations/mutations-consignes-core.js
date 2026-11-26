'use strict';
// Preuve par mutation du banc consignes-core.test.js (entrées-sorties des Consignes en vigueur).
//   node tests/mutations/mutations-consignes-core.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-consignes-core.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-consignes-core.js --liste         affiche les noms
//   node tests/mutations/mutations-consignes-core.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib');
// BOM : l'échappement de la marque d'ordre des octets, écrit sans le caractère lui-même.
const BOM = `${String.fromCharCode(92)}uFEFF`;
const PARSE = `JSON.parse(brut.replace(/^${BOM}/, ''))`;
const TRY_ECRIRE = "try { ecrireEtat(r.etat); } catch (e) { return { erreur: `Écriture impossible dans ${fichier()} (${e && e.message ? e.message : String(e)}) : rien n'a changé.` }; }";

const MUTATIONS = [
  // lecture
  { nom: 'core-fichier-nom-faux', suite: 'lecture', de: "path.join(cockpit.racine(), 'consignes.json')", vers: "path.join(cockpit.racine(), 'consigne.json')" },
  { nom: 'core-lire-etat-defaut', suite: 'lecture', de: 'const lireEtat = () => lireFichier().etat;', vers: 'const lireEtat = () => logique.etatParDefaut();' },
  { nom: 'core-lire-fichier-vide', suite: 'lecture', de: 'const lireFichier = () => cockpit.lireConsignes();', vers: 'const lireFichier = () => ({ etat: logique.etatParDefaut(), illisible: false });' },
  { nom: 'core-lire-fichier-jamais-illisible', suite: 'lecture', de: 'const lireFichier = () => cockpit.lireConsignes();', vers: 'const lireFichier = () => ({ ...cockpit.lireConsignes(), illisible: false });' },
  // écriture
  { nom: 'core-ecrire-non-normalise', suite: 'écriture', de: '...logique.normaliserEtat(etat), maj', vers: '...etat, maj' },
  { nom: 'core-ecrire-sans-date', suite: 'écriture', de: ', maj: new Date().toISOString() }', vers: ' }' },
  { nom: 'core-ecrire-chemin-faux', suite: 'écriture', de: 'cockpit.ecrireJson(fichier(), {', vers: "cockpit.ecrireJson(fichier() + '.x', {" },
  // commande
  { nom: 'core-cmd-illisible-ignore', suite: 'commande', de: "  if (illisible) return { erreur: `${fichier()} est illisible : corrige-le ou supprime-le, puis recommence (rien n'a été écrit).` };\n", vers: '' },
  { nom: 'core-cmd-illisible-message', suite: 'commande', de: " est illisible : corrige-le ou supprime-le, puis recommence (rien n'a été écrit).", vers: ' est illisible.' },
  { nom: 'core-cmd-args-ignores', suite: 'commande', de: 'logique.analyserCommande(args, etat, valeurs())', vers: "logique.analyserCommande('', etat, valeurs())" },
  { nom: 'core-cmd-etat-ignore', suite: 'commande', de: 'logique.analyserCommande(args, etat, valeurs())', vers: 'logique.analyserCommande(args, logique.etatParDefaut(), valeurs())' },
  { nom: 'core-cmd-erreur-ignoree', suite: 'commande', de: '  if (r.erreur) return { erreur: r.erreur };\n', vers: '' },
  { nom: 'core-cmd-erreur-message', suite: 'commande', de: 'if (r.erreur) return { erreur: r.erreur };', vers: "if (r.erreur) return { erreur: 'erreur' };" },
  { nom: 'core-cmd-ecrit-toujours', suite: 'commande', de: 'if (JSON.stringify(r.etat) !== JSON.stringify(etat)) {', vers: 'if (true) {' },
  { nom: 'core-cmd-n-ecrit-jamais', suite: 'commande', de: 'if (JSON.stringify(r.etat) !== JSON.stringify(etat)) {', vers: 'if (false) {' },
  { nom: 'core-cmd-ecrit-ancien-etat', suite: 'commande', de: 'try { ecrireEtat(r.etat); }', vers: 'try { ecrireEtat(etat); }' },
  { nom: 'core-cmd-echec-propage', suite: 'commande', de: TRY_ECRIRE, vers: 'ecrireEtat(r.etat);' },
  { nom: 'core-cmd-echec-sans-cause', suite: 'commande', de: '(${e && e.message ? e.message : String(e)})', vers: '()' },
  { nom: 'core-cmd-echec-sans-chemin', suite: 'commande', de: '`Écriture impossible dans ${fichier()} (', vers: '`Écriture impossible (' },
  { nom: 'core-cmd-echec-message-court', suite: 'commande', de: ") : rien n'a changé.` }; }", vers: ').` }; }' },
  { nom: 'core-cmd-message-perdu', suite: 'commande', de: 'return { message: r.message, etat: r.etat };', vers: "return { message: '', etat: r.etat };" },
  { nom: 'core-cmd-etat-ancien', suite: 'commande', de: 'return { message: r.message, etat: r.etat };', vers: 'return { message: r.message, etat };' },
  { nom: 'core-cmd-etat-perdu', suite: 'commande', de: 'return { message: r.message, etat: r.etat };', vers: 'return { message: r.message };' },
  // décisions
  { nom: 'core-injection-etat-ignore', suite: 'décisions et injection', de: 'logique.texteInjection(lireEtat(), valeurs())', vers: 'logique.texteInjection(logique.etatParDefaut(), valeurs())' },
  { nom: 'core-statut-etat-ignore', suite: 'texte du statut', de: 'logique.texteStatut(lireEtat())', vers: 'logique.texteStatut(logique.etatParDefaut())' },
  { nom: 'core-decision-etat-ignore', suite: 'décisions et injection', de: 'logique.decisionCommande(lireEtat(), commande, valeurs())', vers: 'logique.decisionCommande(logique.etatParDefaut(), commande, valeurs())' },
  { nom: 'core-decision-commande-ignoree', suite: 'décisions et injection', de: 'logique.decisionCommande(lireEtat(), commande, valeurs())', vers: "logique.decisionCommande(lireEtat(), '', valeurs())" },
  { nom: 'core-agent-etat-ignore', suite: 'décisions et injection', de: 'logique.decisionAgent(lireEtat(), valeurs())', vers: 'logique.decisionAgent(logique.etatParDefaut(), valeurs())' },
  // jetons {worktrees} et {plans} : leurs valeurs viennent des réglages du Cockpit
  { nom: 'core-valeurs-config-ignoree', suite: 'jetons', de: 'reglages.valeursJetons(cockpit.lireConfig())', vers: 'reglages.valeursJetons(null)' },
  { nom: 'core-valeurs-cmd-perdues', suite: 'jetons', de: 'logique.analyserCommande(args, etat, valeurs())', vers: 'logique.analyserCommande(args, etat)' },
  { nom: 'core-valeurs-injection-perdues', suite: 'jetons', de: 'logique.texteInjection(lireEtat(), valeurs())', vers: 'logique.texteInjection(lireEtat())' },
  { nom: 'core-valeurs-decision-perdues', suite: 'jetons', de: 'logique.decisionCommande(lireEtat(), commande, valeurs())', vers: 'logique.decisionCommande(lireEtat(), commande)' },
  { nom: 'core-valeurs-agent-perdues', suite: 'jetons', de: 'logique.decisionAgent(lireEtat(), valeurs())', vers: 'logique.decisionAgent(lireEtat())' },
];

executer({
  source: path.join(LIB, 'consignes-core.js'),
  banc: path.join(__dirname, '..', 'consignes-core.test.js'),
  variable: 'CONSIGNES_CORE_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('./cockpit-core.js')", `require(${JSON.stringify(path.join(LIB, 'cockpit-core.js'))})`],
    ["require('./consignes-logique.mjs')", `require(${JSON.stringify(path.join(LIB, 'consignes-logique.mjs'))})`],
    ["require('./config-logique.mjs')", `require(${JSON.stringify(path.join(LIB, 'config-logique.mjs'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
