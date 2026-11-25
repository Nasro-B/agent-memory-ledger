'use strict';
// Bancs de la logique du Garde-quota : scripts/lib/quota-logique.mjs
// Module ES sans aucune dépendance : le même fichier est destiné à l'adaptateur Claude Code et chargé par require() par Codex.
// Lancement : node --test tests/quota-logique.test.js
// Variable interne (preuves par mutation) : QUOTA_LOGIQUE_TESTE = fichier à tester (défaut : ../scripts/lib/quota-logique.mjs)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, describe } = require('node:test');

const Q = require(process.env.QUOTA_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'quota-logique.mjs'));

const MAINTENANT = Date.parse('2026-03-02T12:00:00.000Z');
const MIN = 60 * 1000;
const HEURE = 60 * MIN;
const dans = ms => new Date(MAINTENANT + ms).toISOString();
const fen = (nom, pct, resetsAt) => ({ nom, pct, ...(resetsAt ? { resetsAt } : {}) });
const CFG = Q.configParDefaut();
const sansTiretLong = t => !/\u{2014}/u.test(t);

describe('configuration', () => {
  test('la configuration par défaut : 80 % puis 90 %, blocage, consigne et son actifs', () => {
    assert.deepEqual(Q.configParDefaut(), { attention: 80, critique: 90, bloquerAgents: true, consigne: true, son: true });
  });

  test('normaliserConfig garde les valeurs valides et retombe sur les défauts champ par champ', () => {
    assert.deepEqual(Q.normaliserConfig({ attention: 70, critique: 95, bloquerAgents: false, consigne: false, son: false }), { attention: 70, critique: 95, bloquerAgents: false, consigne: false, son: false });
    for (const brut of [null, undefined, [], 'x', 5, {}]) assert.deepEqual(Q.normaliserConfig(brut), CFG, String(brut));
    assert.equal(Q.normaliserConfig({ attention: 1 }).attention, 1);
    assert.equal(Q.normaliserConfig({ attention: 99, critique: 100 }).attention, 99);
    for (const attention of [0, 100, -1, 80.5, '80', NaN, null]) assert.equal(Q.normaliserConfig({ attention }).attention, 80, `attention ${JSON.stringify(attention)}`);
    for (const critique of [1, 101, 90.5, '90', NaN, null]) assert.equal(Q.normaliserConfig({ critique }).critique, 90, `critique ${JSON.stringify(critique)}`);
    for (const v of ['non', 0, 1, null, {}]) {
      const c = Q.normaliserConfig({ bloquerAgents: v, consigne: v, son: v });
      assert.deepEqual([c.bloquerAgents, c.consigne, c.son], [true, true, true], `seul false désactive : ${JSON.stringify(v)}`);
    }
    assert.deepEqual(Object.keys(Q.normaliserConfig({ attention: 70, maj: 'x', autre: 1 })).sort(), ['attention', 'bloquerAgents', 'consigne', 'critique', 'son']);
  });

  test('un seuil d attention qui n est pas sous le seuil critique remet les deux aux défauts', () => {
    assert.deepEqual([Q.normaliserConfig({ attention: 95, critique: 90 }).attention, Q.normaliserConfig({ attention: 95, critique: 90 }).critique], [80, 90]);
    assert.deepEqual([Q.normaliserConfig({ attention: 90, critique: 90 }).attention, Q.normaliserConfig({ attention: 90, critique: 90 }).critique], [80, 90]);
    assert.deepEqual([Q.normaliserConfig({ attention: 60, critique: 61 }).attention, Q.normaliserConfig({ attention: 60, critique: 61 }).critique], [60, 61]);
    assert.deepEqual([Q.normaliserConfig({ attention: 95 }).attention, Q.normaliserConfig({ attention: 95 }).critique], [80, 90], 'un attention de 95 % avec le critique par défaut est incohérent');
  });
});

