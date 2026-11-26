'use strict';
// Bancs de l'adaptateur Codex du Cockpit : scripts/codex/cockpit.js
// Lancement : node --test tests/cockpit-codex.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variable interne (tests de mutation, qui relancent ce fichier sur une copie mutée) :
//   COCKPIT_CODEX_TESTE   adaptateur à tester (défaut : ../scripts/codex/cockpit.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const { ecrireEtatLedger, monter: monterDans } = require('./lib/cockpit-fixtures.js');

const ADAPTATEUR = process.env.COCKPIT_CODEX_TESTE || path.join(__dirname, '..', 'scripts', 'codex', 'cockpit.js');
const NOYAU = path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js');
const core = require(NOYAU);

let n = 0;
let RUN;
let ETAT; // dossier d'état du Cockpit de ce test
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-codex-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
  process.env.COCKPIT_QUOTA_NATIVE = '0'; // jamais un vrai binaire de Codex pendant un banc
  ETAT = process.env.COCKPIT_DIR;
  const plans = path.join(RUN, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, 'P.md'), '- [x] a\n- [ ] b\n');
  core.ecrireJson(path.join(ETAT, 'config.json'), { worktrees: [], plans: { dossier: plans, exclure: [], profondeur: 1 } });
  ecrireEtatLedger('codex', 'P1', { 'C-0001': { texte: 'travail A', statut: 'ouvert' } });
});

// Lance l'adaptateur comme Codex le fait : l'événement en JSON sur l'entrée standard.
function lancer(entree, { agent = 'codex', args = ['--agent', agent] } = {}) {
  const input = typeof entree === 'string' ? entree : JSON.stringify(entree);
  const r = spawnSync(process.execPath, [ADAPTATEUR, ...args], { input, encoding: 'utf8', env: { ...process.env, COCKPIT_QUOTA_NATIVE: '0' }, timeout: 60000 });
  return r;
}

const demarrage = (extra = {}) => ({ hook_event_name: 'SessionStart', session_id: 'S1', cwd: 'C:/x', source: 'startup', ...extra });
const prompt = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'S1', cwd: 'C:/x', prompt: 'bonjour', ...extra });

const fichierInjection = (agent = 'codex', session = 'S1') => path.join(ETAT, `inj-${agent}-${session}.json`);

function contexteDe(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout);
}

