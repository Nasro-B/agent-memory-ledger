'use strict';
// Bancs de l'adaptateur CODEX du fichier contexte.
// Lancement : node --test tests/context-ledger-codex.test.js
// Sans modèle : payloads simulés CONFORMES au schéma d'entrée de codex-cli 0.155.0-alpha.16 (validés avant
// envoi), sorties validées STRICTEMENT contre le schéma de sortie (fixture schemas-hooks-codex-0.155.json).
// Jamais dans la vraie maison (~/.agent-memory-ledger) : chaque test a sa propre maison
// <dossier de test>/<nom>/.agent-memory-ledger (racine contexte : <maison>/contexte, fichiers de preuve :
// <maison>/history), passée par AGENT_MEMORY_LEDGER_HOME.
// Variables internes (tests de mutation, qui relancent ce fichier sur une copie mutée) :
//   CONTEXT_LEDGER_CODEX_HOOK   adaptateur à tester (défaut : ../scripts/codex/context-ledger.js)
//   CONTEXT_LEDGER_EN_MUTATION  '1' = exécution sur une copie (pas de récursion)
//   CONTEXT_LEDGER_BASE_TESTS   dossier de travail des bancs (défaut : <dossier temporaire>/aml-tests/codex)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { test, describe, before } = require('node:test');

const HOOK = process.env.CONTEXT_LEDGER_CODEX_HOOK || path.join(__dirname, '..', 'scripts', 'codex', 'context-ledger.js');
const EN_MUTATION = process.env.CONTEXT_LEDGER_EN_MUTATION === '1';
const BASE_TESTS = process.env.CONTEXT_LEDGER_BASE_TESTS || path.join(os.tmpdir(), 'aml-tests', 'codex');
const RUN = path.join(BASE_TESTS, (EN_MUTATION ? 'mut-' : 'run-') + Date.now() + '-' + process.pid);
const VRAIE_MAISON = path.join(os.homedir(), '.agent-memory-ledger');
const CWD = 'C:\\travail\\sans-projet';
const PROJET = '_general';
const SCHEMAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas-hooks-codex-0.155.json'), 'utf8')).schemas;
const PLAFOND = 9000;
const CONCURRENCE = { concurrency: 6 };

// Les réglages de la personne qui lance les bancs ne doivent jamais fuir dans les tests.
for (const k of ['CONTEXT_LEDGER_DIR', 'CONTEXT_LEDGER_SECOURS_DIR', 'CONTEXT_LEDGER_PREUVES_DIR', 'AGENT_MEMORY_LEDGER_HOME']) delete process.env[k];

function norm(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }

before(() => {
  assert.ok(!norm(RUN).startsWith(norm(VRAIE_MAISON)), 'les tests ne doivent jamais viser la vraie maison');
  fs.mkdirSync(RUN, { recursive: true });
});

// ---------------------------------------------------------------------------
// Validation JSON Schema (sous-ensemble utilisé par les schémas Codex : type, const, enum, properties,
// required, additionalProperties, allOf, $ref vers #/definitions, schémas booléens)

function valider(schema, v, racineSchema, ou = '$') {
  if (schema === true) return [];
  if (schema === false) return [`${ou} : interdit`];
  const err = [];
  if (schema.$ref) {
    const nom = schema.$ref.replace('#/definitions/', '');
    const cible = (racineSchema.definitions || {})[nom];
    if (!cible) return [`${ou} : $ref introuvable ${schema.$ref}`];
    err.push(...valider(cible, v, racineSchema, ou));
  }
  for (const s of schema.allOf || []) err.push(...valider(s, v, racineSchema, ou));
  if ('const' in schema && v !== schema.const) err.push(`${ou} : attendu const ${JSON.stringify(schema.const)}, reçu ${JSON.stringify(v)}`);
  if (schema.enum && !schema.enum.includes(v)) err.push(`${ou} : ${JSON.stringify(v)} hors enum ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
    const ok = types.some(x => x === t || (x === 'number' && t === 'integer'));
    if (!ok) err.push(`${ou} : type ${t}, attendu ${types.join('|')}`);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (!(r in v)) err.push(`${ou} : champ requis absent ${r}`);
    for (const [k, x] of Object.entries(v)) {
      if (k in props) err.push(...valider(props[k], x, racineSchema, `${ou}.${k}`));
      else if (schema.additionalProperties === false) err.push(`${ou} : champ en trop ${k}`);
    }
  }
  return err;
}

const KEBAB = {
  PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', UserPromptSubmit: 'user-prompt-submit',
  SessionStart: 'session-start', Stop: 'stop', PostCompact: 'post-compact', SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
};

function schemaDe(evt, sens) { return SCHEMAS[`${KEBAB[evt]}.command.${sens}`]; }

function verifierSortie(evt, out) {
  if (!out) return null;
  let obj;
  assert.doesNotThrow(() => { obj = JSON.parse(out); }, `sortie ${evt} non JSON : ${out.slice(0, 200)}`);
  const s = schemaDe(evt, 'output');
  const e = valider(s, obj, s);
  assert.deepEqual(e, [], `sortie ${evt} non conforme au schéma 0.155 : ${e.join(' ; ')}`);
  if (obj.decision === 'block') assert.ok(typeof obj.reason === 'string' && obj.reason.trim(), 'decision:block exige une reason non vide');
  const hso = obj.hookSpecificOutput;
  if (hso && hso.permissionDecision === 'deny') assert.ok(hso.permissionDecisionReason && hso.permissionDecisionReason.trim(), 'deny exige une raison non vide');
  if (hso && typeof hso.additionalContext === 'string') assert.ok(hso.additionalContext.length <= PLAFOND, 'additionalContext > 9000');
  if (typeof obj.reason === 'string') assert.ok(obj.reason.length <= PLAFOND, 'reason > 9000');
  return obj;
}

// ---------------------------------------------------------------------------
// Payloads conformes (validés contre le schéma d'entrée avant envoi)

let seq = 0;
function payload(evt, extra) {
  const commun = { session_id: 'sess-a', cwd: CWD, hook_event_name: evt, model: 'gpt-5.5', transcript_path: null };
  const parEvt = {
    UserPromptSubmit: { permission_mode: 'default', turn_id: 'turn-1', prompt: 'bonjour' },
    SessionStart: { permission_mode: 'default', source: 'startup' },
    PreToolUse: { permission_mode: 'default', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call-' + (++seq) },
    PostToolUse: { permission_mode: 'default', turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { output: '' }, tool_use_id: 'call-' + (++seq) },
    Stop: { permission_mode: 'default', turn_id: 'turn-1', stop_hook_active: false, last_assistant_message: 'fini' },
    PostCompact: { turn_id: 'turn-1', trigger: 'auto' },
    SubagentStart: { permission_mode: 'default', turn_id: 'turn-1', agent_id: 'ag-1', agent_type: 'worker' },
    SubagentStop: { permission_mode: 'default', turn_id: 'turn-1', agent_id: 'ag-1', agent_type: 'worker', agent_transcript_path: null, last_assistant_message: 'rapport', stop_hook_active: false },
  }[evt];
  const p = Object.assign({}, commun, parEvt, extra || {});
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  const s = schemaDe(evt, 'input');
  const e = valider(s, p, s);
  assert.deepEqual(e, [], `payload ${evt} simulé non conforme au schéma d'entrée : ${e.join(' ; ')}`);
  return p;
}

// ---------------------------------------------------------------------------
// Exécution

function dossier(nom) {
  const d = path.join(RUN, nom);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(maisonDe(d), 'contexte'), { recursive: true });
  fs.mkdirSync(path.join(maisonDe(d), 'history'), { recursive: true });
  return d;
}
const maisonDe = d => path.join(d, '.agent-memory-ledger');
const racineDe = d => path.join(maisonDe(d), 'contexte');

function envPour(d) {
  // CONTEXT_LEDGER_BUDGET_MS : les bancs saturent eux-mêmes la machine (un processus par hook) ; le budget
  // de temps réel d'un hook (8 s pour la fin de tour) n'est mesuré que par le test qui lui est dédié.
  const env = Object.assign({ CONTEXT_LEDGER_BUDGET_MS: '600000' }, process.env, { AGENT_MEMORY_LEDGER_HOME: maisonDe(d) });
  delete env.CONTEXT_LEDGER_CODEX_HOOK;
  delete env.CONTEXT_LEDGER_EN_MUTATION;
  return env;
}

// Processus fils asynchrone (les bancs tournent en parallèle : le démarrage de Node coûte ~1 s ici).
function lancer(args, env, entree, cwd) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, args, { env, cwd, windowsHide: true });
    let out = ''; let err = '';
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
    c.stdout.on('data', x => (out += x));
    c.stderr.on('data', x => (err += x));
    c.on('close', code => resolve({ code, out, err }));
    c.stdin.end(entree === undefined ? '' : entree);
  });
}

// plus : variables d'environnement propres à cet appel (les bancs tournent en parallèle : jamais process.env).
async function hook(d, p, script = HOOK, plus = null) {
  const r = await lancer([script], Object.assign(envPour(d), plus || {}), typeof p === 'string' ? p : JSON.stringify(p), d);
  const evt = typeof p === 'string' ? 'PreToolUse' : p.hook_event_name;
  assert.equal(r.code, 0, `code de sortie ${r.code} (${evt}) : ${r.err}`);
  const json = verifierSortie(evt, r.out);
  return { out: r.out, json, err: r.err };
}

async function hookAsync(d, p, script = HOOK) {
  const r = await lancer([script], envPour(d), JSON.stringify(p), d);
  return { code: r.code, out: r.out };
}

async function cli(d, args, script = HOOK) {
  return lancer([script, ...args], envPour(d), '', d);
}

// Opérations du noyau en processus (préparation rapide), sur la racine du test.
const core = require(path.join(__dirname, '..', 'scripts', 'lib', 'context-ledger-core.js'));
function avecRacine(d, fn) {
  const avant = process.env.AGENT_MEMORY_LEDGER_HOME;
  process.env.AGENT_MEMORY_LEDGER_HOME = maisonDe(d);
  try { return fn(); } finally {
    if (avant === undefined) delete process.env.AGENT_MEMORY_LEDGER_HOME; else process.env.AGENT_MEMORY_LEDGER_HOME = avant;
  }
}