describe('fenêtres', () => {
  test('normaliserFenetres nomme les fenêtres connues, arrondit au dixième et trie 5 h, 7 j, budget, puis les autres', () => {
    const r = Q.normaliserFenetres([
      { kind: 'seven_day', percentUsed: 71.64, resetsAt: '2026-03-08T12:00:00.000Z' },
      { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-03-02T14:10:00.000Z' },
      { kind: 'spend_limit', percentUsed: 101.25 },
      { kind: 'autre', percentUsed: 3 },
    ]);
    assert.deepEqual(r, [
      { nom: '5 h', pct: 12, resetsAt: '2026-03-02T14:10:00.000Z' },
      { nom: '7 j', pct: 71.6, resetsAt: '2026-03-08T12:00:00.000Z' },
      { nom: 'budget', pct: 101.3 },
      { nom: 'autre', pct: 3 },
    ]);
  });

  test('normaliserFenetres ignore ce qui n est pas une fenêtre, rend null un pourcentage illisible et écarte une date illisible', () => {
    assert.deepEqual(Q.normaliserFenetres(undefined), []);
    assert.deepEqual(Q.normaliserFenetres('x'), []);
    assert.deepEqual(Q.normaliserFenetres([null, 5, 'x', [], {}, { kind: '' }, { kind: 7 }]), []);
    assert.deepEqual(Q.normaliserFenetres([{ kind: 'five_hour', percentUsed: '40', resetsAt: 'pas une date' }]), [{ nom: '5 h', pct: null }]);
    assert.deepEqual(Q.normaliserFenetres([{ kind: 'five_hour', percentUsed: NaN }]), [{ nom: '5 h', pct: null }]);
    assert.deepEqual(Q.normaliserFenetres([{ kind: 'five_hour', percentUsed: 0 }]), [{ nom: '5 h', pct: 0 }]);
    assert.deepEqual(Q.normaliserFenetres([{ kind: 'constructor', percentUsed: 1 }]), [{ nom: 'constructor', pct: 1 }], 'un nom hérité de Object n est pas une fenêtre connue');
  });

  test('niveau : ok sous le seuil d attention, attention dès ce seuil, critique dès le seuil critique, ok quand le pourcentage est illisible', () => {
    assert.equal(Q.niveau(79.9, CFG), 'ok');
    assert.equal(Q.niveau(80, CFG), 'attention');
    assert.equal(Q.niveau(89.9, CFG), 'attention');
    assert.equal(Q.niveau(90, CFG), 'critique');
    assert.equal(Q.niveau(100, CFG), 'critique');
    assert.equal(Q.niveau(120, CFG), 'critique');
    for (const p of [null, undefined, NaN, 'x', '95']) assert.equal(Q.niveau(p, CFG), 'ok', `${JSON.stringify(p)} : une chaîne n est pas un pourcentage`);
    assert.equal(Q.niveau(70, { ...CFG, attention: 70 }), 'attention');
    assert.equal(Q.niveau(95, { ...CFG, critique: 95 }), 'critique');
    assert.equal(Q.niveau(92, { ...CFG, critique: 95 }), 'attention', 'le seuil critique est celui de la configuration');
    assert.equal(Q.niveau(75, { ...CFG, attention: 70 }), 'attention', 'le seuil d attention est celui de la configuration');
  });

  test('actives écarte une fenêtre dont la remise à zéro est passée, et garde celle sans date', () => {
    const f = [fen('5 h', 95, dans(-1)), fen('7 j', 95, dans(MIN)), fen('budget', 95), fen('a', 5, dans(0))];
    assert.deepEqual(Q.actives(f, MAINTENANT).map(x => x.nom), ['7 j', 'budget']);
    assert.deepEqual(Q.actives([null, 5, 'x', fen('7 j', 1)], MAINTENANT).map(x => x.nom), ['7 j'], 'une entrée qui n est pas une fenêtre est ignorée');
    assert.deepEqual(Q.actives(undefined, MAINTENANT), []);
  });

  test('niveauGlobal est le plus haut niveau des fenêtres actives', () => {
    assert.equal(Q.niveauGlobal([], CFG, MAINTENANT), 'ok');
    assert.equal(Q.niveauGlobal([fen('5 h', 10), fen('7 j', 85)], CFG, MAINTENANT), 'attention');
    assert.equal(Q.niveauGlobal([fen('5 h', 91), fen('7 j', 85)], CFG, MAINTENANT), 'critique');
    assert.equal(Q.niveauGlobal([fen('5 h', 91, dans(-HEURE)), fen('7 j', 10)], CFG, MAINTENANT), 'ok', 'une fenêtre remise à zéro ne compte plus');
  });
});

describe('fenêtres gardées', () => {
  test('assainirFenetres garde les fenêtres bien formées d une mesure gardée dans un fichier, dans l ordre des fenêtres, et écarte le reste', () => {
    assert.deepEqual(Q.assainirFenetres([
      { nom: '7 j', pct: 71.6, resetsAt: '2026-03-08T12:00:00.000Z', extra: 1 },
      { nom: '5 h', pct: 12 },
    ]), [{ nom: '5 h', pct: 12 }, { nom: '7 j', pct: 71.6, resetsAt: '2026-03-08T12:00:00.000Z' }]);
    assert.deepEqual(Q.assainirFenetres([{ nom: '5 h', pct: '12' }, { nom: '7 j', pct: null, resetsAt: 'hier' }]), [{ nom: '5 h', pct: null }, { nom: '7 j', pct: null }]);
    assert.deepEqual(Q.assainirFenetres([{ nom: 'x', pct: NaN }, { nom: 'y', pct: 0 }]), [{ nom: 'x', pct: null }, { nom: 'y', pct: 0 }]);
  });

  test('assainirFenetres : tout ce qui n est pas une liste de fenêtres nommées ne donne rien', () => {
    for (const brut of [undefined, null, 'x', 5, {}, [null, 5, 'x', [], {}, { nom: 3 }, { nom: '' }]]) assert.deepEqual(Q.assainirFenetres(brut), [], JSON.stringify(brut));
  });
});

describe('fenêtres de Codex', () => {
  const secondes = ms => Math.round((MAINTENANT + ms) / 1000);

  test('normaliserFenetresCodex nomme la fenêtre d après sa durée et rend la remise à zéro en date ISO', () => {
    const r = Q.normaliserFenetresCodex({ primary: { used_percent: 43, window_minutes: 10080, resets_at: secondes(3 * 24 * HEURE) }, secondary: null });
    assert.deepEqual(r, [{ nom: '7 j', pct: 43, resetsAt: new Date(secondes(3 * 24 * HEURE) * 1000).toISOString() }]);
  });

  test('deux fenêtres : 5 h avant 7 j, quel que soit leur rang primaire ou secondaire', () => {
    const r = Q.normaliserFenetresCodex({
      primary: { used_percent: 71.64, window_minutes: 10080, resets_at: secondes(24 * HEURE) },
      secondary: { used_percent: 12, window_minutes: 300, resets_at: secondes(2 * HEURE) },
    });
    assert.deepEqual(r.map(f => [f.nom, f.pct]), [['5 h', 12], ['7 j', 71.6]]);
  });

  test('les autres durées : jours entiers, heures entières, sinon minutes', () => {
    const nom = m => Q.normaliserFenetresCodex({ primary: { used_percent: 1, window_minutes: m } })[0].nom;
    assert.equal(nom(1440), '1 j');
    assert.equal(nom(2880), '2 j');
    assert.equal(nom(60), '1 h');
    assert.equal(nom(180), '3 h');
    assert.equal(nom(90), '90 min');
    assert.equal(nom(10080), '7 j');
    assert.equal(nom(300), '5 h');
  });

  test('une fenêtre sans durée lisible, sans pourcentage ou sans date est rendue comme elle est, ou écartée', () => {
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50, window_minutes: 10080 } }), [{ nom: '7 j', pct: 50 }]);
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50, window_minutes: 10080, resets_at: 0 } }), [{ nom: '7 j', pct: 50 }], 'une date nulle n est pas une date');
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50, window_minutes: 10080, resets_at: 'bientôt' } }), [{ nom: '7 j', pct: 50 }]);
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50, window_minutes: 10080, resets_at: '1791948547' } }), [{ nom: '7 j', pct: 50 }], 'une date en chaîne n est pas une date');
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50, window_minutes: 10080, resets_at: 1e20 } }), [{ nom: '7 j', pct: 50 }], 'une date hors du possible n est pas une date');
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { window_minutes: 10080 } }), [{ nom: '7 j', pct: null }]);
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: '50', window_minutes: 10080 } }), [{ nom: '7 j', pct: null }]);
    assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50 } }), [], 'sans durée, on ne sait pas de quelle fenêtre il s agit');
    for (const m of [0, -5, 1.5, '300', null, NaN]) assert.deepEqual(Q.normaliserFenetresCodex({ primary: { used_percent: 50, window_minutes: m } }), [], `durée ${JSON.stringify(m)}`);
  });

  test('un état abîmé ne lève pas et ne donne aucune fenêtre', () => {
    for (const brut of [undefined, null, 'x', 5, [], {}, { primary: null, secondary: null }, { primary: 'x' }, { primary: [] }]) {
      assert.deepEqual(Q.normaliserFenetresCodex(brut), [], JSON.stringify(brut));
    }
  });
});

