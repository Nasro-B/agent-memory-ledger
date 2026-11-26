'use strict';
// Bancs des entrées-sorties du Garde-quota (scripts/lib/quota-core.js) et de la commande cockpit.js quota.
// Réglages (garde-quota.json), lecture du quota de Codex dans son rollout et par son serveur d'application, mémoire des annonces et
// décision de lancement.
// Lancement : node --test tests/quota-core.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR).
// Variables internes (preuves par mutation) : QUOTA_CORE_TESTE = fichier à tester (défaut : ../scripts/lib/quota-core.js),
//   COCKPIT_CLI_TESTE = ligne de commande à tester (défaut : ../scripts/cockpit.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const Q = require(process.env.QUOTA_CORE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js'));
const cockpit = require(path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js'));
const CLI = process.env.COCKPIT_CLI_TESTE || path.join(__dirname, '..', 'scripts', 'cockpit.js'); // COCKPIT_CLI_TESTE : preuves par mutation de la ligne de commande

const MAINTENANT = Date.parse('2026-03-03T12:00:00.000Z');
const MIN = 60 * 1000;
const HEURE = 60 * MIN;
const sec = ms => Math.round((MAINTENANT + ms) / 1000);
const iso = ms => new Date(MAINTENANT + ms).toISOString();

let n = 0;
let RUN;
let ETAT;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `quota-core-${process.pid}-${++n}-`));
  ETAT = path.join(RUN, 'cockpit');
  process.env.COCKPIT_DIR = ETAT;
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison'); // jamais la vraie maison de l'utilisateur
});

const CONFIG = () => path.join(ETAT, 'garde-quota.json');
const lire = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// Une ligne du rollout de Codex, de la forme des relevés réels.
const tokenCount = (rateLimits, extra = {}) => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits, ...extra } });
const autre = (i = 0) => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: i, type: 'response_item', payload: { type: 'message', content: 'x'.repeat(40) } });
const limites = (pct, dansMs = 3 * 24 * HEURE, minutes = 10080) => ({ limit_id: 'codex', primary: { used_percent: pct, window_minutes: minutes, resets_at: sec(dansMs) }, secondary: null, plan_type: 'prolite' });
function rollout(lignes, nom = 'rollout.jsonl') {
  const f = path.join(RUN, nom);
  fs.writeFileSync(f, `${lignes.join('\n')}\n`);
  return f;
}

describe('réglages', () => {
  test('sans fichier, les réglages par défaut ; avec un fichier partiel ou abîmé, ils retombent sur les défauts champ par champ', () => {
    assert.deepEqual(Q.lireConfig(), { attention: 80, critique: 90, bloquerAgents: true, consigne: true, son: true });
    fs.mkdirSync(ETAT, { recursive: true });
    fs.writeFileSync(CONFIG(), JSON.stringify({ attention: 60, critique: 70, son: false }));
    assert.deepEqual(Q.lireConfig(), { attention: 60, critique: 70, bloquerAgents: true, consigne: true, son: false });
    fs.writeFileSync(CONFIG(), '{pas du json');
    assert.deepEqual(Q.lireConfig(), { attention: 80, critique: 90, bloquerAgents: true, consigne: true, son: true });
  });

  test('ecrireConfig écrit les réglages normalisés avec l heure, dans garde-quota.json', () => {
    Q.ecrireConfig({ attention: 70, critique: 85, extra: 1 });
    const c = lire(CONFIG());
    assert.deepEqual({ ...c, maj: undefined }, { attention: 70, critique: 85, bloquerAgents: true, consigne: true, son: true, maj: undefined });
    assert.ok(Math.abs(Date.parse(c.maj) - Date.now()) < 60000);
    assert.equal(c.extra, undefined);
  });

  test('appliquerCommande change les réglages, n écrit que si quelque chose change, et ne touche à rien sur une erreur', () => {
    const a = Q.appliquerCommande('70 85');
    assert.equal(a.message, 'Quota : seuils 70 % puis 85 %.');
    assert.deepEqual(a.config, { attention: 70, critique: 85, bloquerAgents: true, consigne: true, son: true });
    const avant = fs.statSync(CONFIG()).mtimeMs;
    const dormir = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    dormir(30);
    Q.appliquerCommande('70 85');
    assert.equal(fs.statSync(CONFIG()).mtimeMs, avant, 'une commande qui ne change rien n écrit rien');
    const e = Q.appliquerCommande('90 80');
    assert.match(e.erreur, /^Usage : \/quota /);
    assert.equal(e.message, undefined);
    assert.equal(lire(CONFIG()).attention, 70, 'une erreur ne change rien');
  });

  test('sans écriture préalable, une commande qui ne change rien ne crée même pas le fichier', () => {
    Q.appliquerCommande('');
    assert.equal(fs.existsSync(CONFIG()), false);
    Q.appliquerCommande('80 90');
    assert.equal(fs.existsSync(CONFIG()), false, 'les valeurs par défaut redites ne sont pas un changement');
  });
});

