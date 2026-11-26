'use strict';
// Bancs des entrées-sorties du Régulateur d'agents (scripts/lib/regulateur-core.js) et de la commande `cockpit.js politique`.
// Lancement : node --test tests/regulateur-core.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variable interne (preuves par mutation) : REGULATEUR_CORE_TESTE = fichier à tester (défaut : ../scripts/lib/regulateur-core.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const CORE = process.env.REGULATEUR_CORE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-core.js');
const CLI = path.join(__dirname, '..', 'scripts', 'cockpit.js');
const reg = require(CORE);
const cockpit = require(path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js'));

let n = 0;
let RUN;
let FICHIER;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `regulateur-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison'); // jamais la vraie maison de l'utilisateur
  FICHIER = path.join(process.env.COCKPIT_DIR, 'politique-agents.json');
});

const brut = () => JSON.parse(fs.readFileSync(FICHIER, 'utf8'));

describe('lire et écrire la politique', () => {
  test('sans fichier, la politique est inerte et rien n est créé', () => {
    assert.deepEqual(reg.lirePolitique(), { max: null, pause: false, relance: false, file: false });
    assert.equal(fs.existsSync(FICHIER), false);
  });

  test('un fichier abîmé ou mal typé retombe sur les défauts champ par champ', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER, '{pas du json');
    assert.deepEqual(reg.lirePolitique(), { max: null, pause: false, relance: false, file: false });
    fs.writeFileSync(FICHIER, JSON.stringify({ max: 'cinq', pause: true, relance: 'oui' }));
    assert.deepEqual(reg.lirePolitique(), { max: null, pause: true, relance: false, file: false });
    fs.writeFileSync(FICHIER, JSON.stringify({ max: 4, pause: false, relance: true, maj: 'x', autre: 1 }));
    assert.deepEqual(reg.lirePolitique(), { max: 4, pause: false, relance: true, file: false });
  });

  test('ecrirePolitique écrit la politique normalisée et l heure de la modification', () => {
    reg.ecrirePolitique({ max: 5, pause: 'oui', relance: true, autre: 1 });
    const e = brut();
    assert.deepEqual({ max: e.max, pause: e.pause, relance: e.relance, file: e.file }, { max: 5, pause: false, relance: true, file: false });
    assert.deepEqual(Object.keys(e).sort(), ['file', 'maj', 'max', 'pause', 'relance']);
    assert.ok(Math.abs(Date.parse(e.maj) - Date.now()) < 60000);
  });
});

describe('appliquerCommande', () => {
  test('une commande valide change la politique, l écrit et dit le message', () => {
    const r = reg.appliquerCommande('5');
    assert.equal(r.message, 'Agents : maximum 5 en parallèle.');
    assert.deepEqual(r.politique, { max: 5, pause: false, relance: false, file: false });
    assert.equal(brut().max, 5);
    reg.appliquerCommande('pause');
    assert.deepEqual(reg.lirePolitique(), { max: 5, pause: true, relance: false, file: false }, 'la pause garde le plafond, relu depuis le disque');
    reg.appliquerCommande('relance on');
    reg.appliquerCommande('reprendre');
    assert.deepEqual(reg.lirePolitique(), { max: 5, pause: false, relance: true, file: false });
  });

  test('une commande invalide ne change rien et n écrit rien', () => {
    reg.appliquerCommande('5');
    const avant = fs.readFileSync(FICHIER, 'utf8');
    const r = reg.appliquerCommande('abc');
    assert.match(r.erreur, /^Usage : \/plafond /);
    assert.equal(r.message, undefined);
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avant);
  });

  test('une commande qui ne change rien ne réécrit pas le fichier', () => {
    assert.equal(reg.appliquerCommande('').message, 'Agents : libre. Relance des échoués : non. File : non.');
    assert.equal(fs.existsSync(FICHIER), false, 'l état seul ne crée rien');
    reg.appliquerCommande('5');
    const maj = brut().maj;
    const attente = Date.now() + 20;
    while (Date.now() < attente) { /* l heure doit pouvoir changer */ }
    reg.appliquerCommande('5');
    reg.appliquerCommande('');
    assert.equal(brut().maj, maj, 'la politique est la même : le fichier reste tel quel');
  });

  test('le compte des agents en cours est transmis au message d état', () => {
    reg.appliquerCommande('5');
    assert.equal(reg.appliquerCommande('', 3).message, 'Agents : maximum 5, 3 en cours (2 créneaux libres). Relance des échoués : non. File : non.');
  });
});

describe('file d attente : lecture et écriture', () => {
  const FILE = () => path.join(process.env.COCKPIT_DIR, 'file-agents.json');
  const lireBrut = () => JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  const T0 = Date.parse('2026-03-03T20:00:00.000Z');
  const MIN = 60 * 1000;
  const demande = (n = 1) => ({ prompt: `Fais le travail ${n}`, description: `travail ${n}`, subagentType: 'general-purpose' });
  const mise = (n = 1, extra = {}) => reg.mettreEnFile({ agent: 'claude', session: 'S1', description: `travail ${n}`, demande: demande(n), maintenant: T0, ...extra });

  test('sans fichier ou avec un fichier abîmé, la file est vide et rien n est créé', () => {
    assert.deepEqual(reg.lireFile(), { prochain: 1, entrees: [], relances: {} });
    assert.equal(fs.existsSync(FILE()), false);
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), '{pas du json');
    assert.deepEqual(reg.lireFile(), { prochain: 1, entrees: [], relances: {} });
    fs.writeFileSync(FILE(), `\uFEFF${JSON.stringify({ prochain: 4, entrees: [], relances: { A: 1 } })}`);
    assert.deepEqual(reg.lireFile(), { prochain: 4, entrees: [], relances: { A: 1 } }, 'un BOM en tête est toléré');
  });

  test('ecrireFile écrit toujours un état normalisé, même quand on lui en donne un abîmé', () => {
    reg.ecrireFile({ prochain: 'x', entrees: [{ id: 1, agent: 'Claude' }, null], relances: [1], autre: 'x' });
    const f = lireBrut();
    assert.deepEqual(Object.keys(f).sort(), ['entrees', 'maj', 'prochain', 'relances']);
    assert.deepEqual([f.prochain, f.entrees, f.relances], [1, [], {}]);
  });

  test('mettre en file écrit l entrée, la date de modification, et rend la position et le total', () => {
    const r = mise(1);
    assert.equal(r.refus, undefined);
    assert.deepEqual([r.entree.id, r.position, r.total, r.deja], [1, 1, 1, false]);
    const f = lireBrut();
    assert.deepEqual(Object.keys(f).sort(), ['entrees', 'maj', 'prochain', 'relances']);
    assert.equal(f.entrees.length, 1);
    assert.equal(f.entrees[0].demande.prompt, 'Fais le travail 1');
    assert.ok(Math.abs(Date.parse(f.maj) - Date.now()) < 60000);
    const r2 = mise(2);
    assert.deepEqual([r2.entree.id, r2.position, r2.total], [2, 2, 2]);
    assert.equal(mise(3, { session: 'S2' }).total, 1, 'le total ne compte que l agent et la session');
  });

  test('la même demande remise en file ne change pas le fichier', () => {
    mise(1);
    const avant = fs.readFileSync(FILE(), 'utf8');
    const attente = Date.now() + 20;
    while (Date.now() < attente) { /* l heure doit pouvoir changer */ }
    const r = mise(1, { maintenant: T0 + 5 * MIN });
    assert.equal(r.deja, true);
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant);
  });

  test('un refus (invalide, trop grande, file pleine) ne crée ni ne modifie le fichier', () => {
    assert.deepEqual(mise(1, { demande: null }), { refus: 'invalide' });
    assert.deepEqual(mise(1, { demande: { prompt: 'x'.repeat(60000) } }), { refus: 'trop-grande' });
    assert.equal(fs.existsSync(FILE()), false);
    for (let i = 1; i <= 50; i++) mise(i);
    const avant = fs.readFileSync(FILE(), 'utf8');
    assert.deepEqual(mise(51), { refus: 'pleine' });
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant);
  });

  test('une entrée de plus de six heures est retirée à la mise en file suivante', () => {
    mise(1, { maintenant: T0 });
    mise(2, { maintenant: T0 + 5 * 60 * MIN });
    assert.equal(lireBrut().entrees.length, 2);
    const r = mise(3, { maintenant: T0 + 6 * 60 * MIN + 1 });
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [2, 3]);
    assert.equal(r.position, 2);
  });

  test('les entrées lançables sont celles de l agent et de la session, dans l ordre ; ordonner les met de côté dix minutes', () => {
    mise(1);
    mise(2);
    mise(3, { session: 'S2' });
    assert.deepEqual(reg.entreesLancables('claude', 'S1', 5, T0).map(e => e.id), [1, 2]);
    assert.deepEqual(reg.entreesLancables('claude', 'S1', 1, T0).map(e => e.id), [1]);
    assert.deepEqual(reg.entreesLancables('claude', 'S2', 5, T0).map(e => e.id), [3]);
    reg.ordonner([1], T0);
    assert.deepEqual(reg.entreesLancables('claude', 'S1', 5, T0 + MIN).map(e => e.id), [2]);
    assert.deepEqual(reg.entreesLancables('claude', 'S1', 5, T0 + 10 * MIN).map(e => e.id), [1, 2]);
    assert.equal(lireBrut().entrees[0].statut, 'ordonne');
  });

  test('ordonner sans entrée nommée n écrit rien', () => {
    mise(1);
    const avant = fs.readFileSync(FILE(), 'utf8');
    reg.ordonner([99], T0);
    reg.ordonner([], T0);
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant);
  });

  test('purgerFile retire les entrées de plus de six heures et dit combien, sans réécrire une file qui n a rien de périmé', () => {
    mise(1, { maintenant: T0 });
    mise(2, { maintenant: T0 + 5 * 60 * MIN });
    const avant = fs.readFileSync(FILE(), 'utf8');
    assert.equal(reg.purgerFile(T0 + 6 * 60 * MIN), 0);
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant, 'rien de périmé : rien d écrit');
    assert.equal(reg.purgerFile(T0 + 6 * 60 * MIN + 1), 1);
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [2]);
    assert.equal(reg.purgerFile(T0 + 20 * 60 * MIN), 1);
    assert.deepEqual(lireBrut().entrees, []);
    for (const maintenant of [NaN, undefined, 'x']) assert.equal(reg.purgerFile(maintenant), 0);
  });

  test('retirerReconnue retire l entrée de même demande, ordonnée ou non, et dit si elle existait', () => {
    mise(1);
    mise(2);
    reg.ordonner([2], T0);
    assert.equal(reg.retirerReconnue('claude', 'S1', demande(2)), true);
    assert.equal(reg.retirerReconnue('claude', 'S1', demande(2)), false);
    assert.equal(reg.retirerReconnue('claude', 'S2', demande(1)), false, 'une autre session ne retire pas');
    assert.equal(reg.retirerReconnue('codex', 'S1', demande(1)), false, 'un autre agent non plus');
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [1]);
    const avant = fs.readFileSync(FILE(), 'utf8');
    reg.retirerReconnue('claude', 'S1', demande(9));
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant, 'rien à retirer : rien d écrit');
  });

  test('viderFile retire tout, ou seulement l agent et la session donnés, et rend le nombre retiré', () => {
    mise(1);
    mise(2);
    mise(3, { session: 'S2' });
    reg.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(4), maintenant: T0 });
    assert.equal(reg.viderFile('claude', 'S1'), 2);
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [3, 4]);
    assert.equal(reg.viderFile('claude'), 1);
    assert.equal(reg.viderFile(), 1);
    assert.deepEqual(lireBrut().entrees, []);
    const avant = fs.readFileSync(FILE(), 'utf8');
    assert.equal(reg.viderFile(), 0);
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant, 'une file déjà vide n est pas réécrite');
  });

  test('les relances se comptent par clé, plafonnent à deux et s oublient', () => {
    assert.deepEqual([reg.relancesFaites('A'), reg.peutRelancer('A')], [0, true]);
    reg.compterRelance('A');
    reg.compterRelance('A');
    assert.deepEqual([reg.relancesFaites('A'), reg.peutRelancer('A')], [2, false]);
    reg.compterRelance('A');
    assert.equal(lireBrut().relances.A, 2);
    reg.compterRelance('B');
    reg.oublierRelances('A');
    assert.deepEqual(lireBrut().relances, { B: 1 });
    const avant = fs.readFileSync(FILE(), 'utf8');
    reg.oublierRelances('inconnue');
    assert.equal(fs.readFileSync(FILE(), 'utf8'), avant, 'oublier une clé absente n écrit rien');
  });

  test('le résumé compte la file, par agent ou pour tous', () => {
    assert.deepEqual(reg.resumeFile(), { enAttente: 0, ordonnees: 0, plusAncienne: null });
    mise(1);
    mise(2);
    reg.ordonner([2], T0);
    reg.mettreEnFile({ agent: 'codex', session: 'S1', description: 'x', demande: demande(4), maintenant: T0 + MIN });
    assert.deepEqual(reg.resumeFile(), { enAttente: 2, ordonnees: 1, plusAncienne: new Date(T0).toISOString() });
    assert.deepEqual(reg.resumeFile('codex'), { enAttente: 1, ordonnees: 0, plusAncienne: new Date(T0 + MIN).toISOString() });
  });

  test('la politique et la file sont deux fichiers distincts : changer l une ne touche pas l autre', () => {
    mise(1);
    reg.appliquerCommande('5');
    reg.appliquerCommande('file on');
    assert.equal(lireBrut().entrees.length, 1);
    assert.equal(brut().file, true);
    assert.equal(Object.hasOwn(brut(), 'entrees'), false);
  });
});

describe('commande /plafond file', () => {
  const FILE = () => path.join(process.env.COCKPIT_DIR, 'file-agents.json');
  const T0 = Date.parse('2026-03-03T20:00:00.000Z');
  const mise = (n, extra = {}) => reg.mettreEnFile({ agent: 'claude', session: 'S1', description: 'x', demande: { prompt: `Fais ${n}` }, maintenant: T0, ...extra });

  test('file on et file off s écrivent dans la politique et le disent', () => {
    assert.equal(reg.appliquerCommande('file on').message, "Agents : file d'attente activée.");
    assert.equal(reg.lirePolitique().file, true);
    assert.equal(reg.appliquerCommande('file off').message, "Agents : file d'attente désactivée.");
    assert.equal(reg.lirePolitique().file, false);
  });

  test('file vider sans portée vide la file de tous, et dit combien', () => {
    mise(1);
    mise(2, { agent: 'codex' });
    reg.appliquerCommande('5');
    const fichierPolitique = path.join(process.env.COCKPIT_DIR, 'politique-agents.json');
    const avantPolitique = fs.readFileSync(fichierPolitique, 'utf8');
    const attente = Date.now() + 20;
    while (Date.now() < attente) { /* l heure doit pouvoir changer */ }
    const r = reg.appliquerCommande('file vider');
    assert.equal(r.message, "Agents : file d'attente vidée (2 agents retirés).");
    assert.deepEqual(r.politique, reg.lirePolitique(), 'la politique courante est rendue avec le message');
    assert.equal(r.politique.max, 5);
    assert.equal(fs.readFileSync(fichierPolitique, 'utf8'), avantPolitique, 'la politique n est pas réécrite pour rien');
    assert.deepEqual(JSON.parse(fs.readFileSync(FILE(), 'utf8')).entrees, []);
  });

  test('file vider avec une portée ne vide que l agent et la session donnés', () => {
    mise(1);
    mise(2, { session: 'S2' });
    mise(3, { agent: 'codex' });
    assert.equal(reg.appliquerCommande('file vider', undefined, { agent: 'claude', session: 'S1' }).message, "Agents : file d'attente vidée (1 agent retiré).");
    assert.deepEqual(JSON.parse(fs.readFileSync(FILE(), 'utf8')).entrees.map(e => e.id), [2, 3]);
    assert.equal(reg.appliquerCommande('file vider', undefined, { agent: 'claude' }).message, "Agents : file d'attente vidée (1 agent retiré).");
    assert.equal(reg.appliquerCommande('file vider', undefined, {}).message, "Agents : file d'attente vidée (1 agent retiré).");
    assert.equal(reg.appliquerCommande('file vider').message, "Agents : la file d'attente est déjà vide.");
  });

  test('l état dit si la file est activée', () => {
    reg.appliquerCommande('file on');
    assert.match(reg.appliquerCommande('').message, / File : oui\.$/);
  });
});

describe('cockpit.js politique', () => {
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });

  test('fixe, lit puis relit la politique par la ligne de commande', () => {
    const a = cli('politique', '5');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, 'Agents : maximum 5 en parallèle.\n');
    assert.equal(cli('politique', 'pause').stdout, 'Agents : en pause, aucun nouvel agent ne sera lancé.\n');
    assert.equal(cli('politique').stdout, 'Agents : en pause (maximum 5). Relance des échoués : non. File : non.\n');
    assert.equal(cli('politique', 'relance', 'on').stdout, 'Agents : relance des échoués activée.\n');
    assert.deepEqual(reg.lirePolitique(), { max: 5, pause: true, relance: true, file: false });
  });

  test('une commande invalide donne l usage sur stderr et le code 2', () => {
    const r = cli('politique', 'abc');
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage : \/plafond /);
    assert.equal(fs.existsSync(FICHIER), false);
  });
});

describe('agents du fil courant (Codex)', () => {
  const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');
  const MAINTENANT = Date.parse('2026-03-02T12:00:00.000Z');
  const il_y_a = ms => new Date(MAINTENANT - ms).toISOString();
  const MIN = 60 * 1000;
  const HEURE = 60 * MIN;
  const agentLigne = (nom, note, extra = {}) => ({ texte: `[agent] « ${nom} » (default, id-${nom}) : x`, statut: 'en-cours', note, ...extra });
  const EN_COURS = 'agent en cours depuis 2026-03-02 11:00';
  const ECHEC = 'TERMINÉ (failed) le 2026-03-02 11:30 : r';

  test('compte les agents en cours de ce fil, récents seulement', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('A', EN_COURS, { maj: il_y_a(10 * MIN), session: 'S1' }),
      'C-0002': agentLigne('B', EN_COURS, { maj: il_y_a(2 * HEURE + 59 * MIN), session: 'S1' }),
      'C-0003': agentLigne('C', EN_COURS, { maj: il_y_a(3 * HEURE + MIN), session: 'S1' }),
    });
    assert.equal(reg.etatAgents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT }).occupes, 2, 'un agent en cours depuis plus de trois heures est un zombie, pas un créneau');
  });

  test('ne compte ni les autres fils, ni les autres agents, ni les agents terminés', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('A', EN_COURS, { maj: il_y_a(5 * MIN), session: 'S1' }),
      'C-0002': agentLigne('B', EN_COURS, { maj: il_y_a(5 * MIN), session: 'AUTRE' }),
      'C-0003': agentLigne('C', ECHEC, { maj: il_y_a(5 * MIN), session: 'S1', statut: 'ouvert' }),
      'C-0004': { texte: 'un travail ordinaire', statut: 'en-cours', maj: il_y_a(5 * MIN), session: 'S1' },
    });
    ecrireEtatLedger('claude', 'P1', { 'C-0001': agentLigne('D', EN_COURS, { maj: il_y_a(5 * MIN), session: 'S1' }) });
    assert.equal(reg.etatAgents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT }).occupes, 1);
    assert.equal(reg.etatAgents({ agent: 'claude', session: 'S1', maintenant: MAINTENANT }).occupes, 1);
    assert.equal(reg.etatAgents({ agent: 'deepseek_H', session: 'S1', maintenant: MAINTENANT }).occupes, 0);
    assert.equal(reg.etatAgents({ agent: 'codex', session: 'S9', maintenant: MAINTENANT }).occupes, 0);
  });

  test('additionne les projets du même fil', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { maj: il_y_a(MIN), session: 'S1' }) });
    ecrireEtatLedger('codex', 'P2', { 'C-0001': agentLigne('B', EN_COURS, { maj: il_y_a(MIN), session: 'S1' }), 'C-0002': agentLigne('C', EN_COURS, { maj: il_y_a(MIN), session: 'S1' }) });
    assert.equal(reg.etatAgents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT }).occupes, 3);
  });

  test('une ligne sans date lisible ne tient aucun créneau (elle ne peut pas être jugée récente)', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('A', EN_COURS, { session: 'S1' }) });
    const f = path.join(process.env.CONTEXT_LEDGER_DIR, '.etat', 'P1.codex.json');
    const e = JSON.parse(fs.readFileSync(f, 'utf8'));
    e.lignes['C-0001'].maj = 'pas une date';
    fs.writeFileSync(f, JSON.stringify(e));
    assert.equal(reg.etatAgents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT }).occupes, 0);
  });

  test('rend aussi les noms des agents échoués de ce fil, et rien sans ledger', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('A', ECHEC, { session: 'S1', statut: 'ouvert' }),
      'C-0002': agentLigne('B', ECHEC, { session: 'AUTRE', statut: 'ouvert' }),
      'C-0003': agentLigne('C', 'TERMINÉ (killed) le 2026-03-02 11:45 : r', { session: 'S1', statut: 'ouvert' }),
    });
    assert.deepEqual(reg.etatAgents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT }).echoues, ['A', 'C']);
    fs.rmSync(process.env.CONTEXT_LEDGER_DIR, { recursive: true, force: true });
    assert.deepEqual(reg.etatAgents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT }), { occupes: 0, echoues: [] });
  });

  test('echouesRecents rend les échoués de ce fil terminés depuis moins que l âge donné, avec leur ligne et leur projet', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('Récent', ECHEC, { session: 'S1', statut: 'ouvert', maj: il_y_a(30 * MIN) }),
      'C-0002': agentLigne('Ancien', ECHEC, { session: 'S1', statut: 'ouvert', maj: il_y_a(3 * HEURE) }),
      'C-0003': agentLigne('Autre fil', ECHEC, { session: 'AUTRE', statut: 'ouvert', maj: il_y_a(MIN) }),
      'C-0004': agentLigne('Réussi', 'TERMINÉ (completed) le 2026-03-02 11:45 : r', { session: 'S1', statut: 'ouvert', maj: il_y_a(MIN) }),
      'C-0005': agentLigne('En cours', EN_COURS, { session: 'S1', maj: il_y_a(MIN) }),
    });
    ecrireEtatLedger('codex', 'P2', { 'C-0001': agentLigne('Tué', 'TERMINÉ (killed) le 2026-03-02 11:50 : r', { session: 'S1', statut: 'ouvert', maj: il_y_a(10 * MIN) }) });
    const r = reg.echouesRecents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT, ageMax: 2 * HEURE });
    assert.deepEqual(r.map(x => [x.nom, x.ligne, x.projet]), [['Récent', 'C-0001', 'P1'], ['Tué', 'C-0001', 'P2']]);
    assert.deepEqual(r.map(x => x.maj), [il_y_a(30 * MIN), il_y_a(10 * MIN)]);
    assert.deepEqual(reg.echouesRecents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT, ageMax: 20 * MIN }).map(x => x.nom), ['Tué']);
    assert.deepEqual(reg.echouesRecents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT, ageMax: 3 * HEURE + MIN }).map(x => x.nom), ['Ancien', 'Récent', 'Tué'], 'tri par date, le plus ancien d abord');
  });

  test('echouesRecents ignore un échoué sans date lisible, un autre agent, et rend une liste vide sans ledger', () => {
    ecrireEtatLedger('codex', 'P1', { 'C-0001': agentLigne('Sans date', ECHEC, { session: 'S1', statut: 'ouvert' }) });
    ecrireEtatLedger('claude', 'P1', { 'C-0001': agentLigne('Claude', ECHEC, { session: 'S1', statut: 'ouvert', maj: il_y_a(MIN) }) });
    const f = path.join(process.env.CONTEXT_LEDGER_DIR, '.etat', 'P1.codex.json');
    const e = JSON.parse(fs.readFileSync(f, 'utf8'));
    e.lignes['C-0001'].maj = 'pas une date';
    fs.writeFileSync(f, JSON.stringify(e));
    assert.deepEqual(reg.echouesRecents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT, ageMax: HEURE }), []);
    assert.deepEqual(reg.echouesRecents({ agent: 'deepseek_H', session: 'S1', maintenant: MAINTENANT, ageMax: HEURE }), []);
    fs.rmSync(process.env.CONTEXT_LEDGER_DIR, { recursive: true, force: true });
    assert.deepEqual(reg.echouesRecents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT, ageMax: HEURE }), []);
  });

  test('echouesRecents : l âge limite est inclus, zéro est un âge valide, une date dans le futur compte, un âge négatif, infini ou texte ne rend rien', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('Pile', ECHEC, { session: 'S1', statut: 'ouvert', maj: il_y_a(30 * MIN) }),
      'C-0002': agentLigne('Maintenant', ECHEC, { session: 'S1', statut: 'ouvert', maj: il_y_a(0) }),
      'C-0003': agentLigne('Futur', ECHEC, { session: 'S1', statut: 'ouvert', maj: new Date(MAINTENANT + 10 * MIN).toISOString() }),
    });
    const noms = ageMax => reg.echouesRecents({ agent: 'codex', session: 'S1', maintenant: MAINTENANT, ageMax }).map(x => x.nom);
    assert.deepEqual(noms(30 * MIN), ['Pile', 'Maintenant', 'Futur'], 'la limite exacte est incluse');
    assert.deepEqual(noms(30 * MIN - 1), ['Maintenant', 'Futur']);
    assert.deepEqual(noms(0), ['Maintenant', 'Futur'], 'zéro est un âge valide');
    for (const ageMax of [-1, Infinity, '7200000', null, undefined, NaN, 'x']) assert.deepEqual(noms(ageMax), [], String(ageMax));
  });

  test('echouesRecents sans date de référence prend l instant courant, et sans âge ne rend rien', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('A', ECHEC, { session: 'S1', statut: 'ouvert', maj: new Date(Date.now() - MIN).toISOString() }),
      'C-0002': agentLigne('Ancien', ECHEC, { session: 'S1', statut: 'ouvert', maj: new Date(Date.now() - 4 * HEURE).toISOString() }),
    });
    assert.deepEqual(reg.echouesRecents({ agent: 'codex', session: 'S1', ageMax: HEURE }).map(x => x.nom), ['A']);
    for (const ageMax of [undefined, null, 'x', -1, NaN]) assert.deepEqual(reg.echouesRecents({ agent: 'codex', session: 'S1', ageMax }), [], String(ageMax));
  });

  test('sans date de référence, l instant courant fait foi : le récent compte, le zombie non', () => {
    ecrireEtatLedger('codex', 'P1', {
      'C-0001': agentLigne('A', EN_COURS, { maj: new Date(Date.now() - MIN).toISOString(), session: 'S1' }),
      'C-0002': agentLigne('B', EN_COURS, { maj: new Date(Date.now() - 4 * HEURE).toISOString(), session: 'S1' }),
    });
    assert.equal(reg.etatAgents({ agent: 'codex', session: 'S1' }).occupes, 1);
  });
});

describe('agents du dépôt : un nom comme deepseek_H est converti en clé d état', () => {
  const FILE = () => path.join(process.env.COCKPIT_DIR, 'file-agents.json');
  const lireBrut = () => JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  const T0 = Date.parse('2026-03-03T20:00:00.000Z');
  const MIN = 60 * 1000;
  const HEURE = 60 * MIN;
  const demande = n => ({ prompt: `Fais le travail ${n}`, description: `travail ${n}`, subagentType: 'general-purpose' });
  const mise = (n, agent = 'deepseek_H') => reg.mettreEnFile({ agent, session: 'S1', description: `travail ${n}`, demande: demande(n), maintenant: T0 });

  test('la file garde la clé et retrouve ses entrées sous les deux formes du nom', () => {
    const r = mise(1);
    assert.equal(r.refus, undefined);
    assert.equal(r.entree.agent, 'deepseek-h');
    assert.equal(lireBrut().entrees[0].agent, 'deepseek-h');
    mise(2);
    for (const agent of ['deepseek_H', 'deepseek-h']) {
      assert.deepEqual(reg.entreesLancables(agent, 'S1', 5, T0).map(e => e.id), [1, 2], agent);
      assert.deepEqual(reg.resumeFile(agent), { enAttente: 2, ordonnees: 0, plusAncienne: new Date(T0).toISOString() }, agent);
    }
    assert.deepEqual(reg.entreesLancables('claude', 'S1', 5, T0), [], 'une autre clé ne voit rien');
    assert.equal(reg.retirerReconnue('deepseek_H', 'S1', demande(1)), true);
    assert.equal(reg.viderFile('deepseek_H', 'S1'), 1);
    assert.deepEqual(lireBrut().entrees, []);
  });

  test('un nom qui n est ni un agent du dépôt ni une clé valide reste refusé par la file', () => {
    for (const agent of ['Claude', 'deepseek_h', 'x y']) assert.deepEqual(mise(1, agent), { refus: 'invalide' }, agent);
    assert.equal(fs.existsSync(FILE()), false);
  });

  test('les agents en cours et échoués se lisent dans la liste de travail sous le nom du dépôt comme sous la clé', () => {
    const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');
    const MAINTENANT = Date.parse('2026-03-02T12:00:00.000Z');
    const ligne = (nom, note, extra = {}) => ({ texte: `[agent] « ${nom} » (default, id-${nom}) : x`, statut: 'en-cours', note, session: 'S1', maj: new Date(MAINTENANT - 5 * MIN).toISOString(), ...extra });
    ecrireEtatLedger('deepseek_H', 'P1', {
      'C-0001': ligne('A', 'agent en cours depuis 2026-03-02 11:00'),
      'C-0002': ligne('B', 'TERMINÉ (failed) le 2026-03-02 11:30 : r', { statut: 'ouvert' }),
    });
    for (const agent of ['deepseek_H', 'deepseek-h']) {
      const e = reg.etatAgents({ agent, session: 'S1', maintenant: MAINTENANT });
      assert.deepEqual([e.occupes, e.echoues], [1, ['B']], agent);
      assert.deepEqual(reg.echouesRecents({ agent, session: 'S1', maintenant: MAINTENANT, ageMax: HEURE }).map(x => x.nom), ['B'], agent);
    }
    assert.equal(reg.etatAgents({ agent: 'claude', session: 'S1', maintenant: MAINTENANT }).occupes, 0);
  });
});

describe('réservations : un lancement en cours n est pas proposé deux fois', () => {
  const FILE = () => path.join(process.env.COCKPIT_DIR, 'file-agents.json');
  const RESERVATIONS = () => path.join(process.env.COCKPIT_DIR, 'reservations-agents.json');
  const lireBrut = () => JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  const T0 = Date.parse('2026-03-03T20:00:00.000Z');
  const MIN = 60 * 1000;
  const demande = n => ({ prompt: `Fais le travail ${n}`, description: `travail ${n}`, subagentType: 'general-purpose' });
  const mise = (n, agent = 'claude') => reg.mettreEnFile({ agent, session: 'S1', description: `travail ${n}`, demande: demande(n), maintenant: T0 });
  const lancables = (agent = 'claude', n = 5) => reg.entreesLancables(agent, 'S1', n, T0).map(e => e.id);

  test('une demande réservée n est plus proposée ; l acquittement la libère, et la retire de la file si le lancement a réussi', () => {
    mise(1);
    mise(2);
    reg.reserverReconnue('claude', 'S1', demande(1), 'jeton-a');
    assert.deepEqual(lancables(), [2], 'la demande réservée n est pas reproposée');
    assert.equal(reg.acquitter('claude', 'S1', demande(1), true, 'autre-jeton'), false, 'un autre jeton ne libère rien');
    assert.deepEqual(lancables(), [2]);
    assert.equal(reg.acquitter('claude', 'S1', demande(1), false, 'jeton-a'), false, 'un lancement raté libère sans retirer de la file');
    assert.deepEqual(lancables(), [1, 2]);
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [1, 2]);
    reg.reserverReconnue('claude', 'S1', demande(2), 'jeton-b');
    assert.equal(reg.acquitter('claude', 'S1', demande(2), true, 'jeton-b'), true, 'un lancement réussi retire la demande de la file');
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [1]);
    assert.deepEqual(JSON.parse(fs.readFileSync(RESERVATIONS(), 'utf8')), {}, 'rien ne reste réservé');
    assert.equal(reg.acquitter('claude', 'S1', demande(2), true, 'jeton-b'), false, 'une demande déjà retirée ne s acquitte pas deux fois');
  });

  test('une demande inconnue ne réserve rien, une réservation expire au bout de cinq minutes, et le nombre demandé borne les entrées rendues', () => {
    mise(1);
    mise(2);
    mise(3);
    reg.reserverReconnue('claude', 'S1', demande(9), 'jeton-x');
    assert.equal(fs.existsSync(RESERVATIONS()), false, 'aucune réservation pour une demande inconnue');
    assert.equal(reg.acquitter('claude', 'S1', demande(9), true, 'jeton-x'), false);
    reg.reserverReconnue('claude', 'S1', demande(1), 'jeton-a');
    const dater = ms => {
      const r = JSON.parse(fs.readFileSync(RESERVATIONS(), 'utf8'));
      for (const k of Object.keys(r)) r[k].ts = Date.now() - ms;
      fs.writeFileSync(RESERVATIONS(), JSON.stringify(r));
    };
    dater(4 * MIN);
    assert.deepEqual(lancables(), [2, 3], 'quatre minutes : encore réservée');
    assert.deepEqual(lancables('claude', 2), [2, 3], 'une demande réservée ne compte pas dans le nombre demandé');
    dater(6 * MIN);
    assert.deepEqual(lancables(), [1, 2, 3], 'six minutes : la réservation a expiré');
    assert.deepEqual(lancables('claude', 2), [1, 2], 'au plus n entrées');
    assert.equal(reg.acquitter('claude', 'S1', demande(1), true, 'jeton-a'), false, 'une réservation expirée ne permet plus d acquitter');
    assert.deepEqual(lireBrut().entrees.map(e => e.id), [1, 2, 3]);
  });

  test('la réservation retient aussi les entrées d un agent du dépôt, sous sa clé d état', () => {
    mise(1, 'deepseek_H');
    reg.reserverReconnue('deepseek_H', 'S1', demande(1), 'jeton-a');
    assert.deepEqual(lancables('deepseek-h'), []);
    assert.equal(JSON.parse(fs.readFileSync(RESERVATIONS(), 'utf8'))[1].agent, 'deepseek-h');
    assert.equal(reg.acquitter('deepseek-h', 'S1', demande(1), true, 'jeton-a'), true);
    assert.deepEqual(lireBrut().entrees, []);
  });
});

describe('le Cockpit voit la politique', () => {
  test('instantane donne la politique normalisée quand le fichier existe, et null sinon', () => {
    const plans = path.join(RUN, 'plans');
    fs.mkdirSync(plans, { recursive: true });
    const cfg = { worktrees: [], plans: { dossier: plans, exclure: [], profondeur: 1 } };
    assert.equal(cockpit.instantane(cfg).politiqueAgents, null);
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER, JSON.stringify({ max: 3 }));
    assert.deepEqual(cockpit.instantane(cfg).politiqueAgents, { max: 3, pause: false, relance: false, file: false });
  });
});