describe('alertes', () => {
  const R5 = dans(2 * HEURE);
  const R7 = dans(3 * 24 * HEURE);

  test('rien en dessous du seuil d attention', () => {
    assert.deepEqual(Q.alertes([fen('5 h', 79.9, R5), fen('7 j', 10, R7)], CFG, MAINTENANT, []), { nouvelles: [], deja: [] });
  });

  test('l attention est annoncée une fois, puis plus, tant que la fenêtre ne change pas', () => {
    const a = Q.alertes([fen('7 j', 82, R7)], CFG, MAINTENANT, []);
    assert.deepEqual(a.nouvelles, [{ fenetre: '7 j', niveau: 'attention', pct: 82, resetsAt: R7, cle: `7 j|${R7}|attention` }]);
    assert.deepEqual(a.deja, [`7 j|${R7}|attention`]);
    const b = Q.alertes([fen('7 j', 84, R7)], CFG, MAINTENANT, a.deja);
    assert.deepEqual(b.nouvelles, []);
    assert.deepEqual(b.deja, [`7 j|${R7}|attention`]);
  });

  test('le critique est annoncé à son tour, une fois, et comprend l attention déjà dépassée', () => {
    const a = Q.alertes([fen('7 j', 82, R7)], CFG, MAINTENANT, []);
    const b = Q.alertes([fen('7 j', 91, R7)], CFG, MAINTENANT, a.deja);
    assert.deepEqual(b.nouvelles.map(x => [x.fenetre, x.niveau, x.pct]), [['7 j', 'critique', 91]]);
    assert.deepEqual(b.deja.sort(), [`7 j|${R7}|attention`, `7 j|${R7}|critique`]);
    assert.deepEqual(Q.alertes([fen('7 j', 95, R7)], CFG, MAINTENANT, b.deja).nouvelles, []);
  });

  test('un saut direct au critique n annonce que le critique, et l attention ne revient pas ensuite', () => {
    const a = Q.alertes([fen('5 h', 93, R5)], CFG, MAINTENANT, []);
    assert.deepEqual(a.nouvelles.map(x => x.niveau), ['critique']);
    assert.deepEqual(Q.alertes([fen('5 h', 93, R5)], CFG, MAINTENANT, a.deja).nouvelles, []);
  });

  test('chaque fenêtre a ses propres annonces, dans l ordre des fenêtres', () => {
    const a = Q.alertes([fen('5 h', 85, R5), fen('7 j', 95, R7)], CFG, MAINTENANT, []);
    assert.deepEqual(a.nouvelles.map(x => [x.fenetre, x.niveau]), [['5 h', 'attention'], ['7 j', 'critique']]);
  });

  test('une nouvelle période (autre date de remise à zéro) est annoncée de nouveau, et les clés périmées s en vont', () => {
    const vieux = [`5 h|${dans(-3 * HEURE)}|attention`, `5 h|${dans(-3 * HEURE)}|critique`];
    const a = Q.alertes([fen('5 h', 85, R5)], CFG, MAINTENANT, vieux);
    assert.deepEqual(a.nouvelles.map(x => x.cle), [`5 h|${R5}|attention`]);
    assert.deepEqual(a.deja, [`5 h|${R5}|attention`], 'les clés de l ancienne période ont disparu');
  });

  test('une fenêtre dont la remise à zéro est passée n annonce rien', () => {
    assert.deepEqual(Q.alertes([fen('5 h', 99, dans(-MIN))], CFG, MAINTENANT, []), { nouvelles: [], deja: [] });
  });

  test('un pourcentage momentanément illisible garde les annonces déjà faites de cette fenêtre', () => {
    const a = Q.alertes([fen('7 j', 92, R7)], CFG, MAINTENANT, []);
    const b = Q.alertes([fen('7 j', null, R7)], CFG, MAINTENANT, a.deja);
    assert.deepEqual(b.nouvelles, []);
    assert.deepEqual(b.deja.sort(), a.deja.sort());
    assert.deepEqual(Q.alertes([fen('7 j', 92, R7)], CFG, MAINTENANT, b.deja).nouvelles, [], 'pas de nouvelle annonce au retour de la mesure');
  });

  test('l état mémorisé abîmé est ignoré sans lever', () => {
    for (const deja of [undefined, null, 'x', 5, {}, [null, 5, {}]]) {
      assert.equal(Q.alertes([fen('7 j', 85, R7)], CFG, MAINTENANT, deja).nouvelles.length, 1, JSON.stringify(deja));
      assert.deepEqual(Q.alertes([fen('7 j', null, R7)], CFG, MAINTENANT, deja), { nouvelles: [], deja: [] }, `pourcentage illisible : ${JSON.stringify(deja)}`);
    }
  });

  test('les seuils configurés sont ceux qui comptent', () => {
    const c = { ...CFG, attention: 50, critique: 60 };
    assert.deepEqual(Q.alertes([fen('7 j', 55, R7)], c, MAINTENANT, []).nouvelles.map(x => x.niveau), ['attention']);
    assert.deepEqual(Q.alertes([fen('7 j', 85, R7)], c, MAINTENANT, []).nouvelles.map(x => x.niveau), ['critique']);
  });
});