describe('quota lu dans le rollout de Codex', () => {
  test('le dernier événement token_count fait foi, les autres lignes sont ignorées', () => {
    const f = rollout([autre(1), tokenCount(limites(40)), autre(2), tokenCount(limites(43)), autre(3)]);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 43);
  });

  test('un token_count sans rate_limits exploitable cède la place au précédent qui en a', () => {
    const f = rollout([tokenCount(limites(41)), tokenCount(null), tokenCount(undefined), tokenCount('x'), tokenCount([]), tokenCount(5), autre()]);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 41);
  });

  test('une ligne qui parle de token_count sans en être un, ou illisible, est ignorée', () => {
    const faux = JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'token_count', rate_limits: limites(99) } });
    const f = rollout([tokenCount(limites(41)), faux, '{"payload":{"type":"token_count","rate_limits":', autre()]);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 41);
  });

  test('un fichier sans token_count, vide, absent, ou un chemin qui n est pas un texte, donnent null', () => {
    assert.equal(Q.dernierQuotaRollout(rollout([autre(1), autre(2)])), null);
    assert.equal(Q.dernierQuotaRollout(rollout([''], 'vide.jsonl')), null);
    assert.equal(Q.dernierQuotaRollout(path.join(RUN, 'absent.jsonl')), null);
    for (const chemin of [undefined, null, 5, {}, '']) assert.equal(Q.dernierQuotaRollout(chemin), null, JSON.stringify(chemin));
  });

  test('un gros rollout se lit par la fin : le dernier token_count est trouvé sans tout lire', () => {
    const remplissage = Array.from({ length: 20000 }, (_, i) => autre(i)); // environ 3 Mo
    const f = rollout([tokenCount(limites(10)), ...remplissage, tokenCount(limites(77)), autre(), autre()]);
    assert.ok(fs.statSync(f).size > 2 * 1024 * 1024);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 77);
  });

  test('un token_count plus loin que la fin lue n est pas cherché : null, et l appelant garde sa dernière mesure', () => {
    const remplissage = Array.from({ length: 30000 }, (_, i) => autre(i)); // plus de 4 Mo après lui
    const f = rollout([tokenCount(limites(10)), ...remplissage]);
    assert.ok(fs.statSync(f).size > 4 * 1024 * 1024);
    assert.equal(Q.dernierQuotaRollout(f), null);
  });

  test('la première ligne lue peut être coupée en deux sans gêner', () => {
    const grosse = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'y'.repeat(300 * 1024) } });
    const f = rollout([tokenCount(limites(10)), grosse, tokenCount(limites(55)), autre()]);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 55);
    const seule = rollout([tokenCount(limites(10)), grosse, autre()], 'seule.jsonl');
    assert.equal(Q.dernierQuotaRollout(seule).primary.used_percent, 10, 'une ligne plus grande que la première lecture est retrouvée à la seconde');
  });

  test('un caractère accentué coupé au début de la lecture ne gêne pas', () => {
    const accents = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'é'.repeat(200 * 1024) } });
    const f = rollout([accents, tokenCount(limites(66)), autre()]);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 66);
  });
});

