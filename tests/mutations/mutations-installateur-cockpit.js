'use strict';
// Preuve par mutation du banc cockpit-installateur.test.js (branchement du Cockpit par l'installateur de Codex : option --cockpit).
//   node tests/mutations/mutations-installateur-cockpit.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-installateur-cockpit.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-installateur-cockpit.js --liste         affiche les noms
//   node tests/mutations/mutations-installateur-cockpit.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Les mutations visent l'option --cockpit ; les hooks de base, eux, sont prouvés par tests/memoire.test.js.
// Mutation équivalente écartée : traiter tous les composants au lieu de ceux qui ont quelque chose à faire (brancher et retirer ne font rien, et
// n'écrivent rien, sur un composant déjà dans l'état voulu : seul le compte dit change, et il est mesuré par `fin-ajout-nombre`).

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const RACINE = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(RACINE, 'scripts');
const m = (nom, suite, de, vers) => ({ nom: `inst-${nom}`, suite, de, vers });
const AGENT = 'agent';
const ECRITURE = 'ajout';
const RETRAIT = 'retirer';
const ERREUR = 'refusés';

const MUTATIONS = [
  // l'option
  m('option-ignoree', AGENT, "if (args.includes('--cockpit')) { installerCockpit(); return; }", ''),
  m('option-sans-sortie', AGENT, "if (args.includes('--cockpit')) { installerCockpit(); return; }", "if (args.includes('--cockpit')) { installerCockpit(); }"),
  // l'agent
  m('agent-defaut-autre', AGENT, "args.includes('--agent') ? valeur('--agent') : 'codex'", "args.includes('--agent') ? valeur('--agent') : 'deepseek_H'"),
  m('agent-ignore', AGENT, "const agent = args.includes('--agent') ? valeur('--agent') : 'codex';", "const agent = 'codex';"),
  m('agent-invalide-accepte', ERREUR, 'if (cleAgent(agent) === null) {', 'if (false) {'),
  m('agent-minuscules-seulement', AGENT, 'if (cleAgent(agent) === null) {', "if (!/^[a-z][a-z0-9-]{0,31}$/.test(agent)) {"),
  m('agent-invalide-code', ERREUR, "(attendu : codex ou deepseek_H). Rien n'est modifié.\\n`); process.exitCode = 2;", "(attendu : codex ou deepseek_H). Rien n'est modifié.\\n`); process.exitCode = 1;"),
  m('agent-invalide-muet', ERREUR, "process.stderr.write(`--agent invalide : ${JSON.stringify(agent)} (attendu : codex ou deepseek_H). Rien n'est modifié.\\n`); process.exitCode = 2; return;", 'process.exitCode = 2; return;'),
  m('agent-invalide-continue', ERREUR, "Rien n'est modifié.\\n`); process.exitCode = 2; return; }\n  const composant", "Rien n'est modifié.\\n`); process.exitCode = 2; }\n  const composant"),
  // le composant
  m('composant-inconnu-accepte', ERREUR, "args.includes('--composant') && !Object.prototype.hasOwnProperty.call(brancheur.COMPOSANTS, composant)", 'false'),
  m('composant-herite-accepte', ERREUR, '!Object.prototype.hasOwnProperty.call(brancheur.COMPOSANTS, composant)', '!(composant in brancheur.COMPOSANTS)'),
  m('composant-inconnu-code', ERREUR, 'process.exitCode = 2;\n    return;\n  }\n  const noms', 'process.exitCode = 1;\n    return;\n  }\n  const noms'),
  m('composant-inconnu-continue', ERREUR, 'process.exitCode = 2;\n    return;\n  }\n  const noms', 'process.exitCode = 2;\n  }\n  const noms'),
  m('composant-inconnu-liste-perdue', ERREUR, "(attendu : ${Object.keys(brancheur.COMPOSANTS).join(', ')})", '(attendu : aucun)'),
  m('composant-ignore', AGENT, "const noms = args.includes('--composant') ? [composant] : Object.keys(brancheur.COMPOSANTS);", 'const noms = Object.keys(brancheur.COMPOSANTS);'),
  m('composant-seul-toujours', ECRITURE, "const noms = args.includes('--composant') ? [composant] : Object.keys(brancheur.COMPOSANTS);", "const noms = [composant || 'cockpit'];"),
  // le fichier
  m('fichier-absent-accepte', ERREUR, 'if (!fs.existsSync(cible)) {', 'if (false) {'),
  m('fichier-absent-code', ERREUR, "(hooks de base), ou crée ce fichier. Rien n'est modifié.\\n`);\n    process.exitCode = 2;", "(hooks de base), ou crée ce fichier. Rien n'est modifié.\\n`);\n    process.exitCode = 1;"),
  m('fichier-absent-continue', ERREUR, "crée ce fichier. Rien n'est modifié.\\n`);\n    process.exitCode = 2;\n    return;", "crée ce fichier. Rien n'est modifié.\\n`);\n    process.exitCode = 2;"),
  m('fichier-illisible-code', ERREUR, "process.stderr.write(`${e.message}. Rien n'est modifié.\\n`);\n    process.exitCode = 2;", "process.stderr.write(`${e.message}. Rien n'est modifié.\\n`);\n    process.exitCode = 1;"),
  m('fichier-illisible-muet', ERREUR, "process.stderr.write(`${e.message}. Rien n'est modifié.\\n`);\n    process.exitCode = 2;", 'process.exitCode = 2;'),
  m('fichier-illisible-continue', ERREUR, "process.stderr.write(`${e.message}. Rien n'est modifié.\\n`);\n    process.exitCode = 2;\n    return;", "process.stderr.write(`${e.message}. Rien n'est modifié.\\n`);\n    process.exitCode = 2;"),
  // l'état de chaque composant
  m('etat-jamais-branche', ECRITURE, "etat.startsWith('branché : ') ? etat.slice('branché : '.length).split(', ') : []", '[]'),
  m('etat-toujours-branche', ECRITURE, "etat.startsWith('branché : ') ? etat.slice('branché : '.length).split(', ') : []", "etat.slice('branché : '.length).split(', ')"),
  m('etat-coupe-faux', ECRITURE, "etat.slice('branché : '.length).split(', ')", "etat.slice('branché : '.length).split(',')"),
  m('manquants-vides', ECRITURE, 'c.evenements.filter(e => !presents.includes(e))', '[]'),
  m('manquants-tous', ECRITURE, 'c.evenements.filter(e => !presents.includes(e))', 'c.evenements'),
  m('manquants-presents', ECRITURE, 'c.evenements.filter(e => !presents.includes(e))', 'c.evenements.filter(e => presents.includes(e))'),
  m('agent-verifie-fige', ECRITURE, 'brancheur.verifier(cible, agent, c)', "brancheur.verifier(cible, 'codex', c)"),
  m('fichier-verifie-autre', ECRITURE, 'brancheur.verifier(cible, agent, c)', "brancheur.verifier(cible + '.x', agent, c)"),
  // ce qui est dit
  m('entete-sans-agent', AGENT, 'Fichier : ${cible} (agent : ${agent})', 'Fichier : ${cible}'),
  m('a-faire-ajout-inverse', ECRITURE, '(retirer ? t.presents.length > 0 : t.manquants.length > 0)', 't.presents.length > 0'),
  m('a-faire-retrait-inverse', RETRAIT, '(retirer ? t.presents.length > 0 : t.manquants.length > 0)', 't.manquants.length > 0'),
  m('evenements-ajout-faux', ECRITURE, 'const evenements = retirer ? t.presents : t.manquants;', 'const evenements = t.presents;'),
  m('evenements-retrait-faux', RETRAIT, 'const evenements = retirer ? t.presents : t.manquants;', 'const evenements = t.manquants;'),
  m('etiquette-ajouter', ECRITURE, "(retirer ? 'à retirer' : 'à ajouter')", "(retirer ? 'à retirer' : 'à retirer')"),
  m('etiquette-retirer', RETRAIT, "(retirer ? 'à retirer' : 'à ajouter')", "(retirer ? 'à ajouter' : 'à ajouter')"),
  m('etiquette-deja', ECRITURE, "(retirer ? 'pas branché' : 'déjà en place')", "(retirer ? 'pas branché' : 'pas branché')"),
  m('etiquette-pas-branche', RETRAIT, "(retirer ? 'pas branché' : 'déjà en place')", "(retirer ? 'déjà en place' : 'déjà en place')"),
  m('liste-evenements-perdue', ECRITURE, '${evenements.length ? ` : ${evenements.join(\', \')}` : \'\'}', "${''}"),
  m('rien-a-faire-vide', ECRITURE, "if (!aFaire.length) { process.stdout.write(retirer ? 'Aucun composant du Cockpit à retirer.\\n' : 'Tous les composants du Cockpit sont déjà en place : rien à faire.\\n'); return; }", ''),
  m('rien-a-faire-continue', ECRITURE, "rien à faire.\\n'); return; }", "rien à faire.\\n'); }"),
  m('rien-a-retirer-message', RETRAIT, "retirer ? 'Aucun composant du Cockpit à retirer.\\n' :", "retirer ? 'Rien à faire.\\n' :"),
  m('rien-a-faire-message', ECRITURE, "'Tous les composants du Cockpit sont déjà en place : rien à faire.\\n'", "'Rien à faire.\\n'"),
  // l'écriture
  m('ecrit-sans-appliquer', AGENT, "if (!appliquer) { process.stdout.write(`\\nRien n'a été écrit. Relance avec --appliquer pour ${retirer ? 'retirer' : 'ajouter'} ${aFaire.length}", "if (false) { process.stdout.write(`\\nRien n'a été écrit. Relance avec --appliquer pour ${retirer ? 'retirer' : 'ajouter'} ${aFaire.length}"),
  m('ne-sort-pas-sans-appliquer', AGENT, "ajouter'} ${aFaire.length} composant(s).\\n`); return; }", "ajouter'} ${aFaire.length} composant(s).\\n`); }"),
  m('invitation-sans-nombre', AGENT, "${retirer ? 'retirer' : 'ajouter'} ${aFaire.length} composant(s).", "${retirer ? 'retirer' : 'ajouter'} les composants."),
  m('invitation-sans-verbe', AGENT, "pour ${retirer ? 'retirer' : 'ajouter'} ${aFaire.length}", "pour ajouter ${aFaire.length}"),
  m('retrait-inverse', RETRAIT, '(retirer ? brancheur.retirer : brancheur.brancher)', '(retirer ? brancheur.brancher : brancheur.retirer)'),
  m('retrait-jamais', RETRAIT, '(retirer ? brancheur.retirer : brancheur.brancher)', 'brancheur.brancher'),
  m('ajout-jamais', ECRITURE, '(retirer ? brancheur.retirer : brancheur.brancher)', 'brancheur.retirer'),
  m('agent-ecrit-fige', ECRITURE, '(cible, agent, t.c, t.nom)', "(cible, 'codex', t.c, t.nom)"),
  m('nom-ecrit-fige', ECRITURE, '(cible, agent, t.c, t.nom)', "(cible, agent, t.c, 'cockpit')"),
  m('panne-code', ECRITURE, 'process.stderr.write(`${e.message}\\n`);\n    process.exitCode = 1;', 'process.stderr.write(`${e.message}\\n`);\n    process.exitCode = 0;'),
  m('panne-muette', ECRITURE, 'process.stderr.write(`${e.message}\\n`);\n    process.exitCode = 1;', 'process.exitCode = 1;'),
  m('panne-continue', ECRITURE, 'process.stderr.write(`${e.message}\\n`);\n    process.exitCode = 1;\n    return;', 'process.stderr.write(`${e.message}\\n`);\n    process.exitCode = 1;'),
  m('fin-ajout-nombre', ECRITURE, '`${aFaire.length} composant(s) du Cockpit ajouté(s). Ouvre Codex', '`${noms.length} composant(s) du Cockpit ajouté(s). Ouvre Codex'),
  m('fin-ajout-sans-approbation', ECRITURE, "ajouté(s). Ouvre Codex et approuve les nouveaux hooks (écran des hooks) : tant qu'ils ne sont pas approuvés, Codex ne les exécute pas.", 'ajouté(s).'),
  m('fin-retrait-message', RETRAIT, '`${aFaire.length} composant(s) du Cockpit retiré(s).\\n`', "`${aFaire.length} composant(s) du Cockpit ajouté(s).\\n`"),
  m('fin-retrait-nombre', RETRAIT, '`${aFaire.length} composant(s) du Cockpit retiré(s).\\n`', '`${noms.length} composant(s) du Cockpit retiré(s).\\n`'),
];

executer({
  source: path.join(SCRIPTS, 'installer-codex.js'),
  banc: path.join(__dirname, '..', 'cockpit-installateur.test.js'),
  variable: 'INSTALLER_CODEX_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses chemins relatifs deviennent absolus.
  reecritures: [
    ["require('./lib/agents-noms.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'agents-noms.js'))})`],
    ["require('./codex/brancher.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'codex', 'brancher.js'))})`],
    ["path.resolve(__dirname, '..')", `${JSON.stringify(RACINE)}`],
    ["path.join(__dirname, '..', 'codex', 'hooks.modele.json')", `${JSON.stringify(path.join(RACINE, 'codex', 'hooks.modele.json'))}`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
