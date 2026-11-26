'use strict';
// Bancs de l'adaptateur Codex du Régulateur d'agents : scripts/codex/regulateur.js
// Lancement : node --test tests/regulateur-codex.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variable interne (preuves par mutation) : REGULATEUR_CODEX_TESTE = adaptateur à tester (défaut : ../scripts/codex/regulateur.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');

const ADAPTATEUR = process.env.REGULATEUR_CODEX_TESTE || path.join(__dirname, '..', 'scripts', 'codex', 'regulateur.js');
const regulateur = require(path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-core.js'));

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `regulateur-codex-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison');
});

const MIN = 60 * 1000;
const il_y_a = ms => new Date(Date.now() - ms).toISOString();
const agentEnCours = (nom, maj, session = 'S1') => ({ texte: `[agent] « ${nom} » (default, id-${nom}) : x`, statut: 'en-cours', note: 'agent en cours depuis 2026-03-02 11:00', maj, session });

function lancer(entree, { agent = 'codex', args = ['--agent', agent] } = {}) {
  const input = typeof entree === 'string' ? entree : JSON.stringify(entree);
  return spawnSync(process.execPath, [ADAPTATEUR, ...args], { input, encoding: 'utf8', env: { ...process.env }, timeout: 60000 });
}
const spawnAgent = (extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'S1', cwd: 'C:/x', tool_name: 'collaborationspawn_agent', tool_use_id: 'T1', tool_input: { message: 'fais X' }, ...extra });

function deux() { ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)), 'C-0002': agentEnCours('B', il_y_a(5 * MIN)) }); }

describe('refus du lancement', () => {
  test('politique inerte : sortie vide, et le ledger n est pas lu', () => {
    deux();
    const r = lancer(spawnAgent());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('sous le maximum : sortie vide', () => {
    deux();
    regulateur.appliquerCommande('3');
    assert.equal(lancer(spawnAgent()).stdout, '');
  });

  test('au maximum : refus, dans le schéma strict de Codex, avec les chiffres', () => {
    deux();
    regulateur.appliquerCommande('2');
    const r = lancer(spawnAgent());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    assert.equal(s.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(s.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /^Régulateur d'agents : 2 agents en cours sur 2 /);
    assert.ok(!/\u{2014}/u.test(r.stdout), 'jamais de tiret cadratin');
  });

  test('en pause : refus même sans aucun agent', () => {
    regulateur.appliquerCommande('pause');
    const s = JSON.parse(lancer(spawnAgent()).stdout);
    assert.equal(s.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /^Régulateur d'agents : en pause\./);
  });

  test('un agent zombie (plus de trois heures) ne tient pas de créneau', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(4 * 60 * MIN)), 'C-0002': agentEnCours('B', il_y_a(5 * MIN)) });
    regulateur.appliquerCommande('2');
    assert.equal(lancer(spawnAgent()).stdout, '', 'un seul agent vivant sur deux créneaux');
    regulateur.appliquerCommande('1');
    assert.notEqual(lancer(spawnAgent()).stdout, '', 'un seul agent vivant sur un créneau');
  });

  test('les agents d un autre fil ou d un autre agent principal ne comptent pas', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN), 'AUTRE'), 'C-0002': agentEnCours('B', il_y_a(5 * MIN), 'AUTRE') });
    ecrireEtatLedger('claude', 'P1', { 'C-0001': agentEnCours('C', il_y_a(5 * MIN)), 'C-0002': agentEnCours('D', il_y_a(5 * MIN)) });
    regulateur.appliquerCommande('2');
    assert.equal(lancer(spawnAgent()).stdout, '');
    assert.equal(lancer(spawnAgent({ session_id: 'AUTRE' })).stdout.includes('"deny"'), true, 'le fil AUTRE a bien deux agents');
  });

  test('un autre agent du dépôt (deepseek_H) a son propre compte', () => {
    ecrireEtatLedger('deepseek_H', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)) });
    regulateur.appliquerCommande('1');
    assert.equal(lancer(spawnAgent(), { agent: 'codex' }).stdout, '');
    assert.match(lancer(spawnAgent(), { agent: 'deepseek_H' }).stdout, /"deny"/);
  });

  test('un sous-agent qui lance un agent est soumis à la même politique', () => {
    deux();
    regulateur.appliquerCommande('2');
    assert.match(lancer(spawnAgent({ agent_id: 'A9', agent_type: 'default' })).stdout, /"deny"/);
  });
});

describe('refus au seuil critique du quota (Garde-quota)', () => {
  const quota = require(path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js'));
  const cockpit = require(path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js'));
  const HEURE = 60 * MIN;
  const tokenCount = (pct, dansMs = 2 * HEURE, minutes = 10080) => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: minutes, resets_at: Math.round((Date.now() + dansMs) / 1000) }, secondary: null } } });
  let seq = 0;
  const rollout = (...lignes) => {
    const f = path.join(RUN, `rollout-${++seq}.jsonl`);
    fs.writeFileSync(f, `${lignes.join('\n')}\n`);
    return f;
  };

  test('au seuil critique d après le rollout : refus dans le schéma strict de Codex, même avec une politique inerte', () => {
    // la remise à zéro est à 2 h 30 min 30 s : le temps que le processus démarre ne change pas la minute dite
    const r = lancer(spawnAgent({ transcript_path: rollout(tokenCount(93, 2 * HEURE + 30 * MIN + 30 * 1000)) }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    assert.equal(s.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /^Garde-quota : fenêtre 7 j à 93 % \(seuil 90 %\), remise à zéro dans 2 h 30\./);
    assert.ok(!/\u{2014}/u.test(r.stdout), 'jamais de tiret cadratin');
  });

  test('sous le seuil critique, sans rollout ni mesure gardée, ou fenêtre déjà remise à zéro : sortie vide', () => {
    assert.equal(lancer(spawnAgent({ transcript_path: rollout(tokenCount(89)) })).stdout, '');
    assert.equal(lancer(spawnAgent()).stdout, '', 'pas de transcript_path');
    assert.equal(lancer(spawnAgent({ transcript_path: path.join(RUN, 'absent.jsonl') })).stdout, '');
    assert.equal(lancer(spawnAgent({ transcript_path: rollout(tokenCount(99, -MIN)) })).stdout, '', 'la remise à zéro est passée');
  });

  test('la dernière mesure gardée suffit quand le fil n a pas encore de mesure', () => {
    quota.mesurerCodex({ agent: 'codex', chemin: rollout(tokenCount(95)) });
    assert.match(lancer(spawnAgent({ transcript_path: rollout('{}') })).stdout, /Garde-quota/);
    assert.match(lancer(spawnAgent()).stdout, /Garde-quota/);
  });

  test('chaque agent principal a sa mesure', () => {
    quota.mesurerCodex({ agent: 'codex', chemin: rollout(tokenCount(95)) });
    assert.match(lancer(spawnAgent(), { agent: 'codex' }).stdout, /Garde-quota/);
    assert.equal(lancer(spawnAgent(), { agent: 'deepseek_H' }).stdout, '');
  });

  test('le rollout lu met à jour la mesure du Cockpit, même quand rien n est refusé', () => {
    lancer(spawnAgent({ transcript_path: rollout(tokenCount(50)) }));
    assert.equal(cockpit.lireQuota('codex').fenetres[0].pct, 50);
  });

  test('désactivé dans les réglages : sortie vide', () => {
    quota.ecrireConfig({ bloquerAgents: false });
    assert.equal(lancer(spawnAgent({ transcript_path: rollout(tokenCount(99)) })).stdout, '');
  });

  test('les seuils des réglages font foi', () => {
    quota.ecrireConfig({ attention: 50, critique: 60 });
    assert.match(lancer(spawnAgent({ transcript_path: rollout(tokenCount(65)) })).stdout, /\(seuil 60 %\)/);
  });

  test('le quota passe avant la politique du Régulateur : la raison est celle du Garde-quota', () => {
    regulateur.appliquerCommande('pause');
    const s = JSON.parse(lancer(spawnAgent({ transcript_path: rollout(tokenCount(95)) })).stdout);
    assert.match(s.hookSpecificOutput.permissionDecisionReason, /^Garde-quota/);
    assert.match(JSON.parse(lancer(spawnAgent({ transcript_path: rollout(tokenCount(10)) })).stdout).hookSpecificOutput.permissionDecisionReason, /^Régulateur d'agents : en pause/);
  });

  test('un sous-agent qui lance un agent est soumis au même quota', () => {
    assert.match(lancer(spawnAgent({ agent_id: 'A9', agent_type: 'default', transcript_path: rollout(tokenCount(95)) })).stdout, /Garde-quota/);
  });

  test('une panne du Garde-quota reste silencieuse et ne retire pas le refus de la politique', () => {
    const panne = (input) => spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-quota.js')}` },
    });
    const sans = panne(spawnAgent({ transcript_path: rollout(tokenCount(95)) }));
    assert.equal(sans.status, 0, sans.stderr);
    assert.equal(sans.stdout, '', 'politique inerte : le lancement n est pas bloqué par une panne de mesure');
    assert.equal(sans.stderr, '');
    regulateur.appliquerCommande('pause');
    assert.match(panne(spawnAgent()).stdout, /Régulateur d'agents : en pause/, 'la pause refuse toujours');
  });
});