describe('sortie', () => {
  test('SessionStart injecte le bloc du Cockpit dans le schéma strict de Codex', () => {
    const s = contexteDe(lancer(demarrage()));
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    assert.equal(s.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(s.hookSpecificOutput.additionalContext, /^COCKPIT \d{4}-\d{2}-\d{2} \d{2}:\d{2} : ledger 1 ouverte/);
    assert.ok(s.hookSpecificOutput.additionalContext.length <= 700);
    assert.ok(!/\u{2014}/u.test(s.hookSpecificOutput.additionalContext), 'jamais de tiret cadratin');
  });

  test('UserPromptSubmit injecte à la première invite, sous son propre nom d événement', () => {
    const s = contexteDe(lancer(prompt()));
    assert.equal(s.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(s.hookSpecificOutput.additionalContext, /^COCKPIT /);
  });

  test('un événement que le Cockpit ne traite pas donne une sortie vide', () => {
    for (const e of ['PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']) {
      const r = lancer({ hook_event_name: e, session_id: 'S1', cwd: 'C:/x' });
      assert.equal(r.status, 0, `${e} : ${r.stderr}`);
      assert.equal(r.stdout, '', e);
    }
  });

  test('une entrée illisible, vide ou sans session donne une sortie vide, code 0, rien sur stderr', () => {
    for (const entree of ['', 'pas du json', '[]', 'null', JSON.stringify({ hook_event_name: 'SessionStart' }), JSON.stringify({ session_id: 'S1' })]) {
      const r = lancer(entree);
      assert.equal(r.status, 0, entree);
      assert.equal(r.stdout, '', entree);
      assert.equal(r.stderr, '', entree);
    }
  });

  test('un sous-agent ne reçoit jamais le Cockpit et n écrit aucun état', () => {
    for (const e of [demarrage({ agent_id: 'A1' }), prompt({ agent_type: 'explorer' })]) {
      const r = lancer(e);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(fs.readdirSync(ETAT).filter(f => f.startsWith('inj-')), []);
  });

  test('un nom d agent invalide ne construit aucun chemin, ne purge rien et donne une sortie vide', () => {
    const vieux = path.join(ETAT, 'inj-codex-vieux.json');
    fs.writeFileSync(vieux, '{}');
    const ancien = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    fs.utimesSync(vieux, ancien, ancien);
    for (const agent of ['../evil', 'a/b', '', 'AGENT', 'x'.repeat(40)]) {
      const r = lancer(demarrage(), { args: ['--agent', agent] });
      assert.equal(r.status, 0, agent);
      assert.equal(r.stdout, '', agent);
    }
    assert.equal(lancer(demarrage(), { args: [] }).stdout, '', 'sans --agent');
    assert.deepEqual(fs.readdirSync(ETAT).filter(f => f.startsWith('inj-')), ['inj-codex-vieux.json'], 'aucun état écrit, et le vieil état n est pas purgé : le hook s est arrêté avant tout effet');
    assert.deepEqual(fs.readdirSync(RUN).sort(), ['cockpit', 'contexte', 'plans'], 'rien n a été écrit hors du dossier du Cockpit');
  });
});

describe('une injection n est refaite que si l état a changé', () => {
  test('SessionStart réinjecte toujours, même état, même fil', () => {
    assert.match(contexteDe(lancer(demarrage())).hookSpecificOutput.additionalContext, /^COCKPIT /);
    assert.match(contexteDe(lancer(demarrage())).hookSpecificOutput.additionalContext, /^COCKPIT /);
  });

  test('UserPromptSubmit : état inchangé, deuxième invite sans injection', () => {
    contexteDe(lancer(prompt()));
    const r = lancer(prompt());
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('UserPromptSubmit : état changé mais moins de 10 minutes après la dernière injection, pas d injection', () => {
    contexteDe(lancer(prompt()));
    ecrireEtatLedger('codex', 'P1', { 'C-0001': { texte: 'travail A', statut: 'ouvert' }, 'C-0002': { texte: 'attend', statut: 'bloque-utilisateur', note: 'x' } });
    assert.equal(lancer(prompt()).stdout, '');
    const f = fichierInjection();
    const etat = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...etat, ts: Date.now() - 5 * 60 * 1000 }));
    assert.equal(lancer(prompt()).stdout, '', 'cinq minutes après, toujours trop tôt');
  });

  test('UserPromptSubmit : état changé et plus de 10 minutes, nouvelle injection', () => {
    contexteDe(lancer(prompt()));
    ecrireEtatLedger('codex', 'P1', { 'C-0001': { texte: 'travail A', statut: 'ouvert' }, 'C-0002': { texte: 'attend', statut: 'bloque-utilisateur', note: 'x' } });
    const f = fichierInjection();
    const etat = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...etat, ts: Date.now() - 11 * 60 * 1000 }));
    const s = contexteDe(lancer(prompt()));
    assert.match(s.hookSpecificOutput.additionalContext, /ledger 1 ouverte, 1 bloquée \(P1\/C-0002\)/);
  });

  test('UserPromptSubmit : état inchangé même après 10 minutes, pas d injection', () => {
    contexteDe(lancer(prompt()));
    const f = fichierInjection();
    const etat = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...etat, ts: Date.now() - 60 * 60 * 1000 }));
    assert.equal(lancer(prompt()).stdout, '');
  });

  test('le fichier d état garde l empreinte du bloc et l heure de l injection', () => {
    contexteDe(lancer(prompt()));
    const etat = JSON.parse(fs.readFileSync(fichierInjection(), 'utf8'));
    assert.match(etat.empreinte, /^[0-9a-f]{40}$/);
    assert.ok(Math.abs(etat.ts - Date.now()) < 60000);
  });

  test('l empreinte ignore l horodatage et voit tout autre changement', () => {
    const { empreinte } = require(ADAPTATEUR);
    const corps = 'ledger 1 ouverte, 1 bloquée (P1/C-0002) ; agents 1 en cours, 1 échoué (A) ; APP propre, = main, = distant ; API 3 modif, +2 main, +2 distant ; plans 50 % (2/4) ; quota claude 7 j 71 %.';
    const a = `COCKPIT 2026-03-02 20:55 : ${corps}`;
    assert.equal(empreinte(a), empreinte(`COCKPIT 2026-03-02 21:30 : ${corps}`));
    assert.notEqual(empreinte(a), empreinte(`COCKPIT 2026-03-02 20:55 : ${corps.replace('1 ouverte', '2 ouvertes')}`));
    assert.notEqual(empreinte(a), empreinte(`COCKPIT 2026-03-02 20:55 : ${corps.replace('71 %', '72 %')}`), 'un changement tout à la fin du bloc compte aussi');
  });

  test('executer ne lève jamais sur une entrée invalide : il rend null', () => {
    const { executer } = require(ADAPTATEUR);
    for (const entree of ['pas du json', '', '[]', 'null', '"abc"', '5', 'true', '{}']) {
      assert.equal(executer(entree, 'codex'), null, entree);
    }
  });

  test('chaque agent et chaque fil ont leur propre état', () => {
    contexteDe(lancer(prompt(), { agent: 'codex' }));
    contexteDe(lancer(prompt(), { agent: 'deepseek_H' }));
    contexteDe(lancer(prompt({ session_id: 'S2' }), { agent: 'codex' }));
    assert.deepEqual(fs.readdirSync(ETAT).filter(f => f.startsWith('inj-')).sort(), ['inj-codex-S1.json', 'inj-codex-S2.json', 'inj-deepseek-h-S1.json']);
  });

  test('un identifiant de session très long est coupé à 64 caractères', () => {
    contexteDe(lancer(prompt({ session_id: 'a'.repeat(300) })));
    assert.deepEqual(fs.readdirSync(ETAT).filter(f => f.startsWith('inj-')), [`inj-codex-${'a'.repeat(64)}.json`]);
  });

  test('une erreur interne est silencieuse : sortie vide, code 0, rien sur stderr', () => {
    fs.mkdirSync(fichierInjection(), { recursive: true }); // un dossier à la place du fichier d état : l écriture échoue
    const r = lancer(prompt());
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('un identifiant de session hostile ne sort pas du dossier du Cockpit', () => {
    const r = lancer(prompt({ session_id: '../../evil' }));
    assert.equal(r.status, 0);
    assert.deepEqual(fs.readdirSync(RUN).sort(), ['cockpit', 'contexte', 'plans']);
    assert.deepEqual(fs.readdirSync(ETAT).sort(), ['config.json', 'inj-codex-______evil.json'], 'un seul fichier, au nom assaini, et rien d autre');
  });
});