describe('mesure de Codex', () => {
  test('mesurerCodex écrit quota-<agent>.json pour le Cockpit, avec la source, et rend les fenêtres', () => {
    const f = rollout([tokenCount(limites(43.26))]);
    const fenetres = Q.mesurerCodex({ agent: 'codex', chemin: f });
    assert.deepEqual(fenetres, [{ nom: '7 j', pct: 43.3, resetsAt: new Date(sec(3 * 24 * HEURE) * 1000).toISOString() }]);
    const q = cockpit.lireQuota('codex');
    assert.deepEqual(q.fenetres, fenetres);
    assert.equal(q.source, 'rollout');
    assert.ok(q.mesureA);
  });

  test('chaque agent a son fichier, et sans mesure dans le rollout rien n est écrit ni remplacé', () => {
    Q.mesurerCodex({ agent: 'deepseek_H', chemin: rollout([tokenCount(limites(12))]) });
    assert.equal(cockpit.lireQuota('codex'), null);
    assert.equal(cockpit.lireQuota('deepseek-h').fenetres[0].pct, 12, 'le nom du dépôt est converti en clé d état');
    assert.deepEqual(Q.mesurerCodex({ agent: 'deepseek_H', chemin: rollout([autre()], 'sans.jsonl') }), []);
    assert.equal(cockpit.lireQuota('deepseek-h').fenetres[0].pct, 12, 'la dernière mesure n est pas remplacée par du vide');
  });

  test('fenetresCourantes : le rollout d abord (et il met la mesure à jour), sinon la dernière mesure gardée, sinon rien', () => {
    assert.deepEqual(Q.fenetresCourantes({ agent: 'codex', chemin: undefined }), []);
    const f = rollout([tokenCount(limites(43))]);
    assert.equal(Q.fenetresCourantes({ agent: 'codex', chemin: f })[0].pct, 43);
    assert.equal(cockpit.lireQuota('codex').fenetres[0].pct, 43);
    assert.equal(Q.fenetresCourantes({ agent: 'codex', chemin: rollout([autre()], 'neuf.jsonl') })[0].pct, 43, 'un fil sans mesure reprend la dernière connue');
    assert.equal(Q.fenetresCourantes({ agent: 'codex', chemin: path.join(RUN, 'absent.jsonl') })[0].pct, 43);
    assert.deepEqual(Q.fenetresCourantes({ agent: 'deepseek_H', chemin: path.join(RUN, 'absent.jsonl') }), [], 'un autre agent n hérite pas');
  });

  test('une mesure gardée abîmée ne donne aucune fenêtre', () => {
    fs.mkdirSync(ETAT, { recursive: true });
    for (const brut of ['{pas du json', '[]', '"x"', JSON.stringify({ fenetres: 'x' }), JSON.stringify({ fenetres: [null, 5, { nom: 3 }] })]) {
      fs.writeFileSync(path.join(ETAT, 'quota-codex.json'), brut);
      assert.deepEqual(Q.fenetresCourantes({ agent: 'codex', chemin: undefined }), [], brut);
    }
  });

  test('un nom d agent hors liste ne construit aucun chemin', () => {
    const f = rollout([tokenCount(limites(43))]);
    assert.throws(() => Q.mesurerCodex({ agent: '../evil', chemin: f }), /agent invalide/);
    assert.deepEqual(fs.readdirSync(RUN).sort(), ['rollout.jsonl']);
  });
});

