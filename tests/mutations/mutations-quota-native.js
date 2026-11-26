'use strict';
// Preuve par mutation du banc quota-native.test.js (lecture native du quota de Codex : scripts/lib/quota-native.cjs).
//   node tests/mutations/mutations-quota-native.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-quota-native.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-quota-native.js --liste         affiche les noms
//   node tests/mutations/mutations-quota-native.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutations jugées équivalentes (non écrites) : sauter l'élément vide du PATH (un élément vide donne un chemin relatif qui n'existe pas),
// ne pas distinguer les droits d'exécution du binaire (le test existe pour POSIX ; sous Windows l'accès en exécution est toujours accordé, la
// branche n'est même pas lue : ces deux altérations ne peuvent pas rougir ici), ne pas résoudre un dossier de Codex déjà absolu.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib');
const rt = (nom, de, vers) => ({ nom: `native-${nom}`, suite: '^runtime', de, vers });
const lire = (nom, de, vers) => ({ nom: `native-lire-${nom}`, suite: '^quota natif', de, vers });

const MUTATIONS = [
  // quel agent a une lecture native
  rt('agent-tous', "if (agent !== 'codex') return null;", 'if (false) return null;'),
  rt('agent-aucun', "if (agent !== 'codex') return null;", 'if (true) return null;'),
  // le binaire : AML_CODEX_BINAIRE, puis le PATH
  rt('variable-ignoree', "const donne = typeof env.AML_CODEX_BINAIRE === 'string' ? env.AML_CODEX_BINAIRE.trim() : '';", "const donne = '';"),
  rt('variable-sans-blancs', 'env.AML_CODEX_BINAIRE.trim()', 'env.AML_CODEX_BINAIRE'),
  rt('variable-absente-repli-path', "if (donne !== '') return estExecutable(donne) ? path.resolve(donne) : null;", "if (donne !== '' && estExecutable(donne)) return path.resolve(donne);"),
  rt('variable-non-verifiee', "return estExecutable(donne) ? path.resolve(donne) : null;", 'return path.resolve(donne);'),
  rt('variable-pas-resolue', 'path.resolve(donne)', 'donne'),
  rt('variable-blanche', "if (donne !== '') return", "if (donne !== undefined) return"),
  rt('nom-sans-exe', "process.platform === 'win32' ? 'codex.exe' : 'codex'", "'codex'"),
  rt('path-majuscules', 'String(env.PATH ?? env.Path ?? \'\')', "String(env.PATH ?? '')"),
  rt('path-minuscules', 'String(env.PATH ?? env.Path ?? \'\')', "String(env.Path ?? '')"),
  rt('path-delimiteur', '.split(path.delimiter)', ".split(':')"),
  rt('path-premier-seulement', 'for (const dossier of String(env.PATH ?? env.Path ?? \'\').split(path.delimiter)) {', 'for (const dossier of String(env.PATH ?? env.Path ?? \'\').split(path.delimiter).slice(0, 1)) {'),
  rt('fichier-dossier', 'return fs.statSync(chemin).isFile();', 'return fs.statSync(chemin).isFile() || fs.statSync(chemin).isDirectory();'),
  rt('fichier-toujours', 'return fs.statSync(chemin).isFile();', 'return true;'),
  rt('rien-trouve', '  return null;\n}\n\n// { binary, home }', '  return process.execPath;\n}\n\n// { binary, home }'),
  // le dossier de configuration de Codex : CODEX_HOME, sinon ~/.codex
  rt('home-ignore', "typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== ''", 'false'),
  rt('home-toujours', "typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== ''", "typeof env.CODEX_HOME === 'string'"),
  rt('home-sans-blancs', 'path.resolve(env.CODEX_HOME.trim())', 'path.resolve(env.CODEX_HOME)'),
  rt('home-defaut', "path.join(os.homedir(), '.codex')", "path.join(os.homedir(), '.codex-autre')"),
  rt('home-defaut-racine', "path.join(os.homedir(), '.codex')", "path.join(os.homedir(), 'codex')"),
  rt('environnement-defaut', 'function runtime(agent, env = process.env) {', 'function runtime(agent, env = {}) {'),
  rt('binaire-absent-ignore', '  if (binary === null) return null;\n', ''),
  // la lecture : seule la limite de Codex, sans fenêtre secondaire inventée, ni faux zéro
  lire('limite-autre', "(limits.limitId && limits.limitId !== 'codex')", 'false'),
  lire('limite-toujours', "(limits.limitId && limits.limitId !== 'codex')", 'true'),
  lire('limite-choisie', 'response.rateLimitsByLimitId?.codex || response.rateLimits', 'response.rateLimits'),
  lire('secondaire', 'secondary: window(limits.secondary)', 'secondary: window(limits.primary)'),
  lire('principale', 'primary: window(limits.primary)', 'primary: window(limits.secondary)'),
  lire('pourcentage', 'used_percent: value.usedPercent', 'used_percent: value.windowDurationMins'),
  lire('fenetre', 'window_minutes: value.windowDurationMins', 'window_minutes: 60'),
  lire('remise', 'resets_at: value.resetsAt', 'resets_at: 0'),
  lire('source', "{ fenetres, source: 'app-server', sourceAt:", "{ fenetres, source: 'autre', sourceAt:"),
  lire('limite-nom', "limitId: limits.limitId || 'codex'", "limitId: 'autre'"),
  lire('date-mesure', 'sourceAt: new Date().toISOString()', 'sourceAt: null'),
  lire('methode', "method: 'account/rateLimits/read'", "method: 'account/rateLimits/lire'"),
  lire('dossier-donne', 'CODEX_HOME: home', "CODEX_HOME: 'dossier-neutre'"),
  lire('panne-propagee', "child.on('close', () => { clearTimeout(timer); resolve(result); });", "child.on('close', () => { clearTimeout(timer); resolve({ fenetres: [], source: 'app-server' }); });"),
];

executer({
  source: path.join(LIB, 'quota-native.cjs'),
  banc: path.join(__dirname, '..', 'quota-native.test.js'),
  variable: 'QUOTA_NATIVE_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : son require relatif devient absolu.
  reecritures: [
    ["require('./quota-logique.mjs')", `require(${JSON.stringify(path.join(LIB, 'quota-logique.mjs'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