describe('rappel du Régulateur d agents dans le contexte', () => {
  const ENTETE_RAPPEL = "RÉGULATEUR D'AGENTS (ordre de l'utilisateur, valable après compactage) : ";
  const MIN = 60 * 1000;
  const EN_COURS = 'agent en cours depuis 2026-03-02 11:00';
  const ECHEC = 'TERMINÉ (failed) le 2026-03-02 11:30 : r';
  const politique = p => core.ecrireJson(path.join(ETAT, 'politique-agents.json'), p);
  const agentLigne = (nom, note, extra = {}) => ({ texte: `[agent] « ${nom} » (default, id-${nom}) : x`, statut: 'en-cours', note, maj: new Date(Date.now() - MIN).toISOString(), ...extra });
  const contexte = r => contexteDe(r).hookSpecificOutput.additionalContext;
  const vieillir = minutes => {
    const f = fichierInjection();
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ts: Date.now() - minutes * MIN }));
  };

  test('sans politique, le contexte est le bloc du Cockpit seul, même avec des agents en cours', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }) });
    const c = contexte(lancer(demarrage()));
    assert.match(c, /^COCKPIT /);
    assert.ok(!c.includes('\n'), 'une seule ligne');
    assert.ok(!c.includes('RÉGULATEUR'));
    assert.ok(c.length <= 700);
  });

  test('plafond fixé : le rappel suit le bloc sur la ligne suivante, avec les agents de ce fil', () => {
    politique({ max: 3 });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }) });
    const [bloc, rappel, ...reste] = contexte(lancer(demarrage())).split('\n');
    assert.match(bloc, /^COCKPIT .*agents 1 en cours, max 3/);
    assert.equal(rappel, `${ENTETE_RAPPEL}Maximum 3 agents en parallèle. 1 en cours, 2 créneaux libres. Dès qu'un agent finit, lance le suivant de ta liste sans attendre.`);
    assert.deepEqual(reste, []);
  });

  test('le rappel est injecté aussi par UserPromptSubmit, sous son propre nom d événement', () => {
    politique({ max: 3 });
    const s = contexteDe(lancer(prompt()));
    assert.equal(s.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(s.hookSpecificOutput.additionalContext, /\nRÉGULATEUR D'AGENTS .*Maximum 3 agents en parallèle\. 0 en cours, 3 créneaux libres\./);
  });

  test('seuls les agents de CE fil et de CET agent comptent', () => {
    politique({ max: 3 });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }), 'C-0002': agentLigne('B', EN_COURS, { session: 'S1' }), 'C-0003': agentLigne('C', EN_COURS, { session: 'AUTRE' }) });
    ecrireEtatLedger('deepseek_H', 'P1', { 'C-0001': agentLigne('D', EN_COURS, { session: 'S1' }) });
    const dit = (agent, session) => contexte(lancer(demarrage({ session_id: session }), { agent })).split('\n')[1];
    assert.match(dit('codex', 'S1'), /Maximum 3 agents en parallèle\. 2 en cours, 1 créneau libre\./);
    assert.match(dit('codex', 'AUTRE'), /Maximum 3 agents en parallèle\. 1 en cours, 2 créneaux libres\./);
    assert.match(dit('deepseek_H', 'S1'), /Maximum 3 agents en parallèle\. 1 en cours, 2 créneaux libres\./);
    assert.match(dit('deepseek_H', 'S2'), /Maximum 3 agents en parallèle\. 0 en cours, 3 créneaux libres\./);
  });

  test('plafond atteint : le rappel dit qu aucun créneau n est libre', () => {
    politique({ max: 2 });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }), 'C-0002': agentLigne('B', EN_COURS, { session: 'S1' }) });
    assert.equal(contexte(lancer(demarrage())).split('\n')[1], `${ENTETE_RAPPEL}Maximum 2 agents en parallèle. 2 en cours, aucun créneau libre : n'en lance pas avant qu'un finisse.`);
  });

  test('pause : le rappel dit la pause, sans compter les agents', () => {
    politique({ max: 3, pause: true });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }) });
    const c = contexte(lancer(demarrage()));
    assert.match(c.split('\n')[0], /agents 1 en cours, en pause \(max 3\)/);
    assert.equal(c.split('\n')[1], `${ENTETE_RAPPEL}PAUSE : ne lance aucun agent tant que l'utilisateur n'a pas dit « /plafond reprendre » ou « /plafond libre ».`);
  });

  test('pause seule, sans plafond : le rappel dit la pause', () => {
    politique({ pause: true });
    assert.equal(contexte(lancer(demarrage())).split('\n')[1], `${ENTETE_RAPPEL}PAUSE : ne lance aucun agent tant que l'utilisateur n'a pas dit « /plafond reprendre » ou « /plafond libre ».`);
  });

  test('l identifiant du fil sert tel quel au comptage, même avec des caractères que le nom de fichier assainit', () => {
    politique({ max: 3 });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'fil.A:1' }) });
    assert.match(contexte(lancer(demarrage({ session_id: 'fil.A:1' }))).split('\n')[1], /Maximum 3 agents en parallèle\. 1 en cours, 2 créneaux libres\./);
  });

  test('une politique inerte ne lit jamais le ledger des agents, une politique active le lit', () => {
    const espion = path.join(RUN, 'espion.txt');
    const lancerEspion = () => spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(demarrage()),
      encoding: 'utf8',
      env: { ...process.env, ESPION_ETAT_AGENTS: espion, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'espion-etat-agents.js')}` },
      timeout: 60000,
    });
    contexte(lancerEspion());
    assert.equal(fs.existsSync(espion), false, 'politique absente : aucun comptage');
    politique({ max: null, pause: false, relance: false });
    contexte(lancerEspion());
    assert.equal(fs.existsSync(espion), false, 'politique inerte écrite : aucun comptage');
    politique({ max: 3 });
    contexte(lancerEspion());
    assert.equal(fs.readFileSync(espion, 'utf8'), 'appel\n');
  });

  test('relance activée : les agents échoués de ce fil sont nommés, ceux des autres fils non', () => {
    politique({ relance: true });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('Alpha', ECHEC, { session: 'S1', statut: 'ouvert' }), 'C-0002': agentLigne('Beta', ECHEC, { session: 'AUTRE', statut: 'ouvert' }) });
    assert.equal(contexte(lancer(demarrage())).split('\n')[1], `${ENTETE_RAPPEL}Agents échoués à relancer depuis leur point d'arrêt (2 relances au plus chacun) : Alpha.`);
  });

  test('relance activée sans agent échoué dans ce fil : rien à rappeler', () => {
    politique({ relance: true });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('Beta', ECHEC, { session: 'AUTRE', statut: 'ouvert' }) });
    assert.ok(!contexte(lancer(demarrage())).includes('RÉGULATEUR'));
  });

  test('le contexte reste borné : cinq noms longs d agents échoués au plus, le reste compté', () => {
    politique({ max: 50, relance: true });
    const lignes = {};
    for (let i = 1; i <= 7; i++) lignes[`C-000${i}`] = agentLigne(`${'N'.repeat(60)}${i}`, ECHEC, { session: 'S1', statut: 'ouvert' });
    ecrireEtatLedger('codex', 'P1', lignes);
    const c = contexte(lancer(demarrage()));
    const [bloc, rappel] = c.split('\n');
    assert.ok(bloc.length <= 700);
    assert.ok(c.length <= 1301, `longueur ${c.length}`);
    assert.ok(rappel.includes(`${'N'.repeat(37)}...`), 'un nom long est coupé à 40 caractères');
    assert.match(rappel, / \+2\.$/);
  });

  test('un fichier de politique abîmé est une politique inerte', () => {
    for (const abime of ['{pas du json', '[]', '"x"', JSON.stringify({ max: 'cinq', pause: 'oui' })]) {
      fs.writeFileSync(path.join(ETAT, 'politique-agents.json'), abime);
      const c = contexte(lancer(demarrage()));
      assert.match(c, /^COCKPIT /, abime);
      assert.ok(!c.includes('RÉGULATEUR'), abime);
    }
  });

  test('une panne du comptage des agents ne retire pas le bloc du Cockpit', () => {
    politique({ max: 3 });
    const r = spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(demarrage()),
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-etat-agents.js')}` },
      timeout: 60000,
    });
    const c = contexte(r);
    assert.match(c, /^COCKPIT /);
    assert.ok(!c.includes('RÉGULATEUR'));
  });

  test('le rappel compte dans l empreinte : lui seul qui change déclenche une nouvelle injection', () => {
    politique({ max: 3 });
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }) });
    const [bloc1, rappel1] = contexte(lancer(prompt())).split('\n');
    assert.match(rappel1, /1 en cours, 2 créneaux libres/);
    // l agent passe dans un autre fil : le bloc (global) ne change pas, le rappel de ce fil change
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'AUTRE' }) });
    vieillir(11);
    const [bloc2, rappel2] = contexte(lancer(prompt())).split('\n');
    const sansEntete = b => b.replace(/^COCKPIT \d{4}-\d{2}-\d{2} \d{2}:\d{2} : /, '');
    assert.equal(sansEntete(bloc2), sansEntete(bloc1), 'le bloc n a pas changé');
    assert.match(rappel2, /0 en cours, 3 créneaux libres/);
  });

  test('bloc et rappel inchangés, même après une heure : pas de nouvelle injection', () => {
    politique({ max: 3 });
    contexteDe(lancer(prompt()));
    vieillir(60);
    assert.equal(lancer(prompt()).stdout, '');
  });
});

