'use strict';
// Preuve par mutation du banc cockpit-brancher.test.js (outil de branchement des composants dans les hooks Codex).
//   node tests/mutations/mutations-cockpit-brancher.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-cockpit-brancher.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-cockpit-brancher.js --liste         affiche les noms
// Mutation équivalente écartée : retirer la vérification de la clé `hooks` ne change aucun comportement observable
// (l'accès qui suit lève, l'outil sort en erreur sans rien écrire, comme avant).

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const CODEX = path.join(__dirname, '..', '..', 'scripts', 'codex');

const MUTATIONS = [
  { nom: 'brancher-un-seul-evenement', suite: 'brancher', de: "evenements: ['SessionStart', 'UserPromptSubmit', 'PostCompact']", vers: "evenements: ['SessionStart']" },
  { nom: 'brancher-sans-compactage', suite: 'brancher', de: "evenements: ['SessionStart', 'UserPromptSubmit', 'PostCompact']", vers: "evenements: ['SessionStart', 'UserPromptSubmit']" },
  { nom: 'brancher-sans-prompt', suite: 'brancher', de: "evenements: ['SessionStart', 'UserPromptSubmit', 'PostCompact']", vers: "evenements: ['SessionStart', 'PostCompact']" },
  { nom: 'brancher-sans-sauvegarde', suite: 'brancher', de: 'if (!fs.existsSync(sauvegarde)) fs.copyFileSync(fichier, sauvegarde);', vers: '' },
  { nom: 'brancher-sauvegarde-ecrasee', suite: 'brancher', de: 'if (!fs.existsSync(sauvegarde)) fs.copyFileSync(fichier, sauvegarde);', vers: 'fs.copyFileSync(fichier, sauvegarde);' },
  { nom: 'brancher-non-idempotent', suite: 'brancher', de: 'if (etat.objet.hooks[e].some(g => porteLeHook(g, c, agent))) continue;', vers: '' },
  { nom: 'brancher-bom-perdu', suite: 'brancher', de: 'return (bom ?', vers: 'return (false ?' },
  { nom: 'brancher-fin-de-ligne-perdue', suite: 'brancher', de: 'if (finDeLigne) texte += \'\\n\';', vers: '' },
  { nom: 'brancher-crlf-perdu', suite: 'brancher', de: "if (crlf) texte = texte.replace(/\\n/g, '\\r\\n');", vers: '' },
  { nom: 'brancher-script-faux', suite: 'brancher', de: "  cockpit: { script: 'cockpit.js'", vers: "  cockpit: { script: 'consignes.js'" },
  { nom: 'brancher-delai-faux', suite: 'brancher', de: "matcher: null, timeout: 15, message: 'Cockpit : etat du travail'", vers: "matcher: null, timeout: 5, message: 'Cockpit : etat du travail'" },
  { nom: 'brancher-message-faux', suite: 'brancher', de: "message: 'Cockpit : etat du travail'", vers: "message: 'Cockpit'" },
  { nom: 'brancher-agent-invalide-accepte', suite: 'brancher', de: 'if (cleAgent(agent) === null) return erreur(', vers: 'if (false) return erreur(' },
  { nom: 'brancher-commande-sans-guillemets', suite: 'brancher', de: '`node "${DOSSIER}/${c.script}" --agent ${agent}`', vers: '`node ${DOSSIER}/${c.script} --agent ${agent}`' },
  { nom: 'brancher-agent-minuscules-seulement', suite: 'composant regulateur', de: 'if (cleAgent(agent) === null) return erreur(', vers: "if (!/^[a-z][a-z0-9-]{0,31}$/.test(agent)) return erreur(" },
  { nom: 'brancher-evenement-cree-vide', suite: 'brancher', de: 'if (etat.objet.hooks[e] === undefined) etat.objet.hooks[e] = [];', vers: 'if (etat.objet.hooks[e] === undefined) continue;' },
  { nom: 'retirer-cle-vide-gardee', suite: 'retirer', de: 'if (reste.length) etat.objet.hooks[e] = reste; else delete etat.objet.hooks[e];', vers: 'etat.objet.hooks[e] = reste;' },
  { nom: 'retirer-groupe-entier', suite: 'retirer', de: 'hooks: g.hooks.filter(h => !(h && h.command === commande(c, agent)))', vers: 'hooks: []' },
  { nom: 'retirer-groupe-vide-garde', suite: 'retirer', de: '.filter(g => !(Array.isArray(g.hooks) && g.hooks.length === 0))', vers: '' },
  { nom: 'retirer-tout-agent', suite: 'retirer', de: 'g.hooks.some(h => h && h.command === commande(c, agent))', vers: "g.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(c.script))" },
  { nom: 'retirer-ecrit-sans-rien-retirer', suite: 'retirer', de: "if (!retires.length) return 'pas branché';", vers: '' },
  { nom: 'verifier-ecrit', suite: 'retirer', de: 'const presents = evenementsBranches(lire(fichier).objet, c, agent);', vers: "brancher(fichier, agent, c, 'cockpit'); const presents = evenementsBranches(lire(fichier).objet, c, agent);" },
  { nom: 'verifier-toujours-branche', suite: 'retirer', de: "return presents.length ? `branché : ${presents.join(', ')}` : 'pas branché';", vers: "return `branché : ${presents.join(', ')}`;" },
  { nom: 'commande-inconnue-acceptee', suite: 'retirer', de: 'if (!actions[action]) return erreur(', vers: 'if (false) return erreur(' },
  { nom: 'fichier-illisible-silencieux', suite: 'brancher', de: "throw new Error(`fichier illisible : ${fichier} (${e.code || e.message})`);", vers: 'return { brut: \'{"hooks":{}}\', objet: { hooks: {} }, bom: false, crlf: false, finDeLigne: false };' },
  { nom: 'json-invalide-ignore', suite: 'brancher', de: "throw new Error(`JSON invalide : ${fichier} (${e.message})`);", vers: 'objet = { hooks: {} };' },
  // composants
  { nom: 'composant-inconnu-accepte', suite: 'composant regulateur', de: 'if (!Object.prototype.hasOwnProperty.call(COMPOSANTS, nom)) return erreur(', vers: 'if (false) return erreur(' },
  { nom: 'composant-par-defaut-change', suite: 'brancher', de: "argument(argv, '--composant') ?? 'cockpit'", vers: "argument(argv, '--composant') ?? 'regulateur'" },
  { nom: 'regul-matcher-perdu', suite: 'composant regulateur', de: "evenements: ['PreToolUse'], matcher: 'spawn_agent'", vers: "evenements: ['PreToolUse'], matcher: null" },
  { nom: 'regul-matcher-faux', suite: 'composant regulateur', de: "evenements: ['PreToolUse'], matcher: 'spawn_agent'", vers: "evenements: ['PreToolUse'], matcher: 'Bash'" },
  { nom: 'regul-evenement-faux', suite: 'composant regulateur', de: "script: 'regulateur.js', evenements: ['PreToolUse']", vers: "script: 'regulateur.js', evenements: ['PostToolUse']" },
  { nom: 'regul-delai-faux', suite: 'composant regulateur', de: "matcher: 'spawn_agent', timeout: 10, message: \"Regulateur d'agents : plafond et pause\"", vers: "matcher: 'spawn_agent', timeout: 20, message: \"Regulateur d'agents : plafond et pause\"" },
  { nom: 'regul-message-faux', suite: 'composant regulateur', de: "message: \"Regulateur d'agents : plafond et pause\"", vers: "message: 'Regulateur'" },
  { nom: 'regul-script-faux', suite: 'composant regulateur', de: "  regulateur: { script: 'regulateur.js'", vers: "  regulateur: { script: 'cockpit.js'" },
  // composant consignes
  { nom: 'cons-matcher-ajoute', suite: 'composant consignes', de: "script: 'consignes.js', evenements: ['PreToolUse'], matcher: null", vers: "script: 'consignes.js', evenements: ['PreToolUse'], matcher: 'Bash'" },
  { nom: 'cons-evenement-faux', suite: 'composant consignes', de: "script: 'consignes.js', evenements: ['PreToolUse']", vers: "script: 'consignes.js', evenements: ['PostToolUse']" },
  { nom: 'cons-evenement-supplementaire', suite: 'composant consignes', de: "script: 'consignes.js', evenements: ['PreToolUse']", vers: "script: 'consignes.js', evenements: ['PreToolUse', 'UserPromptSubmit']" },
  { nom: 'cons-delai-faux', suite: 'composant consignes', de: "matcher: null, timeout: 10, message: 'Consignes en vigueur", vers: "matcher: null, timeout: 20, message: 'Consignes en vigueur" },
  { nom: 'cons-message-faux', suite: 'composant consignes', de: "message: 'Consignes en vigueur : commandes verrouillees'", vers: "message: 'Consignes'" },
  { nom: 'cons-script-faux', suite: 'composant consignes', de: "script: 'consignes.js'", vers: "script: 'regulateur.js'" },
  { nom: 'cons-composant-absent', suite: 'composant consignes', de: "  consignes: { script: 'consignes.js',", vers: "  consigne: { script: 'consignes.js'," },
  // composant file (le Stop du Régulateur : l'ordre de lancer le suivant de la file)
  { nom: 'file-matcher-ajoute', suite: 'composant file', de: "evenements: ['Stop'], matcher: null", vers: "evenements: ['Stop'], matcher: 'spawn_agent'" },
  { nom: 'file-evenement-faux', suite: 'composant file', de: "evenements: ['Stop'], matcher: null", vers: "evenements: ['SubagentStop'], matcher: null" },
  { nom: 'file-evenement-supplementaire', suite: 'composant file', de: "evenements: ['Stop'], matcher: null", vers: "evenements: ['Stop', 'PreToolUse'], matcher: null" },
  { nom: 'file-delai-faux', suite: 'composant file', de: "matcher: null, timeout: 10, message: \"Regulateur d'agents : file", vers: "matcher: null, timeout: 20, message: \"Regulateur d'agents : file" },
  { nom: 'file-message-faux', suite: 'composant file', de: "message: \"Regulateur d'agents : file d'attente\"", vers: "message: \"Regulateur d'agents\"" },
  { nom: 'file-script-faux', suite: 'composant file', de: "  file: { script: 'regulateur.js',", vers: "  file: { script: 'consignes.js'," },
  { nom: 'file-composant-absent', suite: 'composant file', de: "  file: { script: 'regulateur.js',", vers: "  fichier: { script: 'regulateur.js'," },
  // composant nuit (l'outil de questions)
  { nom: 'nuit-script-faux', suite: 'composant nuit', de: "  nuit: { script: 'nuit.js', evenements: ['PreToolUse']", vers: "  nuit: { script: 'regulateur.js', evenements: ['PreToolUse']" },
  { nom: 'nuit-evenement-faux', suite: 'composant nuit', de: "evenements: ['PreToolUse'], matcher: 'request_user_input'", vers: "evenements: ['PostToolUse'], matcher: 'request_user_input'" },
  { nom: 'nuit-evenement-supplementaire', suite: 'composant nuit', de: "evenements: ['PreToolUse'], matcher: 'request_user_input'", vers: "evenements: ['PreToolUse', 'Stop'], matcher: 'request_user_input'" },
  { nom: 'nuit-matcher-perdu', suite: 'composant nuit', de: "evenements: ['PreToolUse'], matcher: 'request_user_input'", vers: "evenements: ['PreToolUse'], matcher: null" },
  { nom: 'nuit-matcher-faux', suite: 'composant nuit', de: "matcher: 'request_user_input', timeout: 10", vers: "matcher: 'request_user', timeout: 10" },
  { nom: 'nuit-matcher-large', suite: 'composant nuit', de: "matcher: 'request_user_input', timeout: 10", vers: "matcher: 'spawn_agent', timeout: 10" },
  { nom: 'nuit-delai-faux', suite: 'composant nuit', de: "matcher: 'request_user_input', timeout: 10, message: 'Nuit : questions en boite'", vers: "matcher: 'request_user_input', timeout: 20, message: 'Nuit : questions en boite'" },
  { nom: 'nuit-message-faux', suite: 'composant nuit', de: "message: 'Nuit : questions en boite'", vers: "message: 'Nuit'" },
  { nom: 'nuit-composant-absent', suite: 'composant nuit', de: "  nuit: { script: 'nuit.js', evenements: ['PreToolUse']", vers: "  nuits: { script: 'nuit.js', evenements: ['PreToolUse']" },
  // composant nuit-tours (la fin du tour et le message de l'utilisateur)
  { nom: 'nuit-tours-script-faux', suite: 'composant nuit-tours', de: "  'nuit-tours': { script: 'nuit.js',", vers: "  'nuit-tours': { script: 'regulateur.js'," },
  { nom: 'nuit-tours-sans-stop', suite: 'composant nuit-tours', de: "evenements: ['Stop', 'UserPromptSubmit'], matcher: null", vers: "evenements: ['UserPromptSubmit'], matcher: null" },
  { nom: 'nuit-tours-sans-message', suite: 'composant nuit-tours', de: "evenements: ['Stop', 'UserPromptSubmit'], matcher: null", vers: "evenements: ['Stop'], matcher: null" },
  { nom: 'nuit-tours-evenement-faux', suite: 'composant nuit-tours', de: "evenements: ['Stop', 'UserPromptSubmit'], matcher: null", vers: "evenements: ['SubagentStop', 'UserPromptSubmit'], matcher: null" },
  { nom: 'nuit-tours-matcher-ajoute', suite: 'composant nuit-tours', de: "evenements: ['Stop', 'UserPromptSubmit'], matcher: null", vers: "evenements: ['Stop', 'UserPromptSubmit'], matcher: 'request_user_input'" },
  { nom: 'nuit-tours-delai-faux', suite: 'composant nuit-tours', de: "matcher: null, timeout: 10, message: 'Nuit : enchainement et reveil'", vers: "matcher: null, timeout: 20, message: 'Nuit : enchainement et reveil'" },
  { nom: 'nuit-tours-message-faux', suite: 'composant nuit-tours', de: "message: 'Nuit : enchainement et reveil'", vers: "message: 'Nuit'" },
  { nom: 'nuit-tours-composant-absent', suite: 'composant nuit-tours', de: "  'nuit-tours': { script: 'nuit.js',", vers: "  'nuit-tour': { script: 'nuit.js'," },
  { nom: 'outils-script-faux', suite: 'composant cockpit-outils', de: "  'cockpit-outils': { script: 'cockpit.js',", vers: "  'cockpit-outils': { script: 'regulateur.js'," },
  { nom: 'outils-evenement-faux', suite: 'composant cockpit-outils', de: "script: 'cockpit.js', evenements: ['PostToolUse']", vers: "script: 'cockpit.js', evenements: ['PreToolUse']" },
  { nom: 'outils-evenement-supplementaire', suite: 'composant cockpit-outils', de: "script: 'cockpit.js', evenements: ['PostToolUse']", vers: "script: 'cockpit.js', evenements: ['PostToolUse', 'Stop']" },
  { nom: 'outils-matcher-ajoute', suite: 'composant cockpit-outils', de: "evenements: ['PostToolUse'], matcher: null, timeout: 15", vers: "evenements: ['PostToolUse'], matcher: 'spawn_agent', timeout: 15" },
  { nom: 'outils-delai-faux', suite: 'composant cockpit-outils', de: "matcher: null, timeout: 15, message: 'Cockpit : etat du travail apres compactage'", vers: "matcher: null, timeout: 5, message: 'Cockpit : etat du travail apres compactage'" },
  { nom: 'outils-message-faux', suite: 'composant cockpit-outils', de: "message: 'Cockpit : etat du travail apres compactage'", vers: "message: 'Cockpit'" },
  { nom: 'outils-composant-absent', suite: 'composant cockpit-outils', de: "  'cockpit-outils': { script: 'cockpit.js',", vers: "  'cockpit-outil': { script: 'cockpit.js'," },
  { nom: 'resultat-script-faux', suite: 'composant regulateur-resultat', de: "  'regulateur-resultat': { script: 'regulateur.js',", vers: "  'regulateur-resultat': { script: 'cockpit.js'," },
  { nom: 'resultat-evenement-faux', suite: 'composant regulateur-resultat', de: "script: 'regulateur.js', evenements: ['PostToolUse']", vers: "script: 'regulateur.js', evenements: ['PreToolUse']" },
  { nom: 'resultat-evenement-supplementaire', suite: 'composant regulateur-resultat', de: "script: 'regulateur.js', evenements: ['PostToolUse']", vers: "script: 'regulateur.js', evenements: ['PostToolUse', 'Stop']" },
  { nom: 'resultat-matcher-perdu', suite: 'composant regulateur-resultat', de: "evenements: ['PostToolUse'], matcher: 'spawn_agent'", vers: "evenements: ['PostToolUse'], matcher: null" },
  { nom: 'resultat-matcher-faux', suite: 'composant regulateur-resultat', de: "evenements: ['PostToolUse'], matcher: 'spawn_agent'", vers: "evenements: ['PostToolUse'], matcher: 'Bash'" },
  { nom: 'resultat-delai-faux', suite: 'composant regulateur-resultat', de: "matcher: 'spawn_agent', timeout: 10, message: \"Regulateur d'agents : resultat du lancement\"", vers: "matcher: 'spawn_agent', timeout: 20, message: \"Regulateur d'agents : resultat du lancement\"" },
  { nom: 'resultat-message-faux', suite: 'composant regulateur-resultat', de: "message: \"Regulateur d'agents : resultat du lancement\"", vers: "message: 'Regulateur'" },
  { nom: 'resultat-composant-absent', suite: 'composant regulateur-resultat', de: "  'regulateur-resultat': { script: 'regulateur.js',", vers: "  'regulateur-resultats': { script: 'regulateur.js'," },
  { nom: 'sauvegarde-nom-fixe', suite: 'composant regulateur', de: '`${fichier}.avant-agent-memory-ledger-${nom}`', vers: '`${fichier}.avant-agent-memory-ledger-cockpit`' },
  { nom: 'groupe-matcher-jamais-ecrit', suite: 'composant regulateur', de: '...(c.matcher ? { matcher: c.matcher } : {})', vers: '' },
  { nom: 'groupe-matcher-toujours-ecrit', suite: 'brancher', de: '...(c.matcher ? { matcher: c.matcher } : {})', vers: "matcher: c.matcher ?? 'x'" },
];

executer({
  source: path.join(CODEX, 'brancher.js'),
  banc: path.join(__dirname, '..', 'cockpit-brancher.test.js'),
  variable: 'COCKPIT_BRANCHER_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : le dossier des scripts du Cockpit y devient absolu.
  reecritures: [
    ["const DOSSIER = __dirname.replace(/\\\\/g, '/');", `const DOSSIER = ${JSON.stringify(CODEX.replace(/\\/g, '/'))};`],
    ["require('../lib/agents-noms.js')", `require(${JSON.stringify(path.join(CODEX, '..', 'lib', 'agents-noms.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