describe('remises à zéro', () => {
  const R = dans(-MIN);

  test('une fenêtre qui était haute et que la mesure donne maintenant basse est remise à zéro', () => {
    const hauts = [{ nom: '5 h', resetsAt: R }];
    assert.deepEqual(Q.remisesAZero(hauts, [fen('5 h', 3, dans(5 * HEURE))], CFG, MAINTENANT), ['5 h']);
  });

  test('pas de remise tant que la date prévue n est pas passée et ne change pas, ou que la fenêtre manque dans la mesure', () => {
    assert.deepEqual(Q.remisesAZero([{ nom: '5 h', resetsAt: dans(HEURE) }], [fen('5 h', 3, dans(HEURE))], CFG, MAINTENANT), [], 'un seuil relevé par l\'utilisateur n est pas une remise à zéro');
    assert.deepEqual(Q.remisesAZero([{ nom: '5 h', resetsAt: R }], [], CFG, MAINTENANT), [], 'sans mesure, on ne sait pas');
    assert.deepEqual(Q.remisesAZero([{ nom: '5 h', resetsAt: R }], [fen('7 j', 3, dans(HEURE))], CFG, MAINTENANT), []);
  });

  test('pas de remise si la fenêtre est encore haute malgré la date passée', () => {
    assert.deepEqual(Q.remisesAZero([{ nom: '5 h', resetsAt: R }], [fen('5 h', 95, dans(HEURE))], CFG, MAINTENANT), []);
    assert.deepEqual(Q.remisesAZero([{ nom: '5 h', resetsAt: R }], [fen('5 h', 85, dans(HEURE))], CFG, MAINTENANT), [], 'attention compte comme haut');
  });

  test('une date de remise changée vaut remise, même avant l heure prévue', () => {
    assert.deepEqual(Q.remisesAZero([{ nom: '7 j', resetsAt: dans(HEURE) }], [fen('7 j', 2, dans(8 * 24 * HEURE))], CFG, MAINTENANT), ['7 j']);
    assert.deepEqual(Q.remisesAZero([{ nom: '7 j', resetsAt: dans(8 * 24 * HEURE) }], [fen('7 j', 2, dans(HEURE))], CFG, MAINTENANT), [], 'une date plus proche que la prévue n est pas une remise');
    assert.deepEqual(Q.remisesAZero([{ nom: 'budget' }], [fen('budget', 3, dans(HEURE))], CFG, MAINTENANT), ['budget'], 'une fenêtre retenue sans date et mesurée basse avec une date est remise');
    assert.deepEqual(Q.remisesAZero([{ nom: 'budget' }], [fen('budget', 3)], CFG, MAINTENANT), [], 'sans aucune date des deux côtés, rien ne prouve la remise');
  });

  test('la date de remise prévue qui tombe exactement maintenant est passée', () => {
    assert.deepEqual(Q.remisesAZero([{ nom: '5 h', resetsAt: dans(0) }], [fen('5 h', 3, dans(0))], CFG, MAINTENANT), ['5 h']);
  });

  test('plusieurs fenêtres, entrée abîmée', () => {
    const hauts = [{ nom: '5 h', resetsAt: R }, { nom: '7 j', resetsAt: R }, null, 5, { nom: 3 }];
    assert.deepEqual(Q.remisesAZero(hauts, [fen('5 h', 1, dans(HEURE)), fen('7 j', 2, dans(HEURE))], CFG, MAINTENANT), ['5 h', '7 j']);
    assert.deepEqual(Q.remisesAZero(undefined, [fen('5 h', 1)], CFG, MAINTENANT), []);
    assert.deepEqual(Q.remisesAZero('x', [fen('5 h', 1)], CFG, MAINTENANT), []);
  });

  test('hautsActuels garde les fenêtres actives à l attention ou au critique, avec leur date de remise', () => {
    const f = [fen('5 h', 85, dans(HEURE)), fen('7 j', 10, dans(HEURE)), fen('budget', 99), fen('x', 99, dans(-MIN))];
    assert.deepEqual(Q.hautsActuels(f, CFG, MAINTENANT), [{ nom: '5 h', resetsAt: dans(HEURE) }, { nom: 'budget' }]);
  });
});