describe('quota de Codex (Garde-quota)', () => {
  const quotaCore = require(path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js'));
  const MIN = 60 * 1000;
  const HEURE = 60 * MIN;
  const JOURS3 = 3 * 24 * HEURE;
  const tokenCount = (pct, dansMs = JOURS3 + 30 * 1000) => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round((Date.now() + dansMs) / 1000) }, secondary: null } } });
  let seq = 0;
  const rollout = (...lignes) => {
    const f = path.join(RUN, `rollout-${++seq}.jsonl`);
    fs.writeFileSync(f, `${lignes.join('\n')}\n`);
    return f;
  };
  const ENTETE_QUOTA = /^GARDE-QUOTA : Quota 7 j à (\d+) % : /;
  const contexte = r => contexteDe(r).hookSpecificOutput.additionalContext;
  const vieillir = minutes => {
    const f = fichierInjection();
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ts: Date.now() - minutes * MIN }));
  };

  test('la mesure du rollout est dite dans le bloc du Cockpit, sans autre ligne tant que le quota est bas', () => {
    const c = contexte(lancer(demarrage({ transcript_path: rollout(tokenCount(43)) })));
    assert.ok(!c.includes('\n'), 'aucune ligne en plus');
    assert.match(c, /quota codex 7 j 43 %/);
    assert.equal(quotaCore.fenetresCourantes({ agent: 'codex', chemin: undefined })[0].pct, 43);
  });

  test('une alerte d attention est dite une fois, sur la ligne qui suit le bloc, puis plus', () => {
    const f = rollout(tokenCount(82));
    const lignes = contexte(lancer(demarrage({ transcript_path: f }))).split('\n');
    assert.equal(lignes.length, 2);
    assert.match(lignes[0], /^COCKPIT .*quota codex 7 j 82 %/);
    assert.match(lignes[1], /^GARDE-QUOTA : Quota 7 j à 82 % : attention \(remise à zéro dans 3 j 0 h\)$/);
    assert.equal(contexte(lancer(demarrage({ transcript_path: f }))).split('\n').length, 1, 'rien de plus au démarrage suivant');
  });

  test('au seuil critique : l alerte, puis la consigne de relais pour Claude qui reste tant que la fenêtre l est', () => {
    const f = rollout(tokenCount(92));
    const lignes = contexte(lancer(demarrage({ transcript_path: f }))).split('\n');
    assert.equal(lignes.length, 3);
    assert.match(lignes[1], /^GARDE-QUOTA : Quota 7 j à 92 % : seuil critique, nouveaux agents bloqués/);
    assert.match(lignes[2], /^GARDE-QUOTA \(ordre de l'utilisateur, valable après compactage\) : fenêtre 7 j au-delà de 90 %\..*prompt de relais pour Claude dans .*relais-claude\.md, puis ne lance plus d'agent/);
    const suite = contexte(lancer(demarrage({ transcript_path: f }))).split('\n');
    assert.equal(suite.length, 2, 'l alerte n est plus dite, la consigne reste');
    assert.match(suite[1], /^GARDE-QUOTA \(ordre de l'utilisateur/);
  });

  test('une alerte critique n attend pas le délai de dix minutes entre deux injections', () => {
    contexteDe(lancer(prompt({ transcript_path: rollout(tokenCount(50)) })));
    const r = lancer(prompt({ transcript_path: rollout(tokenCount(93)) }));
    assert.match(contexte(r), /\nGARDE-QUOTA : Quota 7 j à 93 % : seuil critique/);
  });

  test('un changement de quota rend immediatement la mesure et son alerte d attention', () => {
    contexteDe(lancer(prompt({ transcript_path: rollout(tokenCount(50)) })));
    const f = rollout(tokenCount(83));
    assert.match(contexte(lancer(prompt({ transcript_path: f }))), /\nGARDE-QUOTA : Quota 7 j à 83 % : attention/);
    assert.equal(lancer(prompt({ transcript_path: f })).stdout, '', 'la meme mesure ne reinjecte pas');
  });

  test('une alerte critique née d un changement de seuil, la mesure restant la même, n attend pas le délai de dix minutes', () => {
    const f = rollout(tokenCount(85));
    contexteDe(lancer(prompt({ transcript_path: f })));
    core.ecrireJson(path.join(ETAT, 'garde-quota.json'), { attention: 70, critique: 80 });
    assert.match(contexte(lancer(prompt({ transcript_path: f }))), /\nGARDE-QUOTA : Quota 7 j à 85 % : seuil critique/);
  });

  test('la nouvelle mesure du Cockpit est injectee sans attendre dix minutes', () => {
    contexteDe(lancer(prompt({ transcript_path: rollout(tokenCount(50)) })));
    assert.match(contexte(lancer(prompt({ transcript_path: rollout(tokenCount(55)) }))), /55 % consommés, 45 % restants/);
    assert.equal(require(path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js')).lireQuota('codex').fenetres[0].pct, 55);
  });

  test('le rappel du Régulateur passe avant les lignes du quota', () => {
    core.ecrireJson(path.join(ETAT, 'politique-agents.json'), { max: 3 });
    const lignes = contexte(lancer(demarrage({ transcript_path: rollout(tokenCount(92)) }))).split('\n');
    assert.deepEqual(lignes.map(l => l.split(' ')[0]), ['COCKPIT', 'RÉGULATEUR', 'GARDE-QUOTA', 'GARDE-QUOTA']);
    assert.ok(lignes.join('\n').length <= 2000, `longueur ${lignes.join('\n').length}`);
  });

  test('sans transcript_path ni mesure gardée, le contexte est celui du Cockpit seul', () => {
    const c = contexte(lancer(demarrage()));
    assert.ok(!c.includes('\n'));
    assert.ok(!c.includes('GARDE-QUOTA'));
    assert.deepEqual(fs.readdirSync(ETAT).filter(x => x.includes('quota')), [], 'aucune mesure ni mémoire de quota écrite sans mesure');
  });

  test('une mesure gardée suffit quand le fil n en a pas encore : l alerte critique est dite', () => {
    quotaCore.mesurerCodex({ agent: 'codex', chemin: rollout(tokenCount(95)) });
    assert.match(contexte(lancer(demarrage())), /\nGARDE-QUOTA : Quota 7 j à 95 %/);
  });

  test('chaque agent principal a sa mesure et sa mémoire d annonces', () => {
    lancer(demarrage({ transcript_path: rollout(tokenCount(82)) }), { agent: 'codex' });
    assert.match(contexte(lancer(demarrage({ transcript_path: rollout(tokenCount(82)) }), { agent: 'deepseek_H' })), /\nGARDE-QUOTA : Quota 7 j à 82 %/);
    assert.deepEqual(fs.readdirSync(ETAT).filter(x => x.includes('quota')).sort(), ['garde-quota-alertes-codex.json', 'garde-quota-alertes-deepseek-h.json', 'quota-codex.json', 'quota-deepseek-h.json']);
  });

  test('après un compactage, la consigne du seuil critique est dite de nouveau', () => {
    const f = rollout(tokenCount(92));
    contexteDe(lancer(prompt({ transcript_path: f })));
    assert.equal(lancer(prompt({ transcript_path: f })).stdout, '');
    lancer({ hook_event_name: 'PostCompact', session_id: 'S1', cwd: 'C:/x' });
    const c = contexte(lancer(prompt({ transcript_path: f })));
    assert.match(c, /\nGARDE-QUOTA \(ordre de l'utilisateur/);
    assert.ok(!/Quota 7 j à 92 %/.test(c), 'l alerte, déjà dite, ne l est pas deux fois');
  });

  test('une panne du Garde-quota ne retire pas le bloc du Cockpit', () => {
    const r = spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(demarrage({ transcript_path: rollout(tokenCount(92)) })),
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-quota.js')}` },
      timeout: 60000,
    });
    const c = contexte(r);
    assert.match(c, /^COCKPIT /);
    assert.ok(!c.includes('GARDE-QUOTA'));
  });

  test('une alerte non remise (injection retardée) n est pas mémorisée', () => {
    core.ecrireJson(path.join(ETAT, 'garde-quota.json'), { attention: 90, critique: 98 });
    // La même mesure pour les deux messages : tokenCount() date la remise à zéro à la seconde de son appel, et deux
    // appels séparés par le premier lancement donnaient parfois deux mesures différentes, donc une injection
    // immédiate (test rouge environ une fois sur quatre).
    const mesure = tokenCount(84);
    contexteDe(lancer(prompt({ transcript_path: rollout(mesure) })));
    core.ecrireJson(path.join(ETAT, 'garde-quota.json'), { attention: 80, critique: 98 });
    assert.equal(lancer(prompt({ transcript_path: rollout(mesure) })).stdout, '');
    assert.equal(fs.existsSync(path.join(ETAT, 'garde-quota-alertes-codex.json')), true, 'la mémoire de la première injection existe');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ETAT, 'garde-quota-alertes-codex.json'), 'utf8')).deja, [], 'mais l alerte à 84 % n y est pas');
  });
});