function etat(d, agent = 'codex', projet = PROJET) {
  const f = path.join(racineDe(d), '.etat', `${projet}.${agent}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
const vue = (d, agent = 'codex', projet = PROJET) => fs.readFileSync(path.join(racineDe(d), `${projet}.${agent}.md`), 'utf8');
const ctx = r => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext : '');
const idDe = (texte, type) => { const m = new RegExp(`\\b${type}-\\d{4}\\b`).exec(texte); return m ? m[0] : null; };
const nouveauM = r => { const m = /Nouveau message (M-\d{4})/.exec(ctx(r)); return m ? m[1] : null; };

// Fichier de preuve simulé (CRLF possible) sous la base de test.
function ecrirePreuve(d, nom, lignes, crlf = false) {
  const f = path.join(maisonDe(d), 'history', nom);
  fs.appendFileSync(f, lignes.join(crlf ? '\r\n' : '\n') + (crlf ? '\r\n' : '\n'));
  return f;
}

// Message humain + ligne C liée (via la CLI), en partant d'une base de réconciliation établie.
// La base du réconciliateur est établie par un processus détaché au premier événement : l'attendre.
async function attendreBase(d, agent = 'codex') {
  const f = path.join(racineDe(d), `.reconciliation-${agent}.json`);
  const m = path.join(racineDe(d), `.reconciliation-${agent}.base-en-cours`);
  const limite = Date.now() + 60000;
  while (!(fs.existsSync(f) && !fs.existsSync(m))) {
    if (Date.now() > limite) throw new Error(`base du réconciliateur ${agent} jamais établie`);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function preparer(d, texte = 'corrige le bug du formulaire', script = HOOK, turn = 'turn-1') {
  const r = await hook(d, payload('UserPromptSubmit', { prompt: texte, turn_id: turn }), script);
  await attendreBase(d, 'codex');
  const m = nouveauM(r);
  assert.ok(m, 'M créé');
  const a = await cli(d, ['ajouter', '--projet', PROJET, '--de', m, texte], script);
  assert.equal(a.code, 0, a.err);
  const c = idDe(a.out, 'C');
  assert.ok(c, 'C créé');
  return { m, c };
}

// ---------------------------------------------------------------------------
// Bancs

describe('adaptateurs Codex et Codex Home', CONCURRENCE, () => {
  test('agent déduit de l\'emplacement du script : scripts/codex -> codex', async () => {
    const d = dossier('agent');
    await hook(d, payload('UserPromptSubmit', { prompt: 'message codex' }));
    const e1 = etat(d, 'codex');
    assert.equal(Object.values(e1.demandes)[0].texte, 'message codex');
    assert.equal(Object.keys(e1.demandes).length, 1);
    assert.equal(etat(d, 'claude'), null, 'rien pour un autre agent');
  });

  test('message humain : M créé mot pour mot, contexte injecté conforme', async () => {
    const d = dossier('message');
    const texte = 'Corrige « tout » :\r\n- le bouton\n- l\'accent é à ç   ';
    const r = await hook(d, payload('UserPromptSubmit', { prompt: texte }));
    const e = etat(d);
    const [m] = Object.keys(e.demandes);
    assert.equal(e.demandes[m].texte, texte);
    assert.equal(e.demandes[m].statut, 'a-trier');
    const c = ctx(r);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(c, new RegExp(`Nouveau message ${m}`));
    assert.ok(c.includes(`node "${HOOK.replace(/\\/g, '/')}" ajouter --projet ${PROJET} --de ${m} "texte mot pour mot"`), 'commande ajouter exacte (chemin du script et projet)');
    assert.match(c, /une seule source par problème/);
    assert.ok(!c.includes('\u2014'), 'tiret cadratin interdit');
  });

  test('prompts non humains ignorés (task-notification, hook_prompt, Message Type, subagent_notification, turn_aborted)', async () => {
    const d = dossier('non-humains');
    for (const p of ['<task-notification>x</task-notification>', '  <hook_prompt hook_run_id="stop:15:x">raison</hook_prompt>',
      'Message Type: NEW_TASK\nfais X', '<subagent_notification>fini</subagent_notification>', '<turn_aborted>']) {
      const r = await hook(d, payload('UserPromptSubmit', { prompt: p }));
      assert.equal(r.out, '', `sortie inattendue pour ${p}`);
    }
    const e = etat(d);
    assert.ok(!e || Object.keys(e.demandes).length === 0, 'aucun M ne doit être créé');
  });

  test('sous-agent (agent_id ou agent_type seul) : rien enregistré, jamais la liste, sa consigne une seule fois', async () => {
    const d = dossier('sous-agent');
    const r1 = await hook(d, payload('UserPromptSubmit', { prompt: 'tâche', agent_id: 'a1', agent_type: 'worker' }));
    const r2 = await hook(d, payload('UserPromptSubmit', { prompt: 'tâche', agent_type: 'worker' }));
    const r3 = await hook(d, payload('PostToolUse', { agent_id: 'a1' }));
    const r4 = await hook(d, payload('PostCompact', { agent_id: 'a1' }));
    // Son démarrage n'a pas été vu : son premier événement lui donne sa consigne, pas la liste.
    assert.ok(ctx(r1).startsWith('Fichier contexte : tu es un sous-agent. Ta fiche : '), ctx(r1).slice(0, 200));
    assert.ok(!/Nouveau message M-|À trier :|Ouvert :/.test(ctx(r1)), 'ni message enregistré, ni liste');
    assert.equal(r2.out + r3.out + r4.out, '');
    assert.equal(etat(d), null);
    assert.ok(!fs.existsSync(path.join(racineDe(d), '.sessions', 'reinject-codex-sess-a')), 'pas de drapeau pour un sous-agent');
  });

  test('dédoublonnage : même turn_id et même texte -> un seul M ; message envoyé en cours de tour -> gardé', async () => {
    const d = dossier('doublon');
    await hook(d, payload('UserPromptSubmit', { prompt: 'A', turn_id: 't1' }));
    const r = await hook(d, payload('UserPromptSubmit', { prompt: 'A', turn_id: 't1' }));
    assert.equal(r.out, '');
    await hook(d, payload('UserPromptSubmit', { prompt: 'B ajouté en cours de tour', turn_id: 't1' }));
    const textes = Object.values(etat(d).demandes).map(x => x.texte).sort();
    assert.deepEqual(textes, ['A', 'B ajouté en cours de tour']);
  });

  test('SessionStart (startup, resume, clear, compact, fork) : vue réinjectée, conforme', async () => {
    const d = dossier('session');
    const { c } = await preparer(d);
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      const r = await hook(d, payload('SessionStart', { source }));
      assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(ctx(r), /fait foi pour ce qui reste, pas le résumé de compactage/);
      assert.match(ctx(r), new RegExp(c));
      assert.match(ctx(r), /une seule source par problème/);
    }
  });

  test('SubagentStart : consigne au sous-agent (sa fiche, sa mission seulement, liste en lecture), conforme', async () => {
    const d = dossier('subagent-start');
    const r = await hook(d, payload('SubagentStart'));
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'SubagentStart');
    const c = ctx(r);
    assert.match(c, /^Fichier contexte : tu es un sous-agent \(ligne C-\d{4} de l'orchestrateur\)\. Ta fiche : /);
    // Codex 0.155 : le message de lancement est chiffré, le hook ne peut pas copier la mission.
    assert.match(c, /Ta mission n'a pas pu y être copiée automatiquement : commence par la recopier mot pour mot avec `node ".+context-ledger\.js" note --fiche ag-1 --genre mission "\.\.\."`/);
    assert.match(c, /\nTa mission est celle de ton lancement, rien d'autre : .+ ils ne te donnent aucun travail\.\n/);
    assert.match(c, /elle ne se modifie pas : ajouter, etat, sans-travail et abandon lui sont réservés\./);
    assert.match(c, /--genre deja-fait "C-NNNN : la preuve"/);
    assert.ok(c.length <= PLAFOND);
  });

  test('CLI ajouter --de M : C lié à M, M converti', async () => {
    const d = dossier('cli');
    const { m, c } = await preparer(d);
    const e = etat(d);
    assert.equal(e.lignes[c].de, m);
    assert.equal(e.demandes[m].statut, 'converti');
    assert.match(vue(d), new RegExp(`- ${c} \\|`));
  });

  test('preuve par contenu : apply_patch sur l\'historique avec [ctx C] -> fait et retiré ; [ctx C partiel] -> en-cours', async () => {
    const d = dossier('preuve-fichier');
    ecrirePreuve(d, 'infra.codex.md', ['# historique', '- ancienne ligne']);
    const { c } = await preparer(d);
    const { c: c2 } = await preparer(d, 'deuxième travail', HOOK, 'turn-2');
    const f = ecrirePreuve(d, 'infra.codex.md', [`- 2026-09-24 | fix | formulaire corrigé [ctx ${c}]`, `- avance [ctx ${c2} partiel]`]);
    const patch = `*** Begin Patch\n*** Update File: ${f}\n@@\n+- formulaire corrigé [ctx ${c}]\n*** End Patch`;
    const r = await hook(d, payload('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: { output: 'Success' } }));
    const e = etat(d);
    assert.equal(e.lignes[c].statut, 'fait');
    assert.match(e.lignes[c].preuve, /infra\.codex\.md/);
    assert.equal(e.lignes[c2].statut, 'en-cours');
    assert.ok(!vue(d).includes(`- ${c} |`), 'la ligne faite ne doit plus apparaître dans la vue');
    assert.match(vue(d), new RegExp(`- ${c2} \\|`));
    assert.match(ctx(r), new RegExp(`Retiré sur preuve .*${c}`));
    const r2 = await hook(d, payload('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } }));
    assert.equal(r2.out, '', 'rien de nouveau : aucune réinjection');
  });

  test('réconciliateur : un marqueur déjà présent au premier passage ne compte pas (base), un nouveau oui', async () => {
    const d = dossier('base-reconciliation');
    const e0 = await cli(d, ['ajouter', '--projet', PROJET, 'travail découvert en route']);
    const c = idDe(e0.out, 'C');
    ecrirePreuve(d, 'infra.codex.md', [`- vieille mention [ctx ${c}]`]);
    await hook(d, payload('SessionStart')); // premier passage = base (processus détaché)
    await attendreBase(d);
    assert.equal(etat(d).lignes[c].statut, 'ouvert');
    await hook(d, payload('PostToolUse'));
    assert.equal(etat(d).lignes[c].statut, 'ouvert');
    ecrirePreuve(d, 'infra.codex.md', [`- fait maintenant [ctx ${c}]`]);
    await hook(d, payload('PostToolUse'));
    assert.equal(etat(d).lignes[c].statut, 'fait');
  });

  test('première base du réconciliateur : établie par un processus détaché, un marqueur récent empêche un second lancement', async () => {
    const d = dossier('base-detachee');
    const marqueur = path.join(racineDe(d), '.reconciliation-codex.base-en-cours');
    const etatRec = path.join(racineDe(d), '.reconciliation-codex.json');
    fs.writeFileSync(marqueur, 'base déjà en cours ailleurs');
    await hook(d, payload('PostToolUse'));
    await new Promise(r => setTimeout(r, 3000));
    assert.ok(!fs.existsSync(etatRec), 'aucune base lancée tant qu\'une autre est en cours');
    fs.unlinkSync(marqueur);
    await hook(d, payload('PostToolUse'));
    await attendreBase(d);
    assert.ok(fs.existsSync(etatRec) && !fs.existsSync(marqueur));
    const r = await lancer([HOOK, '--reconcilier-base'], envPour(d), '', d);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /base du réconciliateur établie \(codex\)/);
  });

  test('fichiers CRLF : marqueur trouvé dans un historique CRLF ; vue en CRLF non considérée comme modifiée', async () => {
    const d = dossier('crlf');
    ecrirePreuve(d, 'Memory-x.codex.md', ['# base'], true);
    const { c } = await preparer(d);
    const md = path.join(racineDe(d), `${PROJET}.codex.md`);
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/\n/g, '\r\n'));
    await hook(d, payload('PostToolUse'));
    const journal = fs.readFileSync(path.join(racineDe(d), `${PROJET}.codex.journal.log`), 'utf8');
    assert.ok(!journal.includes('restauration-vue'), 'une vue en CRLF au contenu identique ne doit pas être « restaurée »');
    assert.ok(fs.readFileSync(md, 'utf8').includes('\r\n'), 'vue CRLF laissée telle quelle');
    ecrirePreuve(d, 'Memory-x.codex.md', [`- ok [ctx ${c}]`], true);
    await hook(d, payload('PostToolUse'));
    assert.equal(etat(d).lignes[c].statut, 'fait');
  });

  test('ID d\'un autre agent ignoré', async () => {
    const d = dossier('autre-agent');
    await hook(d, payload('SessionStart')); // base du réconciliateur
    await attendreBase(d);
    const c = avecRacine(d, () => core.ajouterLigne({ projet: PROJET, agent: 'claude', texte: 'travail de Claude', de: null }));
    ecrirePreuve(d, 'infra.claude.md', [`- fait [ctx ${c}]`]);
    const r = await hook(d, payload('PostToolUse'));
    assert.equal(r.out, '');
    assert.equal(etat(d, 'claude').lignes[c].statut, 'ouvert', 'Codex ne touche pas une ligne de Claude');
  });

  test('commit avec [ctx C] : exec_command direct et exec en code mode -> fait', async () => {
    const d = dossier('commit');
    const repo = path.join(d, 'depot');
    const sansHooks = path.join(d, 'sans-hooks');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(sansHooks, { recursive: true });
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['config', 'core.hooksPath', sansHooks]);
    git(['config', 'user.name', 'banc']);
    git(['config', 'user.email', 'banc@example.invalid']);
    const { c } = await preparer(d);
    const { c: c2 } = await preparer(d, 'second', HOOK, 'turn-2');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', `fix(banc): premier [ctx ${c}]`]);
    const r = await hook(d, payload('PostToolUse', {
      tool_name: 'Bash', tool_input: { command: `git commit -m "fix(banc): premier [ctx ${c}]"`, workdir: repo }, tool_response: { output: 'ok' },
    }));
    assert.equal(etat(d).lignes[c].statut, 'fait');
    assert.match(etat(d).lignes[c].preuve, /^commit [0-9a-f]{40}/);
    assert.match(ctx(r), new RegExp(c));
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
    git(['add', 'b.txt']);
    git(['commit', '-q', '-m', `fix(banc): second [ctx ${c2}]`]);
    const code = `const r = await tools.exec_command({ cmd: "git commit -m \\"fix(banc): second [ctx ${c2}]\\"", workdir: ${JSON.stringify(repo)} });\ntext(r.output);`;
    await hook(d, payload('PostToolUse', { tool_name: 'exec', tool_input: { code }, tool_response: { output: 'ok' } }));
    assert.equal(etat(d).lignes[c2].statut, 'fait');
  });

  test('ligne effacée à la main du .md -> restaurée au passage suivant', async () => {
    const d = dossier('restauration');
    const { c } = await preparer(d);
    const md = path.join(racineDe(d), `${PROJET}.codex.md`);
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8').split('\n').filter(l => !l.includes(c)).join('\n'));
    assert.ok(!fs.readFileSync(md, 'utf8').includes(c));
    await hook(d, payload('PostToolUse'));
    assert.match(fs.readFileSync(md, 'utf8'), new RegExp(`- ${c} \\|`));
  });

  // Règle : la citation doit venir d'un message écrit APRÈS la création de la ligne.
  test('abandon : citation absente ou tirée de la demande d\'origine refusée, contre-ordre postérieur accepté', async () => {
    const d = dossier('abandon');
    const { c } = await preparer(d, 'refais le module de paiement cette semaine');
    const r1 = await cli(d, ['abandon', '--projet', PROJET, c, 'citation inventée par l\'agent']);
    assert.notEqual(r1.code, 0);
    assert.equal(etat(d).lignes[c].statut, 'ouvert');
    const r0 = await cli(d, ['abandon', '--projet', PROJET, c, 'refais le module de paiement']);
    assert.notEqual(r0.code, 0, 'la demande d\'origine ne doit pas permettre l\'abandon : ' + r0.out);
    assert.match(r0.err, /message antérieur à la ligne/);
    assert.equal(etat(d).lignes[c].statut, 'ouvert');
    await hook(d, payload('UserPromptSubmit', { prompt: 'laisse tomber le module de paiement pour cette semaine', turn_id: 'turn-2' }));
    const r2 = await cli(d, ['abandon', '--projet', PROJET, c, 'laisse tomber le module de paiement']);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(etat(d).lignes[c].statut, 'abandon-utilisateur');
  });

  test('PostCompact : sortie vide conforme, drapeau posé ; le prochain UserPromptSubmit (même non humain) réinjecte et l\'efface', async () => {
    const d = dossier('post-compact');
    const { c } = await preparer(d);
    const r = await hook(d, payload('PostCompact'));
    assert.equal(r.out, '');
    const drapeau = path.join(racineDe(d), '.sessions', 'reinject-codex-sess-a');
    assert.ok(fs.existsSync(drapeau), 'drapeau posé');
    const r2 = await hook(d, payload('UserPromptSubmit', { prompt: '<hook_prompt hook_run_id="stop:1:x">suite</hook_prompt>' }));
    assert.match(ctx(r2), /Réinjection après compactage/);
    assert.match(ctx(r2), new RegExp(c));
    assert.ok(!fs.existsSync(drapeau), 'drapeau effacé');
    const r3 = await hook(d, payload('UserPromptSubmit', { prompt: '<hook_prompt hook_run_id="stop:1:x">suite</hook_prompt>' }));
    assert.equal(r3.out, '', 'une seule réinjection');
  });

  test('PostCompact puis PostToolUse : la réinjection passe par PostToolUse', async () => {
    const d = dossier('post-compact-outil');
    const { c } = await preparer(d);
    await hook(d, payload('PostCompact', { trigger: 'manual' }));
    const r = await hook(d, payload('PostToolUse'));
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(ctx(r), /Réinjection après compactage/);
    assert.match(ctx(r), new RegExp(c));
    assert.equal((await hook(d, payload('PostToolUse'))).out, '');
  });

  test('Stop : stop_hook_active -> rien ; rappel decision:block une seule fois par message ; rien si cité', async () => {
    const d = dossier('stop');
    await hook(d, payload('UserPromptSubmit', { prompt: 'refais la page contact', turn_id: 't9' }));
    assert.equal((await hook(d, payload('Stop', { turn_id: 't9', stop_hook_active: true }))).out, '');
    const r = await hook(d, payload('Stop', { turn_id: 't9', last_assistant_message: null }));
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /encore à trier/);
    assert.equal((await hook(d, payload('Stop', { turn_id: 't9' }))).out, '', 'un seul rappel par message');
    // Le message de t9 est trié (sinon il est rappelé à nouveau au message humain suivant, voir le banc suivant).
    const m9 = Object.keys(etat(d).demandes)[0];
    assert.equal((await cli(d, ['sans-travail', '--projet', PROJET, m9, 'question déjà traitée'])).code, 0);
    // Tour suivant : ligne créée pendant le tour et citée dans la réponse -> pas de rappel.
    const r2 = await hook(d, payload('UserPromptSubmit', { prompt: 'ajoute un test', turn_id: 't10' }));
    const m = nouveauM(r2);
    const c = idDe((await cli(d, ['ajouter', '--projet', PROJET, '--de', m, 'ajoute un test'])).out, 'C');
    assert.equal((await hook(d, payload('Stop', { turn_id: 't10', last_assistant_message: `Reste ${c} : en cours.` }))).out, '');
  });

  // Le Stop est le canal le plus sûr vers le modèle Codex.
  test('Stop Codex : deux messages dans le même tour -> les deux rappelés ; vue (lignes ouvertes des tours précédents) jointe', async () => {
    const d = dossier('stop-session');
    const { c } = await preparer(d, 'vieille demande ouverte', HOOK, 't1');
    assert.equal((await hook(d, payload('Stop', { turn_id: 't1', last_assistant_message: `En cours ${c}` }))).out, '');
    const r1 = await hook(d, payload('UserPromptSubmit', { prompt: 'premier message : refais le menu', turn_id: 't2' }));
    const r2 = await hook(d, payload('UserPromptSubmit', { prompt: 'deuxième message envoyé en cours de tour', turn_id: 't2' }));
    const m1 = nouveauM(r1); const m2 = nouveauM(r2);
    const s = await hook(d, payload('Stop', { turn_id: 't2', last_assistant_message: 'fini' }));
    assert.equal(s.json.decision, 'block');
    assert.ok(s.json.reason.includes(m1) && s.json.reason.includes(m2), `rappel incomplet : ${s.json.reason.slice(0, 300)}`);
    assert.ok(s.json.reason.includes(c), 'la ligne ouverte d\'un tour précédent doit accompagner le rappel');
    assert.equal((await hook(d, payload('Stop', { turn_id: 't2' }))).out, '', 'un seul rappel par message humain');
    // Message humain suivant, converti et cité : m1 et m2 toujours à trier -> rappelés une fois de plus.
    const r3 = await hook(d, payload('UserPromptSubmit', { prompt: 'ajoute un test', turn_id: 't3' }));
    const c3 = idDe((await cli(d, ['ajouter', '--projet', PROJET, '--de', nouveauM(r3), 'ajoute un test'])).out, 'C');
    const s3 = await hook(d, payload('Stop', { turn_id: 't3', last_assistant_message: `Reste ${c3}.` }));
    assert.equal(s3.json.decision, 'block');
    assert.match(s3.json.reason, new RegExp(`de cette session encore à trier : ${m1}, ${m2}`));
    assert.equal((await hook(d, payload('Stop', { turn_id: 't3', last_assistant_message: `Reste ${c3}.` }))).out, '');
  });

  // Constaté dans une session réelle de Codex : « Fichier contexte : rappel de fin de tour, hook timed out
  // after 10s ». Un hook tué ne rend rien. Mesuré : au repos ce hook prend moins d'une seconde ; sous forte
  // charge le démarrage de node mange le délai. Quand le budget est épuisé, le rappel sort quand même et les
  // mises à jour qui le précèdent (preuves, fins de sous-agents) attendent le prochain événement.
  test('Stop Codex : budget de temps épuisé -> le rappel sort quand même, les mises à jour attendent le prochain événement', async () => {
    const d = dossier('stop-budget');
    const { c } = await preparer(d, 'vieille demande ouverte', HOOK, 't1');
    const r = await hook(d, payload('UserPromptSubmit', { prompt: 'second message, pas encore trié', turn_id: 't2' }));
    const m2 = nouveauM(r);
    ecrirePreuve(d, 'infra.codex.md', [`- vieille demande faite [ctx ${c}]`]);
    const s = await hook(d, payload('Stop', { turn_id: 't2', last_assistant_message: 'fini' }), HOOK, { CONTEXT_LEDGER_BUDGET_MS: '1' });
    assert.equal(s.json.decision, 'block', 'le rappel de fin de tour sort, budget épuisé ou non');
    assert.ok(s.json.reason.includes(m2), s.json.reason.slice(0, 300));
    assert.equal(etat(d).lignes[c].statut, 'ouvert', 'la preuve n\'a pas été cherchée : plus de temps');
    await hook(d, payload('PostToolUse'));
    assert.equal(etat(d).lignes[c].statut, 'fait', 'elle l\'est à l\'événement suivant');
  });

  test('CLI sous charge : verrou du fichier contexte tenu 7,5 s (> 3 s du noyau) -> ajouter réussit quand même', async () => {
    const d = dossier('cli-verrou');
    const a0 = await cli(d, ['ajouter', '--projet', PROJET, 'ligne témoin']);
    assert.equal(a0.code, 0, a0.err);
    const verrou = path.join(racineDe(d), '.etat', `${PROJET}.codex.json.lock`);
    fs.writeFileSync(verrou, 'autre processus');
    const liberer = new Promise(r => setTimeout(() => { try { fs.unlinkSync(verrou); } catch (_) { /* rien */ } r(); }, 7500));
    const [a] = await Promise.all([cli(d, ['ajouter', '--projet', PROJET, 'ligne pendant le verrou']), liberer]);
    assert.equal(a.code, 0, `ajouter a échoué sous verrou : ${a.err}`);
    assert.ok(Object.values(etat(d).lignes).some(l => l.texte === 'ligne pendant le verrou'));
  });

  test('incident disque (.sessions inutilisable) : message gardé en secours et modèle prévenu, jamais de perte silencieuse', async () => {
    const d = dossier('secours');
    fs.writeFileSync(path.join(racineDe(d), '.sessions'), 'fichier à la place du dossier');
    const r = await hook(d, payload('UserPromptSubmit', { prompt: 'message important pendant un incident disque', turn_id: 'ti' }));
    const f = path.join(racineDe(d), '.secours-codex.jsonl');
    assert.ok(fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('message important pendant un incident disque'), 'message perdu');
    assert.match(ctx(r), /n'a PAS pu être enregistré/);
    assert.match(ctx(r), /\.secours-codex\.jsonl/);
  });

  test('plafond : additionalContext <= 9000 avec 80 lignes longues, mention « lignes de plus », règle 6 bis gardée', async () => {
    const d = dossier('plafond');
    avecRacine(d, () => { // synchrone : aucun autre banc ne s'intercale pendant le changement de racine
      for (let i = 0; i < 80; i++) core.ajouterLigne({ projet: PROJET, agent: 'codex', texte: `travail ${i} ` + 'x'.repeat(380), de: null });
    });
    const r = await hook(d, payload('UserPromptSubmit', { prompt: 'où en est-on ?' }));
    const c = ctx(r);
    assert.ok(c.length <= PLAFOND, `taille ${c.length}`);
    assert.match(c, /\(\d+ lignes de plus : node /);
    assert.match(c, /une seule source par problème/);
    assert.match(c, /Nouveau message M-\d{4}/);
    await hook(d, payload('PostCompact'));
    const r2 = await hook(d, payload('PostToolUse'));
    assert.ok(ctx(r2).length <= PLAFOND);
    assert.match(ctx(r2), /Réinjection après compactage/);
    assert.match(ctx(r2), /\(\d+ lignes de plus : node /);
  });

  test('verrou bloqué : le message n\'est jamais perdu (mis en attente, enregistré au prochain événement)', async () => {
    const d = dossier('attente');
    await hook(d, payload('SessionStart')); // lie la session
    const verrou = path.join(racineDe(d), '.sessions', 'codex-sess-a.json.lock');
    fs.writeFileSync(verrou, 'autre processus');
    const rafraichir = setInterval(() => { try { const t = new Date(); fs.utimesSync(verrou, t, t); } catch (_) { /* rien */ } }, 500);
    let r;
    try { r = await hook(d, payload('UserPromptSubmit', { prompt: 'message pendant un verrou occupé', turn_id: 'tv' })); } finally { clearInterval(rafraichir); }
    fs.unlinkSync(verrou);
    assert.match(ctx(r), /gardé en attente/);
    const e0 = etat(d);
    assert.ok(!e0 || !Object.values(e0.demandes).some(x => x.texte === 'message pendant un verrou occupé'), 'pas encore enregistré');
    await hook(d, payload('PostToolUse'));
    const e = etat(d);
    const ms = Object.values(e.demandes).filter(x => x.texte === 'message pendant un verrou occupé');
    assert.equal(ms.length, 1, 'enregistré une seule fois');
    assert.equal(ms[0].statut, 'a-trier');
    assert.ok(!fs.existsSync(path.join(racineDe(d), '.sessions', 'en-attente-codex.jsonl')), 'file d\'attente vidée');
  });

  test('concurrence : 10 processus en parallèle (deux sessions) -> 10 M distincts, aucun perdu', async () => {
    const d = dossier('concurrence');
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(hookAsync(d, payload('UserPromptSubmit', { prompt: `message ${i}`, turn_id: `t${i}`, session_id: i % 2 ? 'sess-b' : 'sess-a' })));
    }
    const res = await Promise.all(jobs);
    res.forEach(x => assert.equal(x.code, 0));
    const ids = Object.keys(etat(d, 'codex').demandes);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
    const textes = Object.values(etat(d, 'codex').demandes).map(x => x.texte).sort();
    assert.deepEqual(textes, Array.from({ length: 10 }, (_, i) => `message ${i}`).sort());
    res.forEach(x => verifierSortie('UserPromptSubmit', x.out));
  });
});

// ---------------------------------------------------------------------------
// Livraisons des sous-agents. Rollouts simulés aux formes relevées dans des
// rollouts réels (codex-cli 0.155.0-alpha.16) ; payloads conformes au schéma d'entrée 0.155.

function rolloutEnfant(d, fil, { chemin, surnom, role, profondeur = 1 }) {
  const f = path.join(d, `rollout-${fil}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({
    timestamp: '2026-09-27T23:22:03.521Z', ordinal: 0, type: 'session_meta',
    payload: {
      session_id: 'sess-a', id: fil, parent_thread_id: 'sess-a', timestamp: '2026-09-27T23:22:03.242Z', cwd: CWD,
      runtime_workspace_roots: [CWD], originator: 'Codex Desktop', cli_version: '0.155.0-alpha.16.4',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sess-a', depth: profondeur, agent_path: chemin, agent_nickname: surnom, agent_role: role } } },
      thread_source: 'subagent', agent_nickname: surnom, agent_role: role, agent_path: chemin, model_provider: 'openai',
      base_instructions: { text: 'instructions '.repeat(1500) },
    },
  }) + '\n');
  return f;
}

