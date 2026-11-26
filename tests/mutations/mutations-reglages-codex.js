'use strict';
// Preuve par mutation du banc cockpit-codex-reglages.test.js : chaque hook de Codex qui cesserait de lire le réglage que la ligne de commande du
// Cockpit écrit (la politique d'agents, les seuils du quota, les consignes, la nuit, les réglages du Cockpit) doit rendre le banc rouge. Les quatre
// hooks sont altérés l'un après l'autre, par la variable interne de leur banc propre (COCKPIT_CODEX_TESTE, REGULATEUR_CODEX_TESTE...).
//   node tests/mutations/mutations-reglages-codex.js                 toutes les mutations (témoin non muté d'abord, pour chaque hook)
//   node tests/mutations/mutations-reglages-codex.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-reglages-codex.js --liste         affiche les noms
//   node tests/mutations/mutations-reglages-codex.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const lib = nom => [`require('../lib/${nom}')`, `require(${JSON.stringify(path.join(SCRIPTS, 'lib', nom))})`];
const INERTE = '{ pause: false, max: null, relance: false, file: false }';

const GROUPES = [
  {
    source: 'regulateur.js',
    variable: 'REGULATEUR_CODEX_TESTE',
    reecritures: ['regulateur-core.js', 'regulateur-logique.mjs', 'quota-core.js', 'file-logique.mjs', 'agents-noms.js'].map(lib),
    mutations: [
      { nom: 'reglages-regul-politique-lancement-inerte', suite: 'le Régulateur et sa file', de: 'const politique = regulateur.lirePolitique();\n  if (!politique.pause && politique.max === null) {', vers: `const politique = ${INERTE};\n  if (!politique.pause && politique.max === null) {` },
      { nom: 'reglages-regul-politique-stop-inerte', suite: 'le Régulateur et sa file', de: 'const politique = regulateur.lirePolitique();\n  if (!politique.file || politique.pause) return null;', vers: `const politique = ${INERTE};\n  if (!politique.file || politique.pause) return null;` },
      { nom: 'reglages-regul-quota-ignore', suite: 'le Régulateur et sa file', de: 'try { return quota.decisionAgentCodex({ agent, chemin }); }', vers: 'try { return { autorise: true }; }' },
    ],
  },
  {
    source: 'consignes.js',
    variable: 'CONSIGNES_CODEX_TESTE',
    reecritures: ['consignes-core.js'].map(lib),
    mutations: [
      { nom: 'reglages-consignes-commande-ignoree', suite: 'les Consignes', de: 'const decision = consignes.decisionCommande(commande);', vers: 'const decision = { autorise: true };' },
      { nom: 'reglages-consignes-agent-ignore', suite: 'les Consignes', de: 'const decision = consignes.decisionAgent();', vers: 'const decision = { autorise: true };' },
    ],
  },
  {
    source: 'nuit.js',
    variable: 'NUIT_CODEX_TESTE',
    reecritures: ['nuit-core.js'].map(lib),
    mutations: [
      { nom: 'reglages-nuit-question-ignoree', suite: 'la Nuit', de: 'const r = nuit.refuserQuestion({ agent, session: entree.session_id, entreeOutil: entree.tool_input });', vers: 'const r = { refuser: false };' },
      { nom: 'reglages-nuit-enchainement-ignore', suite: 'la Nuit', de: "const d = nuit.continuer({ agent, session: entree.session_id, reason: 'answer', chemin: typeof entree.transcript_path === 'string' ? entree.transcript_path : undefined });", vers: 'const d = { continuer: false };' },
    ],
  },
  {
    source: 'cockpit.js',
    variable: 'COCKPIT_CODEX_TESTE',
    reecritures: [...['cockpit-core.js', 'agents-noms.js', 'regulateur-core.js', 'regulateur-logique.mjs', 'quota-core.js', 'consignes-core.js'].map(lib),
      ["path.join(__dirname, '..', 'cockpit.js')", `path.join(${JSON.stringify(SCRIPTS)}, 'cockpit.js')`]],
    mutations: [
      { nom: 'reglages-cockpit-consignes-ignorees', suite: 'le Cockpit', de: 'return consignes.texteInjection();', vers: 'return null;' },
      { nom: 'reglages-cockpit-politique-ignoree', suite: 'le Cockpit', de: 'const politique = regulateur.lirePolitique();', vers: `const politique = ${INERTE};` },
      { nom: 'reglages-cockpit-quota-ignore', suite: 'le Cockpit', de: 'const fenetres = quota.fenetresCourantes({ agent, chemin });', vers: 'const fenetres = [];' },
      { nom: 'reglages-cockpit-config-ignoree', suite: 'le Cockpit', de: 'const config = core.lireConfig();', vers: "const config = { worktrees: [], plans: { dossier: '', exclure: [], profondeur: 1 } };" },
    ],
  },
];

(async () => {
  const argv = process.argv.slice(2);
  const noms = argv.filter(a => !a.startsWith('--'));
  const options = argv.filter(a => a.startsWith('--'));
  const toutes = GROUPES.flatMap(g => g.mutations.map(m => m.nom));
  const inconnues = noms.filter(n => !toutes.includes(n));
  if (inconnues.length) { process.stderr.write(`mutation inconnue : ${inconnues.join(', ')}\n`); process.exitCode = 2; return; }
  let code = 0;
  for (const g of GROUPES) {
    const choisies = noms.length ? g.mutations.filter(m => noms.includes(m.nom)) : g.mutations;
    if (!choisies.length) continue;
    process.stdout.write(`\n== ${g.source}\n`);
    const c = await executer({
      source: path.join(SCRIPTS, 'codex', g.source),
      banc: path.join(__dirname, '..', 'cockpit-codex-reglages.test.js'),
      variable: g.variable,
      mutations: g.mutations,
      reecritures: g.reecritures,
      argv: [...options, ...choisies.map(m => m.nom)],
      concurrence: 3,
    });
    code = Math.max(code, c);
  }
  process.exitCode = code;
})().catch(e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
