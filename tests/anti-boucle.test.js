'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const fichierCore = process.env.AML_CORE_TEST || path.join(__dirname, '../scripts/lib/context-ledger-core.js');
const baseTests = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-anti-boucle-'));

function cas(nom, fn) {
  const maison = path.join(baseTests, nom);
  fs.mkdirSync(path.join(maison, 'history'), { recursive: true });
  const avant = { ...process.env };
  process.env.AGENT_MEMORY_LEDGER_HOME = maison;
  process.env.CONTEXT_LEDGER_DIR = path.join(maison, 'contexte');
  process.env.CONTEXT_LEDGER_BUDGET_MS = '600000';
  delete process.env.CONTEXT_LEDGER_SECOURS_DIR;
  const ctx = vm.createContext({ require: createRequire(fichierCore), module: { exports: {} }, process, Buffer, __dirname: path.dirname(fichierCore), __filename: fichierCore, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(fichierCore, 'utf8'), ctx, { filename: fichierCore });
  const c = ctx.module.exports;
  try { fn(c, maison, ctx); } finally {
    for (const k of Object.keys(process.env)) if (!(k in avant)) delete process.env[k];
    Object.assign(process.env, avant);
  }
}
const ligne = c => c.ajouterLigne({ projet: '_general', agent: 'codex', sessionId: 'parent-a', texte: 'Travail de test' });

test('une preuve reste en attente si son application echoue', () => cas('reprise-preuve', (c, base, ctx) => {
  const id = ligne(c);
  const f = path.join(base, 'history/demo.codex.md');
  fs.writeFileSync(f, 'Etat initial\n');
  c.reconcilier({ agent: 'codex', base });
  fs.appendFileSync(f, `Fait et verifie [ctx ${id}]\n`);
  vm.runInContext('var applicationInitiale = appliquerPreuves; appliquerPreuves = () => { throw new Error("panne simulee"); };', ctx);
  assert.throws(() => c.reconcilier({ agent: 'codex', base }), /panne simulee/);
  vm.runInContext('appliquerPreuves = applicationInitiale;', ctx);
  assert.ok(c.reconcilier({ agent: 'codex', base }).faits.includes(id));
  assert.equal(c.lireLedger('_general', 'codex').lignes[id].statut, 'fait');
}));

test('la base initiale ne cloture pas les mentions anciennes', () => cas('base', (c, base) => {
  const id = ligne(c);
  fs.writeFileSync(path.join(base, 'history/demo.codex.md'), `Ancien exemple [ctx ${id}]\n`);
  assert.equal(c.reconcilier({ agent: 'codex', base }).faits.length, 0);
}));

test('une fin dupliquee ne recree pas une livraison cloturee', () => cas('fin', c => {
  c.suivreTache({ agent: 'codex', sessionId: 'parent-a', cwd: baseTests, tache: { id: 'enfant-a', titre: 'Lecture', genre: 'worker' } });
  const args = { agent: 'codex', sessionId: 'parent-a', id: 'enfant-a', reprise: true, resultat: 'rapport.md', livraisonId: 'tour-1' };
  const r = c.finirTache(args);
  c.appliquerPreuves({ agent: 'codex', marqueurs: [{ id: r.ligne, partiel: false }], preuve: 'preuve de test' });
  assert.equal(c.finirTache(args), null);
  assert.equal(Object.keys(c.lireLedger('_general', 'codex').lignes).length, 1);
  const nouveau = c.finirTache({ ...args, livraisonId: 'tour-2' });
  assert.ok(nouveau && nouveau.ligne !== r.ligne);
}));

test('un journal qui grossit ne prouve pas une nouvelle livraison', () => cas('journal-fin', (c, base) => {
  const f = path.join(base, 'resultat.jsonl');
  fs.writeFileSync(f, 'Premier resultat\n');
  c.suivreTache({ agent: 'codex', sessionId: 'parent-a', cwd: base, tache: { id: 'enfant-a' } });
  const args = { agent: 'codex', sessionId: 'parent-a', id: 'enfant-a', reprise: true, resultat: f };
  const fin = c.finirTache(args);
  c.appliquerPreuves({ agent: 'codex', marqueurs: [{ id: fin.ligne, partiel: false }], preuve: 'controle' });
  fs.appendFileSync(f, 'Evenement technique du hook\n');
  assert.equal(c.finirTache(args), null);
  assert.equal(Object.keys(c.lireLedger('_general', 'codex').lignes).length, 1);
}));

test('deux rapports distincts dans un meme tour restent deux livraisons', () => cas('identite-fin', c => {
  c.suivreTache({ agent: 'codex', sessionId: 'parent-a', cwd: baseTests, tache: { id: 'enfant-a' } });
  const args = { agent: 'codex', sessionId: 'parent-a', id: 'enfant-a', reprise: true, livraisonId: 'tour-a', dernierMessage: 'resultat' };
  const fin = c.finirTache(args);
  c.appliquerPreuves({ agent: 'codex', marqueurs: [{ id: fin.ligne, partiel: false }], preuve: 'controle' });
  assert.equal(c.finirTache(args), null);
  assert.ok(c.finirTache({ ...args, dernierMessage: 'Nouveau rapport apres verification complementaire' }));
}));

test('une conversation ne recoit pas les taches dune autre', () => cas('perimetre', c => {
  const a = c.enregistrerMessage({ agent: 'codex', sessionId: 'session-a', cwd: baseTests, promptId: 'p-a', texte: 'Mission A' });
  const b = c.enregistrerMessage({ agent: 'codex', sessionId: 'session-b', cwd: baseTests, promptId: 'p-b', texte: 'Mission B' });
  const id = c.ajouterLigne({ agent: 'codex', projet: a.projet, de: a.id, texte: 'Travail A' });
  const texte = c.contexteSession({ agent: 'codex', projet: b.projet, sessionId: 'session-b', script: 'ledger.js' });
  assert.ok(!texte.includes(id));
  assert.ok(texte.includes(b.id));
  const cli = c.executerCli(['lister', '--projet', a.projet, '--session', 'session-b'], { agent: 'codex', script: 'ledger.js' });
  assert.equal(cli.code, 0);
  assert.ok(!cli.sortie.includes(id));
  assert.ok(c.lireLedger(a.projet, 'codex').lignes[id]);
}));

test('une mission peut etre reprise explicitement par son identifiant', () => cas('adoption', c => {
  const id = ligne(c);
  c.lierSession('codex', 'session-b', baseTests);
  const r = c.executerCli(['reprendre', '--projet', '_general', '--session', 'session-b', id], { agent: 'codex', script: 'ledger.js' });
  assert.equal(r.code, 0, r.erreur);
  assert.ok(c.contexteSession({ agent: 'codex', projet: '_general', sessionId: 'session-b', script: 'ledger.js' }).includes(id));
}));

test('les exemples et les constats non termines ne valent pas cloture', () => cas('mention', c => {
  assert.equal(c.extraireMarqueurs('NON TERMINE : [ctx C-900001]').length, 0);
  assert.equal(c.extraireMarqueurs('Exemple : [ctx C-900001]').length, 0);
  assert.equal(c.extraireMarqueurs('```md\n[ctx C-900001]\n```').length, 0);
  assert.equal(c.extraireMarqueurs('````md\n```\n[ctx C-900001]\n```\n````').length, 0);
  assert.equal(c.extraireMarqueurs('NON TRAITE : [ctx C-900001]').length, 0);
  assert.equal(c.extraireMarqueurs('Fait et verifie [ctx C-900001]').length, 1);
}));

test('un rappel inchange ne relance pas chaque tour', () => cas('rappel', c => {
  c.suivreTache({ agent: 'codex', sessionId: 'parent-a', cwd: baseTests, tache: { id: 'enfant-a', titre: 'Lecture', genre: 'worker' } });
  c.finirTache({ agent: 'codex', sessionId: 'parent-a', id: 'enfant-a', livraisonId: 'tour-1' });
  c.suivreTache({ agent: 'codex', sessionId: 'parent-a', cwd: baseTests, tache: { id: 'enfant-b', titre: 'Lecture B', genre: 'worker' } });
  c.finirTache({ agent: 'codex', sessionId: 'parent-a', id: 'enfant-b', livraisonId: 'tour-2' });
  assert.ok(c.texteLivraisons({ agent: 'codex', sessionId: 'parent-a' }));
  assert.equal(c.texteLivraisons({ agent: 'codex', sessionId: 'parent-a' }), '');
  const attentes = c.livraisons({ agent: 'codex', sessionId: 'parent-a' }).attente;
  assert.equal(attentes.length, 2);
  assert.equal(c.texteLivraisons({ agent: 'codex', sessionId: 'parent-a', dernierMessage: attentes[0].ligne }), '');
  assert.equal(c.texteLivraisons({ agent: 'codex', sessionId: 'parent-a', dernierMessage: attentes[1].ligne }), '');
}));

test('traiter exige une preuve et conserve executant et verificateur', () => cas('recu', (c, base) => {
  const id = ligne(c);
  const f = path.join(base, 'rapport.md');
  const args = ['traiter', '--projet', '_general', '--session', 'parent-a', '--executant', 'enfant-a', '--preuve', f, '--verification', 'Lecture des sources et controle du resultat', '--resultat', 'accepte', id];
  assert.equal(c.executerCli(args, { agent: 'codex', script: 'ledger.js' }).code, 1);
  fs.writeFileSync(f, `statut: traite [ctx ${id}]\nPreuve de verification\n`);
  assert.equal(c.executerCli(args, { agent: 'codex', script: 'ledger.js' }).code, 0);
  const l = c.lireLedger('_general', 'codex').lignes[id];
  assert.equal(l.statut, 'fait');
  assert.equal(l.cloture.executant, 'enfant-a');
  assert.equal(l.cloture.verificateur, 'codex:parent-a');
  assert.match(l.cloture.empreinte, /^[a-f0-9]{64}$/);
  assert.equal(c.rejouerJournal('_general', 'codex').lignes[id].cloture.executant, 'enfant-a');
  assert.ok(!c.rendreVue(c.lireLedger('_general', 'codex')).includes(id));
}));

test('rejeter une livraison exige de conserver le reste', () => cas('rejet', (c, base) => {
  const id = c.suivreTache({ agent: 'codex', sessionId: 'parent-a', cwd: baseTests, tache: { id: 'enfant-a', titre: 'Lecture', genre: 'worker' } });
  const reste = ligne(c);
  const f = path.join(base, 'controle.md');
  fs.writeFileSync(f, `statut: traite [ctx ${id}]\nRapport rejete, travail non termine\n`);
  const args = ['traiter', '--projet', '_general', '--session', 'parent-a', '--executant', 'enfant-a', '--preuve', f, '--verification', 'Preuves insuffisantes', '--resultat', 'rejete', id];
  assert.equal(c.executerCli(args, { agent: 'codex', script: 'ledger.js' }).code, 1);
  assert.equal(c.executerCli([...args, '--reste', reste], { agent: 'codex', script: 'ledger.js' }).code, 0);
  assert.equal(c.lireLedger('_general', 'codex').lignes[reste].statut, 'ouvert');
}));

test('le rappel memoire Claude ignore un sous-agent', () => {
  const script = process.env.AML_RAPPEL_TEST || path.join(__dirname, '../scripts/memoire/rappel.js');
  const r = spawnSync(process.execPath, [script, '--agent', 'claude'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'parent-a', agent_id: 'enfant-a' }), encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_MEMORY_LEDGER_HOME: path.join(baseTests, 'memoire') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('Claude rapproche une preuve ecrite par un outil shell', () => cas('claude-contenu', (c, base) => {
  const id = c.ajouterLigne({ projet: '_general', agent: 'claude', texte: 'Travail termine' });
  const f = path.join(base, 'history/demo.claude.md');
  fs.writeFileSync(f, 'Base\n');
  c.reconcilier({ agent: 'claude', base });
  fs.appendFileSync(f, `Fait et verifie [ctx ${id}]\n`);
  const script = process.env.AML_CLAUDE_TEST || path.join(__dirname, '../scripts/claude/context-ledger.js');
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'parent-a', cwd: base, tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: {} }), env: { ...process.env, CONTEXT_LEDGER_PREUVES_DIR: base }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.equal(c.lireLedger('_general', 'claude').lignes[id].statut, 'fait');
}));

test('un sous-agent ne peut pas traiter ni reprendre la liste du parent', () => cas('garde-recu', c => {
  for (const commande of ['traiter', 'reprendre']) {
    const raison = c.gardeOutil({ input: { agent_id: 'enfant-a', tool_name: 'Bash', tool_input: { command: `node context-ledger.js ${commande} --projet _general --session parent-a C-0001` } }, generique: true });
    assert.ok(raison, commande);
  }
}));

test('un recu partiel garde la tache dans la liste active', () => cas('partiel', (c, base) => {
  const id = ligne(c);
  const f = path.join(base, 'partiel.md');
  fs.writeFileSync(f, `statut: partiel [ctx ${id} partiel]\nReste a verifier\n`);
  const r = c.executerCli(['traiter', '--projet', '_general', '--session', 'parent-a', '--executant', 'parent-a', '--preuve', f, '--verification', 'Lecture partielle', '--resultat', 'partiel', id], { agent: 'codex', script: 'ledger.js' });
  assert.equal(r.code, 0, r.erreur);
  assert.equal(c.lireLedger('_general', 'codex').lignes[id].statut, 'en-cours');
  assert.ok(c.rendreVue(c.lireLedger('_general', 'codex')).includes(id));
  c.appliquerPreuves({ agent: 'codex', marqueurs: [{ id, partiel: false }], preuve: 'controle complet' });
  assert.equal(c.executerCli(['traiter', '--projet', '_general', '--session', 'parent-a', '--executant', 'parent-a', '--preuve', f, '--verification', 'Ancien controle partiel', '--resultat', 'partiel', id], { agent: 'codex', script: 'ledger.js' }).code, 1);
  assert.equal(c.lireLedger('_general', 'codex').lignes[id].statut, 'fait');
}));

test('un signalement est reserve a la session responsable, sans consommer celui de lautre', () => cas('signalement-perimetre', c => {
  c.lierSession('claude', 'parent-a', baseTests);
  c.lierSession('claude', 'parent-b', baseTests);
  const id = c.ajouterLigne({ agent: 'claude', projet: '_general', sessionId: 'parent-a', texte: 'Mission A' });
  c.signalerAgent({ de: 'codex', vers: 'claude', projet: '_general', ligne: id, genre: 'deja-fait', texte: 'Preuve a controler' });
  assert.equal(c.texteSignalementsAgents({ agent: 'claude', sessionId: 'parent-b' }), '');
  assert.ok(c.texteSignalementsAgents({ agent: 'claude', sessionId: 'parent-a' }).includes(id));
  assert.equal(c.texteSignalementsAgents({ agent: 'claude', sessionId: 'parent-a' }), '');
}));

test('une session ne cloture pas une mission etrangere sans reprise explicite', () => cas('recu-perimetre', (c, base) => {
  const id = ligne(c);
  const f = path.join(base, 'controle.md');
  fs.writeFileSync(f, `statut: traite [ctx ${id}]\nControle execute\n`);
  const args = ['traiter', '--projet', '_general', '--session', 'parent-b', '--executant', 'parent-a', '--preuve', f, '--verification', 'Lecture des preuves', '--resultat', 'accepte', id];
  assert.equal(c.executerCli(args, { agent: 'codex', script: 'ledger.js' }).code, 1);
  assert.equal(c.lireLedger('_general', 'codex').lignes[id].statut, 'ouvert');
  assert.equal(c.executerCli(['reprendre', '--projet', '_general', '--session', 'parent-b', id], { agent: 'codex', script: 'ledger.js' }).code, 0);
  assert.equal(c.executerCli(args, { agent: 'codex', script: 'ledger.js' }).code, 0);
}));

// Une installation qui a un second adaptateur Codex (un autre dossier de configuration, avec sa propre identite)
// le teste avec les memes bancs : AML_HOME_AGENT (son identite), AML_HOME_TEST (son script) et
// AML_HOME_DOSSIER (le nom du dossier qui la designe). Sans ces variables, seul l'adaptateur du depot est teste.
const SECOND = process.env.AML_HOME_AGENT ? { agent: process.env.AML_HOME_AGENT, script: process.env.AML_HOME_TEST, dossier: process.env.AML_HOME_DOSSIER } : null;
const ADAPTATEURS = [{ agent: 'codex', script: process.env.AML_CODEX_TEST || path.join(__dirname, '../scripts/codex/context-ledger.js') }].concat(SECOND ? [SECOND] : []);

for (const { agent, script } of ADAPTATEURS) test(`${agent} : une fin repetee ne bloque plus le parent`, () => cas('adaptateur-' + agent, (c, base) => {
  const sid = 'parent-a';
  c.lierSession(agent, sid, base);
  const id = c.suivreTache({ agent, sessionId: sid, cwd: base, tache: { id: 'enfant-a', titre: 'Controle', genre: 'worker' } });
  const outil = payload => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ session_id: sid, cwd: base, transcript_path: null, ...payload }), env: { ...process.env, CONTEXT_LEDGER_PREUVES_DIR: base }, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const fin = { hook_event_name: 'SubagentStop', agent_id: 'enfant-a', agent_type: 'worker', turn_id: 'tour-1', last_assistant_message: 'Rapport concret', agent_transcript_path: null };
  outil(fin);
  assert.ok(c.lireSession(agent, sid).taches['enfant-a'].fini, 'la fin doit etre enregistree');
  assert.equal(outil({ hook_event_name: 'Stop', turn_id: 'tour-parent', stop_hook_active: false }).decision, 'block');
  assert.equal(outil({ hook_event_name: 'Stop', turn_id: 'tour-parent-2', stop_hook_active: false }), null);
  c.appliquerPreuves({ agent, marqueurs: [{ id, partiel: false }], preuve: 'Sources relues' });
  outil(fin);
  assert.equal(Object.keys(c.lireLedger('_general', agent).lignes).length, 1);
  assert.equal(c.lireLedger('_general', agent).lignes[id].statut, 'fait');
  const propre = c.ajouterLigne({ agent, projet: '_general', sessionId: sid, texte: 'Controle propre' });
  const etrangere = c.ajouterLigne({ agent, projet: '_general', sessionId: 'parent-b', texte: 'Autre mission' });
  const preuve = path.join(base, `history/demo.${agent}.md`);
  fs.writeFileSync(preuve, 'Base\n');
  c.reconcilier({ agent, base });
  fs.appendFileSync(preuve, `Fait et verifie [ctx ${propre}]\n`);
  const injection = outil({ hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_input: { cmd: 'echo controle' }, tool_response: { exit_code: 0 } });
  assert.ok(injection && injection.hookSpecificOutput, 'la preuve nouvelle doit produire une injection');
  assert.ok(!injection.hookSpecificOutput.additionalContext.includes(etrangere), 'la preuve ne doit pas reinjecter une mission etrangere');
}));

test('le rappel Claude reconnait le chemin dun sous-agent sans agent_id', () => {
  const script = process.env.AML_RAPPEL_TEST || path.join(__dirname, '../scripts/memoire/rappel.js');
  const r = spawnSync(process.execPath, [script, '--agent', 'claude'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'parent-a', transcript_path: path.join(baseTests, 'subagents', 'enfant.jsonl') }), encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_MEMORY_LEDGER_HOME: path.join(baseTests, 'memoire') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

if (SECOND && SECOND.dossier) test('un second adaptateur garde une identite distincte', () => cas('identites', c => {
  assert.equal(c.agentDepuisChemin(path.join(baseTests, SECOND.dossier, 'hooks', 'scripts')), SECOND.agent);
  assert.notEqual(c.chemins('_general', 'codex').json, c.chemins('_general', SECOND.agent).json);
}));