describe('suivi des fenêtres hautes', () => {
  const R = dans(-MIN);

  test('suivreHauts retient les fenêtres hautes actuelles avec leur date et rend les remises constatées', () => {
    const r = Q.suivreHauts([{ nom: '5 h', resetsAt: R }], [fen('5 h', 3, dans(5 * HEURE)), fen('7 j', 85, dans(24 * HEURE))], CFG, MAINTENANT);
    assert.deepEqual(r.remises, ['5 h']);
    assert.deepEqual(r.hauts, [{ nom: '7 j', resetsAt: dans(24 * HEURE) }]);
  });

  test('une fenêtre encore haute reste retenue avec sa nouvelle date, sans remise', () => {
    const r = Q.suivreHauts([{ nom: '7 j', resetsAt: dans(HEURE) }], [fen('7 j', 95, dans(HEURE))], CFG, MAINTENANT);
    assert.deepEqual(r, { hauts: [{ nom: '7 j', resetsAt: dans(HEURE) }], remises: [] });
  });

  test('une fenêtre absente de la mesure garde son ancienne entrée : on ne sait pas encore', () => {
    const r = Q.suivreHauts([{ nom: '5 h', resetsAt: R }, { nom: 'budget' }], [fen('7 j', 10, dans(HEURE))], CFG, MAINTENANT);
    assert.deepEqual(r.remises, []);
    assert.deepEqual(r.hauts, [{ nom: '5 h', resetsAt: R }, { nom: 'budget' }]);
  });

  test('une fenêtre mesurée basse sort de la liste, remise à zéro ou non', () => {
    const r = Q.suivreHauts([{ nom: '7 j', resetsAt: dans(HEURE) }], [fen('7 j', 10, dans(HEURE))], CFG, MAINTENANT);
    assert.deepEqual(r, { hauts: [], remises: [] });
  });

  test('l ancien état abîmé est ignoré sans lever', () => {
    for (const anciens of [undefined, null, 'x', 5, {}, [null, 5, {}, { nom: 3 }]]) {
      assert.deepEqual(Q.suivreHauts(anciens, [fen('5 h', 85, dans(HEURE))], CFG, MAINTENANT), { hauts: [{ nom: '5 h', resetsAt: dans(HEURE) }], remises: [] }, JSON.stringify(anciens));
    }
    assert.deepEqual(Q.suivreHauts([{ nom: '5 h' }], undefined, CFG, MAINTENANT), { hauts: [{ nom: '5 h' }], remises: [] });
    assert.deepEqual(Q.suivreHauts([{ nom: '5 h' }], [null, 5, fen('7 j', 85, dans(HEURE))], CFG, MAINTENANT), { hauts: [{ nom: '7 j', resetsAt: dans(HEURE) }, { nom: '5 h' }], remises: [] }, 'une entrée qui n est pas une fenêtre est ignorée');
  });

  test('remiseRecente : vraie pendant 30 minutes après la constatation, fausse ensuite et pour un état abîmé', () => {
    assert.equal(Q.DUREE_REMISE_MS, 30 * MIN);
    const remise = { noms: ['5 h'], ts: MAINTENANT };
    assert.equal(Q.remiseRecente(remise, MAINTENANT), true);
    assert.equal(Q.remiseRecente(remise, MAINTENANT + 30 * MIN - 1), true);
    assert.equal(Q.remiseRecente(remise, MAINTENANT + 30 * MIN), false);
    assert.equal(Q.remiseRecente(remise, MAINTENANT - 1), false, 'une date dans le futur n est pas une remise récente');
    for (const brut of [undefined, null, 'x', 5, [], {}, { noms: ['5 h'] }, { ts: MAINTENANT }, { noms: 'x', ts: MAINTENANT }, { noms: [], ts: MAINTENANT }, { noms: ['5 h'], ts: 'hier' }, { noms: ['5 h'], ts: String(MAINTENANT) }]) {
      assert.equal(Q.remiseRecente(brut, MAINTENANT), false, JSON.stringify(brut));
    }
  });
});