describe('file d attente : un agent refusé au maximum attend son tour', () => {
  const HEURE = 60 * MIN;
  const demande = (n = 1, extra = {}) => ({ message: `Fais le travail ${n}`, agent_type: 'default', ...extra });
  const lancement = (n = 1, extra = {}) => spawnAgent({ tool_input: demande(n), ...extra });
  const politiqueFile = (max = 2, options = '') => { regulateur.appliquerCommande(String(max)); regulateur.appliquerCommande('file on'); if (options) regulateur.appliquerCommande(options); };
  const fichierFile = () => path.join(process.env.COCKPIT_DIR, 'file-agents.json');
  const refusDe = r => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;

  test('file activée et maximum atteint : le lancement est refusé avec sa position, et la demande entière est gardée', () => {
    deux();
    politiqueFile(2);
    const r = lancer(lancement(1, { tool_input: { message: 'Fais le travail 1', agent_type: 'worker', model: 'x', champ_inconnu: { a: [1, 2] } } }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(s.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    assert.equal(s.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refusDe(r), /^Régulateur d'agents : maximum atteint\. Cet agent est mis en file \(n° 1 sur 1\)\. Dès qu'un créneau se libère, le Régulateur te demandera de le lancer, avec exactement les mêmes arguments\. Ne le relance pas toi-même/);
    assert.ok(!/\u{2014}/u.test(r.stdout));
    const f = regulateur.lireFile();
    assert.equal(f.entrees.length, 1);
    assert.deepEqual([f.entrees[0].agent, f.entrees[0].session, f.entrees[0].statut], ['codex', 'S1', 'en-attente']);
    assert.deepEqual(f.entrees[0].demande, { message: 'Fais le travail 1', agent_type: 'worker', model: 'x', champ_inconnu: { a: [1, 2] } });
    assert.equal(f.entrees[0].description, 'Fais le travail 1');
  });

  test('la description vient du message, nettoyée et coupée ; sans message, elle est vide', () => {
    deux();
    politiqueFile(2);
    lancer(lancement(1, { tool_input: { message: `  ${'x'.repeat(100)}\n suite ` } }));
    lancer(lancement(2, { tool_input: { autre: 'chose' } }));
    lancer(lancement(3, { tool_input: { message: 5, nom: 'n' } }));
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.description), [`${'x'.repeat(77)}...`, '', '']);
  });

  test('les positions suivent l ordre d arrivée, et la même demande ne se met pas deux fois en file', () => {
    deux();
    politiqueFile(2);
    assert.match(refusDe(lancer(lancement(1))), /\(n° 1 sur 1\)/);
    assert.match(refusDe(lancer(lancement(2))), /\(n° 2 sur 2\)/);
    assert.match(refusDe(lancer(lancement(1))), /\(n° 1 sur 2\)/);
    assert.equal(regulateur.lireFile().entrees.length, 2);
  });

  test('chaque fil et chaque agent principal a sa file', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN), 'S1'), 'C-0002': agentEnCours('B', il_y_a(5 * MIN), 'S1'), 'C-0003': agentEnCours('C', il_y_a(5 * MIN), 'S2'), 'C-0004': agentEnCours('D', il_y_a(5 * MIN), 'S2') });
    ecrireEtatLedger('deepseek_H', 'P1', { 'C-0001': agentEnCours('E', il_y_a(5 * MIN), 'S1'), 'C-0002': agentEnCours('F', il_y_a(5 * MIN), 'S1') });
    politiqueFile(2);
    lancer(lancement(1));
    assert.match(refusDe(lancer(lancement(1), { agent: 'deepseek_H' })), /\(n° 1 sur 1\)/);
    assert.match(refusDe(lancer(lancement(1, { session_id: 'S2' }))), /\(n° 1 sur 1\)/);
    assert.deepEqual(regulateur.lireFile().entrees.map(e => [e.agent, e.session]), [['codex', 'S1'], ['deepseek-h', 'S1'], ['codex', 'S2']]);
  });

  test('file désactivée : le refus est celui d avant et rien n est écrit', () => {
    deux();
    regulateur.appliquerCommande('2');
    assert.match(refusDe(lancer(lancement())), /^Régulateur d'agents : 2 agents en cours sur 2 /);
    assert.equal(fs.existsSync(fichierFile()), false);
  });

  test('en pause, le refus est celui de la pause et rien ne se met en file', () => {
    politiqueFile(2, 'pause');
    assert.match(refusDe(lancer(lancement())), /^Régulateur d'agents : en pause\./);
    assert.equal(fs.existsSync(fichierFile()), false);
  });

  test('le quota critique passe avant la file : rien n est mis en file', () => {
    const quota = require(path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js'));
    deux();
    politiqueFile(2);
    const rollout = path.join(RUN, 'rollout-quota.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 95, window_minutes: 10080, resets_at: Math.round((Date.now() + 2 * HEURE) / 1000) }, secondary: null } } })}\n`);
    assert.match(refusDe(lancer(lancement(1, { transcript_path: rollout }))), /^Garde-quota/);
    assert.equal(fs.existsSync(fichierFile()), false);
    assert.ok(quota);
  });

  test('sans arguments exploitables (absents, tableau, texte), le refus dit que la demande ne peut pas être mise en file', () => {
    deux();
    politiqueFile(2);
    for (const tool_input of [undefined, null, [], 'texte', 5]) {
      const r = lancer(lancement(1, { tool_input }));
      assert.match(refusDe(r), /^Régulateur d'agents : maximum atteint, et cette demande ne peut pas être mise en file\. Ne lance pas celui-ci maintenant/, JSON.stringify(tool_input));
    }
    assert.equal(fs.existsSync(fichierFile()), false);
  });

  test('une file pleine ou une demande trop grande donnent un refus qui dit pourquoi', () => {
    deux();
    politiqueFile(2);
    for (let i = 1; i <= 50; i++) regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: { message: `déjà ${i}` }, maintenant: Date.now() });
    assert.match(refusDe(lancer(lancement(99))), /^Régulateur d'agents : maximum atteint, et la file est pleine \(50 agents\)\./);
    regulateur.viderFile();
    assert.match(refusDe(lancer(lancement(1, { tool_input: { message: 'x'.repeat(60000) } }))), /^Régulateur d'agents : maximum atteint, et cette demande est trop grande pour la file \(60000 caractères au plus\)\./);
  });

  test('un fichier de file qui ne peut pas être écrit est dit, au lieu de promettre une mise en file', () => {
    deux();
    politiqueFile(2);
    fs.mkdirSync(fichierFile(), { recursive: true }); // un dossier occupe la place du fichier
    assert.match(refusDe(lancer(lancement())), /^Régulateur d'agents : maximum atteint, et la file d'attente ne peut pas être écrite\./);
  });

  test('un lancement autorisé qui correspond à une demande ordonnée la retire de la file', () => {
    politiqueFile(2);
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: Date.now() });
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'y', demande: demande(2), maintenant: Date.now() });
    regulateur.ordonner([1], Date.now());
    assert.equal(lancer(lancement(1)).stdout, '');
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.id), [1, 2], 'avant resultat, la demande reste reservee');
    lancer({ ...lancement(1), hook_event_name: 'PostToolUse', tool_response: { agent_id: 'nouveau' } });
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.id), [2]);
    assert.equal(lancer(lancement(7)).stdout, '', 'une demande qui n est pas en file passe sans toucher à la file');
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.id), [2]);
  });

  test('le résultat d un lancement décide du sort de la demande : seul un succès connu la retire, tout échec la garde et lève la réservation', () => {
    politiqueFile(2);
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: Date.now() });
    regulateur.ordonner([1], Date.now());
    const reservations = () => JSON.parse(fs.readFileSync(path.join(process.env.COCKPIT_DIR, 'reservations-agents.json'), 'utf8'));
    const resultat = (evenement, extra, outil = 'collaborationspawn_agent') => lancer({ ...lancement(1), hook_event_name: evenement, tool_name: outil, ...extra });
    const echecs = [
      ['PostToolUse', { tool_response: { agent_id: 'a', error: 'boom' } }],
      ['PostToolUse', { tool_response: { agent_id: 'a', isError: true } }],
      ['PostToolUse', { tool_response: { agent_id: 'a', exit_code: 1 } }],
      ['PostToolUse', { tool_response: {} }],
      ['PostToolUse', { tool_response: { agent_id: '' } }],
      ['PostToolUse', { tool_response: 'pas du json' }],
      ['PostToolUseFailure', { tool_response: { agent_id: 'a' } }],
    ];
    for (const [evenement, extra] of echecs) {
      assert.equal(lancer(lancement(1)).stdout, '', 'le lancement est autorisé : la demande est réservée');
      assert.equal(Object.keys(reservations()).length, 1);
      assert.equal(resultat(evenement, extra).stdout, '');
      assert.deepEqual(regulateur.lireFile().entrees.map(e => e.id), [1], `${evenement} ${JSON.stringify(extra)} : la demande reste en file`);
      assert.deepEqual(reservations(), {}, `${evenement} ${JSON.stringify(extra)} : la réservation est levée`);
    }
    lancer(lancement(1));
    resultat('PostToolUse', { tool_response: { agent_id: 'a' } }, 'Bash');
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.id), [1], 'le résultat d un autre outil ne retire rien');
    assert.equal(Object.keys(reservations()).length, 1, 'ni ne lève la réservation');
    resultat('PostToolUse', { tool_response: JSON.stringify({ agent_id: 'a' }) });
    assert.deepEqual(regulateur.lireFile().entrees, [], 'un succès connu (réponse en texte JSON) retire la demande');
    assert.deepEqual(reservations(), {});
  });

  test('un lancement autorisé d une demande en file d une autre session ne la retire pas', () => {
    politiqueFile(2);
    regulateur.mettreEnFile({ agent: 'codex', session: 'AUTRE', description: 'x', demande: demande(1), maintenant: Date.now() });
    regulateur.mettreEnFile({ agent: 'deepseek_H', session: 'S1', description: 'x', demande: demande(1), maintenant: Date.now() });
    assert.equal(lancer(lancement(1)).stdout, '');
    assert.equal(regulateur.lireFile().entrees.length, 2);
  });

  test('le retrait d une demande lancée vise le fil et l agent du lancement, sous le maximum comme sans plafond', () => {
    for (const reglage of ['3', 'libre']) {
      regulateur.viderFile();
      regulateur.appliquerCommande(reglage);
      regulateur.appliquerCommande('file on');
      for (const [agent, session] of [['codex', 'S1'], ['codex', 'S2'], ['deepseek_H', 'S2']]) {
        regulateur.mettreEnFile({ agent, session, description: 'x', demande: demande(1), maintenant: Date.now() });
      }
      assert.equal(lancer(lancement(1, { session_id: 'S2' })).stdout, '', reglage);
      lancer({ ...lancement(1, { session_id: 'S2' }), hook_event_name: 'PostToolUse', tool_response: { agent_id: 'nouveau' } });
      assert.deepEqual(regulateur.lireFile().entrees.map(e => [e.agent, e.session]), [['codex', 'S1'], ['deepseek-h', 'S2']], `${reglage} : seule l entrée de ce fil et de cet agent est retirée`);
      assert.equal(lancer(lancement(1, { session_id: 'S2' }), { agent: 'deepseek_H' }).stdout, '', reglage);
      lancer({ ...lancement(1, { session_id: 'S2' }), hook_event_name: 'PostToolUse', tool_response: { agent_id: 'nouveau-home' } }, { agent: 'deepseek_H' });
      assert.deepEqual(regulateur.lireFile().entrees.map(e => [e.agent, e.session]), [['codex', 'S1']], `${reglage} : puis celle de l autre agent principal`);
    }
  });

  test('file désactivée : un lancement autorisé laisse la file telle quelle, même quand elle contient la demande', () => {
    for (const reglage of ['3', 'libre']) {
      regulateur.viderFile();
      regulateur.appliquerCommande(reglage);
      regulateur.appliquerCommande('file on');
      regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: Date.now() });
      regulateur.appliquerCommande('file off');
      assert.equal(lancer(lancement(1)).stdout, '', reglage);
      assert.equal(regulateur.lireFile().entrees.length, 1, `${reglage} : la file n est pas touchée`);
      assert.equal(fs.existsSync(path.join(process.env.COCKPIT_DIR, 'reservations-agents.json')), false, `${reglage} : rien n est réservé`);
    }
  });

  test('une panne de la réservation ne bloque pas le lancement autorisé : sortie vide, code 0, rien sur stderr, la demande reste en file', () => {
    politiqueFile(2);
    regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: Date.now() });
    const panne = input => spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-retrait-file.js')}` },
    });
    const r = panne(lancement(1));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'le lancement n est pas refusé');
    assert.equal(r.stderr, '');
    assert.equal(regulateur.lireFile().entrees.length, 1);
    regulateur.appliquerCommande('libre');
    assert.equal(panne(lancement(1)).stdout, '', 'sans plafond non plus');
  });

  test('file désactivée ou politique inerte : un lancement autorisé ne lit ni n écrit la file', () => {
    assert.equal(lancer(lancement(1)).stdout, '');
    regulateur.appliquerCommande('3');
    assert.equal(lancer(lancement(1)).stdout, '');
    assert.equal(fs.existsSync(fichierFile()), false);
  });

  test('la file reste une file par agent : deepseek_H a sa propre position', () => {
    deux();
    politiqueFile(2);
    lancer(lancement(1));
    assert.deepEqual(regulateur.resumeFile('codex'), { enAttente: 1, ordonnees: 0, plusAncienne: regulateur.lireFile().entrees[0].ajoute });
    assert.deepEqual(regulateur.resumeFile('deepseek_H'), { enAttente: 0, ordonnees: 0, plusAncienne: null });
  });
});