describe('annonces de Codex', () => {
  const f = (pct, dansMs = 3 * 24 * HEURE) => [{ nom: '7 j', pct, resetsAt: iso(dansMs) }];

  test('une alerte d attention est dite une fois persistée, pas avant', () => {
    const a = Q.suivreCodex({ agent: 'codex', fenetres: f(82), maintenant: MAINTENANT });
    assert.deepEqual(a.lignes, ['GARDE-QUOTA : Quota 7 j à 82 % : attention (remise à zéro dans 3 j 0 h)']);
    assert.equal(a.urgent, false);
    const sans = Q.suivreCodex({ agent: 'codex', fenetres: f(82), maintenant: MAINTENANT });
    assert.equal(sans.lignes.length, 1, 'tant que rien n est persisté, l alerte reste à dire');
    assert.equal(fs.existsSync(path.join(ETAT, 'garde-quota-alertes-codex.json')), false);
    a.persister();
    assert.deepEqual(Q.suivreCodex({ agent: 'codex', fenetres: f(83), maintenant: MAINTENANT }).lignes, []);
  });

  test('au seuil critique : l alerte, urgente, et la consigne de relais pour Claude, qui reste tant que la fenêtre est critique', () => {
    const a = Q.suivreCodex({ agent: 'codex', fenetres: f(92), maintenant: MAINTENANT });
    assert.equal(a.urgent, true);
    assert.equal(a.lignes.length, 2);
    assert.match(a.lignes[0], /^GARDE-QUOTA : Quota 7 j à 92 % : seuil critique, nouveaux agents bloqués/);
    assert.equal(a.lignes[1], `GARDE-QUOTA (ordre de l'utilisateur, valable après compactage) : fenêtre 7 j au-delà de 90 %. Maintenant : journalise ce qui est fait (history et Memory-Auto), commite les fichiers attribués (jamais de push), écris le prompt de relais pour Claude dans ${path.join(ETAT, 'relais-claude.md').split(path.sep).join('/')}, puis ne lance plus d'agent avant la remise à zéro.`);
    a.persister();
    const suite = Q.suivreCodex({ agent: 'codex', fenetres: f(95), maintenant: MAINTENANT });
    assert.equal(suite.urgent, false);
    assert.equal(suite.lignes.length, 1, 'plus d alerte, mais la consigne reste');
    assert.match(suite.lignes[0], /^GARDE-QUOTA \(ordre de l'utilisateur/);
  });

  test('un nom d agent hors liste ne construit aucun chemin', () => {
    assert.throws(() => Q.suivreCodex({ agent: '../evil', fenetres: f(82), maintenant: MAINTENANT }), /agent invalide/);
    assert.equal(fs.existsSync(ETAT), false);
  });

  test('sans consigne dans les réglages, la remise à zéro est dite sans consigne de relance', () => {
    Q.suivreCodex({ agent: 'codex', fenetres: f(92, HEURE), maintenant: MAINTENANT }).persister();
    Q.ecrireConfig({ consigne: false });
    const apres = MAINTENANT + 2 * HEURE;
    const r = Q.suivreCodex({ agent: 'codex', fenetres: [{ nom: '7 j', pct: 2, resetsAt: new Date(apres + 7 * 24 * HEURE).toISOString() }], maintenant: apres });
    assert.deepEqual(r.lignes, []);
    assert.equal(r.urgent, true, 'la remise à zéro reste un événement, même sans texte pour le modèle');
  });

  test('sans consigne dans les réglages, seule l alerte est dite', () => {
    Q.ecrireConfig({ consigne: false });
    const a = Q.suivreCodex({ agent: 'codex', fenetres: f(92), maintenant: MAINTENANT });
    assert.equal(a.lignes.length, 1);
    a.persister();
    assert.deepEqual(Q.suivreCodex({ agent: 'codex', fenetres: f(95), maintenant: MAINTENANT }).lignes, []);
  });

  test('la remise à zéro est dite, urgente, et la consigne de relance reste 30 minutes', () => {
    Q.suivreCodex({ agent: 'codex', fenetres: f(92, HEURE), maintenant: MAINTENANT }).persister();
    const apres = MAINTENANT + 2 * HEURE;
    const r = Q.suivreCodex({ agent: 'codex', fenetres: [{ nom: '7 j', pct: 2, resetsAt: new Date(apres + 7 * 24 * HEURE).toISOString() }], maintenant: apres });
    assert.equal(r.urgent, true);
    assert.equal(r.lignes.length, 1);
    assert.match(r.lignes[0], /^GARDE-QUOTA : la fenêtre 7 j est remise à zéro\./);
    r.persister();
    const encore = Q.suivreCodex({ agent: 'codex', fenetres: [{ nom: '7 j', pct: 3, resetsAt: new Date(apres + 7 * 24 * HEURE).toISOString() }], maintenant: apres + 29 * MIN });
    assert.equal(encore.urgent, false);
    assert.equal(encore.lignes.length, 1, 'la relance reste dite pendant 30 minutes');
    assert.deepEqual(Q.suivreCodex({ agent: 'codex', fenetres: [{ nom: '7 j', pct: 3, resetsAt: new Date(apres + 7 * 24 * HEURE).toISOString() }], maintenant: apres + 31 * MIN }).lignes, []);
  });

  test('chaque agent a sa mémoire', () => {
    Q.suivreCodex({ agent: 'codex', fenetres: f(82), maintenant: MAINTENANT }).persister();
    assert.equal(Q.suivreCodex({ agent: 'deepseek_H', fenetres: f(82), maintenant: MAINTENANT }).lignes.length, 1);
    assert.deepEqual(fs.readdirSync(ETAT).filter(x => x.startsWith('garde-quota-alertes')), ['garde-quota-alertes-codex.json']);
  });

  test('une mémoire abîmée est ignorée sans lever', () => {
    fs.mkdirSync(ETAT, { recursive: true });
    for (const brut of ['{pas du json', '[]', '"x"', JSON.stringify({ deja: 5, hauts: 'x', remise: [] })]) {
      fs.writeFileSync(path.join(ETAT, 'garde-quota-alertes-codex.json'), brut);
      assert.equal(Q.suivreCodex({ agent: 'codex', fenetres: f(82), maintenant: MAINTENANT }).lignes.length, 1, brut);
    }
  });

  test('sans fenêtre, rien à dire et rien d écrit', () => {
    const a = Q.suivreCodex({ agent: 'codex', fenetres: [], maintenant: MAINTENANT });
    assert.deepEqual(a.lignes, []);
    a.persister();
    assert.equal(fs.existsSync(path.join(ETAT, 'garde-quota-alertes-codex.json')), true, 'la mémoire est écrite même vide (état à jour)');
  });
});

describe('décision de lancement de Codex', () => {
  test('refusé au seuil critique d après le rollout, avec la raison du Garde-quota', () => {
    const d = Q.decisionAgentCodex({ agent: 'codex', chemin: rollout([tokenCount(limites(93, 2 * HEURE))]), maintenant: MAINTENANT });
    assert.equal(d.autorise, false);
    assert.match(d.raison, /^Garde-quota : fenêtre 7 j à 93 % \(seuil 90 %\), remise à zéro dans 2 h 00\./);
  });

  test('autorisé sous le seuil, sans mesure, avec une mesure déjà remise à zéro, ou quand le blocage est désactivé', () => {
    assert.deepEqual(Q.decisionAgentCodex({ agent: 'codex', chemin: rollout([tokenCount(limites(89))]), maintenant: MAINTENANT }), { autorise: true });
    assert.deepEqual(Q.decisionAgentCodex({ agent: 'codex', chemin: undefined, maintenant: MAINTENANT }), { autorise: true });
    assert.deepEqual(Q.decisionAgentCodex({ agent: 'codex', chemin: rollout([tokenCount(limites(99, -MIN))], 'passee.jsonl'), maintenant: MAINTENANT }), { autorise: true });
    Q.ecrireConfig({ bloquerAgents: false });
    assert.deepEqual(Q.decisionAgentCodex({ agent: 'codex', chemin: rollout([tokenCount(limites(99))], 'bloc.jsonl'), maintenant: MAINTENANT }), { autorise: true });
  });

  test('la dernière mesure gardée suffit quand le rollout n en a pas', () => {
    Q.mesurerCodex({ agent: 'codex', chemin: rollout([tokenCount(limites(95))]) });
    assert.equal(Q.decisionAgentCodex({ agent: 'codex', chemin: rollout([autre()], 'neuf.jsonl'), maintenant: MAINTENANT }).autorise, false);
  });

  test('l instant par défaut est l instant courant', () => {
    const maintenant = Date.now();
    const f = rollout([tokenCount({ limit_id: 'codex', primary: { used_percent: 95, window_minutes: 10080, resets_at: Math.round((maintenant + HEURE) / 1000) } })]);
    assert.equal(Q.decisionAgentCodex({ agent: 'codex', chemin: f }).autorise, false);
    const passee = rollout([tokenCount({ limit_id: 'codex', primary: { used_percent: 95, window_minutes: 10080, resets_at: Math.round((maintenant - HEURE) / 1000) } })], 'p.jsonl');
    assert.equal(Q.decisionAgentCodex({ agent: 'codex', chemin: passee }).autorise, true);
  });
});

describe('lecture native et mesures datées', () => {
  const childProcess = require('node:child_process');
  const evenement = (pct, limite = 'codex', timestamp = '2026-03-01T10:00:00.000Z') => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { ...limites(pct), limit_id: limite } } });
  const sansLecture = (variable, f) => {
    const avant = process.env.COCKPIT_QUOTA_NATIVE;
    if (variable === undefined) delete process.env.COCKPIT_QUOTA_NATIVE; else process.env.COCKPIT_QUOTA_NATIVE = variable;
    try { return f(); } finally { if (avant === undefined) delete process.env.COCKPIT_QUOTA_NATIVE; else process.env.COCKPIT_QUOTA_NATIVE = avant; }
  };
  // Remplace le lancement de quota-native.cjs : note l'agent demandé (dernier argument) et rend la réponse donnée.
  const espion = reponse => {
    const vrai = childProcess.spawnSync;
    const appels = [];
    childProcess.spawnSync = (_, args) => { appels.push(args.at(-1)); return reponse(args.at(-1)); };
    return { appels, rendre: () => { childProcess.spawnSync = vrai; } };
  };
  const nativeOk = pct => () => ({ status: 0, stdout: JSON.stringify({ fenetres: [{ nom: '7 j', pct }], source: 'app-server', limitId: 'codex', sourceAt: new Date().toISOString() }) });

  test('le quota de Codex est celui de sa limite, pas du dernier événement d une autre limite', () => {
    const f = rollout([evenement(47), evenement(12, 'autre-limite')]);
    assert.equal(Q.dernierQuotaRollout(f).primary.used_percent, 47);
    assert.equal(Q.dernierQuotaRollout(rollout([evenement(12, 'autre-limite')], 'autre.jsonl')), null, 'une autre limite seule n est pas le quota de Codex');
    const sans = JSON.stringify({ timestamp: '2026-03-01T10:00:00.000Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 31, window_minutes: 10080, resets_at: sec(HEURE) } } } });
    assert.equal(Q.dernierQuotaRollout(rollout([sans], 'sans-id.jsonl')).primary.used_percent, 31, 'une limite sans identifiant est celle de Codex');
  });

  test('la mesure écrite est datée du rollout, pas de sa relecture', () => {
    Q.mesurerCodex({ agent: 'codex', chemin: rollout([evenement(47, 'codex', '2026-03-01T10:00:00.000Z')]) });
    const q = cockpit.lireQuota('codex');
    assert.equal(q.mesureA, '2026-03-01T10:00:00.000Z');
    assert.equal(q.limitId, 'codex');
    assert.equal(Q.dernierQuotaRollout(rollout([evenement(47)], 'meta.jsonl'), { metadata: true }).sourceAt, '2026-03-01T10:00:00.000Z');
    const sansDate = JSON.stringify({ payload: { type: 'token_count', rate_limits: limites(47) } });
    assert.equal(Q.dernierQuotaRollout(rollout([sansDate], 'sans-date.jsonl'), { metadata: true }).sourceAt, null);
  });

  test('une mesure native récente ne recule pas devant un ancien rollout, mais un rollout plus récent la remplace', () => {
    cockpit.ecrireQuota('codex', { fenetres: [{ nom: '7 j', pct: 55 }], source: 'app-server', sourceAt: new Date().toISOString() });
    assert.equal(Q.fenetresCourantes({ agent: 'codex', chemin: rollout([evenement(47, 'codex', '2026-03-01T10:00:00.000Z')]) })[0].pct, 55);
    assert.equal(cockpit.lireQuota('codex').source, 'app-server');
    const futur = new Date(Date.now() + 3600000).toISOString();
    assert.equal(Q.fenetresCourantes({ agent: 'codex', chemin: rollout([evenement(61, 'codex', futur)], 'recent.jsonl') })[0].pct, 61);
    assert.equal(cockpit.lireQuota('codex').source, 'rollout');
  });

  test('la lecture native se fait au plus une fois par minute et par agent, et seul codex en a une', () => {
    const e = espion(nativeOk(55));
    try {
      sansLecture(undefined, () => {
        Q.rafraichirNatif('codex');
        Q.rafraichirNatif('codex');
        Q.rafraichirNatif('claude');
        Q.rafraichirNatif('deepseek_H');
        assert.deepEqual(e.appels, ['codex'], 'une lecture pour codex, aucune pour les autres, une seule dans la minute');
        assert.equal(cockpit.lireQuota('codex').fenetres[0].pct, 55);
        assert.equal(cockpit.lireQuota('codex').source, 'app-server');
        assert.equal(cockpit.lireQuota('claude'), null);
        assert.equal(cockpit.lireQuota('deepseek-h'), null);
        fs.writeFileSync(path.join(ETAT, 'quota-native-codex.json'), JSON.stringify({ ts: Date.now() - 59 * 1000 }));
        Q.rafraichirNatif('codex');
        assert.equal(e.appels.length, 1, 'à 59 secondes, pas encore');
        fs.writeFileSync(path.join(ETAT, 'quota-native-codex.json'), JSON.stringify({ ts: Date.now() - 61 * 1000 }));
        Q.rafraichirNatif('codex');
        assert.deepEqual(e.appels, ['codex', 'codex'], 'à 61 secondes, une nouvelle lecture');
        assert.deepEqual(fs.readdirSync(ETAT).filter(x => x.startsWith('quota-native')), ['quota-native-codex.json']);
        assert.throws(() => Q.rafraichirNatif('../evil'), /agent invalide/);
      });
    } finally { e.rendre(); }
  });

  test('COCKPIT_QUOTA_NATIVE=0 coupe la lecture native, et la valeur 1 ne la coupe pas', () => {
    const e = espion(nativeOk(55));
    try {
      sansLecture('0', () => Q.rafraichirNatif('codex'));
      assert.deepEqual(e.appels, []);
      assert.equal(fs.existsSync(path.join(ETAT, 'quota-native-codex.json')), false, 'coupée : rien n est noté');
      sansLecture('1', () => Q.rafraichirNatif('codex'));
      assert.deepEqual(e.appels, ['codex']);
    } finally { e.rendre(); }
  });

  test('une lecture native qui échoue est dite indisponible sans mesure gardée, et ne redonne pas une date fraîche à une ancienne mesure', () => {
    const e = espion(() => ({ status: 1, stdout: '' }));
    try {
      sansLecture(undefined, () => {
        Q.rafraichirNatif('codex');
        const q = cockpit.lireQuota('codex');
        assert.deepEqual([q.fenetres, q.source], [[], 'app-server-indisponible']);
        cockpit.ecrireQuota('codex', { fenetres: [{ nom: '7 j', pct: 42 }], source: 'rollout', sourceAt: '2026-03-01T10:00:00.000Z' });
        const gardee = cockpit.lireQuota('codex');
        fs.writeFileSync(path.join(ETAT, 'quota-native-codex.json'), JSON.stringify({ ts: 0 }));
        Q.rafraichirNatif('codex');
        assert.deepEqual(cockpit.lireQuota('codex'), gardee);
        for (const reponse of [{ status: 0, stdout: 'null' }, { status: 0, stdout: JSON.stringify({ fenetres: [], source: 'app-server' }) }, { status: 0, stdout: JSON.stringify({ fenetres: [{ nom: '7 j', pct: 9 }], source: 'autre' }) }, { status: 0, stdout: '' }, { status: 1, stdout: JSON.stringify({ fenetres: [{ nom: '7 j', pct: 9 }], source: 'app-server', sourceAt: new Date().toISOString() }) }]) {
          fs.writeFileSync(path.join(ETAT, 'quota-native-codex.json'), JSON.stringify({ ts: 0 }));
          e.rendre();
          const suite = espion(() => reponse);
          try { Q.rafraichirNatif('codex'); } finally { suite.rendre(); }
          assert.deepEqual(cockpit.lireQuota('codex'), gardee, JSON.stringify(reponse));
        }
      });
    } finally { e.rendre(); }
  });

  test('un nom d agent du dépôt est converti en clé : les annonces et la décision de lancement le suivent', () => {
    const f = [{ nom: '7 j', pct: 92, resetsAt: iso(3 * 24 * HEURE) }];
    const a = Q.suivreCodex({ agent: 'deepseek_H', fenetres: f, maintenant: MAINTENANT });
    assert.equal(a.urgent, true);
    a.persister();
    assert.deepEqual(fs.readdirSync(ETAT).filter(x => x.startsWith('garde-quota-alertes')), ['garde-quota-alertes-deepseek-h.json']);
    assert.equal(Q.suivreCodex({ agent: 'deepseek-h', fenetres: f, maintenant: MAINTENANT }).urgent, false, 'sous la forme clé, l alerte déjà dite n est pas redite');
    Q.mesurerCodex({ agent: 'deepseek_H', chemin: rollout([tokenCount(limites(95, 2 * HEURE))]) });
    assert.equal(Q.decisionAgentCodex({ agent: 'deepseek_H', chemin: undefined, maintenant: MAINTENANT }).autorise, false);
    assert.equal(Q.decisionAgentCodex({ agent: 'deepseek-h', chemin: undefined, maintenant: MAINTENANT }).autorise, false);
    assert.equal(Q.decisionAgentCodex({ agent: 'codex', chemin: undefined, maintenant: MAINTENANT }).autorise, true, 'la mesure de deepseek-h n est pas celle de codex');
    for (const agent of ['Claude', 'deepseek_h', 'x y', undefined]) assert.throws(() => Q.decisionAgentCodex({ agent, chemin: undefined, maintenant: MAINTENANT }), /agent invalide/, String(agent));
  });
});

describe('ligne de commande', () => {
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });

  test('cockpit.js quota change les réglages comme /quota et les relit', () => {
    const a = cli('quota', '70', '85');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, 'Quota : seuils 70 % puis 85 %.\n');
    assert.equal(lire(CONFIG()).critique, 85);
    assert.equal(cli('quota').stdout, 'Quota : seuils 70 % puis 85 %. Blocage des agents : oui. Consigne au modèle : oui. Son : oui.\n');
    assert.equal(cli('quota', 'bloquer', 'off').stdout, 'Quota : blocage des agents désactivé.\n');
  });

  test('une commande invalide donne l usage sur stderr et le code 2, sans rien écrire', () => {
    const r = cli('quota', '90', '80');
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage : \/quota /);
    assert.equal(fs.existsSync(CONFIG()), false);
  });
});