describe('décision de lancement', () => {
  test('autorisé sous le seuil critique, même à l attention', () => {
    assert.deepEqual(Q.decisionAgent([fen('7 j', 89.9, dans(HEURE))], CFG, MAINTENANT), { autorise: true });
    assert.deepEqual(Q.decisionAgent([], CFG, MAINTENANT), { autorise: true });
  });

  test('refusé dès le seuil critique, avec la fenêtre, les chiffres et le temps restant', () => {
    const d = Q.decisionAgent([fen('5 h', 12, dans(HEURE)), fen('7 j', 91.4, dans(2 * HEURE + 5 * MIN))], CFG, MAINTENANT);
    assert.equal(d.autorise, false);
    assert.match(d.raison, /^Garde-quota : fenêtre 7 j à 91 % \(seuil 90 %\), remise à zéro dans 2 h 05\./);
    assert.match(d.raison, /Ne lance aucun agent avant la remise à zéro : journalise, commite les fichiers attribués et écris le prompt de relais\.$/);
    assert.ok(sansTiretLong(d.raison));
  });

  test('sans date de remise, la raison ne prétend pas en connaître une', () => {
    const d = Q.decisionAgent([fen('budget', 100)], CFG, MAINTENANT);
    assert.equal(d.autorise, false);
    assert.ok(!/dans /.test(d.raison));
    assert.match(d.raison, /fenêtre budget à 100 %/);
  });

  test('autorisé quand le blocage est désactivé ou que la fenêtre est déjà remise à zéro', () => {
    assert.deepEqual(Q.decisionAgent([fen('7 j', 99, dans(HEURE))], { ...CFG, bloquerAgents: false }, MAINTENANT), { autorise: true });
    assert.deepEqual(Q.decisionAgent([fen('7 j', 99, dans(-MIN))], CFG, MAINTENANT), { autorise: true });
  });

  test('le seuil critique configuré fait foi', () => {
    const d = Q.decisionAgent([fen('7 j', 85, dans(HEURE))], { ...CFG, attention: 70, critique: 85 }, MAINTENANT);
    assert.equal(d.autorise, false);
    assert.match(d.raison, /\(seuil 85 %\)/);
  });
});