describe('Stop : ordre de lancer le suivant, ordre de relancer les échoués', () => {
  const HEURE = 60 * MIN;
  const stop = (extra = {}) => ({ hook_event_name: 'Stop', session_id: 'S1', stop_hook_active: false, last_assistant_message: '', ...extra });
  const demande = (n = 1) => ({ message: `Fais le travail ${n}`, agent_type: 'default' });
  const enFile = (n, extra = {}) => regulateur.mettreEnFile({ agent: 'codex', session: 'S1', description: `travail ${n}`, demande: demande(n), maintenant: Date.now(), ...extra });
  const agentEchoue = (nom, maj, session = 'S1') => ({ texte: `[agent] « ${nom} » (default, id-${nom}) : x`, statut: 'ouvert', note: 'TERMINÉ (failed) le 2026-03-03 11:30 : r', maj, session });
  const politiqueFile = (max = 2, options = []) => { regulateur.appliquerCommande(String(max)); regulateur.appliquerCommande('file on'); for (const o of options) regulateur.appliquerCommande(o); };
  const ordre = r => JSON.parse(r.stdout);

  test('file activée, un créneau libre et une demande en file : le modèle reçoit l ordre de la lancer, dans le schéma strict de Codex', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)) });
    politiqueFile(2);
    enFile(1);
    const r = lancer(stop());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const s = ordre(r);
    assert.deepEqual(Object.keys(s).sort(), ['decision', 'reason']);
    assert.equal(s.decision, 'block');
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 1 créneau libre et 1 agent en file\. Lance maintenant, avec spawn_agent et exactement ces arguments, l'agent suivant de la file\./);
    assert.ok(s.reason.includes('1. {"agent_type":"default","message":"Fais le travail 1"}'));
    assert.ok(!/\u{2014}/u.test(r.stdout));
  });

  test('l entrée devient ordonnée et ne sera pas redonnée avant dix minutes', () => {
    politiqueFile(2);
    enFile(1);
    assert.equal(lancer(stop()).status, 0);
    assert.equal(regulateur.lireFile().entrees[0].statut, 'ordonne');
    assert.equal(lancer(stop()).stdout, '', 'le tour suivant, rien de nouveau');
    const f = regulateur.lireFile();
    f.entrees[0].ordre = new Date(Date.now() - 11 * MIN).toISOString();
    regulateur.ecrireFile(f);
    assert.equal(ordre(lancer(stop())).decision, 'block', 'l ordre n a pas été suivi : il est redonné');
  });

  test('plusieurs créneaux libres : jusqu à trois demandes dans un seul ordre, dans l ordre de la file', () => {
    politiqueFile(5);
    for (const n of [1, 2, 3, 4]) enFile(n);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 5 créneaux libres et 3 agents en file\./);
    assert.deepEqual([1, 2, 3].map(i => s.reason.includes(`${i}. {"agent_type":"default","message":"Fais le travail ${i}"}`)), [true, true, true]);
    assert.ok(!s.reason.includes('Fais le travail 4'));
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.statut), ['ordonne', 'ordonne', 'ordonne', 'en-attente']);
  });

  test('les créneaux libres limitent le nombre de demandes de l ordre', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)), 'C-0002': agentEnCours('B', il_y_a(5 * MIN)) });
    politiqueFile(3);
    for (const n of [1, 2, 3]) enFile(n);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 1 créneau libre et 1 agent en file\./);
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.statut), ['ordonne', 'en-attente', 'en-attente']);
  });

  test('sans plafond (libre), l ordre ne parle pas de créneaux', () => {
    regulateur.appliquerCommande('file on');
    enFile(1);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 1 agent en file\. Lance maintenant/);
  });

  test('rien à dire : file désactivée, file vide, pas de créneau, pause, politique inerte', () => {
    enFile(1);
    assert.equal(lancer(stop()).stdout, '', 'file désactivée');
    politiqueFile(2);
    regulateur.viderFile();
    assert.equal(lancer(stop()).stdout, '', 'file vide');
    enFile(1);
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)), 'C-0002': agentEnCours('B', il_y_a(5 * MIN)) });
    assert.equal(lancer(stop()).stdout, '', 'aucun créneau libre');
    regulateur.appliquerCommande('pause');
    assert.equal(lancer(stop()).stdout, '', 'en pause');
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente');
  });

  test('stop_hook_active : une seule continuation par message de l\'utilisateur, la file n est pas touchée', () => {
    politiqueFile(2);
    enFile(1);
    assert.equal(lancer(stop({ stop_hook_active: true })).stdout, '');
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente');
    for (const actif of [1, 'true', null, undefined]) {
      regulateur.viderFile();
      enFile(1);
      assert.equal(ordre(lancer(stop({ stop_hook_active: actif }))).decision, 'block', `valeur ${JSON.stringify(actif)} : seul true arrête`);
    }
  });

  test('de bout en bout : la demande refusée au maximum est ordonnée au Stop qui suit la fin d un agent, puis retirée quand le modèle la lance', () => {
    deux();
    regulateur.appliquerCommande('2');
    regulateur.appliquerCommande('file on');
    const arguments_ = { message: 'Fais le travail 7', agent_type: 'worker', model: 'x', champ_inconnu: { a: [1, 2] } };
    assert.match(JSON.parse(lancer(spawnAgent({ tool_input: arguments_ })).stdout).hookSpecificOutput.permissionDecisionReason, /Cet agent est mis en file \(n° 1 sur 1\)/);
    assert.equal(lancer(stop()).stdout, '', 'aucun créneau libre tant que A et B tournent');
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)) });
    const s = ordre(lancer(stop()));
    assert.equal(s.decision, 'block');
    assert.ok(s.reason.includes('Fais le travail 7') && s.reason.includes('"agent_type":"worker"') && s.reason.includes('"champ_inconnu":{"a":[1,2]}'), s.reason);
    assert.equal(regulateur.lireFile().entrees[0].statut, 'ordonne');
    assert.equal(lancer(spawnAgent({ tool_input: arguments_ })).stdout, '', 'un créneau est libre : le modèle lance ce qu on lui a ordonné');
    assert.equal(regulateur.lireFile().entrees.length, 1, 'PreToolUse ne vaut pas succes');
    lancer({ ...spawnAgent({ tool_input: arguments_ }), hook_event_name: 'PostToolUse', tool_response: { agent_id: 'nouveau' } });
    assert.deepEqual(regulateur.lireFile().entrees, [], 'la demande quitte la file');
  });

  test('les demandes d un autre fil, d un autre agent ou d une autre session ne sont jamais ordonnées', () => {
    politiqueFile(2);
    regulateur.mettreEnFile({ agent: 'codex', session: 'AUTRE', description: 'x', demande: demande(1), maintenant: Date.now() });
    regulateur.mettreEnFile({ agent: 'deepseek_H', session: 'S1', description: 'x', demande: demande(2), maintenant: Date.now() });
    assert.equal(lancer(stop()).stdout, '');
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.statut), ['en-attente', 'en-attente']);
    assert.equal(ordre(lancer(stop(), { agent: 'deepseek_H' })).decision, 'block');
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.statut), ['en-attente', 'ordonne']);
  });

  test('les entrées de plus de six heures ne sont jamais ordonnées', () => {
    politiqueFile(2);
    enFile(1, { maintenant: Date.now() - 7 * HEURE });
    assert.equal(lancer(stop()).stdout, '');
  });

  test('chaque Stop de la file active retire les entrées de plus de six heures, avec ou sans créneau libre', () => {
    const vieillir = () => { const f = regulateur.lireFile(); f.entrees[0].ajoute = il_y_a(7 * HEURE); regulateur.ecrireFile(f); };
    politiqueFile(2);
    enFile(1);
    enFile(2);
    vieillir();
    assert.equal(ordre(lancer(stop())).decision, 'block');
    assert.deepEqual(regulateur.lireFile().entrees.map(e => [e.id, e.statut]), [[2, 'ordonne']], 'un créneau libre : la vieille entrée est retirée, la récente ordonnée');
    regulateur.viderFile();
    enFile(3);
    vieillir();
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN)), 'C-0002': agentEnCours('B', il_y_a(5 * MIN)) });
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(regulateur.lireFile().entrees.length, 0, 'aucun créneau libre : la vieille entrée est retirée quand même');
  });

  test('les créneaux libres se comptent par agent principal et par fil', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEnCours('A', il_y_a(5 * MIN), 'S1'), 'C-0002': agentEnCours('B', il_y_a(5 * MIN), 'S1') });
    politiqueFile(2);
    enFile(1);
    enFile(2, { session: 'S2' });
    enFile(3, { agent: 'deepseek_H' });
    assert.equal(lancer(stop()).stdout, '', 'le fil S1 de Codex a ses deux créneaux pris');
    assert.match(ordre(lancer(stop({ session_id: 'S2' }))).reason, /Fais le travail 2/);
    assert.match(ordre(lancer(stop(), { agent: 'deepseek_H' })).reason, /Fais le travail 3/);
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.statut), ['en-attente', 'ordonne', 'ordonne']);
  });

  test('relance activée : un échoué récent de ce fil est à relancer, et le compteur avance', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(30 * MIN)), 'C-0002': agentEchoue('Ancien', il_y_a(3 * HEURE)), 'C-0003': agentEchoue('Autre fil', il_y_a(MIN), 'AUTRE') });
    politiqueFile(3, ['relance on']);
    const s = ordre(lancer(stop()));
    assert.equal(s.decision, 'block');
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 1 agent a échoué\. Relance-le maintenant depuis son point d'arrêt, sans repartir de zéro :\n1\. Audit \(relance 1 sur 2\)$/);
    assert.equal(regulateur.relancesFaites('codex:S1:Audit'), 1);
    assert.equal(regulateur.relancesFaites('codex:S1:Ancien'), 0);
  });

  test('la clé de relance garde les huit premiers caractères du fil : deux fils proches ne partagent pas leur compteur', () => {
    const fil = '01b2c3d4-0000-7000-8000-0000000000a1';
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(30 * MIN), fil) });
    politiqueFile(3, ['relance on']);
    assert.match(ordre(lancer(stop({ session_id: fil }))).reason, /\(relance 1 sur 2\)/);
    assert.equal(regulateur.relancesFaites('codex:01b2c3d4:Audit'), 1);
    assert.equal(regulateur.relancesFaites(`codex:${fil}:Audit`), 0);
    assert.equal(regulateur.relancesFaites('codex:01b2c3d:Audit'), 0);
  });

  test('un échoué de 90 minutes est relancé, un échoué de plus de deux heures ne l est pas', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Recent', il_y_a(90 * MIN)), 'C-0002': agentEchoue('Vieux', il_y_a(2 * HEURE + MIN)) });
    politiqueFile(5, ['relance on']);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /\n1\. Recent \(relance 1 sur 2\)$/);
    assert.ok(!s.reason.includes('Vieux'));
  });

  test('deux relances au plus par agent : au troisième tour, plus rien', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(30 * MIN)) });
    politiqueFile(3, ['relance on']);
    assert.match(ordre(lancer(stop())).reason, /\(relance 1 sur 2\)/);
    assert.match(ordre(lancer(stop())).reason, /\(relance 2 sur 2\)/);
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(regulateur.relancesFaites('codex:S1:Audit'), 2);
  });

  test('sans la relance, ou sans la file, les échoués ne donnent aucun ordre', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(MIN)) });
    politiqueFile(3);
    assert.equal(lancer(stop()).stdout, '', 'relance désactivée');
    regulateur.appliquerCommande('relance on');
    regulateur.appliquerCommande('file off');
    assert.equal(lancer(stop()).stdout, '', 'file désactivée');
  });

  test('les relances passent avant la file et se partagent les créneaux libres', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(20 * MIN)), 'C-0002': agentEchoue('Build', il_y_a(10 * MIN)) });
    politiqueFile(3, ['relance on']);
    enFile(1);
    enFile(2);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 2 agents ont échoué\. Relance-les maintenant/);
    assert.match(s.reason, /\n\nRÉGULATEUR D'AGENTS : 1 créneau libre et 1 agent en file\./);
    assert.ok(s.reason.includes('Fais le travail 1'));
    assert.ok(!s.reason.includes('Fais le travail 2'));
    assert.deepEqual(regulateur.lireFile().entrees.map(e => e.statut), ['ordonne', 'en-attente']);
  });

  test('en pause, même avec des créneaux libres, des échoués et une file : aucun ordre, rien n est marqué', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(20 * MIN)) });
    politiqueFile(3, ['relance on', 'pause']);
    enFile(1);
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente');
    assert.equal(regulateur.relancesFaites('codex:S1:Audit'), 0);
    regulateur.appliquerCommande('reprendre');
    assert.equal(ordre(lancer(stop())).decision, 'block', 'la reprise rend la parole au Régulateur');
  });

  test('plafond baissé sous le nombre d agents en cours : aucun ordre, ni relance ni demande de la file', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentEnCours('A', il_y_a(5 * MIN)),
      'C-0002': agentEnCours('B', il_y_a(5 * MIN)),
      'C-0003': agentEnCours('C', il_y_a(5 * MIN)),
      'C-0004': agentEchoue('Audit', il_y_a(20 * MIN)),
      'C-0005': agentEchoue('Build', il_y_a(10 * MIN)),
    });
    politiqueFile(2, ['relance on']);
    enFile(1);
    assert.equal(lancer(stop()).stdout, '');
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente');
    assert.equal(regulateur.relancesFaites('codex:S1:Audit'), 0);
  });

  test('plus de créneau libre après les relances : la file attend', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(20 * MIN)), 'C-0002': agentEchoue('Build', il_y_a(10 * MIN)) });
    politiqueFile(2, ['relance on']);
    enFile(1);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 2 agents ont échoué\./);
    assert.ok(!s.reason.includes('Fais le travail 1'));
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente');
  });

  test('plus d échoués que de créneaux : seuls les plus anciens sont relancés d abord', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(20 * MIN)), 'C-0002': agentEchoue('Build', il_y_a(10 * MIN)) });
    politiqueFile(1, ['relance on']);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /\n1\. Audit \(relance 1 sur 2\)$/);
    assert.ok(!s.reason.includes('Build'));
    assert.equal(regulateur.relancesFaites('codex:S1:Build'), 0);
  });

  test('les échoués se relancent dans leur fil : un autre fil ne reçoit ni leur ordre ni leur compteur', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(MIN), 'S1'), 'C-0002': agentEchoue('Build', il_y_a(MIN), 'S2') });
    politiqueFile(3, ['relance on']);
    const s = ordre(lancer(stop({ session_id: 'S2' })));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 1 agent a échoué\. Relance-le maintenant depuis son point d'arrêt, sans repartir de zéro :\n1\. Build \(relance 1 sur 2\)$/);
    assert.equal(regulateur.relancesFaites('codex:S2:Build'), 1);
    assert.equal(regulateur.relancesFaites('codex:S1:Audit'), 0);
  });

  test('un seul ordre relance au plus trois échoués, même avec davantage de créneaux libres', () => {
    ecrireEtatLedger('codex', 'P1', Object.fromEntries(['Alpha', 'Bravo', 'Charlie', 'Delta'].map((nom, i) => [`C-000${i + 1}`, agentEchoue(nom, il_y_a((40 - i) * MIN))])));
    politiqueFile(10, ['relance on']);
    const s = ordre(lancer(stop()));
    assert.match(s.reason, /^RÉGULATEUR D'AGENTS : 3 agents ont échoué\./);
    assert.ok(s.reason.includes('3. Charlie (relance 1 sur 2)'));
    assert.ok(!s.reason.includes('Delta'));
    assert.equal(regulateur.relancesFaites('codex:S1:Delta'), 0);
  });

  test('chaque agent principal a ses propres échoués et ses propres compteurs', () => {
    ecrireEtatLedger('deepseek_H', 'P1', { 'C-0001': agentEchoue('Audit', il_y_a(MIN)) });
    politiqueFile(3, ['relance on']);
    assert.equal(lancer(stop(), { agent: 'codex' }).stdout, '');
    assert.equal(ordre(lancer(stop(), { agent: 'deepseek_H' })).decision, 'block');
    assert.equal(regulateur.relancesFaites('deepseek-h:S1:Audit'), 1);
  });

  test('au seuil critique du quota, aucun ordre n est donné : le Garde-quota refuserait le lancement', () => {
    politiqueFile(2);
    enFile(1);
    const rollout = path.join(RUN, 'rollout-stop.jsonl');
    const mesure = pct => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round((Date.now() + 2 * HEURE) / 1000) }, secondary: null } } });
    fs.writeFileSync(rollout, `${mesure(95)}\n`);
    assert.equal(lancer(stop({ transcript_path: rollout })).stdout, '');
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente');
    fs.writeFileSync(rollout, `${mesure(10)}\n`);
    assert.equal(ordre(lancer(stop({ transcript_path: rollout }))).decision, 'block');
  });

  test('le quota se juge par agent principal : la mesure gardée de Codex ne retient pas deepseek_H', () => {
    const quota = require(path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js'));
    const rollout = path.join(RUN, 'rollout-stop-agent.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 95, window_minutes: 10080, resets_at: Math.round((Date.now() + 2 * HEURE) / 1000) }, secondary: null } } })}\n`);
    quota.mesurerCodex({ agent: 'codex', chemin: rollout });
    politiqueFile(2);
    enFile(1);
    enFile(2, { agent: 'deepseek_H' });
    assert.equal(lancer(stop()).stdout, '', 'Codex est au seuil critique');
    assert.equal(ordre(lancer(stop(), { agent: 'deepseek_H' })).decision, 'block', 'deepseek_H a sa propre mesure, et aucune n est au seuil');
  });

  test('une entrée illisible, sans session, ou une panne interne donne une sortie vide, code 0, rien sur stderr', () => {
    politiqueFile(2);
    enFile(1);
    for (const entree of ['', 'pas du json', '[]', 'null', JSON.stringify(stop({ session_id: undefined })), JSON.stringify(stop({ session_id: '' })), JSON.stringify(stop({ session_id: 5 }))]) {
      const r = lancer(entree);
      assert.equal(r.status, 0, entree);
      assert.equal(r.stdout, '', entree);
      assert.equal(r.stderr, '', entree);
    }
    const panne = spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(stop()), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-etat-agents.js')}` },
    });
    assert.equal(panne.status, 0, panne.stderr);
    assert.equal(panne.stdout, '');
    assert.equal(panne.stderr, '');
    assert.equal(regulateur.lireFile().entrees[0].statut, 'en-attente', 'une panne ne marque rien comme ordonné');
  });

  test('un nom d agent invalide ou absent donne une sortie vide', () => {
    politiqueFile(2);
    enFile(1);
    for (const args of [['--agent', '../evil'], ['--agent', ''], []]) assert.equal(lancer(stop(), { args }).stdout, '', args.join(' '));
  });
});