// Ce que Codex écrit dans le rollout du sous-agent quand le texte d'un hook lui parvient (forme relevée dans
// 11 rollouts réels le 2026-10-02 : response_item, message du rôle developer).
const consigneEcrite = texte => JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: texte }] } }) + '\n';

function rolloutParent(d) {
  const f = path.join(d, 'rollout-parent.jsonl');
  fs.writeFileSync(f, JSON.stringify({ timestamp: '2026-09-27T23:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'sess-a', id: 'sess-a', source: 'vscode' } }) + '\n');
  return f;
}

function reponseFinale(auteur) {
  return JSON.stringify({
    timestamp: new Date().toISOString(), ordinal: 9, type: 'response_item',
    payload: { type: 'agent_message', id: 'amsg_1', author: auteur, recipient: '/root', content: [{ type: 'input_text', text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${auteur}\nPayload:\nrapport` }] },
  }) + '\n';
}

// Un message humain, aussitôt classé : les rappels de fin de tour ne portent plus que sur les livraisons.
async function tourTrie(d, parent, turn, texte) {
  const r = await hook(d, payload('UserPromptSubmit', { prompt: texte, turn_id: turn, transcript_path: parent }));
  const m = nouveauM(r);
  assert.ok(m, 'M créé');
  assert.equal((await cli(d, ['sans-travail', '--projet', PROJET, m, 'traité dans le tour'])).code, 0);
}

describe('livraisons des sous-agents (Codex)', CONCURRENCE, () => {
  test('sous-agents : inscrit au lancement, « à traiter » à sa fin, le Stop bloque à chaque fin de tour jusqu\'à la preuve', async () => {
    const d = dossier('livraisons');
    const parent = rolloutParent(d);
    const e1 = rolloutEnfant(d, 'th-1', { chemin: '/root/export_pdf', surnom: 'Ada', role: 'worker' });
    const e2 = rolloutEnfant(d, 'th-2', { chemin: '/root/revue_export', surnom: 'Blaise', role: 'code-reviewer' });
    const e3 = rolloutEnfant(d, 'th-3', { chemin: '/root/export_pdf/sous_tache', surnom: 'Euler', role: 'worker', profondeur: 2 });
    await tourTrie(d, parent, 't1', 'lance deux agents');
    await attendreBase(d);
    const r1 = await hook(d, payload('SubagentStart', { agent_id: 'th-1', agent_type: 'worker', transcript_path: e1 }));
    assert.match(ctx(r1), /^Fichier contexte : tu es un sous-agent \(ligne C-\d{4} de l'orchestrateur\)\. Ta fiche : /);
    await hook(d, payload('SubagentStart', { agent_id: 'th-2', agent_type: 'code-reviewer', transcript_path: e2 }));
    await hook(d, payload('SubagentStart', { agent_id: 'th-1', agent_type: 'worker', transcript_path: e1 })); // second démarrage du même fil
    await hook(d, payload('SubagentStart', { agent_id: 'th-3', agent_type: 'worker', transcript_path: e3 })); // lancé par un sous-agent
    let e = etat(d);
    assert.equal(Object.keys(e.lignes).length, 2, 'une ligne par sous-agent de l\'orchestrateur, aucune pour un sous-agent de sous-agent');
    const [c1, c2] = Object.keys(e.lignes).sort();
    assert.equal(e.lignes[c1].texte, '[agent] « export_pdf (Ada) » (worker, th-1) : à sa fin, lire son résultat, le vérifier et l\'intégrer.');
    assert.equal(e.lignes[c1].statut, 'en-cours');
    assert.match(e.lignes[c1].note, /^agent en cours depuis \d{4}-/);
    // Fin de tour, sous-agents encore en cours : aucun rappel de livraison.
    const s1 = await hook(d, payload('Stop', { turn_id: 't1', last_assistant_message: 'Agents lancés.', transcript_path: parent }));
    assert.ok(!/Sous-agents TERMINÉS/.test(s1.out));
    // Le premier finit : événement SubagentStop (sortie vide, conforme).
    assert.equal((await hook(d, payload('SubagentStop', { agent_id: 'th-1', agent_type: 'worker', agent_transcript_path: e1, transcript_path: parent }))).out, '');
    e = etat(d);
    assert.equal(e.lignes[c1].statut, 'ouvert');
    assert.ok(e.lignes[c1].note.startsWith('TERMINÉ (terminé) le ') && e.lignes[c1].note.endsWith(' : résultat à lire, vérifier et intégrer : ' + e1), e.lignes[c1].note);
    // SubagentStop ne dit rien à l'orchestrateur : la fin lui est annoncée à son prochain outil, une seule fois.
    const p0 = await hook(d, payload('PostToolUse', { transcript_path: parent }));
    assert.ok(ctx(p0).startsWith(`Sous-agent(s) terminé(s), résultat à traiter : ${c1} « export_pdf (Ada) » (résultat : ${e1}). Ne les oublie pas`), ctx(p0));
    assert.equal((await hook(d, payload('PostToolUse', { transcript_path: parent }))).out, '');
    // Le second finit aussi ; seule sa réponse finale dans le rollout de l'orchestrateur le dit (filet).
    fs.appendFileSync(parent, reponseFinale('/root/inconnu') + reponseFinale('/root/revue_export'));
    const p = await hook(d, payload('PostToolUse', { transcript_path: parent }));
    assert.ok(ctx(p).includes(`Sous-agent(s) terminé(s), résultat à traiter : ${c2} « revue_export (Blaise) »`), ctx(p));
    assert.match(etat(d).lignes[c2].note, /^TERMINÉ/);
    // Tour suivant : l'orchestrateur fait autre chose et s'arrête sans avoir traité les livraisons.
    await tourTrie(d, parent, 't2', 'corrige le readme');
    const s2 = await hook(d, payload('Stop', { turn_id: 't2', last_assistant_message: 'Readme corrigé.', transcript_path: parent }));
    assert.equal(s2.json.decision, 'block');
    assert.ok(s2.json.reason.includes(`Sous-agents TERMINÉS dont le résultat n'est pas traité (2) : ${c1} « export_pdf (Ada) » (résultat : ${e1}) ; ${c2} `), s2.json.reason.slice(0, 500));
    assert.equal((await hook(d, payload('Stop', { turn_id: 't2', stop_hook_active: true, transcript_path: parent }))).out, '', 'pas de boucle');
    // Encore un tour sans les traiter : le rappel REVIENT.
    await tourTrie(d, parent, 't3', 'et le changelog');
    const s3 = await hook(d, payload('Stop', { turn_id: 't3', last_assistant_message: 'Changelog fait.', transcript_path: parent }));
    assert.match(s3.json.reason, /n'est pas traité \(2\)/);
    // La première livraison est vérifiée et prouvée : elle sort du rappel.
    ecrirePreuve(d, 'infra.codex.md', [`- résultat de l'export vérifié et intégré [ctx ${c1}]`]);
    await hook(d, payload('PostToolUse', { transcript_path: parent }));
    assert.equal(etat(d).lignes[c1].statut, 'fait');
    // Sa réponse finale relue plus tard dans le rollout ne recrée pas de ligne.
    fs.appendFileSync(parent, reponseFinale('/root/export_pdf'));
    await hook(d, payload('PostToolUse', { transcript_path: parent }));
    assert.equal(Object.keys(etat(d).lignes).length, 2);
    await tourTrie(d, parent, 't4', 'suite');
    const s4 = await hook(d, payload('Stop', { turn_id: 't4', last_assistant_message: 'Fini.', transcript_path: parent }));
    assert.ok(s4.json.reason.includes(`n'est pas traité (1) : ${c2} « revue_export (Blaise) »`), s4.json.reason.slice(0, 400));
    assert.ok(!s4.json.reason.includes(`${c1} «`));
    // L'orchestrateur dit lui-même à l'utilisateur ce qui reste : pas de rappel en plus.
    await tourTrie(d, parent, 't5', 'suite 2');
    assert.equal((await hook(d, payload('Stop', { turn_id: 't5', last_assistant_message: `Il reste ${c2} à vérifier.`, transcript_path: parent }))).out, '');
  });

  test('sous-agents : reprise après clôture -> nouvelle ligne ; sans rollout -> titre de repli ; fin d\'un agent jamais inscrit -> inscrit et à traiter', async () => {
    const d = dossier('livraisons-reprise');
    const parent = rolloutParent(d);
    await tourTrie(d, parent, 't1', 'lance un agent');
    await attendreBase(d);
    await hook(d, payload('SubagentStart', { agent_id: 'th-9', agent_type: 'worker' })); // rollout pas encore écrit
    let e = etat(d);
    const [c1] = Object.keys(e.lignes);
    assert.equal(e.lignes[c1].texte, '[agent] « sous-agent worker » (worker, th-9) : à sa fin, lire son résultat, le vérifier et l\'intégrer.');
    const e9 = rolloutEnfant(d, 'th-9', { chemin: '/root/nettoyage', surnom: 'Noether', role: 'worker' });
    const fin = () => hook(d, payload('SubagentStop', { agent_id: 'th-9', agent_type: 'worker', agent_transcript_path: e9 }));
    await fin();
    assert.ok(etat(d).lignes[c1].note.endsWith(' : ' + e9), 'le rollout connu à la fin est donné comme résultat');
    await fin(); // autre tour du sous-agent alors que la ligne attend encore : une seule ligne par agent
    assert.equal(Object.keys(etat(d).lignes).length, 1);
    ecrirePreuve(d, 'infra.codex.md', [`- résultat intégré [ctx ${c1}]`]);
    await hook(d, payload('PostToolUse', { transcript_path: parent }));
    assert.equal(etat(d).lignes[c1].statut, 'fait');
    await fin(); // le sous-agent, relancé, rend un nouveau résultat après la clôture
    e = etat(d);
    assert.equal(Object.keys(e.lignes).length, 2);
    const c2 = Object.keys(e.lignes).sort()[1];
    assert.equal(e.lignes[c2].texte, `[agent] « sous-agent worker » (worker, th-9) : nouveau résultat rendu après la clôture de ${c1}, à lire, vérifier et intégrer.`);
    assert.equal(e.lignes[c2].statut, 'ouvert');
    assert.match(e.lignes[c2].note, /^TERMINÉ \(terminé\)/);
    // Sous-agent lancé avant le branchement : sa fin l'inscrit, directement « à traiter ».
    const e7 = rolloutEnfant(d, 'th-7', { chemin: '/root/audit_routes', surnom: 'Turing', role: 'codebase-explorer' });
    await hook(d, payload('SubagentStop', { agent_id: 'th-7', agent_type: 'codebase-explorer', agent_transcript_path: e7 }));
    e = etat(d);
    const c3 = Object.keys(e.lignes).sort()[2];
    assert.match(e.lignes[c3].texte, /^\[agent\] « audit_routes \(Turing\) » \(codebase-explorer, th-7\)/);
    assert.equal(e.lignes[c3].statut, 'ouvert');
    assert.match(e.lignes[c3].note, /^TERMINÉ/);
  });

  // Fiches des sous-agents. Mesuré la même nuit dans 24 rollouts : les 22
  // sous-agents Codex ont été compactés 1 à 7 fois, sans rien pour retrouver leur mission. Formes réelles :
  // un événement d'outil d'un sous-agent porte agent_id et, en transcript_path, SON rollout ; un compactage
  // y est écrit en ligne { timestamp, ordinal, type: 'compacted', payload }.
  test('sous-agents : fiche créée au démarrage, mission recopiée par le sous-agent, fiche rendue après le compactage de SON rollout, signalement dit à l\'orchestrateur', async () => {
    const d = dossier('fiches');
    const parent = rolloutParent(d);
    const e1 = rolloutEnfant(d, 'th-6', { chemin: '/root/p1_a3', surnom: 'Banach', role: 'default' });
    await tourTrie(d, parent, 't1', 'lance un agent');
    await attendreBase(d);
    const sa = { agent_id: 'th-6', agent_type: 'default' };
    const debut = await hook(d, payload('SubagentStart', Object.assign({ transcript_path: e1 }, sa)));
    assert.match(ctx(debut), /note --fiche th-6 --genre mission/);
    fs.appendFileSync(e1, consigneEcrite(ctx(debut)));
    const index = () => JSON.parse(fs.readFileSync(path.join(racineDe(d), '.fiches', 'codex-th-6.json'), 'utf8'));
    const [c1] = Object.keys(etat(d).lignes);
    assert.equal(index().ligne, c1);
    assert.equal(index().mission, false);
    assert.equal(index().titre, 'p1_a3 (Banach)');
    const fiche = () => fs.readFileSync(index().fiche, 'utf8');
    assert.ok(fiche().includes('- ID de travail : th-6 (default)'));
    assert.ok(fiche().includes(`- Ligne de suivi dans la liste de l'orchestrateur : ${c1} (lecture seule pour le sous-agent)`));
    // Le sous-agent recopie sa mission, puis note son avancement.
    assert.equal((await cli(d, ['note', '--fiche', 'th-6', '--genre', 'mission', 'Relire A3 ligne à ligne, sans modifier le dépôt.'])).code, 0);
    assert.equal((await cli(d, ['note', '--fiche', 'th-6', 'A3 : 300 lignes lues sur 900'])).code, 0);
    assert.ok(fiche().includes('## Mission (mot pour mot)\n\nRelire A3 ligne à ligne, sans modifier le dépôt.\n'));
    assert.equal(index().mission, true);
    // Outil du sous-agent : rien tant que son rollout n'a pas de compactage (premier passage : base).
    const outil = () => hook(d, payload('PostToolUse', Object.assign({ transcript_path: e1 }, sa)));
    assert.equal((await outil()).out, '');
    fs.appendFileSync(e1, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: 464, type: 'compacted', payload: { message: '', replacement_history: [] } }) + '\n');
    const reprise = ctx(await outil());
    assert.ok(reprise.startsWith('Fichier contexte : ton contexte de sous-agent vient d\'être compacté. Voici ta fiche ('), reprise.slice(0, 200));
    assert.ok(reprise.includes('Relire A3 ligne à ligne, sans modifier le dépôt.'));
    assert.ok(reprise.includes('| A3 : 300 lignes lues sur 900'));
    assert.ok(!/À trier :|Ouvert :/.test(reprise), 'jamais la liste de l\'orchestrateur');
    assert.equal((await outil()).out, '', 'une seule reprise pour ce compactage');
    // Plus tard, un autre compactage, annoncé par son événement (PostCompact porte agent_id : 7 événements
    // réels le 2026-10-02) : rien ne peut être injecté à ce moment, la fiche est rendue au prochain outil.
    const fIndex = path.join(racineDe(d), '.fiches', 'codex-th-6.json');
    const i2 = index();
    i2.repriseLe = new Date(Date.now() - 20 * 60000).toISOString();
    fs.writeFileSync(fIndex, JSON.stringify(i2));
    assert.equal((await hook(d, payload('PostCompact', Object.assign({ trigger: 'auto', transcript_path: e1 }, sa)))).out, '');
    assert.ok(ctx(await outil()).startsWith('Fichier contexte : ton contexte de sous-agent vient d\'être compacté.'));
    assert.equal(index().reprises, 2);
    assert.equal((await outil()).out, '');
    // Message de l'orchestrateur reçu par le sous-agent (UserPromptSubmit porte agent_id) : pas un message de l'utilisateur.
    const avant = Object.keys(etat(d).demandes).length;
    assert.equal((await hook(d, payload('UserPromptSubmit', Object.assign({ prompt: 'suite de la tâche', transcript_path: e1 }, sa)))).out, '');
    assert.equal(Object.keys(etat(d).demandes).length, avant);
    // Il constate qu'une ligne de la liste est déjà faite : il le signale, l'orchestrateur le lit à son prochain outil.
    assert.equal((await cli(d, ['note', '--fiche', 'th-6', '--genre', 'deja-fait', `${c1} : déjà corrigé par le commit abc1234`])).code, 0);
    const o = ctx(await hook(d, payload('PostToolUse', { transcript_path: parent })));
    assert.ok(o.startsWith(`Signalement du sous-agent ${c1} « p1_a3 (Banach) » (deja-fait) : « ${c1} : déjà corrigé par le commit abc1234 ». Vérifie dans le code ou l'historique`), o.slice(0, 300));
    assert.equal((await hook(d, payload('PostToolUse', { transcript_path: parent }))).out, '');
  });

  // Mesuré le 2026-10-02 dans 24 rollouts réels : la consigne du démarrage n'est arrivée qu'à 2 sous-agents sur
  // 22 (hook SubagentStart tué par son délai, ou jamais déclenché). Filet : le premier événement du sous-agent
  // la donne, une seule fois.
  test('sous-agents : consigne donnée au premier outil quand le démarrage ne l\'a pas donnée, une seule fois', async () => {
    const d = dossier('consigne-filet');
    const parent = rolloutParent(d);
    const e1 = rolloutEnfant(d, 'th-8', { chemin: '/root/lecture_noyau', surnom: 'Kepler', role: 'default' });
    await tourTrie(d, parent, 't1', 'lance deux agents');
    await attendreBase(d);
    const sa = { agent_id: 'th-8', agent_type: 'default' };
    const outil = () => hook(d, payload('PostToolUse', Object.assign({ transcript_path: e1 }, sa)));
    const c = ctx(await outil());
    assert.ok(c.startsWith('Fichier contexte : tu es un sous-agent. Ta fiche : '), c.slice(0, 200));
    assert.match(c, /note --fiche th-8 --genre mission/);
    assert.match(c, /\nTa mission est celle de ton lancement, rien d'autre : /);
    assert.ok(!/À trier :|Ouvert :/.test(c), 'jamais la liste de l\'orchestrateur');
    fs.appendFileSync(e1, consigneEcrite(c));
    assert.equal((await outil()).out, '', 'la consigne n\'est donnée qu\'une fois');
    // Démarrage vu : la consigne a été donnée là (et écrite dans son rollout), son premier outil ne la redit pas.
    const e2 = rolloutEnfant(d, 'th-10', { chemin: '/root/lecture_android', surnom: 'Hubble', role: 'default' });
    const sb = { agent_id: 'th-10', agent_type: 'default' };
    const debut = ctx(await hook(d, payload('SubagentStart', Object.assign({ transcript_path: e2 }, sb))));
    assert.match(debut, /^Fichier contexte : tu es un sous-agent \(ligne C-\d{4} de l'orchestrateur\)\. Ta fiche : /);
    fs.appendFileSync(e2, consigneEcrite(debut));
    assert.equal((await hook(d, payload('PostToolUse', Object.assign({ transcript_path: e2 }, sb)))).out, '');
  });

  // Constaté le 2026-10-02 dans un rollout réel : le hook de démarrage a posé sa marque puis Codex l'a tué à
  // son délai de 5 s, sortie jetée ; le filet ne redonnait rien puisque la marque était posée.
  test('sous-agents : consigne marquée au démarrage mais absente de son rollout : redonnée au premier outil, une fois', async () => {
    const d = dossier('consigne-absente');
    const parent = rolloutParent(d);
    await tourTrie(d, parent, 't1', 'lance deux agents');
    await attendreBase(d);
    const outil = (e, sa) => hook(d, payload('PostToolUse', Object.assign({ transcript_path: e }, sa)));
    // Sortie du démarrage jetée : rien dans son rollout, la consigne est redonnée au premier outil, une fois.
    const e1 = rolloutEnfant(d, 'th-11', { chemin: '/root/relecture_lot', surnom: 'Bohr', role: 'default' });
    const sa = { agent_id: 'th-11', agent_type: 'default' };
    await hook(d, payload('SubagentStart', Object.assign({ transcript_path: e1 }, sa)));
    const c = ctx(await outil(e1, sa));
    assert.ok(c.startsWith('Fichier contexte : tu es un sous-agent (ligne C-'), c.slice(0, 200));
    assert.match(c, /note --fiche th-11 /);
    fs.appendFileSync(e1, consigneEcrite(c));
    assert.equal((await outil(e1, sa)).out, '', 'redonnée une seule fois');
    // Consigne d'un autre sous-agent dans son rollout (fork qui hérite de l'historique) : ne compte pas.
    const e2 = rolloutEnfant(d, 'th-12', { chemin: '/root/relecture_lot/suite', surnom: 'Born', role: 'default', profondeur: 2 });
    const sb = { agent_id: 'th-12', agent_type: 'default' };
    await hook(d, payload('SubagentStart', Object.assign({ transcript_path: e2 }, sb)));
    fs.appendFileSync(e2, consigneEcrite(c));
    assert.match(ctx(await outil(e2, sb)), /note --fiche th-12 /);
  });

  // Un autre agent principal (ici Claude) qui voit une ligne de la liste de Codex déjà faite la signale dans la
  // boîte de Codex ; Codex le lit à son prochain outil, une fois.
  test('signalement entre agents : Claude signale une ligne de Codex, dit au prochain outil de Codex, une seule fois', async () => {
    const d = dossier('signalement-agents');
    const parent = rolloutParent(d);
    await tourTrie(d, parent, 't1', 'travaille sur le lot B');
    await attendreBase(d);
    const id = avecRacine(d, () => core.ajouterLigne({ projet: PROJET, agent: 'codex', texte: 'Relire le lot B', de: null }));
    avecRacine(d, () => core.signalerAgent({ de: 'claude', vers: 'codex', projet: PROJET, ligne: id, genre: 'deja-fait', texte: 'lot B relu et intégré (historique du 2026-10-03)' }));
    const outil = () => hook(d, payload('PostToolUse', { transcript_path: parent }));
    const c = ctx(await outil());
    assert.ok(c.startsWith(`Signalement de claude sur ta ligne ${id} (deja-fait, `), c.slice(0, 200));
    assert.match(c, new RegExp(`« lot B relu et intégré \\(historique du 2026-10-03\\) »\\. Vérifie dans le code ou l'historique : si c'est exact, ferme la ligne par une preuve \\[ctx ${id}\\]`));
    assert.equal((await outil()).out, '', 'dit une seule fois');
    assert.equal(etat(d).lignes[id].statut, 'ouvert', 'le signalement ne ferme rien');
  });

  // Trou trouvé dans une session réelle de Claude Code (un tour de plus de 4 heures, 7 résultats sans
  // rappel) : le noyau est commun, le même suivi en cours de tour est branché ici.
  test('sous-agents : tour long sans fin de tour -> fin annoncée une fois au prochain outil, puis rappel passé le délai, jusqu\'à la preuve', async () => {
    const d = dossier('livraisons-en-cours');
    const parent = rolloutParent(d);
    const e1 = rolloutEnfant(d, 'th-5', { chemin: '/root/audit_taxes', surnom: 'Fermat', role: 'worker' });
    await tourTrie(d, parent, 't1', 'lance un agent et continue');
    await attendreBase(d);
    await hook(d, payload('SubagentStart', { agent_id: 'th-5', agent_type: 'worker', transcript_path: e1 }));
    const [c1] = Object.keys(etat(d).lignes);
    await hook(d, payload('SubagentStop', { agent_id: 'th-5', agent_type: 'worker', agent_transcript_path: e1, transcript_path: parent }));
    const outil = plus => hook(d, payload('PostToolUse', { transcript_path: parent }), HOOK, plus);
    const DELAI_PASSE = { CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN: '0' };
    assert.ok(ctx(await outil()).startsWith(`Sous-agent(s) terminé(s), résultat à traiter : ${c1} « audit_taxes (Fermat) »`));
    assert.equal((await outil()).out, '', 'une seule annonce');
    // Sa réponse finale arrive ensuite dans le rollout de l'orchestrateur : pas de seconde annonce.
    fs.appendFileSync(parent, reponseFinale('/root/audit_taxes'));
    assert.equal((await outil()).out, '');
    const rappel = ctx(await outil(DELAI_PASSE));
    assert.ok(rappel.startsWith(`Rappel : 1 sous-agent(s) TERMINÉ(S) dont le résultat n'est toujours pas traité : ${c1} « audit_taxes (Fermat) ». N'attends pas la fin du tour`), rappel);
    assert.equal((await outil()).out, '', 'pas de rappel avant le délai (20 minutes par défaut)');
    // Résultat prouvé : plus rien à rappeler, même délai passé.
    ecrirePreuve(d, 'infra.codex.md', [`- audit des taxes vérifié et intégré [ctx ${c1}]`]);
    const preuve = await outil(DELAI_PASSE);
    assert.equal(etat(d).lignes[c1].statut, 'fait');
    assert.ok(!ctx(preuve).includes('Rappel :'), ctx(preuve));
    assert.equal((await outil(DELAI_PASSE)).out, '');
  });
});

describe('garde PreToolUse (Codex)', CONCURRENCE, () => {
  const R = d => racineDe(d).replace(/\\/g, '/');

  test('garde : apply_patch sur le .md -> deny ; sur un autre fichier -> rien', async () => {
    const d = dossier('garde-patch');
    const r = await hook(d, payload('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${R(d)}/_general.codex.md\n@@\n-- C-0001\n*** End Patch` } }));
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /ne se modifie pas à la main/);
    const r2 = await hook(d, payload('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${d}\\autre.md\n@@\n+x\n*** End Patch` } }));
    assert.equal(r2.out, '');
    const r3 = await hook(d, payload('PreToolUse', { tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Delete File: C:/Users/demo/.agent-memory-ledger/contexte/_general.codex.md\n*** End Patch` }));
    assert.equal(r3.json.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('garde : shell rm, sed -i, redirection > sur la racine -> deny ; cat, Get-Content -> autorisé', async () => {
    const d = dossier('garde-shell');
    for (const cmd of [`rm ${R(d)}/_general.codex.md`, `sed -i 's/a/b/' ${R(d)}/_general.codex.md`, `echo x > ${R(d)}/_general.codex.md`,
      `Remove-Item "${R(d)}\\_general.codex.md"`, 'del C:\\Users\\demo\\.agent-memory-ledger\\contexte\\x.md']) {
      const r = await hook(d, payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny', `devait refuser : ${cmd}`);
    }
    for (const cmd of [`cat ${R(d)}/_general.codex.md`, `Get-Content "${R(d)}/_general.codex.md" | Select-String C-0001`]) {
      assert.equal((await hook(d, payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: cmd } }))).out, '', `devait autoriser : ${cmd}`);
    }
    assert.equal((await hook(d, payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: ['powershell.exe', '-Command', `Get-Content ${R(d)}/x.md`] } }))).out, '');
    const rArr = await hook(d, payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', `rm -f ${R(d)}/x.md`] } }));
    assert.equal(rArr.json.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('garde : workdir dans la racine -> seule la lecture passe', async () => {
    const d = dossier('garde-workdir');
    const r = await hook(d, payload('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'rm _general.codex.md', workdir: R(d) } }));
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await hook(d, payload('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'cat _general.codex.md', workdir: R(d) } }))).out, '');
  });

  test('garde : code mode (exec) -> appels imbriqués analysés', async () => {
    const d = dossier('garde-code');
    const refus = [
      `await tools.exec_command({ cmd: "rm ${R(d)}/_general.codex.md" });`,
      `await tools.apply_patch("*** Begin Patch\\n*** Update File: ${R(d)}/_general.codex.md\\n@@\\n+x\\n*** End Patch");`,
      `const p = '${R(d)}/_general.codex.md'; await tools.exec_command({ cmd: 'rm ' + p });`,
    ];
    for (const code of refus) {
      const r = await hook(d, payload('PreToolUse', { tool_name: 'exec', tool_input: { code } }));
      assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny', `devait refuser : ${code}`);
    }
    const ok = `const r = await tools.exec_command({ cmd: "cat ${R(d)}/_general.codex.md" }); text(r.output);`;
    assert.equal((await hook(d, payload('PreToolUse', { tool_name: 'exec', tool_input: { code: ok } }))).out, '');
    assert.equal((await hook(d, payload('PreToolUse', { tool_name: 'exec', tool_input: { code: 'await tools.exec_command({ cmd: "git status" })' } }))).out, '');
  });

  // Règle : un sous-agent n'ÉCRIT jamais dans la liste de travail. La garde lui refusait aussi la lecture :
  // 19 refus dans 7 sous-agents Codex d'une session réelle, tous pour lire la liste ou le texte intégral
  // d'une ligne. Les commandes ci-dessous sont les formes relevées dans leurs rollouts.
  test('garde : sous-agent : écriture et commandes d\'écriture de la CLI -> deny ; lecture de la racine -> autorisée ; orchestrateur -> autorisé', async () => {
    const d = dossier('garde-cli');
    const S = 'node "C:/outils/agent-memory-ledger/scripts/codex/context-ledger.js"';
    const appel = `${S} ajouter --projet ${PROJET} "x"`;
    const sa = { agent_id: 'a1', agent_type: 'worker' };
    const garde = (command, qui) => hook(d, payload('PreToolUse', Object.assign({ tool_name: 'Bash', tool_input: { command } }, qui || {})));
    const r1 = await garde(appel, sa);
    assert.match(r1.json.hookSpecificOutput.permissionDecisionReason, /^Seul l'orchestrateur écrit dans le fichier contexte\. Toi, sous-agent, tu peux le LIRE/);
    const r2 = await hook(d, payload('PreToolUse', { tool_name: 'exec', tool_input: { code: `await tools.exec_command({ cmd: ${JSON.stringify(appel)} })` }, agent_type: 'worker' }));
    assert.equal(r2.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await garde(appel)).out, '', 'l\'orchestrateur appelle la CLI');
    const W = R(d).replace(/\//g, '\\');
    for (const cmd of [
      `Set-Content -LiteralPath '${W}\\projet-demo.claude.md' -Value x`,
      `$p='${W}\\x.md'; Remove-Item $p`,
      `Get-Content '${W}\\x.md' | Out-File '${W}\\y.md'`,
      `Get-ChildItem '${W}' | ForEach-Object { Remove-Item $_ }`,
      `Get-ChildItem '${W}' | ForEach-Object Delete`,
      `echo x > ${R(d)}/x.md`,
      `${S} etat --projet ${PROJET} C-0001 ouvert`,
      `cat ${R(d)}/x.md; ${S} ajouter --projet ${PROJET} "y"`,
      `${S} note --fiche a2 "dans la fiche d'un autre"`,
    ]) {
      const r = await garde(cmd, sa);
      assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny', `devait refuser : ${cmd}`);
    }
    for (const cmd of [
      `cat ${R(d)}/x.md`,
      `$p='${W}\\projet-demo.claude.md'; Get-Content -LiteralPath $p -TotalCount 4`,
      `$root='${W}\\projet-demo.claude.md'; Select-String -LiteralPath $root -Pattern 'LGPL|fpdf2' | Select-Object -First 50`,
      `rg -n -i -l --glob 'C-*.txt' 'domain_tlds' '${W}\\projet-demo.claude'`,
      `Get-Content -LiteralPath '${W}\\projet-demo.claude\\C-0297.txt'`,
      `Select-String -Path '${W}\\projet-demo.claude.md' -Pattern 'References legales' -SimpleMatch`,
      `Get-Content -LiteralPath '${W}\\projet-demo.claude.md' | Select-String 'C-0461' | ForEach-Object { $_.Line }`,
      `${S} chercher --agent claude --projet projet-demo "domain_tlds"`,
      `${S} lister --projet ${PROJET}`,
      `${S} note --fiche a1 "fait : lots B01 à B05 lus"`,
    ]) assert.equal((await garde(cmd, sa)).out, '', `devait permettre : ${cmd}`);
  });

  test('garde : stdin illisible visant la racine -> deny conforme', async () => {
    const d = dossier('garde-illisible');
    const r = await hook(d, '{"hook_event_name":"PreToolUse","tool_input":{"command":"rm C:/Users/demo/.agent-memory-ledger/contexte/x.md"');
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('fonctions pures de l\'adaptateur', () => {
  test('ajuster : respecte le plafond et cumule les lignes omises', async () => {
    const { ajuster } = require(HOOK);
    const lignes = Array.from({ length: 50 }, (_, i) => `- C-${String(i).padStart(4, '0')} | ` + 'y'.repeat(200));
    const texte = ['Entête', ...lignes, '(7 lignes de plus : L)', 'Pied'].join('\n');
    const t = ajuster('Haut', texte, 'Bas '.repeat(10), 'L');
    assert.ok(t.length <= PLAFOND);
    const m = /\((\d+) lignes de plus : L\)/.exec(t);
    assert.ok(m && Number(m[1]) > 7);
    const gardees = t.split('\n').filter(l => l.startsWith('- ')).length;
    assert.equal(gardees + Number(m[1]), 57);
    assert.ok(t.startsWith('Haut\nEntête'));
    assert.ok(t.includes('Pied'));
    assert.equal(ajuster('a', 'b', 'c', 'L'), 'a\nb\nc');
  });

  test('analyser : exec_command direct, tableau, patch, code mode', async () => {
    const { analyser } = require(HOOK);
    assert.deepEqual(analyser('exec_command', { cmd: 'git status', workdir: 'C:/x' }).commandes, ['git status']);
    assert.deepEqual(analyser('Bash', { command: ['bash', '-lc', 'ls -la'] }).commandes, ['ls -la']);
    assert.equal(analyser('apply_patch', { command: '*** Begin Patch\n*** End Patch' }).patchs.length, 1);
    const a = analyser('exec', { code: 'await tools.exec_command({ cmd: "git log", workdir: "C:/x" })' });
    assert.deepEqual(a.commandes, ['git log']);
    assert.deepEqual(a.dossiers, ['C:/x']);
  });
});

// ---------------------------------------------------------------------------
// Mutations : une copie mutée de l'adaptateur doit rendre au moins un banc ROUGE ; la copie témoin
// (non mutée, même emplacement relatif) doit rester verte avec le même filtre.

function copier(nom, transformer) {
  const scripts = path.join(__dirname, '..', 'scripts');
  const dir = path.join(RUN, nom, 'scripts', 'codex');
  const lib = path.join(RUN, nom, 'scripts', 'lib');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['context-ledger-core.js', 'config.js', 'commande-git.js']) fs.copyFileSync(path.join(scripts, 'lib', f), path.join(lib, f));
  const src = fs.readFileSync(path.join(scripts, 'codex', 'context-ledger.js'), 'utf8');
  const out = transformer(src);
  if (out === src && nom.startsWith('mutation')) throw new Error(`mutation ${nom} sans effet : ancre introuvable`);
  const f = path.join(dir, 'context-ledger.js');
  fs.writeFileSync(f, out);
  return f;
}

async function relancer(script, motif) {
  const env = Object.assign({}, process.env, { CONTEXT_LEDGER_CODEX_HOOK: script, CONTEXT_LEDGER_EN_MUTATION: '1' });
  delete env.NODE_TEST_CONTEXT; // sinon le fils se croit sous-processus du lanceur de tests
  const r = await lancer(['--test', '--test-reporter=tap', '--test-name-pattern=' + motif, __filename], env, '', __dirname);
  const pass = /^# pass (\d+)/m.exec(r.out);
  const fail = /^# fail (\d+)/m.exec(r.out);
  return { code: r.code, pass: pass ? Number(pass[1]) : -1, fail: fail ? Number(fail[1]) : -1 };
}

const MUTATIONS = [
  { nom: 'garde', motif: '^garde', transformer: s => s.replace(/const raison = gardeCodex\(input\); \/\/ ancre-mutation:garde-codex/, 'const raison = null; // mutation') },
  { nom: 'drapeau', motif: 'PostCompact', transformer: s => s.replace(/function poserDrapeau\(sessionId\) \{/, 'function poserDrapeau(sessionId) { return;') },
  { nom: 'attente', motif: 'verrou bloqué', transformer: s => s.replace(/try \{ mettreEnAttente\(m\); enAttente = true; \} catch \(e2\) \{ \/\/ ancre-mutation:attente/, 'try { /* mutation */ } catch (e2) {') },
  { nom: 'secours', motif: 'incident disque', transformer: s => s.replace(/signalerEchec\(input, m, [^\n]*\/\/ ancre-mutation:secours/, '/* mutation */') },
  { nom: 'stop-session', motif: '^Stop Codex', transformer: s => s.replace(/if \(!cle \|\| !aTrier\.length \|\| \(s\.rappels \|\| \[\]\)\.includes\(cle\)\) return ''; \/\/ ancre-mutation:stop-session/, "return ''; // mutation") },
  { nom: 'cli-reessai', motif: '^CLI sous charge', transformer: s => s.replace(/while \(r\.code !== 0 && \/verrou occupé\/\.test\(r\.erreur \|\| ''\) && Date\.now\(\) < limite\) \{ \/\/ ancre-mutation:cli-reessai/, 'while (false) { // mutation') },
  { nom: 'stop-vue', motif: '^Stop Codex', transformer: s => s.replace(/try \{ vue = core\.contexteSession\(\{ agent: AGENT, projet, script: SCRIPT \}\); \} catch \(_\) \{ vue = ''; \} \/\/ ancre-mutation:stop-vue/, "vue = ''; // mutation") },
  { nom: 'suivi-lancement', motif: '^sous-agents', transformer: s => s.replace('return core.suivreTache({ // ancre-mutation:suivi-lancement', 'return null; core.suivreTache({ // mutation') },
  { nom: 'suivi-fin', motif: '^sous-agents', transformer: s => s.replace(/core\.finirTache\(\{[^\n]*\/\/ ancre-mutation:suivi-fin/, '// mutation') },
  { nom: 'stop-livraisons', motif: '^sous-agents', transformer: s => s.replace(/const livraisons = core\.texteLivraisons\([^\n]*\/\/ ancre-mutation:stop-livraisons/, "const livraisons = ''; // mutation") },
  { nom: 'filet-rollout', motif: '^sous-agents', transformer: s => s.replace('if (!r) return fins; // ancre-mutation:filet-rollout', 'return fins; // mutation') },
  { nom: 'suivi-en-cours', motif: '^sous-agents', transformer: s => s.replace(/try \{ return core\.texteSuiviEnCours\([^\n]*\/\/ ancre-mutation:suivi-en-cours/, "return ''; // mutation") },
  { nom: 'reprise-sous-agent', motif: '^sous-agents : fiche', transformer: s => s.replace(/if \(compacte\) \{ contexte\([^\n]*\/\/ ancre-mutation:reprise-sous-agent/, '// mutation') },
  { nom: 'consigne-filet', motif: '^sous-agents : consigne', transformer: s => s.replace(/if \(!index\.reprises && !index\.consigneVerifieeLe[^\n]*\/\/ ancre-mutation:consigne-filet/, '// mutation') },
  // Sans le transcript, la consigne marquée mais perdue n'est plus redonnée.
  // Suivi en cours débranché : le signalement d'un autre agent n'arrive plus à Codex.
  { nom: 'signalements-agents', motif: '^signalement entre agents', transformer: s => s.replace(/try \{ return core\.texteSuiviEnCours\([^\n]*\/\/ ancre-mutation:suivi-en-cours/, "return ''; // mutation") },
  { nom: 'consigne-transcript', motif: '^sous-agents : consigne marquée', transformer: s => s.replace(/fichier: input\.transcript_path, formes: \['"role":"developer"'\] \}\)\) contexte\(evenement/, "formes: ['\"role\":\"developer\"'] })) contexte(evenement") },
  { nom: 'stop-budget', motif: '^Stop Codex : budget', transformer: s => s.replace(/const sIlResteDuTemps = [^\n]*\/\/ ancre-mutation:stop-budget/, 'const sIlResteDuTemps = fn => { try { fn(); } catch (_) { /* mutation */ } };') },
  { nom: 'reconciliateur', motif: 'preuve par contenu|réconciliateur|CRLF', transformer: s => s.replace(/const r = core\.reconcilier\(\{ agent: AGENT, base: basePreuves\(\) \}\);/, 'const r = { faits: [], partiels: [], ignores: [], projets: [] };') },
];

describe('mutations', { skip: EN_MUTATION, concurrency: 3 }, () => {
  for (const mu of MUTATIONS) {
    test(`mutation ${mu.nom} : banc rouge ; témoin vert`, async () => {
      const mute = copier(`mutation-${mu.nom}`, mu.transformer);
      const temoin = copier(`temoin-${mu.nom}`, s => s);
      const [rm, rt] = await Promise.all([relancer(mute, mu.motif), relancer(temoin, mu.motif)]);
      console.log(`mutation ${mu.nom} : muté pass=${rm.pass} fail=${rm.fail} code=${rm.code} ; témoin pass=${rt.pass} fail=${rt.fail} code=${rt.code}`);
      assert.ok(rt.pass > 0, `le témoin ${mu.nom} n'a exécuté aucun banc (filtre ${mu.motif})`);
      assert.equal(rt.fail, 0, `le témoin ${mu.nom} devrait rester vert`);
      assert.equal(rt.code, 0);
      assert.ok(rm.fail > 0, `la mutation ${mu.nom} n'a rendu aucun banc rouge`);
    });
  }
});