describe('consigne au modèle', () => {
  const AUTRE = { autre: 'Codex', fichier: 'C:/x/relais-codex.md' };

  test('aucune consigne tant qu aucune fenêtre n est au seuil critique', () => {
    assert.equal(Q.consigne([fen('7 j', 89, dans(HEURE))], CFG, MAINTENANT, AUTRE), null);
    assert.equal(Q.consigne([], CFG, MAINTENANT, AUTRE), null);
  });

  test('au seuil critique : journaliser, commiter sans push, écrire le prompt de relais, ne plus lancer d agent', () => {
    const t = Q.consigne([fen('5 h', 91, dans(HEURE))], CFG, MAINTENANT, AUTRE);
    assert.match(t, /^GARDE-QUOTA \(ordre de l'utilisateur, valable après compactage\) : fenêtre 5 h au-delà de 90 %\./);
    assert.match(t, /journalise/);
    assert.match(t, /commite les fichiers attribués \(jamais de push\)/);
    assert.match(t, /prompt de relais pour Codex dans C:\/x\/relais-codex\.md/);
    assert.match(t, /ne lance plus d'agent avant la remise à zéro/);
    assert.ok(sansTiretLong(t));
  });

  test('le texte ne dépend ni du pourcentage exact ni de l heure (le cache du prompt reste valable)', () => {
    const a = Q.consigne([fen('5 h', 91, dans(HEURE))], CFG, MAINTENANT, AUTRE);
    const b = Q.consigne([fen('5 h', 97.3, dans(2 * HEURE))], CFG, MAINTENANT + 7 * MIN, AUTRE);
    assert.equal(a, b);
  });

  test('le seuil critique de la configuration est celui que la consigne cite', () => {
    assert.match(Q.consigne([fen('7 j', 88, dans(HEURE))], { ...CFG, attention: 70, critique: 85 }, MAINTENANT, AUTRE), /fenêtre 7 j au-delà de 85 %/);
  });

  test('plusieurs fenêtres critiques sont nommées toutes les deux', () => {
    assert.match(Q.consigne([fen('5 h', 95, dans(HEURE)), fen('7 j', 99, dans(HEURE))], CFG, MAINTENANT, AUTRE), /fenêtre 5 h et 7 j au-delà de 90 %/);
  });

  test('désactivée par la configuration, ou fenêtre déjà remise à zéro', () => {
    assert.equal(Q.consigne([fen('7 j', 99, dans(HEURE))], { ...CFG, consigne: false }, MAINTENANT, AUTRE), null);
    assert.equal(Q.consigne([fen('7 j', 99, dans(-MIN))], CFG, MAINTENANT, AUTRE), null);
  });

  test('sans autre agent ni fichier de relais donnés, la consigne reste lisible', () => {
    const t = Q.consigne([fen('7 j', 99, dans(HEURE))], CFG, MAINTENANT);
    assert.match(t, /écris le prompt de relais pour l'autre agent, puis ne lance plus d'agent/);
    assert.ok(!/null|undefined/.test(t));
  });

  test('l autre agent et son fichier de relais sont ceux qu on donne', () => {
    const t = Q.consigne([fen('7 j', 99, dans(HEURE))], CFG, MAINTENANT, { autre: 'Claude', fichier: 'C:/x/relais-claude.md' });
    assert.match(t, /prompt de relais pour Claude dans C:\/x\/relais-claude\.md/);
  });

  test('la consigne de remise à zéro nomme les fenêtres remises et demande de relancer les agents arrêtés', () => {
    const t = Q.consigneRemise(['5 h']);
    assert.match(t, /^GARDE-QUOTA : la fenêtre 5 h est remise à zéro\./);
    assert.match(t, /relance les agents arrêtés/);
    assert.match(Q.consigneRemise(['5 h', '7 j']), /les fenêtres 5 h et 7 j sont remises à zéro/);
    assert.equal(Q.consigneRemise([]), null);
    assert.equal(Q.consigneRemise(['', 5, null, undefined]), null, 'seuls les noms non vides comptent');
    assert.equal(Q.consigneRemise(undefined), null);
    assert.match(Q.consigneRemise(['5 h', '', 7]), /la fenêtre 5 h est remise/);
    assert.match(Q.consigneRemise(['5 h', '7 j', 'budget']), /les fenêtres 5 h, 7 j et budget sont remises/);
    assert.ok(sansTiretLong(t));
  });
});

describe('affichage', () => {
  test('texteStatut : chaque fenêtre active avec son pourcentage arrondi, son niveau et le temps avant la remise à zéro', () => {
    const t = Q.texteStatut([fen('5 h', 12.4, dans(HEURE + 10 * MIN)), fen('7 j', 71.6, dans(3 * 24 * HEURE + 4 * HEURE))], CFG, MAINTENANT);
    assert.equal(t, '5 h 12 % (remise à zéro dans 1 h 10) | 7 j 72 % (remise à zéro dans 3 j 4 h)');
    assert.ok(sansTiretLong(t));
  });

  test('texteStatut : le niveau est dit en toutes lettres à partir de l attention', () => {
    assert.equal(Q.texteStatut([fen('5 h', 85, dans(30 * MIN))], CFG, MAINTENANT), '5 h 85 % ATTENTION (remise à zéro dans 30 min)');
    assert.equal(Q.texteStatut([fen('5 h', 95, dans(20 * 1000))], CFG, MAINTENANT), '5 h 95 % CRITIQUE (remise à zéro dans moins d\'une minute)');
  });

  test('texteStatut : sans date, sans pourcentage ou sans fenêtre active', () => {
    assert.equal(Q.texteStatut([fen('budget', 40)], CFG, MAINTENANT), 'budget 40 %');
    assert.equal(Q.texteStatut([fen('5 h', null, dans(HEURE))], CFG, MAINTENANT), '5 h ? % (remise à zéro dans 1 h 00)');
    assert.equal(Q.texteStatut([], CFG, MAINTENANT), undefined);
    assert.equal(Q.texteStatut([fen('5 h', 50, dans(-MIN))], CFG, MAINTENANT), undefined, 'une fenêtre remise à zéro ne s affiche plus');
  });

  test('dureeCourte : minutes, heures et minutes, jours et heures', () => {
    assert.equal(Q.dureeCourte(0), 'moins d\'une minute');
    assert.equal(Q.dureeCourte(59 * 1000), 'moins d\'une minute');
    assert.equal(Q.dureeCourte(59 * 1000 + 600), 'moins d\'une minute', 'les secondes sont tronquées, pas arrondies');
    assert.equal(Q.dureeCourte(MIN + 59 * 1000), '1 min', 'les minutes aussi');
    assert.equal(Q.dureeCourte(MIN), '1 min');
    assert.equal(Q.dureeCourte(59 * MIN + 59 * 1000), '59 min');
    assert.equal(Q.dureeCourte(HEURE), '1 h 00');
    assert.equal(Q.dureeCourte(2 * HEURE + 5 * MIN), '2 h 05');
    assert.equal(Q.dureeCourte(47 * HEURE + 59 * MIN), '47 h 59');
    assert.equal(Q.dureeCourte(48 * HEURE), '2 j 0 h');
    assert.equal(Q.dureeCourte(3 * 24 * HEURE + 4 * HEURE + 30 * MIN), '3 j 4 h');
    assert.equal(Q.dureeCourte(-5), 'moins d\'une minute');
  });

  test('texteAlerte dit la fenêtre, le niveau, le pourcentage et le temps restant', () => {
    const a = { fenetre: '7 j', niveau: 'attention', pct: 82.3, resetsAt: dans(3 * 24 * HEURE) };
    assert.equal(Q.texteAlerte(a, MAINTENANT), 'Quota 7 j à 82 % : attention (remise à zéro dans 3 j 0 h)');
    assert.equal(Q.texteAlerte({ ...a, niveau: 'critique', pct: 91 }, MAINTENANT), 'Quota 7 j à 91 % : seuil critique, nouveaux agents bloqués (remise à zéro dans 3 j 0 h)');
    assert.equal(Q.texteAlerte({ ...a, niveau: 'critique', pct: 91 }, MAINTENANT, { ...CFG, bloquerAgents: false }), 'Quota 7 j à 91 % : seuil critique (remise à zéro dans 3 j 0 h)', 'le blocage n est annoncé que s il est actif');
    assert.equal(Q.texteAlerte({ fenetre: 'budget', niveau: 'attention', pct: 80 }, MAINTENANT), 'Quota budget à 80 % : attention');
  });
});

describe('commande /quota', () => {
  test('sans argument ou avec « etat » : les seuils et les réglages', () => {
    for (const a of ['', '  ', 'etat', 'état', undefined, null]) {
      const r = Q.analyserCommande(a, CFG);
      assert.deepEqual(r.config, CFG);
      assert.equal(r.message, 'Quota : seuils 80 % puis 90 %. Blocage des agents : oui. Consigne au modèle : oui. Son : oui.');
    }
  });

  test('deux nombres fixent l attention puis le critique', () => {
    const r = Q.analyserCommande('70 85', CFG);
    assert.deepEqual(r.config, { ...CFG, attention: 70, critique: 85 });
    assert.equal(r.message, 'Quota : seuils 70 % puis 85 %.');
    assert.deepEqual(Q.analyserCommande('  70   85 ', CFG).config.critique, 85);
  });

  test('des seuils invalides ou incohérents donnent l usage sans rien changer', () => {
    for (const a of ['90 80', '80 80', '0 50', '50 101', '1', '70 85 90', 'a b', '70.5 90']) {
      const r = Q.analyserCommande(a, CFG);
      assert.match(r.erreur, /^Usage : \/quota /, a);
      assert.equal(r.config, undefined, a);
    }
  });

  test('bloquer, consigne et son se règlent avec on ou off', () => {
    assert.equal(Q.analyserCommande('bloquer off', CFG).config.bloquerAgents, false);
    assert.equal(Q.analyserCommande('bloquer on', { ...CFG, bloquerAgents: false }).config.bloquerAgents, true);
    assert.equal(Q.analyserCommande('consigne off', CFG).config.consigne, false);
    assert.equal(Q.analyserCommande('son non', CFG).config.son, false);
    assert.equal(Q.analyserCommande('son oui', { ...CFG, son: false }).config.son, true);
    assert.equal(Q.analyserCommande('bloquer off', CFG).message, 'Quota : blocage des agents désactivé.');
    assert.equal(Q.analyserCommande('consigne on', CFG).message, 'Quota : consigne au modèle activée.');
    assert.equal(Q.analyserCommande('son off', CFG).message, 'Quota : son désactivé.');
    for (const a of ['bloquer', 'bloquer peut-être', 'son 1']) assert.match(Q.analyserCommande(a, CFG).erreur, /^Usage : /, a);
  });

  test('defaut remet tout aux valeurs par défaut', () => {
    for (const mot of ['defaut', 'défaut']) {
      const r = Q.analyserCommande(mot, { attention: 50, critique: 60, bloquerAgents: false, consigne: false, son: false });
      assert.deepEqual(r.config, CFG, mot);
      assert.equal(r.message, 'Quota : réglages remis aux valeurs par défaut.', mot);
    }
  });

  test('la casse et les espaces ne comptent pas, et une commande inconnue donne l usage', () => {
    assert.equal(Q.analyserCommande('  BLOQUER   OFF ', CFG).config.bloquerAgents, false);
    const r = Q.analyserCommande('nimporte', CFG);
    assert.match(r.erreur, /^Usage : \/quota \[/);
    assert.ok(sansTiretLong(r.erreur));
  });

  test('une configuration abîmée en entrée est normalisée', () => {
    assert.deepEqual(Q.analyserCommande('', { attention: 'x' }).config, CFG);
    assert.deepEqual(Q.analyserCommande('son off', null).config, { ...CFG, son: false });
  });
});

// Un moteur peut ne rapporter que la fenêtre de 7 j (la logique reste générique, un autre moteur garde sa fenêtre de 5 h).
// Ces bancs figent ce que la mesure doit donner sans fenêtre de session.
describe('moteur sans fenêtre de session de 5 h', () => {
  const FIN = dans(5 * 24 * HEURE);
  const brut = pct => [{ kind: 'seven_day', percentUsed: pct, resetsAt: FIN }];

  test('la mesure ne contient que la fenêtre de 7 j : aucune fenêtre de 5 h n est inventée', () => {
    assert.deepEqual(Q.normaliserFenetres(brut(91.4)), [{ nom: '7 j', pct: 91.4, resetsAt: FIN }]);
  });

  test('au seuil critique la fenêtre de 7 j seule bloque les agents et porte la consigne et la ligne de statut', () => {
    const m = Q.normaliserFenetres(brut(91.4));
    const d = Q.decisionAgent(m, CFG, MAINTENANT);
    assert.equal(d.autorise, false);
    assert.match(d.raison, /fenêtre 7 j à 91 %/);
    assert.match(Q.consigne(m, CFG, MAINTENANT), /fenêtre 7 j au-delà de 90 %/);
    assert.equal(Q.texteStatut(m, CFG, MAINTENANT), '7 j 91 % CRITIQUE (remise à zéro dans 5 j 0 h)');
  });

  test('l attention de la fenêtre de 7 j est annoncée une seule fois', () => {
    const m = Q.normaliserFenetres(brut(85));
    const a = Q.alertes(m, CFG, MAINTENANT, []);
    assert.equal(a.nouvelles.length, 1);
    assert.equal(Q.texteAlerte(a.nouvelles[0], MAINTENANT, CFG), 'Quota 7 j à 85 % : attention (remise à zéro dans 5 j 0 h)');
    assert.equal(Q.alertes(m, CFG, MAINTENANT, a.deja).nouvelles.length, 0);
  });

  test('sans aucune fenêtre mesurée (hors abonnement, ou avant la première mesure) rien n est bloqué ni annoncé et la ligne de statut s efface', () => {
    assert.deepEqual(Q.normaliserFenetres([]), []);
    assert.equal(Q.decisionAgent([], CFG, MAINTENANT).autorise, true);
    assert.equal(Q.consigne([], CFG, MAINTENANT), null);
    assert.equal(Q.texteStatut([], CFG, MAINTENANT), undefined);
    assert.deepEqual(Q.alertes([], CFG, MAINTENANT, []), { nouvelles: [], deja: [] });
    assert.equal(Q.niveauGlobal([], CFG, MAINTENANT), 'ok');
  });
});