describe('ce que le Régulateur ne touche pas', () => {
  test('les autres outils ne sont jamais refusés, même en pause', () => {
    regulateur.appliquerCommande('pause');
    for (const tool_name of ['Bash', 'apply_patch', 'exec_command', 'mcp__codex_app__x', 'collaborationsend_input', 'request_user_input_async', 'spawn_agent_extra']) {
      const r = lancer(spawnAgent({ tool_name }));
      assert.equal(r.status, 0, tool_name);
      assert.equal(r.stdout, '', tool_name);
    }
  });

  test('toute variante du nom de l outil de lancement est refusée', () => {
    regulateur.appliquerCommande('pause');
    for (const tool_name of ['collaborationspawn_agent', 'spawn_agent', 'collaboration.spawn_agent']) assert.match(lancer(spawnAgent({ tool_name })).stdout, /"deny"/, tool_name);
  });

  test('les autres événements donnent une sortie vide', () => {
    regulateur.appliquerCommande('pause');
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStart']) assert.equal(lancer(spawnAgent({ hook_event_name: e })).stdout, '', e);
  });

  test('une entrée illisible, vide, sans session ou sans nom d outil donne une sortie vide, code 0, rien sur stderr', () => {
    regulateur.appliquerCommande('pause');
    for (const entree of ['', 'pas du json', '[]', 'null', JSON.stringify(spawnAgent({ session_id: undefined })), JSON.stringify(spawnAgent({ session_id: '' })), JSON.stringify(spawnAgent({ session_id: 5 })), JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'S1' }), JSON.stringify(spawnAgent({ tool_name: 5 }))]) {
      const r = lancer(entree);
      assert.equal(r.status, 0, entree);
      assert.equal(r.stdout, '', entree);
      assert.equal(r.stderr, '', entree);
    }
  });

  test('un nom d agent invalide ou absent donne une sortie vide : le Régulateur ne bloque pas sur une erreur de réglage', () => {
    regulateur.appliquerCommande('pause');
    for (const args of [['--agent', '../evil'], ['--agent', ''], ['--agent', 'AGENT'], []]) {
      const r = lancer(spawnAgent(), { args });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', args.join(' '));
    }
  });

  test('executer ne lève jamais sur une entrée invalide : il rend null', () => {
    const { executer } = require(ADAPTATEUR);
    for (const entree of ['pas du json', '', '[]', 'null', '"abc"', '5', 'true', '{}']) assert.equal(executer(entree, 'codex'), null, entree);
  });

  test('une panne interne reste silencieuse : sortie vide, code 0, rien sur stderr, le lancement n est pas bloqué', () => {
    regulateur.appliquerCommande('pause');
    const normal = lancer(spawnAgent());
    assert.match(normal.stdout, /"deny"/, 'sans panne, la pause refuse');
    const panne = spawnSync(process.execPath, [ADAPTATEUR, '--agent', 'codex'], {
      input: JSON.stringify(spawnAgent()), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'panne-etat-agents.js')}` },
    });
    assert.equal(panne.status, 0, panne.stderr);
    assert.equal(panne.stdout, '');
    assert.equal(panne.stderr, '');
  });

  test('une politique abîmée est une politique inerte', () => {
    fs.mkdirSync(process.env.COCKPIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.COCKPIT_DIR, 'politique-agents.json'), '{pas du json');
    deux();
    assert.equal(lancer(spawnAgent()).stdout, '');
  });
});
