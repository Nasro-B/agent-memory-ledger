'use strict';
// Preuve par mutation des commandes `cockpit.js nuit` et `cockpit.js nuit-hook` (scripts/cockpit.js), par le banc nuit-core.test.js (suite « ligne de commande »).
//   node tests/mutations/mutations-nuit-cli.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-nuit-cli.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-nuit-cli.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutation équivalente écartée : `lastIndexOf` au lieu de `indexOf` dans extraireOption (chaque option n'apparaît qu'une fois).
// Les autres commandes de cockpit.js sont mutées par leurs propres scripts.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const m = (nom, de, vers) => ({ nom: `ncli-${nom}`, suite: 'ligne de commande', de, vers });

const MUTATIONS = [
  // extraireOption
  m('option-absente-en-tete', 'if (i < 0) return { present: false', 'if (i <= 0) return { present: false'),
  m('option-absente', 'if (i < 0) return { present: false, valeur: undefined, mots };', 'if (i < 0) return { present: true, valeur: undefined, mots };'),
  m('option-presente', 'return { present: true, valeur: mots[i + 1],', 'return { present: false, valeur: mots[i + 1],'),
  m('option-valeur', 'return { present: true, valeur: mots[i + 1],', 'return { present: true, valeur: mots[i],'),
  m('option-valeur-gardee', 'mots: [...mots.slice(0, i), ...mots.slice(i + 2)] };', 'mots: [...mots.slice(0, i), ...mots.slice(i + 1)] };'),
  m('option-debut-perdu', 'mots: [...mots.slice(0, i), ...mots.slice(i + 2)] };', 'mots: [...mots.slice(i + 2)] };'),
  m('option-fin-perdue', 'mots: [...mots.slice(0, i), ...mots.slice(i + 2)] };', 'mots: [...mots.slice(0, i)] };'),

  // nuit
  m('nuit-commande-absente', "    case 'nuit': {", "    case 'nuits': {"),
  m('nuit-option-agent', "extraireOption(options, '--agent')", "extraireOption(options, '--agents')"),
  m('nuit-option-session', "extraireOption(choixAgent.mots, '--session')", "extraireOption(choixAgent.mots, '--sessions')"),
  m('nuit-session-apres-agent', "extraireOption(choixAgent.mots, '--session')", "extraireOption(options, '--session')"),
  m('nuit-agent-defaut', "choixAgent.present ? choixAgent.valeur : 'claude'", "choixAgent.present ? choixAgent.valeur : 'codex'"),
  m('nuit-agent-sans-valeur', "choixAgent.present ? choixAgent.valeur : 'claude'", "choixAgent.valeur || 'claude'"),
  m('nuit-agent-invalide', 'if (!nuit.agentValide(agent)) {', 'if (false) {'),
  m('nuit-agent-invalide-sens', 'if (!nuit.agentValide(agent)) {', 'if (nuit.agentValide(agent)) {'),
  m('nuit-agent-invalide-texte', "`Agent invalide : ${agent === undefined ? '(aucun)' : agent}\\n`", '`Agent invalide\\n`'),
  m('nuit-agent-invalide-aucun', "agent === undefined ? '(aucun)' : agent", "agent === undefined ? '' : agent"),
  m('nuit-agent-invalide-code', 'process.exitCode = 2; break; }\n      const r = nuit.appliquerCommande', 'process.exitCode = 1; break; }\n      const r = nuit.appliquerCommande'),
  m('nuit-agent-invalide-suite', 'process.exitCode = 2; break; }\n      const r = nuit.appliquerCommande', 'process.exitCode = 2; }\n      const r = nuit.appliquerCommande'),
  m('nuit-agent-invalide-sortie', "process.stderr.write(`Agent invalide : ", "process.stdout.write(`Agent invalide : "),
  m('nuit-mots', "nuit.appliquerCommande(choixSession.mots.join(' '),", "nuit.appliquerCommande(choixSession.mots.join(''),"),
  m('nuit-mots-perdus', "nuit.appliquerCommande(choixSession.mots.join(' '),", "nuit.appliquerCommande(choixAgent.mots.join(' '),"),
  m('nuit-mots-options', "nuit.appliquerCommande(choixSession.mots.join(' '),", "nuit.appliquerCommande(options.join(' '),"),
  m('nuit-agent-transmis', '{ agent, session: choixSession.valeur });', "{ agent: 'claude', session: choixSession.valeur });"),
  m('nuit-session-transmise', '{ agent, session: choixSession.valeur });', '{ agent });'),
  m('nuit-session-agent', '{ agent, session: choixSession.valeur });', '{ agent, session: choixAgent.valeur });'),
  m('nuit-erreur-sortie', "if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n${r.prompt", "if (r.erreur) { process.stdout.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n${r.prompt"),
  m('nuit-erreur-code', "if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n${r.prompt", "if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 0; } else process.stdout.write(`${r.message}\\n${r.prompt"),
  m('nuit-erreur-ignoree', "if (r.erreur) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n${r.prompt", "if (false) { process.stderr.write(`${r.erreur}\\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\\n${r.prompt"),
  m('nuit-message-perdu', '`${r.message}\\n${r.prompt === undefined', '`${r.prompt === undefined'),
  m('nuit-prompt-perdu', "${r.prompt === undefined ? '' : `Texte à donner à l'agent : ${r.prompt}\\n`}`", "${''}`"),
  m('nuit-prompt-toujours', "${r.prompt === undefined ? '' : `Texte à donner à l'agent : ${r.prompt}\\n`}`", "Texte à donner à l'agent : ${r.prompt}\\n`"),
  m('nuit-prompt-texte', "`Texte à donner à l'agent : ${r.prompt}\\n`", '`${r.prompt}\\n`'),
  m('nuit-prompt-valeur', "`Texte à donner à l'agent : ${r.prompt}\\n`", "`Texte à donner à l'agent : ${r.message}\\n`"),

  // nuit-hook
  m('hook-commande-absente', "    case 'nuit-hook': {", "    case 'nuit-hooks': {"),
  // Le bloc de pause-hook lui ressemble ligne pour ligne : chaque ancre embarque ce qui est propre à nuit-hook.
  m('hook-entree', "case 'nuit-hook': {\n      let entree;\n      try { entree = JSON.parse(fs.readFileSync(0, 'utf8'));", "case 'nuit-hook': {\n      let entree;\n      try { entree = undefined;"),
  m('hook-entree-vide', "} catch (_) { entree = undefined; }\n      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : nuit.", "} catch (_) { entree = {}; }\n      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : nuit."),
  m('hook-entree-erreur', "} catch (_) { entree = undefined; }\n      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : nuit.", "} catch (_) { throw _; }\n      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : nuit."),
  m('hook-illisible', "{ erreur: 'entrée illisible' } : nuit.", "{ erreur: 'illisible' } : nuit."),
  m('hook-illisible-test', "entree === undefined ? { erreur: 'entrée illisible' } : nuit.", "entree === null ? { erreur: 'entrée illisible' } : nuit."),
  m('hook-operation', 'nuit.executerHook(options[0], entree)', 'nuit.executerHook(options[1], entree)'),
  m('hook-operation-perdue', 'nuit.executerHook(options[0], entree)', 'nuit.executerHook(undefined, entree)'),
  m('hook-entree-transmise', 'nuit.executerHook(options[0], entree)', 'nuit.executerHook(options[0], {})'),
  m('hook-json', 'process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: \'entrée illisible\' } : nuit.', 'process.stdout.write(`${String(entree === undefined ? { erreur: \'entrée illisible\' } : nuit.'),
  m('hook-ligne', "nuit.executerHook(options[0], entree))}\\n`);", 'nuit.executerHook(options[0], entree))}`);'),

  // usage
  m('usage-nuit', 'consignes, nuit, nuit-hook, pause, reprendre, pause-hook)', 'consignes, nuit-hook, pause, reprendre, pause-hook)'),
  m('usage-nuit-hook', 'consignes, nuit, nuit-hook, pause, reprendre, pause-hook)', 'consignes, nuit, pause, reprendre, pause-hook)'),
];

executer({
  source: path.join(SCRIPTS, 'cockpit.js'),
  banc: path.join(__dirname, '..', 'nuit-core.test.js'),
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
    // cockpit.js charge aussi le noyau des modèles par agent.
    ["require('./lib/modeles-agents-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'modeles-agents-core.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