describe('après un compactage', () => {
  // Codex interdit d'injecter au PostCompact (schéma) : l'adaptateur oublie l'injection de ce fil, le message suivant réinjecte.
  const compactage = (extra = {}) => ({ hook_event_name: 'PostCompact', session_id: 'S1', cwd: 'C:/x', ...extra });

  test('PostCompact n injecte rien et oublie l injection de CE fil de CET agent seulement', () => {
    contexteDe(lancer(prompt()));
    contexteDe(lancer(prompt({ session_id: 'S2' })));
    contexteDe(lancer(prompt(), { agent: 'deepseek_H' }));
    const r = lancer(compactage());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(fichierInjection('codex', 'S1')), false);
    assert.equal(fs.existsSync(fichierInjection('codex', 'S2')), true, 'un autre fil garde son état');
    assert.equal(fs.existsSync(fichierInjection('deepseek-h', 'S1')), true, 'un autre agent garde son état');
  });

  test('le message suivant réinjecte le bloc même si rien n a changé et si la dernière injection est récente', () => {
    contexteDe(lancer(prompt()));
    assert.equal(lancer(prompt()).stdout, '', 'sans compactage, un état inchangé reste silencieux');
    lancer(compactage());
    assert.match(contexteDe(lancer(prompt())).hookSpecificOutput.additionalContext, /^COCKPIT /);
  });

  test('le rappel du Régulateur est réinjecté de la même façon', () => {
    core.ecrireJson(path.join(ETAT, 'politique-agents.json'), { max: 3 });
    contexteDe(lancer(prompt()));
    lancer(compactage());
    assert.match(contexteDe(lancer(prompt())).hookSpecificOutput.additionalContext, /\nRÉGULATEUR D'AGENTS .*Maximum 3 agents en parallèle\./);
  });

  test('un PostCompact de sous-agent ne touche à rien', () => {
    contexteDe(lancer(prompt()));
    for (const extra of [{ agent_id: 'A1' }, { agent_type: 'explorer' }]) {
      const r = lancer(compactage(extra));
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
    assert.equal(fs.existsSync(fichierInjection()), true);
  });

  test('un PostCompact sans état préalable ne lève pas et n écrit rien', () => {
    const r = lancer(compactage());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.deepEqual(fs.readdirSync(ETAT), ['config.json']);
  });

  test('executer rend null sans lever, même quand il n y a aucun état à oublier', () => {
    const { executer } = require(ADAPTATEUR);
    assert.equal(executer(JSON.stringify(compactage()), 'codex'), null);
  });

  test('sans agent valide ou sans session, rien n est effacé', () => {
    contexteDe(lancer(prompt()));
    assert.equal(lancer(compactage(), { args: [] }).stdout, '');
    assert.equal(lancer(compactage(), { args: ['--agent', '../evil'] }).stdout, '');
    assert.equal(lancer({ hook_event_name: 'PostCompact', cwd: 'C:/x' }).stdout, '');
    assert.equal(fs.existsSync(fichierInjection()), true);
  });

  test('un identifiant de session hostile n efface rien d autre que l état assaini de ce fil', () => {
    const voisin = path.join(ETAT, 'evil.json'); // ce que « inj-codex-../../evil.json » désignerait sans assainissement
    fs.writeFileSync(voisin, '{}');
    contexteDe(lancer(prompt({ session_id: '../../evil' })));
    assert.equal(fs.existsSync(fichierInjection('codex', '______evil')), true);
    const r = lancer(compactage({ session_id: '../../evil' }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(voisin), true, 'le fichier voisin est intact');
    assert.equal(fs.existsSync(fichierInjection('codex', '______evil')), false, 'seul l état assaini de ce fil est parti');
    assert.deepEqual(fs.readdirSync(RUN).sort(), ['cockpit', 'contexte', 'plans']);
  });
});

describe('entretien', () => {
  test('SessionStart supprime les états d injection de plus de trois jours, et seulement eux', () => {
    fs.mkdirSync(ETAT, { recursive: true });
    const vieux = path.join(ETAT, 'inj-codex-vieux.json');
    const recent = path.join(ETAT, 'inj-codex-recent.json');
    const autre = path.join(ETAT, 'quota-codex.json');
    for (const f of [vieux, recent, autre]) fs.writeFileSync(f, '{}');
    const ancien = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    fs.utimesSync(vieux, ancien, ancien);
    fs.utimesSync(autre, ancien, ancien);
    contexteDe(lancer(demarrage()));
    assert.equal(fs.existsSync(vieux), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(autre), true, 'un fichier qui n est pas un état d injection n est jamais supprimé');
  });
});

describe('consignes en vigueur', () => {
  const MIN = 60 * 1000;
  const cons = (id, texte, verrou = null, actif = true) => ({ id, texte, actif, verrou });
  const poser = consignes => core.ecrireJson(path.join(ETAT, 'consignes.json'), { prochain: 50, consignes });
  const vieillir = ms => {
    const f = fichierInjection();
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ts: Date.now() - ms }));
  };
  const contexte = r => contexteDe(r).hookSpecificOutput.additionalContext;
  const ENTETE = "CONSIGNES EN VIGUEUR DE L'UTILISATEUR (ordres permanents, liste complète et à jour : elle remplace toute liste vue avant ; valables après compactage ; « verrou » = le code refuse ce qu'il sait reconnaître) :";
  const LEVEE = 'CONSIGNES EN VIGUEUR DE L\'UTILISATEUR : aucune. Les consignes données avant sont levées.';

  test('sans consigne, le contexte est celui d avant : le bloc seul, et rien de plus dans l état', () => {
    const c = contexte(lancer(demarrage()));
    assert.match(c, /^COCKPIT [^\n]*$/);
    assert.ok(!c.includes('CONSIGNES'));
    assert.equal(JSON.parse(fs.readFileSync(fichierInjection(), 'utf8')).consignes, null);
  });

  test('des consignes actives sont dites après le bloc, avec leur verrou, au démarrage et à la première invite', () => {
    poser([cons(1, 'Pas de push', 'push'), cons(3, 'Français')]);
    for (const evenement of [demarrage(), prompt({ session_id: 'S2' })]) {
      const lignes = contexte(lancer(evenement)).split('\n');
      assert.equal(lignes.length, 4);
      assert.match(lignes[0], /^COCKPIT /);
      assert.equal(lignes[1], ENTETE);
      assert.equal(lignes[2], '1. Pas de push [verrou : push]');
      assert.equal(lignes[3], '3. Français');
      assert.ok(!/\u{2014}/u.test(lignes.join('\n')), 'jamais de tiret cadratin');
    }
  });

  test('elles viennent après le rappel du Régulateur', () => {
    core.ecrireJson(path.join(ETAT, 'politique-agents.json'), { max: 3 });
    poser([cons(1, 'Pas de push', 'push')]);
    const lignes = contexte(lancer(demarrage())).split('\n');
    assert.match(lignes[0], /^COCKPIT /);
    assert.match(lignes[1], /^RÉGULATEUR D'AGENTS /);
    assert.equal(lignes[2], ENTETE);
  });

  test('une consigne en pause n est pas dite ; sans consigne active, le contexte est le bloc seul', () => {
    poser([cons(1, 'Pas de push', 'push', false), cons(2, 'Français')]);
    const c = contexte(lancer(demarrage()));
    assert.ok(!c.includes('Pas de push'));
    assert.ok(c.includes('2. Français'));
    poser([cons(1, 'Pas de push', 'push', false)]);
    assert.ok(!contexte(lancer(demarrage({ session_id: 'S2' }))).includes('CONSIGNES'), 'un fil qui n a jamais reçu de consigne n a rien à lever');
    assert.ok(contexte(lancer(demarrage())).endsWith(`\n${LEVEE}`), 'le fil qui les avait reçues apprend leur levée');
  });

  test('une consigne ajoutée ou changée n attend pas le délai de dix minutes entre deux injections', () => {
    contexteDe(lancer(prompt()));
    poser([cons(1, 'Pas de push', 'push')]);
    vieillir(1 * MIN);
    assert.ok(contexte(lancer(prompt())).includes('1. Pas de push [verrou : push]'));
    poser([cons(1, 'Pas de push ni de déploiement', 'push')]);
    vieillir(1 * MIN);
    assert.ok(contexte(lancer(prompt())).includes('1. Pas de push ni de déploiement'));
  });

  test('consignes et bloc inchangés : pas de nouvelle injection, même après une heure', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    contexteDe(lancer(prompt()));
    assert.equal(lancer(prompt()).stdout, '');
    vieillir(60 * MIN);
    assert.equal(lancer(prompt()).stdout, '');
  });

  test('toutes les consignes levées : une ligne le dit une fois, puis plus rien', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    contexteDe(lancer(prompt()));
    poser([]);
    vieillir(1 * MIN);
    const c = contexte(lancer(prompt()));
    assert.ok(c.endsWith(`\n${LEVEE}`), c);
    assert.equal(JSON.parse(fs.readFileSync(fichierInjection(), 'utf8')).consignes, null);
    vieillir(60 * MIN);
    assert.equal(lancer(prompt()).stdout, '', 'dite une seule fois');
  });

  test('une consigne retirée parmi d autres : la liste complète est redite, sans la ligne de levée', () => {
    poser([cons(1, 'Pas de push', 'push'), cons(2, 'Français')]);
    contexteDe(lancer(prompt()));
    poser([cons(2, 'Français')]);
    vieillir(1 * MIN);
    const c = contexte(lancer(prompt()));
    assert.ok(c.includes(ENTETE));
    assert.ok(!c.includes('Pas de push'));
    assert.ok(!c.includes(LEVEE));
  });

  test('après un compactage, le message suivant redit les consignes même si rien n a changé', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    contexteDe(lancer(prompt()));
    assert.equal(lancer(prompt()).stdout, '');
    lancer({ hook_event_name: 'PostCompact', session_id: 'S1', cwd: 'C:/x' });
    assert.ok(contexte(lancer(prompt())).includes('1. Pas de push [verrou : push]'));
  });

  test('l état d injection garde l empreinte du texte des consignes', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    contexteDe(lancer(prompt()));
    const avant = JSON.parse(fs.readFileSync(fichierInjection(), 'utf8'));
    assert.match(avant.consignes, /^[0-9a-f]{40}$/);
    poser([cons(1, 'Pas de push', 'push'), cons(2, 'Français')]);
    vieillir(1 * MIN);
    contexteDe(lancer(prompt()));
    const apres = JSON.parse(fs.readFileSync(fichierInjection(), 'utf8'));
    assert.match(apres.consignes, /^[0-9a-f]{40}$/);
    assert.notEqual(apres.consignes, avant.consignes);
  });

  test('un état d injection d avant les consignes (sans leur empreinte) est compris comme « aucune consigne »', () => {
    contexteDe(lancer(prompt()));
    const f = fichierInjection();
    const ancien = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete ancien.consignes;
    fs.writeFileSync(f, JSON.stringify(ancien));
    assert.equal(lancer(prompt()).stdout, '', 'rien n a changé : pas de ligne de levée');
    // Le contexte a changé (empreinte différente) mais le délai de dix minutes n'est pas écoulé : un état d'avant les consignes ne
    // compte pas comme un changement de consignes, il ne force donc pas la réinjection (ni une ligne de levée).
    fs.writeFileSync(f, JSON.stringify({ ...ancien, empreinte: 'autre-empreinte' }));
    assert.equal(lancer(prompt()).stdout, '', 'un état d avant les consignes n est pas un changement de consignes');
    poser([cons(1, 'Pas de push', 'push')]);
    vieillir(1 * MIN);
    assert.ok(contexte(lancer(prompt())).includes('1. Pas de push'));
  });

  test('un fichier de consignes abîmé n ajoute rien et ne retire pas le bloc', () => {
    fs.writeFileSync(path.join(ETAT, 'consignes.json'), '{pas du json');
    const c = contexte(lancer(demarrage()));
    assert.match(c, /^COCKPIT [^\n]*$/);
  });

  test('une panne des consignes ne retire pas le bloc du Cockpit', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    const r = spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(demarrage()),
      encoding: 'utf8',
      // COCKPIT_QUOTA_NATIVE=0 comme dans lancer() : sans lui ce test lisait le vrai quota du poste et rougissait au seuil critique.
      env: { ...process.env, COCKPIT_QUOTA_NATIVE: '0', NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-consignes.js')}` },
      timeout: 60000,
    });
    const c = contexte(r);
    assert.match(c, /^COCKPIT [^\n]*$/);
    assert.ok(!c.includes('CONSIGNES'));
  });

  test('un sous-agent ne reçoit pas les consignes (le refus des commandes, lui, vaut pour tous)', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    const r = lancer(prompt({ agent_id: 'A1' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('chaque fil a son état : un autre fil reçoit les consignes à sa première invite', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    contexteDe(lancer(prompt()));
    assert.ok(contexte(lancer(prompt({ session_id: 'S2' }))).includes('1. Pas de push'));
  });
});

describe('mesure git en arrière-plan', () => {
  const attendre = async (condition, ms = 40000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { if (condition()) return true; await new Promise(r => setTimeout(r, 250)); }
    return condition();
  };

  test('sans mesure git, l adaptateur répond tout de suite et la mesure arrive ensuite', async () => {
    const { depot } = monterDans(RUN);
    core.ecrireJson(path.join(ETAT, 'config.json'), { worktrees: [depot], plans: { dossier: path.join(RUN, 'plans'), exclure: [], profondeur: 1 } });
    const s = contexteDe(lancer(demarrage()));
    assert.match(s.hookSpecificOutput.additionalContext, /git \?/, 'la première réponse ne attend pas la mesure');
    assert.equal(await attendre(() => core.lireGitEtat() !== null), true, 'la mesure git est arrivée');
    assert.equal(core.lireGitEtat().depots[0].nom, 'T');
    const suite = contexteDe(lancer(demarrage()));
    assert.match(suite.hookSpecificOutput.additionalContext, /T propre, = main, = distant/);
  });

  test('sans worktree configuré, aucune mesure git n est lancée', async () => {
    contexteDe(lancer(demarrage()));
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(fs.existsSync(path.join(ETAT, 'git-etat.json')), false);
    assert.equal(fs.existsSync(path.join(ETAT, 'git-etat.verrou')), false);
  });

  test('une mesure git récente n est pas relancée', async () => {
    const { depot } = monterDans(RUN);
    core.ecrireJson(path.join(ETAT, 'config.json'), { worktrees: [depot], plans: { dossier: path.join(RUN, 'plans'), exclure: [], profondeur: 1 } });
    core.ecrireJson(path.join(ETAT, 'git-etat.json'), { mesureA: new Date().toISOString(), depots: [], marqueur: 'intact' });
    contexteDe(lancer(demarrage()));
    await new Promise(r => setTimeout(r, 6000));
    assert.equal(core.lireJson(path.join(ETAT, 'git-etat.json'), {}).marqueur, 'intact');
  });

  test('une mesure git de plus de 10 minutes est relancée', async () => {
    const { depot } = monterDans(RUN);
    core.ecrireJson(path.join(ETAT, 'config.json'), { worktrees: [depot], plans: { dossier: path.join(RUN, 'plans'), exclure: [], profondeur: 1 } });
    core.ecrireJson(path.join(ETAT, 'git-etat.json'), { mesureA: new Date(Date.now() - 11 * 60 * 1000).toISOString(), depots: [], marqueur: 'ancien' });
    contexteDe(lancer(demarrage()));
    assert.equal(await attendre(() => core.lireJson(path.join(ETAT, 'git-etat.json'), {}).marqueur === undefined), true);
    assert.equal(core.lireGitEtat().depots[0].nom, 'T');
  });
});

describe('la nuit dans le bloc', () => {
  const contexte = r => contexteDe(r).hookSpecificOutput.additionalContext;
  const poserNuit = etat => core.ecrireJson(path.join(ETAT, 'nuit.json'), etat);
  const poserBoite = entrees => core.ecrireJson(path.join(ETAT, 'nuit-boite.json'), { prochain: 50, entrees });
  const question = (id, extra = {}) => ({ id, agent: 'codex', session: 'S1', type: 'question', ajoute: '2026-03-04T00:05:00.000Z', titre: `Question ${id} ?`, details: '', options: [], statut: 'en-attente', reponse: null, traite: null, ...extra });

  test('sans nuit active ni question en boîte, le bloc ne dit rien de la nuit', () => {
    poserNuit({ actif: false, tours: 3 });
    assert.ok(!contexte(lancer(demarrage())).includes('nuit'));
  });

  test('une nuit active et les questions qui attendent sont dites dans le bloc, au démarrage', () => {
    poserNuit({ actif: true, mode: 'nuit', depuis: '2026-03-04T00:00:00.000Z', tours: 4, maxTours: 60 });
    poserBoite([question(1), question(2, { statut: 'ecartee', traite: '2026-03-04T01:00:00.000Z' })]);
    assert.match(contexte(lancer(demarrage())), / ; nuit active 4\/60, 1 à décider ;/);
  });

  test('une question en boîte alors que la nuit est finie est dite aussi', () => {
    poserNuit({ actif: false });
    poserBoite([question(1)]);
    assert.match(contexte(lancer(demarrage())), / ; nuit inactive, 1 à décider ;/);
  });
});

// Après un compactage, le premier outil réinjecte le bloc, une seule fois.
describe('compactage puis outil', () => {
  const outil = (extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: 'S1', cwd: 'C:/x', tool_name: 'shell', ...extra });
  const compacter = (extra = {}) => lancer({ hook_event_name: 'PostCompact', session_id: 'S1', cwd: 'C:/x', ...extra });
  const marque = (agent = 'codex', session = 'S1') => path.join(ETAT, `inj-${agent}-${session}.compacte`);

  test('sans compactage, un outil ne reçoit rien, même après une injection', () => {
    assert.equal(lancer(outil()).stdout, '');
    contexteDe(lancer(prompt()));
    assert.equal(lancer(outil()).stdout, '');
  });

  test('le premier outil après le compactage reçoit le bloc sous le nom PostToolUse, le suivant rien', () => {
    contexteDe(lancer(prompt()));
    compacter();
    assert.equal(fs.existsSync(marque()), true);
    const s = contexteDe(lancer(outil()));
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    assert.equal(s.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(s.hookSpecificOutput.additionalContext, /^COCKPIT /);
    assert.equal(fs.existsSync(marque()), false);
    assert.equal(lancer(outil()).stdout, '', 'une seule fois');
    assert.equal(lancer(prompt()).stdout, '', 'le message suivant ne redit pas un bloc inchangé');
  });

  test('un outil de sous-agent, d un autre fil ou d un autre agent ne prend pas la marque', () => {
    contexteDe(lancer(prompt()));
    compacter();
    assert.equal(lancer(outil({ agent_id: 'A1' })).stdout, '');
    assert.equal(lancer(outil({ agent_type: 'explorer' })).stdout, '');
    assert.equal(lancer(outil({ session_id: 'S2' })).stdout, '');
    assert.equal(lancer(outil(), { agent: 'deepseek_H' }).stdout, '');
    assert.equal(fs.existsSync(marque()), true);
    assert.match(contexteDe(lancer(outil())).hookSpecificOutput.additionalContext, /^COCKPIT /);
  });

  test('si le message de l\'utilisateur arrive avant l outil, il réinjecte et la marque part : pas de double', () => {
    contexteDe(lancer(prompt()));
    compacter();
    assert.match(contexteDe(lancer(prompt())).hookSpecificOutput.additionalContext, /^COCKPIT /);
    assert.equal(fs.existsSync(marque()), false);
    assert.equal(lancer(outil()).stdout, '');
  });

  test('les consignes en vigueur reviennent avec le bloc après un outil', () => {
    contexteDe(lancer(prompt()));
    compacter();
    const { executer } = require(ADAPTATEUR);
    const s = executer(JSON.stringify(outil()), 'codex');
    assert.equal(s.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.equal(executer(JSON.stringify(outil()), 'codex'), null);
  });
});
