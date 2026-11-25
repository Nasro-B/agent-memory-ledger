'use strict';
// Bancs de la logique de la Nuit : scripts/lib/nuit-logique.mjs
// Module ES sans aucune dépendance : le même fichier est destiné à l'adaptateur Claude Code et chargé par require() par Codex.
// Lancement : node --test tests/nuit-logique.test.js
// Variable interne (preuves par mutation) : NUIT_LOGIQUE_TESTE = fichier à tester (défaut : ../scripts/lib/nuit-logique.mjs)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, describe } = require('node:test');

const N = require(process.env.NUIT_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'nuit-logique.mjs'));

const T0 = Date.parse('2026-03-03T00:10:00.000Z');
const MIN = 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const sansTiretLong = t => !/\u{2014}/u.test(t);
const vide = () => N.etatParDefaut();
const active = (extra = {}) => ({ ...N.activer(vide(), { mode: 'nuit', maintenant: T0, lignesOuvertes: 5 }), ...extra });

describe('constantes', () => {
  test('les bornes sont celles de la conception', () => {
    assert.equal(N.MAX_BOITE, 50);
    assert.equal(N.MAX_TOURS_DEFAUT, 60);
    assert.equal(N.MAX_TOURS_LIMITE, 500);
    assert.equal(N.ABSENCE_DEFAUT_MIN, 60);
    assert.equal(N.ABSENCE_LIMITE_MIN, 1440);
    assert.equal(N.REPETITION_MAX, 3);
    assert.equal(N.PREFIXE_CONTINUATION, 'NUIT : ');
  });
});

describe('état', () => {
  test('l état par défaut est inactif, et chaque appel en rend un neuf', () => {
    assert.deepEqual(N.etatParDefaut(), {
      actif: false, mode: null, depuis: null, fin: null,
      tours: 0, maxTours: 60, absenceMinutes: 60, derniereActivite: null,
      derniereLigne: null, repetition: 0, sautees: [], arret: null,
      refus: { question: 0, garde: 0, action: 0 }, lignesAuDebut: null, passages: {},
    });
    assert.notEqual(N.etatParDefaut().passages, N.etatParDefaut().passages);
    assert.notEqual(N.etatParDefaut(), N.etatParDefaut());
    assert.notEqual(N.etatParDefaut().refus, N.etatParDefaut().refus);
    assert.notEqual(N.etatParDefaut().sautees, N.etatParDefaut().sautees);
  });

  test('un brut qui n est pas un objet donne l état par défaut', () => {
    for (const brut of [null, undefined, [], 'x', 5, true]) assert.deepEqual(N.normaliserEtat(brut), vide(), String(brut));
  });

  test('un état valide est gardé tel quel, sans champ inconnu', () => {
    const brut = {
      actif: true, mode: 'absence', depuis: iso(T0), fin: null, tours: 4, maxTours: 30, absenceMinutes: 120, derniereActivite: iso(T0 - MIN),
      derniereLigne: 'C-0866', repetition: 2, sautees: ['C-0100'], arret: null, refus: { question: 2, garde: 1, action: 3 }, lignesAuDebut: 9, autre: 'x',
      passages: { 'C-0100': 2, 'C-0866': 1 },
    };
    const e = N.normaliserEtat(brut);
    assert.deepEqual(e, {
      actif: true, mode: 'absence', depuis: iso(T0), fin: null, tours: 4, maxTours: 30, absenceMinutes: 120, derniereActivite: iso(T0 - MIN),
      derniereLigne: 'C-0866', repetition: 2, sautees: ['C-0100'], arret: null, refus: { question: 2, garde: 1, action: 3 }, lignesAuDebut: 9,
      passages: { 'C-0100': 2, 'C-0866': 1 },
    });
  });

  test('les passages gardés sont un compte par identifiant de ligne, borné, et tout le reste est écarté', () => {
    assert.deepEqual(N.normaliserEtat({ passages: { 'C-0001': 3, 'x': 1, 'M-0002': 1, 'C-0003': 0, 'C-0004': -1, 'C-0005': 1.5, 'C-0006': '2', 'C-0007': 20000 } }).passages, { 'C-0001': 3, 'C-0007': 9999 });
    for (const passages of [null, undefined, 'C-0001', 5, ['C-0001'], true]) assert.deepEqual(N.normaliserEtat({ passages }).passages, {}, String(passages));
    const trop = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`C-${String(i + 1).padStart(4, '0')}`, 1]));
    const gardes = Object.keys(N.normaliserEtat({ passages: trop }).passages);
    assert.equal(gardes.length, 1000);
    assert.equal(gardes[0], 'C-0201', 'au-delà de la borne, ce sont les derniers inscrits qui restent');
    assert.equal(gardes[999], 'C-1200');
  });

  test('un état actif sans mode lisible redevient une nuit manuelle, un mode inconnu sans activité est ignoré', () => {
    assert.equal(N.normaliserEtat({ actif: true, depuis: iso(T0) }).mode, 'nuit');
    assert.equal(N.normaliserEtat({ actif: true, mode: 'autre', depuis: iso(T0) }).mode, 'nuit');
    assert.equal(N.normaliserEtat({ actif: false, mode: 'autre' }).mode, null);
    assert.equal(N.normaliserEtat({ actif: 'oui' }).actif, false, 'seul true active');
    assert.equal(N.normaliserEtat({ actif: 1 }).actif, false);
  });

  test('les dates illisibles sont écartées', () => {
    const e = N.normaliserEtat({ actif: true, depuis: 'pas une date', fin: 5, derniereActivite: 'hier' });
    assert.deepEqual([e.depuis, e.fin, e.derniereActivite], [null, null, null]);
  });

  test('les nombres hors bornes retombent sur la valeur par défaut, les compteurs négatifs sur zéro', () => {
    for (const maxTours of [0, -1, 501, 1.5, '60', null]) assert.equal(N.normaliserEtat({ maxTours }).maxTours, 60, String(maxTours));
    assert.equal(N.normaliserEtat({ maxTours: 1 }).maxTours, 1);
    assert.equal(N.normaliserEtat({ maxTours: 500 }).maxTours, 500);
    for (const absenceMinutes of [0, -5, 1441, 1.5, '60']) assert.equal(N.normaliserEtat({ absenceMinutes }).absenceMinutes, 60, String(absenceMinutes));
    assert.equal(N.normaliserEtat({ absenceMinutes: 1 }).absenceMinutes, 1);
    assert.equal(N.normaliserEtat({ absenceMinutes: 1440 }).absenceMinutes, 1440);
    assert.equal(N.normaliserEtat({ absenceMinutes: null }).absenceMinutes, null, 'null veut dire : pas de détection d absence');
    for (const tours of [-1, 1.5, '3', null]) assert.equal(N.normaliserEtat({ tours }).tours, 0, String(tours));
    assert.deepEqual(N.normaliserEtat({ refus: { question: -1, garde: 'x', action: 2.5 } }).refus, { question: 0, garde: 0, action: 0 });
    assert.equal(N.normaliserEtat({ lignesAuDebut: -1 }).lignesAuDebut, null);
    assert.equal(N.normaliserEtat({ lignesAuDebut: 0 }).lignesAuDebut, 0);
  });

  test('la ligne mémorisée doit être un identifiant du fichier contexte, les lignes sautées une liste d identifiants bornée', () => {
    assert.equal(N.normaliserEtat({ derniereLigne: 'C-0866' }).derniereLigne, 'C-0866');
    for (const derniereLigne of ['0866', 'M-0001', '', 5, 'C-']) assert.equal(N.normaliserEtat({ derniereLigne }).derniereLigne, null, String(derniereLigne));
    assert.deepEqual(N.normaliserEtat({ sautees: ['C-0001', 'x', 'C-0001', 5, 'C-0002'] }).sautees, ['C-0001', 'C-0002']);
    const trop = Array.from({ length: 80 }, (_, i) => `C-${String(i + 1).padStart(4, '0')}`);
    assert.equal(N.normaliserEtat({ sautees: trop }).sautees.length, 50);
    assert.equal(N.normaliserEtat({ sautees: 'C-0001' }).sautees.length, 0);
  });

  test('l arrêt ne prend que des raisons connues', () => {
    for (const arret of ['plafond', 'termine', 'pause', 'quota', 'repetition']) assert.equal(N.normaliserEtat({ arret }).arret, arret);
    for (const arret of ['autre', 5, '', null]) assert.equal(N.normaliserEtat({ arret }).arret, null, String(arret));
  });
});

describe('activation, fin et réveil', () => {
  test('activer remet les compteurs à zéro et garde les réglages', () => {
    const avant = N.normaliserEtat({ maxTours: 20, absenceMinutes: 90, derniereActivite: iso(T0 - 5 * MIN), tours: 7, derniereLigne: 'C-0001', repetition: 2, sautees: ['C-0002'], arret: 'plafond', refus: { question: 4, garde: 1, action: 1 }, fin: iso(T0 - MIN), passages: { 'C-0002': 1 } });
    const e = N.activer(avant, { mode: 'nuit', maintenant: T0, lignesOuvertes: 12 });
    assert.deepEqual(e, {
      actif: true, mode: 'nuit', depuis: iso(T0), fin: null, tours: 0, maxTours: 20, absenceMinutes: 90, derniereActivite: iso(T0 - 5 * MIN),
      derniereLigne: null, repetition: 0, sautees: [], arret: null, refus: { question: 0, garde: 0, action: 0 }, lignesAuDebut: 12,
      passages: { 'C-0002': 1 }, // les passages des nuits d'avant restent : c'est ce qui fait avancer la nuit suivante dans la liste
    });
  });

  test('le mode d activation est nuit ou absence, tout autre mot donne nuit, et le nombre de lignes inconnu reste null', () => {
    assert.equal(N.activer(vide(), { mode: 'absence', maintenant: T0 }).mode, 'absence');
    assert.equal(N.activer(vide(), { mode: 'nuit', maintenant: T0 }).mode, 'nuit');
    assert.equal(N.activer(vide(), { mode: 'x', maintenant: T0 }).mode, 'nuit');
    assert.equal(N.activer(vide(), { maintenant: T0 }).mode, 'nuit');
    assert.equal(N.activer(vide(), { maintenant: T0 }).lignesAuDebut, null);
    assert.equal(N.activer(vide(), { maintenant: T0, lignesOuvertes: -3 }).lignesAuDebut, null);
  });

  test('activer sans instant lisible ne change rien', () => {
    assert.deepEqual(N.activer(vide(), { mode: 'nuit', maintenant: NaN }), vide());
    assert.deepEqual(N.activer(vide(), { mode: 'nuit' }), vide());
  });

  test('désactiver garde les compteurs et le mode pour le récap, et date la fin', () => {
    const e = N.desactiver(active({ tours: 6, refus: { question: 2, garde: 1, action: 0 } }), T0 + 7 * 60 * MIN);
    assert.equal(e.actif, false);
    assert.equal(e.mode, 'nuit');
    assert.equal(e.fin, iso(T0 + 7 * 60 * MIN));
    assert.equal(e.tours, 6);
    assert.deepEqual(e.refus, { question: 2, garde: 1, action: 0 });
    assert.equal(e.depuis, iso(T0));
  });

  test('désactiver une nuit déjà finie ne bouge pas la date de fin', () => {
    const finie = N.desactiver(active(), T0 + 60 * MIN);
    assert.deepEqual(N.desactiver(finie, T0 + 120 * MIN), finie);
  });

  test('un message de l\'utilisateur date son activité, et réveille une nuit active', () => {
    const r = N.noterActivite(active({ tours: 3 }), T0 + 9 * 60 * MIN);
    assert.equal(r.reveil, true);
    assert.equal(r.etat.actif, false);
    assert.equal(r.etat.fin, iso(T0 + 9 * 60 * MIN));
    assert.equal(r.etat.derniereActivite, iso(T0 + 9 * 60 * MIN));
    assert.equal(r.etat.tours, 3, 'les compteurs restent pour le récap');
  });

  test('un message de l\'utilisateur sans nuit active ne fait que dater son activité', () => {
    const r = N.noterActivite(vide(), T0);
    assert.equal(r.reveil, false);
    assert.deepEqual(r.etat, { ...vide(), derniereActivite: iso(T0) });
  });

  test('sans instant lisible, l activité n est pas datée', () => {
    assert.deepEqual(N.noterActivite(active(), NaN), { etat: active(), reveil: false });
  });
});

describe('absence', () => {
  const present = (minutes = 60) => N.normaliserEtat({ derniereActivite: iso(T0 - minutes * MIN), absenceMinutes: 60 });

  test('l absence est atteinte au délai réglé, pas avant', () => {
    assert.equal(N.absenceAtteinte(present(59), T0), false);
    assert.equal(N.absenceAtteinte(present(60), T0), true);
    assert.equal(N.absenceAtteinte(present(61), T0), true);
  });

  test('sans activité connue, ou sans délai réglé, ou nuit déjà active : jamais d absence détectée', () => {
    assert.equal(N.absenceAtteinte(vide(), T0), false, 'activité inconnue');
    assert.equal(N.absenceAtteinte(N.normaliserEtat({ derniereActivite: iso(T0 - 600 * MIN), absenceMinutes: null }), T0), false, 'détection éteinte');
    assert.equal(N.absenceAtteinte({ ...present(600), actif: true }, T0), false, 'déjà active');
    assert.equal(N.absenceAtteinte(present(600), NaN), false, 'instant illisible');
  });

  test('estActive : nuit manuelle ou absence atteinte', () => {
    assert.equal(N.estActive(active(), T0), true);
    assert.equal(N.estActive(present(10), T0), false);
    assert.equal(N.estActive(present(90), T0), true);
    assert.equal(N.estActive(vide(), T0), false);
  });

  test('activerSiAbsent active la nuit en mode absence, une seule fois, avec le nombre de lignes du moment', () => {
    const r = N.activerSiAbsent(present(90), T0, 8);
    assert.equal(r.active, true);
    assert.equal(r.etat.actif, true);
    assert.equal(r.etat.mode, 'absence');
    assert.equal(r.etat.depuis, iso(T0));
    assert.equal(r.etat.lignesAuDebut, 8);
    assert.equal(r.etat.tours, 0);
    const encore = N.activerSiAbsent(r.etat, T0 + MIN, 8);
    assert.equal(encore.active, false);
    assert.deepEqual(encore.etat, r.etat);
  });

  test('activerSiAbsent ne touche pas à un état présent', () => {
    const e = present(10);
    const r = N.activerSiAbsent(e, T0, 8);
    assert.deepEqual([r.active, r.etat], [false, e]);
  });
});

describe('boîte', () => {
  const ajout = (boite, extra = {}) => N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom pour le module ?', maintenant: T0, ...extra });
  const remplie = (n, extra = {}) => {
    let boite = N.boiteParDefaut();
    for (let i = 1; i <= n; i++) boite = ajout(boite, { titre: `Question ${i}`, maintenant: T0 + i * MIN, ...extra }).boite;
    return boite;
  };

  test('la boîte par défaut est vide, et chaque appel en rend une neuve', () => {
    assert.deepEqual(N.boiteParDefaut(), { prochain: 1, entrees: [] });
    assert.notEqual(N.boiteParDefaut(), N.boiteParDefaut());
    assert.notEqual(N.boiteParDefaut().entrees, N.boiteParDefaut().entrees);
  });

  test('un brut qui n est pas un objet donne la boîte par défaut', () => {
    for (const brut of [null, undefined, [], 'x', 5, true]) assert.deepEqual(N.normaliserBoite(brut), N.boiteParDefaut(), String(brut));
    assert.deepEqual(N.normaliserBoite({ entrees: 'x' }), N.boiteParDefaut());
  });

  test('une entrée valide est gardée telle quelle, avec ses champs et rien d autre', () => {
    const brute = {
      id: 3, agent: 'autre-agent', session: 'S9', type: 'action', ajoute: iso(T0), titre: 'git push de la branche', details: 'détails',
      options: [{ label: 'Autoriser', description: 'pousse', autre: 1 }, { label: 'Refuser' }], statut: 'repondue', reponse: 'Autoriser', traite: iso(T0 + MIN), autre: 'x',
    };
    const b = N.normaliserBoite({ prochain: 10, entrees: [brute] });
    assert.deepEqual(b.entrees, [{
      id: 3, agent: 'autre-agent', session: 'S9', type: 'action', ajoute: iso(T0), titre: 'git push de la branche', details: 'détails',
      options: [{ label: 'Autoriser', description: 'pousse' }, { label: 'Refuser', description: '' }], statut: 'repondue', reponse: 'Autoriser', traite: iso(T0 + MIN),
    }]);
    assert.equal(b.prochain, 10);
  });

  test('une entrée mal formée est écartée, les autres sont gardées', () => {
    const bonne = { id: 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'ok' };
    // Chaque entrée fautive a son identifiant : une seule faute à la fois, et jamais écartée comme doublon de la bonne.
    const fautes = [
      { id: 0 }, { id: -3 }, { id: 1.5 }, { id: '7' },
      { agent: 'Claude' }, { agent: '' }, { agent: '../x' }, { agent: 5 },
      { session: '' }, { session: 5 }, { session: 'x'.repeat(129) },
      { type: 'autre' }, { type: undefined }, { ajoute: 'hier' }, { ajoute: undefined }, { titre: '' }, { titre: '   ' }, { titre: 5 }, { titre: undefined },
    ];
    const mauvaises = [null, 'x', 5, [], {}, ...fautes.map((faute, i) => ({ ...bonne, id: i + 2, ...faute }))];
    const b = N.normaliserBoite({ entrees: [...mauvaises, bonne] });
    assert.deepEqual(b.entrees.map(e => e.id), [1]);
  });

  test('un identifiant en double est écarté, et prochain dépasse toujours le plus grand identifiant', () => {
    const e = id => ({ id, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: `q${id}` });
    const b = N.normaliserBoite({ prochain: 2, entrees: [e(7), e(7), e(3)] });
    assert.deepEqual(b.entrees.map(x => x.id), [7, 3]);
    assert.equal(b.prochain, 8);
    assert.equal(N.normaliserBoite({ prochain: 'x', entrees: [] }).prochain, 1);
    assert.equal(N.normaliserBoite({ prochain: 0, entrees: [] }).prochain, 1);
  });

  test('la normalisation borne les textes, les options et le nombre d entrées', () => {
    const longue = { id: 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: `  ${'t'.repeat(400)}\n suite `, details: 'd'.repeat(5900), reponse: 'r'.repeat(900), statut: 'repondue', traite: iso(T0),
      options: Array.from({ length: 9 }, (_, i) => ({ label: `option ${i}`.padEnd(120, 'x'), description: 'y'.repeat(300) })) };
    const e = N.normaliserBoite({ entrees: [longue] }).entrees[0];
    assert.equal(e.titre.length, 240);
    assert.ok(e.titre.endsWith('...'));
    assert.equal(e.details.length, 5000, 'les détails gardent la commande entière, bornés à 5000');
    assert.equal(e.reponse.length, 600);
    assert.equal(e.options.length, 6);
    assert.equal(e.options[0].label.length, 80);
    assert.equal(e.options[0].description.length, 120);
    const beaucoup = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: `q${i}` }));
    assert.equal(N.normaliserBoite({ entrees: beaucoup }).entrees.length, 50);
  });

  test('les options sans libellé sont écartées, un statut inconnu est en attente, une réponse n existe que pour une entrée traitée', () => {
    const base = { id: 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'q' };
    const e = N.normaliserBoite({ entrees: [{ ...base, options: [{ label: '' }, { label: 5 }, 'x', null, { label: 'A' }], statut: 'inconnu', reponse: 'R', traite: iso(T0) }] }).entrees[0];
    assert.deepEqual(e.options, [{ label: 'x', description: '' }, { label: 'A', description: '' }]);
    assert.equal(e.statut, 'en-attente');
    assert.equal(e.reponse, null);
    assert.equal(e.traite, null);
    const ecartee = N.normaliserBoite({ entrees: [{ ...base, statut: 'ecartee', reponse: 'R', traite: iso(T0) }] }).entrees[0];
    assert.deepEqual([ecartee.statut, ecartee.reponse, ecartee.traite], ['ecartee', null, iso(T0)], 'une entrée écartée n a pas de réponse');
    const sansDate = N.normaliserBoite({ entrees: [{ ...base, statut: 'repondue', reponse: 'R' }] }).entrees[0];
    assert.equal(sansDate.statut, 'en-attente', 'une entrée traitée sans date de traitement redevient à décider');
  });

  test('ajouter une entrée la met en attente avec le prochain identifiant', () => {
    const r = ajout(N.boiteParDefaut(), { details: 'Contexte', options: [{ label: 'Option A (Recommended)', description: 'la sûre' }, { label: 'Option B' }] });
    assert.equal(r.deja, false);
    assert.deepEqual(r.entree, {
      id: 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'Quel nom pour le module ?', details: 'Contexte',
      options: [{ label: 'Option A (Recommended)', description: 'la sûre' }, { label: 'Option B', description: '' }], statut: 'en-attente', reponse: null, traite: null,
    });
    assert.equal(r.boite.prochain, 2);
    assert.deepEqual(r.boite.entrees, [r.entree]);
  });

  test('la même question en attente ne s ajoute pas deux fois', () => {
    const premiere = ajout(N.boiteParDefaut());
    const seconde = ajout(premiere.boite, { maintenant: T0 + MIN });
    assert.equal(seconde.deja, true);
    assert.equal(seconde.boite.entrees.length, 1);
    assert.equal(seconde.entree.id, 1);
    assert.equal(seconde.boite.prochain, 2);
    assert.equal(ajout(premiere.boite, { session: 'S2' }).deja, false, 'une autre session');
    assert.equal(ajout(premiere.boite, { agent: 'codex' }).deja, false, 'un autre agent');
    assert.equal(ajout(premiere.boite, { type: 'action' }).deja, false, 'un autre genre');
    assert.equal(ajout(premiere.boite, { titre: 'Autre question' }).deja, false, 'un autre titre');
  });

  test('une question déjà traitée peut être posée de nouveau', () => {
    const traitee = N.repondre(ajout(N.boiteParDefaut()).boite, 1, 'Veilleur', T0 + MIN).boite;
    const r = ajout(traitee, { maintenant: T0 + 2 * MIN });
    assert.equal(r.deja, false);
    assert.deepEqual(r.boite.entrees.map(e => [e.id, e.statut]), [[1, 'repondue'], [2, 'en-attente']]);
  });

  test('une entrée invalide est refusée sans toucher à la boîte', () => {
    const b = N.boiteParDefaut();
    for (const extra of [{ agent: 'Claude' }, { agent: undefined }, { session: '' }, { session: undefined }, { type: 'autre' }, { titre: '' }, { titre: '  ' }, { titre: 5 }, { maintenant: NaN }, { maintenant: undefined }]) {
      assert.deepEqual(ajout(b, extra), { refus: 'invalide' }, JSON.stringify(extra));
    }
  });

  test('la boîte pleine refuse, sauf si des entrées traitées peuvent partir : les plus anciennes d abord', () => {
    const pleine = remplie(50);
    assert.deepEqual(ajout(pleine, { titre: 'Une de trop' }), { refus: 'pleine' });
    let traitee = N.repondre(pleine, 2, 'oui', T0 + 100 * MIN).boite;
    traitee = N.ecarter(traitee, 7, T0 + 90 * MIN).boite;
    const r = ajout(traitee, { titre: 'Une de plus', maintenant: T0 + 200 * MIN });
    assert.equal(r.refus, undefined);
    assert.equal(r.boite.entrees.length, 50);
    assert.ok(!r.boite.entrees.some(e => e.id === 7), 'l entrée traitée la plus anciennement (ni la première, ni la dernière de la liste) a été retirée');
    assert.ok(r.boite.entrees.some(e => e.id === 2), 'l autre entrée traitée reste');
    assert.ok(r.boite.entrees.some(e => e.id === 1), 'les entrées à décider restent, la première comprise');
    assert.equal(r.boite.entrees.at(-1).titre, 'Une de plus');
    assert.equal(r.boite.prochain, 52, 'les identifiants ne sont jamais réutilisés');
  });

  test('un titre est nettoyé et borné à l ajout, les options inutilisables sont écartées', () => {
    const r = ajout(N.boiteParDefaut(), { titre: `  ${'t'.repeat(400)}\n suite `, details: 'd'.repeat(5900), options: [{ label: '' }, { label: 'ok' }] });
    assert.equal(r.entree.titre.length, 240);
    assert.equal(r.entree.details.length, 5000);
    assert.deepEqual(r.entree.options, [{ label: 'ok', description: '' }]);
    assert.deepEqual(ajout(N.boiteParDefaut(), { options: 'x' }).entree.options, []);
    assert.equal(ajout(N.boiteParDefaut(), { details: undefined }).entree.details, '');
  });

  test('répondre marque l entrée comme répondue avec la réponse et la date', () => {
    const b = ajout(N.boiteParDefaut()).boite;
    const r = N.repondre(b, 1, '  Option A\n  retenue ', T0 + 5 * MIN);
    assert.equal(r.erreur, undefined);
    assert.deepEqual([r.entree.statut, r.entree.reponse, r.entree.traite], ['repondue', 'Option A retenue', iso(T0 + 5 * MIN)]);
    assert.deepEqual(r.boite.entrees[0], r.entree);
  });

  test('répondre dit pourquoi c est impossible', () => {
    const b = ajout(N.boiteParDefaut()).boite;
    assert.equal(N.repondre(b, 9, 'x', T0).erreur, 'Boîte : question n° 9 introuvable.');
    assert.equal(N.repondre(b, 'a', 'x', T0).erreur, 'Boîte : question n° a introuvable.');
    assert.equal(N.repondre(b, 1, '   ', T0).erreur, 'Boîte : la réponse est vide.');
    assert.equal(N.repondre(b, 1, 5, T0).erreur, 'Boîte : la réponse est vide.');
    assert.equal(N.repondre(b, 1, 'x', NaN).erreur, "Boîte : instant illisible, rien n'a changé.");
    const traitee = N.repondre(b, 1, 'x', T0).boite;
    assert.equal(N.repondre(traitee, 1, 'y', T0).erreur, 'Boîte : la question n° 1 est déjà traitée.');
  });

  test('une action accepte seulement le libellé exact de ses options', () => {
    const boite = ajout(N.boiteParDefaut(), { type: 'action', titre: 'Accord requis', options: [{ label: 'Autoriser' }, { label: 'Refuser' }] }).boite;
    const avant = JSON.stringify(boite);
    for (const texte of ['oui', 'autoriser', 'Autoriser demain', '']) {
      assert.ok(N.repondre(boite, 1, texte, T0 + MIN).erreur, texte);
      assert.equal(JSON.stringify(boite), avant, 'la boîte reçue ne change pas');
    }
    const bonne = N.repondre(boite, 1, 'Autoriser', T0 + MIN);
    assert.deepEqual([bonne.entree.statut, bonne.entree.reponse], ['repondue', 'Autoriser']);
    assert.equal(N.repondre(bonne.boite, 1, 'Refuser', T0 + 2 * MIN).erreur, 'Boîte : la question n° 1 est déjà traitée.');
    assert.ok(N.repondre(ajout(N.boiteParDefaut(), { type: 'action', options: [] }).boite, 1, 'Autoriser', T0).erreur);
  });

  test('une question garde sa réponse libre, mais refuse une réponse trop longue', () => {
    const boite = ajout(N.boiteParDefaut()).boite;
    assert.equal(N.repondre(boite, 1, 'réponse libre', T0).entree.reponse, 'réponse libre');
    assert.equal(N.repondre(boite, 1, 'x'.repeat(600), T0).entree.reponse.length, 600);
    assert.equal(N.repondre(boite, 1, 'x'.repeat(601), T0).erreur, 'Boîte : la réponse dépasse 600 caractères.');
    assert.equal(boite.entrees[0].statut, 'en-attente');
  });

  test('écarter marque l entrée comme écartée, sans réponse', () => {
    const b = ajout(N.boiteParDefaut()).boite;
    const r = N.ecarter(b, 1, T0 + 5 * MIN);
    assert.deepEqual([r.entree.statut, r.entree.reponse, r.entree.traite], ['ecartee', null, iso(T0 + 5 * MIN)]);
    assert.equal(N.ecarter(b, 4, T0).erreur, 'Boîte : question n° 4 introuvable.');
    assert.equal(N.ecarter(r.boite, 1, T0).erreur, 'Boîte : la question n° 1 est déjà traitée.');
    assert.equal(N.ecarter(b, 1, NaN).erreur, "Boîte : instant illisible, rien n'a changé.");
  });

  test('enAttente rend les entrées à décider, dans l ordre', () => {
    let b = remplie(3);
    b = N.repondre(b, 2, 'x', T0).boite;
    assert.deepEqual(N.enAttente(b).map(e => e.id), [1, 3]);
    assert.deepEqual(N.enAttente(null), []);
  });
});

describe('question refusée pendant la nuit', () => {
  const askClaude = { questions: [{ question: 'Quel nom pour le module ?', header: 'Nom', multiSelect: false, options: [{ label: 'Veilleur (Recommended)', description: 'court' }, { label: 'Nuit', description: 'direct' }] }] };

  test('une question de Claude donne son titre, ses détails et ses options', () => {
    const q = N.questionsDeOutil(askClaude);
    assert.equal(q.titre, 'Quel nom pour le module ?');
    assert.equal(q.details, 'Quel nom pour le module ? Options : Veilleur (Recommended) ; Nuit');
    assert.deepEqual(q.options, [{ label: 'Veilleur (Recommended)', description: 'court' }, { label: 'Nuit', description: 'direct' }]);
  });

  test('une question de Codex (title, sans options) donne son titre', () => {
    const q = N.questionsDeOutil({ questions: [{ title: 'Quelles ressources peux-tu affecter ?' }] });
    assert.deepEqual(q, { titre: 'Quelles ressources peux-tu affecter ?', details: '', options: [] });
  });

  test('plusieurs questions : le titre dit combien d autres, les détails les listent, aucun bouton ne répond à toutes', () => {
    const q = N.questionsDeOutil({ questions: [{ question: 'Première ?', options: [{ label: 'A' }] }, { question: 'Seconde ?' }, { title: 'Troisième ?' }] });
    assert.equal(q.titre, 'Première ? (+2 autres questions)');
    assert.equal(q.details, 'Première ? Options : A | Seconde ? | Troisième ?');
    assert.deepEqual(q.options, []);
    assert.equal(N.questionsDeOutil({ questions: [{ question: 'A ?' }, { question: 'B ?' }] }).titre, 'A ? (+1 autre question)');
  });

  test('une question sans texte lisible garde une trace', () => {
    const vide = { titre: 'Question sans texte lisible', details: '', options: [] };
    for (const entree of [null, undefined, 'x', 5, [], {}, { questions: [] }, { questions: 'x' }, { questions: [null, 5, {}] }, { questions: [{ question: '  ' }] }]) {
      assert.deepEqual(N.questionsDeOutil(entree), vide, JSON.stringify(entree));
    }
  });

  test('les textes sont nettoyés et bornés, les questions sans texte sont ignorées', () => {
    const q = N.questionsDeOutil({ questions: [{ question: '  une   question\n sur plusieurs lignes ', options: Array.from({ length: 8 }, (_, i) => ({ label: `option ${i}` })) }] });
    assert.equal(q.titre, 'une question sur plusieurs lignes');
    assert.equal(q.options.length, 6);
    const longue = N.questionsDeOutil({ questions: [{ question: 'q'.repeat(500) }, { question: '' }, { question: 'suite' }] });
    assert.equal(longue.titre.length <= 240, true);
    assert.ok(longue.titre.endsWith('(+1 autre question)'));
    assert.ok(longue.details.length <= 600);
  });

  test('l option recommandée est la première marquée, sans sa mention', () => {
    assert.equal(N.optionRecommandee([{ label: 'A' }, { label: 'B (Recommended)' }, { label: 'C (Recommended)' }]), 'B');
    assert.equal(N.optionRecommandee([{ label: 'Oui (recommandé)' }]), 'Oui');
    assert.equal(N.optionRecommandee([{ label: 'Non (Recommandée)' }]), 'Non');
    assert.equal(N.optionRecommandee([{ label: 'A' }, { label: 'B' }]), null);
    assert.equal(N.optionRecommandee([]), null);
    assert.equal(N.optionRecommandee(null), null);
    assert.equal(N.optionRecommandee([{ label: '(Recommended)' }]), null, 'une mention sans libellé ne dit rien');
  });

  test('le refus de la question dit où elle est notée et quoi faire à la place', () => {
    const t = N.texteRefusQuestion({ id: 4, enAttente: 2, options: askClaude.questions[0].options });
    assert.ok(t.startsWith('NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse.'), t);
    assert.ok(t.includes('Elle est notée en boîte (n° 4, 2 à décider au réveil).'), t);
    assert.ok(t.includes('Ne la repose pas.'), t);
    assert.ok(t.includes('l\'option la plus sûre et réversible (de préférence « Veilleur », marquée recommandée)'), t);
    assert.ok(t.includes('note ce choix et ses raisons dans le fichier contexte'), t);
    assert.ok(t.includes('passe à une autre ligne ouverte de ta liste de travail'), t);
    assert.ok(sansTiretLong(t));
  });

  test('sans option recommandée, le refus ne cite pas d option', () => {
    const t = N.texteRefusQuestion({ id: 1, enAttente: 1, options: [{ label: 'A' }] });
    assert.ok(t.includes('l\'option la plus sûre et réversible, note ce choix'), t);
    assert.ok(!t.includes('recommandée'), t);
    assert.ok(N.texteRefusQuestion({ id: 1, enAttente: 1 }).includes('la plus sûre et réversible, note'));
  });

  test('le refus d une question qui n a pas pu être notée ne promet pas de boîte', () => {
    const t = N.texteRefusQuestion({ id: null, enAttente: 0, options: [] });
    assert.ok(t.startsWith('NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse.'), t);
    assert.ok(t.includes('La boîte n\'a pas pu la noter : écris-la dans le fichier contexte.'), t);
    assert.ok(!t.includes('Elle est notée en boîte'), t);
    assert.ok(t.includes('Ne la repose pas.'), t);
  });
});

describe('arrêts de garde transformés en refus', () => {
  // Formes de sortie d'un hook de sécurité : la garde du dépôt rend hookSpecificOutput avec permissionDecision ; continue:false et stopReason sont lus aussi, par tolérance.
  const bloc = raison => ({ continue: false, stopReason: raison, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });
  const demande = raison => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: raison } });

  test('un blocage du garde est reconnu, avec sa raison', () => {
    assert.deepEqual(N.analyserSortieGarde(bloc('DANGER: rm recursif + force detecte')), { genre: 'bloc', raison: 'DANGER: rm recursif + force detecte' });
  });

  test('continue:false seul, ou un refus sans continue:false, sont aussi des blocages', () => {
    assert.deepEqual(N.analyserSortieGarde({ continue: false, stopReason: 'arrêt' }), { genre: 'bloc', raison: 'arrêt' });
    assert.deepEqual(N.analyserSortieGarde({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'refus' } }), { genre: 'bloc', raison: 'refus' });
    assert.deepEqual(N.analyserSortieGarde({ continue: false }), { genre: 'bloc', raison: 'refus du garde de sécurité' });
  });

  test('une demande d accord (push, déploiement) est reconnue comme telle', () => {
    assert.deepEqual(N.analyserSortieGarde(demande('git push detecte')), { genre: 'ask', raison: 'git push detecte' });
    assert.equal(N.analyserSortieGarde({ hookSpecificOutput: { permissionDecision: 'ask' } }).genre, 'ask');
  });

  test('un avertissement, une autorisation ou une sortie illisible ne sont pas des arrêts', () => {
    for (const sortie of [null, undefined, 'x', 5, [], {}, { systemMessage: 'ATTENTION: vercel env add' }, { continue: true }, { hookSpecificOutput: { permissionDecision: 'allow' } }, { hookSpecificOutput: 'x' }]) {
      assert.equal(N.analyserSortieGarde(sortie), null, JSON.stringify(sortie));
    }
  });

  test('la raison est nettoyée et bornée', () => {
    const r = N.analyserSortieGarde(bloc(`  ${'r'.repeat(900)}\n fin `)).raison;
    assert.equal(r.length, 600);
    assert.ok(r.endsWith('...'));
  });

  test('chaque règle de la garde de sécurité du dépôt a son alternative', () => {
    // Libellés de scripts/gardes/securite.js, tels que la garde les rend.
    const cas = [
      ["Suppression récursive forcée détectée (flags combinés ou séparés). Confirme explicitement le chemin et l'intention avant.", /laisse le dossier en place, note-le pour le réveil de l'utilisateur/],
      ['Suppression récursive Windows détectée (Remove-Item -Recurse -Force, rmdir /s, del /s).', /laisse le dossier en place, note-le pour le réveil de l'utilisateur/],
      ['git clean avec -f détecté (supprime tous les fichiers non suivis, -x inclut aussi les ignorés).', /laisse le dossier en place, note-le pour le réveil de l'utilisateur/],
      ['COMMIT REFUSE : rappel avant commit (dépôt C:/x).', /checklist-confirmer\.js/],
      ["Option de saut des vérifications de git détectée (elle contourne les hooks, dont le rappel avant commit).", /Ne contourne pas les hooks de git/],
      ["Poussée forcée détectée (--force, --force-with-lease, -f ou refspec « + ») : elle écrase l'historique distant.", /Ne force pas le push/],
      ['git reset --hard détecté : perte des modifications non commitées.', /git stash/],
      ["Suppression ou renommage d'une branche protégée détecté (motifs de gardes.json, securite.branchesProtegees).", /Ne supprime et ne renomme jamais une branche protégée/],
      ['wrangler deploy sans --keep-vars peut effacer les variables et secrets du Worker.', /--keep-vars/],
      ["git push détecté : jamais automatique, uniquement sur ordre explicite de l'utilisateur.", /Aucun push ni déploiement sans l'ordre explicite de l\'utilisateur/],
      ['Déploiement de production détecté (vercel --prod) : jamais automatique.', /Aucun push ni déploiement sans l'ordre explicite de l\'utilisateur/],
    ];
    for (const [raison, attendu] of cas) assert.match(N.alternativePourGarde(raison), attendu, raison);
  });

  test('plusieurs raisons donnent chaque alternative une fois, une raison inconnue donne la voie générale', () => {
    const t = N.alternativePourGarde('DANGER: Force push detecte | --no-verify detecte | Force push detecte');
    assert.match(t, /Ne force pas le push/);
    assert.match(t, /Ne contourne pas les hooks de git/);
    assert.equal(t.split('Ne force pas le push').length, 2, 'une seule fois');
    const defaut = N.alternativePourGarde('quelque chose de nouveau');
    assert.match(defaut, /Cherche une autre voie qui respecte la règle/);
    assert.equal(N.alternativePourGarde(undefined), defaut);
    assert.equal(N.alternativePourGarde(''), defaut);
  });

  test('le refus d un blocage dit la raison, l alternative et qu il ne faut pas s arrêter', () => {
    const t = N.texteRefusGarde({ genre: 'bloc', raison: 'DANGER: git reset --hard detecte' });
    assert.ok(t.startsWith('NUIT : le garde de sécurité refuse cette commande (DANGER: git reset --hard detecte).'), t);
    assert.ok(t.includes('L\'utilisateur est absent : ne t\'arrête pas, change de voie.'), t);
    assert.ok(t.includes('git stash'), t);
    assert.ok(!t.includes('boîte'), t);
    assert.ok(sansTiretLong(t));
  });

  test('le refus d une demande d accord dit que la commande n est pas lancée et où est la demande', () => {
    const t = N.texteRefusGarde({ genre: 'ask', raison: 'git push detecte - REGLE ABSOLUE', id: 3 });
    assert.ok(t.startsWith('NUIT : cette commande demande l\'accord de l\'utilisateur (git push detecte - REGLE ABSOLUE).'), t);
    assert.ok(t.includes('Il est absent : elle n\'est pas lancée.'), t);
    assert.ok(t.includes('Aucun push ni déploiement sans l\'ordre explicite de l\'utilisateur'), t);
    assert.ok(t.includes('La demande est notée en boîte (n° 3) : il l\'autorisera ou la refusera à son réveil.'), t);
    assert.ok(!N.texteRefusGarde({ genre: 'ask', raison: 'git push detecte', id: null }).includes('boîte'));
  });

  test('la raison du refus est bornée à trois cents caractères', () => {
    const t = N.texteRefusGarde({ genre: 'bloc', raison: 'x'.repeat(900) });
    assert.ok(t.includes(`(${'x'.repeat(297)}...)`), t);
  });

  test('une commande à valider donne une entrée de boîte avec deux boutons', () => {
    const a = N.actionDeGarde({ commande: '  git   push origin main\n', raison: 'git push detecte' });
    assert.equal(a.titre, 'Commande en attente d\'accord : git push origin main');
    assert.equal(a.details, 'git push detecte | Commande entière : git push origin main');
    assert.deepEqual(a.options.map(o => o.label), ['Autoriser', 'Refuser']);
    assert.equal(N.actionDeGarde({ commande: '', raison: 'x' }).titre, 'Commande en attente d\'accord');
    assert.equal(N.actionDeGarde({ commande: 'c'.repeat(400), raison: 'x' }).titre.length <= 240, true);
    assert.equal(N.actionDeGarde().titre, 'Commande en attente d\'accord');
  });
});

describe('enchaînement sur les lignes ouvertes', () => {
  const id = n => `C-${String(n).padStart(4, '0')}`;
  const ligne = (n, extra = {}) => ({ id: id(n), texte: `Travail ${n}`, statut: 'ouvert', session: 'S1', ...extra });
  const decide = (extra = {}) => N.decisionContinuation({ etat: active(), reason: 'answer', lignes: [ligne(1), ligne(2), ligne(3)], session: 'S1', pause: false, quotaCritique: false, ...extra });

  test('une nuit active, un tour terminé et des lignes ouvertes : on continue avec la première', () => {
    const d = decide();
    assert.equal(d.continuer, true);
    assert.deepEqual(d.ligne, { id: 'C-0001', texte: 'Travail 1' });
    assert.equal(d.restantes, 3);
    assert.equal(d.etat.tours, 1);
    assert.equal(d.etat.derniereLigne, 'C-0001');
    assert.equal(d.etat.repetition, 1);
    assert.equal(d.etat.arret, null);
    assert.ok(d.texte.startsWith('NUIT : L\'utilisateur est absent. Continue sans l\'attendre avec la ligne suivante de ta liste de travail : C-0001 « Travail 1 ».'), d.texte);
  });

  test('l état de départ n est jamais modifié', () => {
    const etat = active();
    const copie = JSON.parse(JSON.stringify(etat));
    N.decisionContinuation({ etat, reason: 'answer', lignes: [ligne(1)], session: 'S1' });
    assert.deepEqual(etat, copie);
  });

  test('seules les lignes de cette conversation, ouvertes ou en cours, sont proposées, dans l ordre des numéros', () => {
    const lignes = [ligne(12), ligne(5, { session: 'AUTRE' }), ligne(3, { statut: 'bloque-utilisateur' }), ligne(7, { session: null }), ligne(8, { statut: 'en-cours' }), { id: 'M-0001', texte: 'x', statut: 'ouvert', session: 'S1' }, ligne(9, { statut: 'fait' }), null, 'x', ligne(2)];
    const d = decide({ lignes });
    assert.equal(d.ligne.id, 'C-0002');
    assert.equal(d.restantes, 3, 'C-0002, C-0008 et C-0012');
  });

  test('lignesCandidates rend les lignes de la conversation, ouvertes ou en cours, dans l ordre des numéros, avec leur texte borné', () => {
    const lignes = [ligne(12), ligne(5, { session: 'AUTRE' }), ligne(3, { statut: 'bloque-utilisateur' }), ligne(8, { statut: 'en-cours', texte: ' un   texte\n sur deux lignes ' }), ligne(2)];
    assert.deepEqual(N.lignesCandidates(lignes, 'S1'), [{ id: 'C-0002', texte: 'Travail 2' }, { id: 'C-0008', texte: 'un texte sur deux lignes' }, { id: 'C-0012', texte: 'Travail 12' }]);
    assert.deepEqual(N.lignesCandidates(null, 'S1'), []);
    assert.deepEqual(N.lignesCandidates(lignes, undefined), []);
  });

  test('le texte de la ligne est nettoyé et borné dans le message', () => {
    const d = decide({ lignes: [ligne(1, { texte: `  ${'t'.repeat(300)}\n fin ` })] });
    assert.equal(d.ligne.texte.length, 160);
    assert.ok(d.texte.includes(`« ${'t'.repeat(157)}... »`), d.texte);
  });

  test('la même ligne est proposée trois fois de suite au plus, puis laissée de côté pour la nuit', () => {
    let etat = active();
    const lignes = [ligne(1), ligne(2)];
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const d = N.decisionContinuation({ etat, reason: 'answer', lignes, session: 'S1' });
      assert.equal(d.continuer, true, `tour ${i + 1}`);
      ids.push(d.ligne.id);
      etat = d.etat;
    }
    assert.deepEqual(ids, ['C-0001', 'C-0001', 'C-0001', 'C-0002', 'C-0002']);
    assert.deepEqual(etat.sautees, ['C-0001']);
    assert.equal(etat.repetition, 2);
    assert.equal(etat.tours, 5);
  });

  test('une ligne laissée de côté ne revient pas, même quand l autre a changé', () => {
    let etat = active({ derniereLigne: 'C-0001', repetition: 3 });
    const d1 = N.decisionContinuation({ etat, reason: 'answer', lignes: [ligne(1), ligne(2)], session: 'S1' });
    assert.equal(d1.ligne.id, 'C-0002');
    etat = { ...d1.etat, derniereLigne: 'C-0002', repetition: 3 };
    const d2 = N.decisionContinuation({ etat, reason: 'answer', lignes: [ligne(1), ligne(2)], session: 'S1' });
    assert.equal(d2.continuer, false);
    assert.equal(d2.motif, 'repetition');
    assert.deepEqual(d2.etat.sautees, ['C-0001', 'C-0002']);
    assert.equal(d2.etat.arret, 'repetition');
  });

  test('une ligne différente remet le compteur de répétition à un', () => {
    const d = decide({ etat: active({ derniereLigne: 'C-0009', repetition: 3 }) });
    assert.equal(d.ligne.id, 'C-0001');
    assert.equal(d.etat.repetition, 1);
  });

  test('aucune ligne ouverte : la nuit a fini son travail', () => {
    const d = decide({ lignes: [ligne(1, { session: 'AUTRE' }), ligne(2, { statut: 'bloque-utilisateur' })] });
    assert.equal(d.continuer, false);
    assert.equal(d.motif, 'termine');
    assert.equal(d.etat.arret, 'termine');
    assert.equal(d.etat.tours, 0);
    assert.equal(decide({ lignes: [] }).motif, 'termine');
    assert.equal(decide({ lignes: undefined }).motif, 'termine');
  });

  test('pas de nuit active : rien ne continue, et l état ne bouge pas', () => {
    const d = decide({ etat: vide() });
    assert.deepEqual([d.continuer, d.motif, d.etat], [false, 'inactive', vide()]);
  });

  test('un tour interrompu, en erreur ou refusé ne continue pas : l\'utilisateur a peut-être repris la main', () => {
    for (const reason of ['aborted', 'error', 'refusal', undefined, 'autre']) {
      const d = decide({ reason });
      assert.deepEqual([d.continuer, d.motif, d.etat.arret], [false, 'interrompu', null], String(reason));
    }
  });

  test('la pause du Régulateur et le quota critique arrêtent l enchaînement et le disent', () => {
    const p = decide({ pause: true });
    assert.deepEqual([p.continuer, p.motif, p.etat.arret], [false, 'pause', 'pause']);
    const q = decide({ quotaCritique: true });
    assert.deepEqual([q.continuer, q.motif, q.etat.arret], [false, 'quota', 'quota']);
  });

  test('le plafond de tours arrête l enchaînement : au plafond exactement, pas avant', () => {
    assert.equal(decide({ etat: active({ tours: 59 }) }).continuer, true);
    const d = decide({ etat: active({ tours: 60 }) });
    assert.deepEqual([d.continuer, d.motif, d.etat.arret], [false, 'plafond', 'plafond']);
    assert.equal(decide({ etat: active({ tours: 5, maxTours: 5 }) }).motif, 'plafond');
    assert.equal(decide({ etat: active({ tours: 4, maxTours: 5 }) }).continuer, true);
  });

  test('ordre des raisons : inactive, interrompu, pause, quota, plafond, puis fin du travail', () => {
    const tout = { reason: 'aborted', pause: true, quotaCritique: true, etat: active({ tours: 60 }), lignes: [] };
    assert.equal(decide(tout).motif, 'interrompu');
    assert.equal(decide({ ...tout, reason: 'answer' }).motif, 'pause');
    assert.equal(decide({ ...tout, reason: 'answer', pause: false }).motif, 'quota');
    assert.equal(decide({ ...tout, reason: 'answer', pause: false, quotaCritique: false }).motif, 'plafond');
    assert.equal(decide({ ...tout, reason: 'answer', pause: false, quotaCritique: false, etat: active() }).motif, 'termine');
    assert.equal(decide({ ...tout, etat: vide() }).motif, 'inactive');
  });

  test('le texte de continuation dit la ligne, ce qui reste, les règles, et le rang de l enchaînement', () => {
    const t = N.texteContinuation({ ligne: { id: 'C-0007', texte: 'Travail 7' }, restantes: 3, tours: 4, maxTours: 60 });
    assert.equal(t, 'NUIT : L\'utilisateur est absent. Continue sans l\'attendre avec la ligne suivante de ta liste de travail : C-0007 « Travail 7 ». Il reste 3 lignes ouvertes pour cette conversation. Vérifie d\'abord dans le code si elle est déjà faite ; si oui, ferme-la sur preuve. Ne pose aucune question : l\'outil de questions sera refusé et ta question notée en boîte pour son réveil, alors choisis l\'option la plus sûre et réversible. Aucun push, aucun déploiement sans son ordre. (enchaînement 4 sur 60)');
    assert.ok(N.texteContinuation({ ligne: { id: 'C-0007', texte: 'x' }, restantes: 1, tours: 1, maxTours: 60 }).includes('Il reste 1 ligne ouverte pour cette conversation.'));
    assert.ok(sansTiretLong(t));
    assert.ok(t.startsWith(N.PREFIXE_CONTINUATION));
  });
});

describe('textes : durée, statut, boîte, récap', () => {
  const ajout = (boite, extra = {}) => N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom ?', maintenant: T0, ...extra }).boite;
  const finie = (extra = {}) => ({ ...N.desactiver(active({ tours: 14, refus: { question: 3, garde: 5, action: 1 }, ...extra }), T0 + (7 * 60 + 22) * MIN) });

  test('la durée se dit en heures et minutes', () => {
    assert.equal(N.texteDuree(30 * 1000), 'moins d\'une minute');
    assert.equal(N.texteDuree(MIN), '1 min');
    assert.equal(N.texteDuree(45 * MIN), '45 min');
    assert.equal(N.texteDuree(60 * MIN), '1 h');
    assert.equal(N.texteDuree(65 * MIN), '1 h 05 min');
    assert.equal(N.texteDuree((7 * 60 + 22) * MIN), '7 h 22 min');
    assert.equal(N.texteDuree(26 * 60 * MIN), '26 h');
    for (const x of [-1, NaN, undefined, 'x', Infinity]) assert.equal(N.texteDuree(x), 'durée inconnue', String(x));
  });

  test('le statut d une nuit active dit le mode, la durée, les enchaînements et la boîte', () => {
    const boite = ajout(ajout(N.boiteParDefaut()), { titre: 'Autre ?' });
    const t = N.texteStatut(active({ tours: 14 }), boite, T0 + 130 * MIN);
    assert.equal(t, 'Nuit : active (nuit) depuis 2 h 10 min, 14 enchaînements sur 60, 2 à décider en boîte.');
    assert.equal(N.texteStatut(N.activer(vide(), { mode: 'absence', maintenant: T0 }), N.boiteParDefaut(), T0 + 5 * MIN), 'Nuit : active (absence de l\'utilisateur) depuis 5 min, 0 enchaînement sur 60, 0 à décider en boîte.');
    assert.ok(N.texteStatut(active({ tours: 1 }), N.boiteParDefaut(), T0).includes('1 enchaînement sur 60'));
  });

  test('le statut d une nuit active dit pourquoi l enchaînement s est arrêté', () => {
    const t = N.texteStatut(active({ arret: 'quota' }), N.boiteParDefaut(), T0 + MIN);
    assert.ok(t.endsWith(' Enchaînement arrêté : le Garde-quota a atteint son seuil critique.'), t);
  });

  test('le statut d une nuit inactive dit la détection d absence et comment la régler', () => {
    assert.equal(N.texteStatut(vide(), N.boiteParDefaut(), T0), 'Nuit : inactive. Détection d\'absence : après 60 min sans message de l\'utilisateur (réglable : /nuit absence <minutes> ou /nuit absence off). 0 à décider en boîte.');
    const eteinte = N.texteStatut(N.normaliserEtat({ absenceMinutes: null }), ajout(N.boiteParDefaut()), T0);
    assert.equal(eteinte, 'Nuit : inactive. Détection d\'absence : désactivée (/nuit absence <minutes> pour l\'activer). 1 à décider en boîte.');
  });

  test('le récap d une nuit finie dit la durée, les enchaînements, les lignes, les refus et la boîte', () => {
    const boite = ajout(ajout(N.boiteParDefaut(), { options: [{ label: 'Veilleur (Recommended)' }, { label: 'Nuit' }] }), { type: 'action', titre: 'Commande en attente d\'accord : git push', options: [] });
    const t = N.texteRecap(finie({ lignesAuDebut: 11 }), boite, { maintenant: T0 + 600 * MIN, lignesMaintenant: 7 });
    assert.equal(t, [
      'NUIT : récap.',
      'Durée : 7 h 22 min (nuit). 14 enchaînements sur 60 au plus.',
      'Lignes ouvertes : 11 au coucher, 7 maintenant.',
      'Refus pendant l\'absence : 3 questions mises en boîte, 5 arrêts de garde transformés en refus, 1 commande en attente d\'accord.',
      'À décider (2) :',
      '1. [question] Quel nom ? Options : Veilleur (Recommended) ; Nuit',
      '2. [action] Commande en attente d\'accord : git push',
    ].join('\n'));
    assert.ok(sansTiretLong(t));
  });

  test('le récap d une nuit en cours compte la durée jusqu à maintenant', () => {
    const t = N.texteRecap(active({ tours: 2 }), N.boiteParDefaut(), { maintenant: T0 + 90 * MIN, lignesMaintenant: null });
    assert.ok(t.startsWith('NUIT : récap (nuit en cours).\nDurée : 1 h 30 min (nuit). 2 enchaînements sur 60 au plus.'), t);
    assert.ok(!t.includes('Lignes ouvertes'), 'sans nombre de lignes, la ligne est omise');
  });

  test('le récap dit pourquoi l enchaînement s est arrêté', () => {
    const phrase = (arret, extra = {}) => N.texteRecap(finie({ arret, ...extra }), N.boiteParDefaut(), { maintenant: T0 }).split('\n').find(l => l.startsWith('Enchaînement arrêté'));
    assert.equal(phrase('plafond', { maxTours: 14 }), 'Enchaînement arrêté : le plafond de 14 enchaînements est atteint.');
    assert.equal(phrase('termine'), 'Enchaînement arrêté : toutes les lignes ouvertes de cette conversation sont traitées.');
    assert.equal(phrase('pause'), 'Enchaînement arrêté : le Régulateur d\'agents est en pause.');
    assert.equal(phrase('quota'), 'Enchaînement arrêté : le Garde-quota a atteint son seuil critique.');
    assert.equal(phrase('repetition'), 'Enchaînement arrêté : les lignes restantes n\'avançaient pas : elles ont été laissées de côté.');
    assert.equal(phrase(null), undefined);
  });

  test('le récap sans refus et sans boîte le dit', () => {
    const t = N.texteRecap(finie({ refus: { question: 0, garde: 0, action: 0 } }), N.boiteParDefaut(), { maintenant: T0 });
    assert.ok(t.includes('Aucun refus pendant l\'absence.'), t);
    assert.ok(t.endsWith('Rien à décider en boîte.'), t);
  });

  test('le récap singulier : une question, un arrêt, une commande', () => {
    const t = N.texteRecap(finie({ refus: { question: 1, garde: 1, action: 1 } }), N.boiteParDefaut(), { maintenant: T0 });
    assert.ok(t.includes('1 question mise en boîte, 1 arrêt de garde transformé en refus, 1 commande en attente d\'accord.'), t);
  });

  test('sans nuit enregistrée, le récap le dit, et montre quand même la boîte', () => {
    const t = N.texteRecap(vide(), ajout(N.boiteParDefaut()), { maintenant: T0 });
    assert.ok(t.startsWith('NUIT : récap.\nAucune nuit enregistrée.'), t);
    assert.ok(t.includes('À décider (1) :'), t);
    assert.ok(!t.includes('Durée'), t);
  });

  test('le récap ne liste que dix entrées et renvoie à la boîte pour les autres', () => {
    let boite = N.boiteParDefaut();
    for (let i = 1; i <= 12; i++) boite = ajout(boite, { titre: `Question ${i}`, maintenant: T0 + i * MIN });
    const t = N.texteRecap(finie(), boite, { maintenant: T0 });
    assert.ok(t.includes('À décider (12) :'), t);
    assert.ok(t.includes('10. [question] Question 10'), t);
    assert.ok(!t.includes('11. [question]'), t);
    assert.ok(t.endsWith('Et 2 autres : /nuit boite.'), t);
  });

  test('la boîte complète montre les entrées à décider puis les traitées, avec leur réponse', () => {
    let boite = ajout(ajout(ajout(N.boiteParDefaut(), { titre: 'A ?' }), { titre: 'B ?' }), { titre: 'C ?' });
    boite = N.repondre(boite, 1, 'Option A', T0 + MIN).boite;
    boite = N.ecarter(boite, 3, T0 + 2 * MIN).boite;
    assert.equal(N.texteBoite(boite), [
      'Boîte de la nuit : 1 à décider, 2 traitées.',
      '2. [question] B ?',
      '1. [question] A ? (répondue : Option A)',
      '3. [question] C ? (écartée)',
    ].join('\n'));
    assert.equal(N.texteBoite(N.boiteParDefaut()), 'Boîte de la nuit : vide.');
    assert.equal(N.texteBoite(ajout(N.boiteParDefaut())), 'Boîte de la nuit : 1 à décider, 0 traitée.\n1. [question] Quel nom ?');
  });
});

describe('commande /nuit', () => {
  const USAGE = 'Usage : /nuit [on | off | statut | recap | boite | absence <minutes 1 à 1440> | absence off | tours <1 à 500> | repondre <n°> <réponse> | ecarter <n°> | defaut]';
  const avecQuestion = () => N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom ?', options: [{ label: 'A' }], maintenant: T0 }).boite;
  const cmd = (args, { etat = vide(), boite = N.boiteParDefaut(), maintenant = T0 + 10 * MIN, lignesOuvertes = 5 } = {}) => N.analyserCommande(args, etat, boite, { maintenant, lignesOuvertes });

  // Test ajouté par le réalignement des mutations : la mutation nuit-commande-repondre-reponse survivait.
  test('repondre : la réponse rendue est celle gardée en boîte, espaces réduits, pas le texte tapé', () => {
    const r = cmd('  repondre   1   Le   Veilleur  ', { boite: avecQuestion() });
    assert.equal(r.reponse.texte, 'Le Veilleur');
    assert.equal(r.reponse.entree.reponse, 'Le Veilleur');
    assert.equal(r.boite.entrees[0].reponse, 'Le Veilleur');
  });

  test('sans argument, ou statut : l état en une ligne, rien ne change', () => {
    for (const args of ['', '   ', undefined, null, 'statut', 'STATUT', 'etat', 'état']) {
      const r = cmd(args);
      assert.equal(r.erreur, undefined, String(args));
      assert.equal(r.message, N.texteStatut(vide(), N.boiteParDefaut(), T0 + 10 * MIN), String(args));
      assert.deepEqual([r.etat, r.boite, r.effet], [vide(), N.boiteParDefaut(), null], String(args));
    }
  });

  test('on commence la nuit, avec le nombre de lignes ouvertes du moment', () => {
    const r = cmd('on');
    assert.equal(r.etat.actif, true);
    assert.equal(r.etat.mode, 'nuit');
    assert.equal(r.etat.depuis, iso(T0 + 10 * MIN));
    assert.equal(r.etat.lignesAuDebut, 5);
    assert.equal(r.effet, 'active');
    assert.equal(r.message, 'Nuit : active. Les questions bloquantes iront en boîte, les arrêts de garde deviendront des refus avec alternative, et le travail continue sur les lignes ouvertes de cette conversation. Elle prend fin à ton prochain message ou avec /nuit off.');
    assert.ok(sansTiretLong(r.message));
    assert.equal(cmd('  ON ').etat.actif, true, 'casse et espaces');
  });

  test('on pendant une nuit active ne la recommence pas', () => {
    const etat = active({ tours: 4 });
    const r = cmd('on', { etat, maintenant: T0 + 90 * MIN });
    assert.equal(r.message, 'Nuit : déjà active depuis 1 h 30 min.');
    assert.deepEqual([r.etat, r.effet], [etat, null]);
  });

  test('on sans instant lisible dit que rien n a changé', () => {
    assert.deepEqual(cmd('on', { maintenant: NaN }), { erreur: 'Nuit : instant illisible, rien n\'a changé.' });
    assert.deepEqual(cmd('off', { etat: active(), maintenant: NaN }), { erreur: 'Nuit : instant illisible, rien n\'a changé.' });
  });

  test('off met fin à la nuit et rend le récap', () => {
    const etat = active({ tours: 3, refus: { question: 1, garde: 0, action: 0 } });
    const boite = avecQuestion();
    const r = cmd('off', { etat, boite, maintenant: T0 + 130 * MIN, lignesOuvertes: 4 });
    assert.equal(r.etat.actif, false);
    assert.equal(r.etat.fin, iso(T0 + 130 * MIN));
    assert.equal(r.effet, 'reveil');
    assert.equal(r.message, N.texteRecap(r.etat, boite, { maintenant: T0 + 130 * MIN, lignesMaintenant: 4 }));
    assert.ok(r.message.includes('Lignes ouvertes : 5 au coucher, 4 maintenant.'));
  });

  test('off sans nuit active le dit', () => {
    const r = cmd('off');
    assert.equal(r.message, 'Nuit : déjà inactive.');
    assert.deepEqual([r.etat, r.effet], [vide(), null]);
  });

  test('recap et boite montrent sans rien changer', () => {
    const boite = avecQuestion();
    const etat = active();
    const rec = cmd('recap', { etat, boite, maintenant: T0 + 60 * MIN, lignesOuvertes: 2 });
    assert.equal(rec.message, N.texteRecap(etat, boite, { maintenant: T0 + 60 * MIN, lignesMaintenant: 2 }));
    assert.deepEqual([rec.etat, rec.boite, rec.effet], [etat, boite, null]);
    const b = cmd('boite', { boite });
    assert.equal(b.message, N.texteBoite(boite));
    assert.deepEqual([b.boite, b.effet], [boite, null]);
  });

  test('absence règle le délai de la détection, off l éteint', () => {
    const r = cmd('absence 90');
    assert.equal(r.etat.absenceMinutes, 90);
    assert.equal(r.message, 'Détection d\'absence : la nuit commence quand l\'utilisateur n\'écrit plus depuis 90 min.');
    assert.equal(cmd('absence 1').etat.absenceMinutes, 1);
    assert.equal(cmd('absence 1440').etat.absenceMinutes, 1440);
    const eteinte = cmd('absence off');
    assert.equal(eteinte.etat.absenceMinutes, null);
    assert.equal(eteinte.message, 'Détection d\'absence désactivée : seule la commande /nuit on commence une nuit.');
    assert.equal(cmd('absence OFF').etat.absenceMinutes, null);
    for (const args of ['absence', 'absence 0', 'absence 1441', 'absence x', 'absence 1.5', 'absence -5', 'absence 60 min', 'absence 05x']) {
      assert.deepEqual(cmd(args), { erreur: USAGE }, args);
    }
  });

  test('tours règle le plafond d enchaînements', () => {
    const r = cmd('tours 20');
    assert.equal(r.etat.maxTours, 20);
    assert.equal(r.message, 'Plafond d\'enchaînements : 20 par nuit.');
    assert.equal(cmd('tours 1').etat.maxTours, 1);
    assert.equal(cmd('tours 500').etat.maxTours, 500);
    for (const args of ['tours', 'tours 0', 'tours 501', 'tours x', 'tours 2.5', 'tours 10 20']) assert.deepEqual(cmd(args), { erreur: USAGE }, args);
  });

  test('un réglage ne touche ni à la nuit en cours ni à la boîte', () => {
    const etat = active({ tours: 4 });
    const boite = avecQuestion();
    const r = cmd('absence 120', { etat, boite });
    assert.deepEqual({ ...r.etat, absenceMinutes: 60 }, etat);
    assert.deepEqual(r.boite, boite);
  });

  test('repondre note la réponse et la rend pour être transmise au modèle', () => {
    const r = cmd('repondre 1   Option   A   retenue', { boite: avecQuestion() });
    assert.equal(r.erreur, undefined);
    assert.equal(r.message, 'Boîte : réponse notée pour la question n° 1.');
    assert.equal(r.effet, 'reponse');
    assert.equal(r.boite.entrees[0].statut, 'repondue');
    assert.equal(r.reponse.id, 1);
    assert.equal(r.reponse.texte, 'Option A retenue');
    assert.equal(r.reponse.entree.titre, 'Quel nom ?');
  });

  test('repondre garde la casse de la réponse', () => {
    assert.equal(cmd('REPONDRE 1 Oui, VEILLEUR', { boite: avecQuestion() }).reponse.texte, 'Oui, VEILLEUR');
  });

  test('repondre dit pourquoi c est impossible', () => {
    const boite = avecQuestion();
    assert.deepEqual(cmd('repondre 9 x', { boite }), { erreur: 'Boîte : question n° 9 introuvable.' });
    assert.deepEqual(cmd('repondre 1', { boite }), { erreur: 'Boîte : la réponse est vide.' });
    assert.deepEqual(cmd('repondre', { boite }), { erreur: USAGE });
    assert.deepEqual(cmd('repondre x oui', { boite }), { erreur: USAGE });
    assert.deepEqual(cmd('repondre 1.5 oui', { boite }), { erreur: USAGE });
    const traitee = cmd('repondre 1 oui', { boite }).boite;
    assert.deepEqual(cmd('repondre 1 non', { boite: traitee }), { erreur: 'Boîte : la question n° 1 est déjà traitée.' });
  });

  test('ecarter retire la question de celles à décider', () => {
    const r = cmd('ecarter 1', { boite: avecQuestion() });
    assert.equal(r.message, 'Boîte : question n° 1 écartée.');
    assert.equal(r.effet, 'ecartee');
    assert.equal(r.boite.entrees[0].statut, 'ecartee');
    assert.deepEqual(cmd('ecarter 5', { boite: avecQuestion() }), { erreur: 'Boîte : question n° 5 introuvable.' });
    assert.deepEqual(cmd('ecarter', { boite: avecQuestion() }), { erreur: USAGE });
    assert.deepEqual(cmd('ecarter 1 2', { boite: avecQuestion() }), { erreur: USAGE });
    assert.deepEqual(cmd('ecarter x', { boite: avecQuestion() }), { erreur: USAGE });
  });

  test('defaut remet les réglages sans toucher à la nuit ni à la boîte', () => {
    const etat = active({ maxTours: 10, absenceMinutes: 5, tours: 2 });
    const boite = avecQuestion();
    const r = cmd('defaut', { etat, boite });
    assert.equal(r.message, 'Réglages de la nuit remis aux valeurs par défaut (absence après 60 min, 60 enchaînements au plus).');
    assert.deepEqual([r.etat.maxTours, r.etat.absenceMinutes, r.etat.actif, r.etat.tours], [60, 60, true, 2]);
    assert.deepEqual(r.boite, boite);
    assert.deepEqual(cmd('defaut x'), { erreur: USAGE });
  });

  test('une commande inconnue ou un argument en trop donne l usage', () => {
    for (const args of ['demain', 'on off', 'statut x', 'recap x', 'boite x', 'off x', 'on x']) assert.deepEqual(cmd(args), { erreur: USAGE }, args);
  });

  test('la commande ne modifie ni l état ni la boîte reçus', () => {
    const etat = active();
    const boite = avecQuestion();
    const e0 = JSON.parse(JSON.stringify(etat));
    const b0 = JSON.parse(JSON.stringify(boite));
    for (const args of ['on', 'off', 'absence 5', 'tours 5', 'repondre 1 x', 'ecarter 1', 'defaut']) N.analyserCommande(args, etat, boite, { maintenant: T0 });
    assert.deepEqual([etat, boite], [e0, b0]);
  });
});

describe('bornes exactes', () => {
  const entreeBrute = (extra = {}) => ({ id: 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'q', ...extra });
  const un = extra => N.normaliserBoite({ entrees: [entreeBrute(extra)] }).entrees;
  const tronque = (lettre, n) => `${lettre.repeat(n - 3)}...`;

  test('un texte de la largeur exacte est gardé tel quel, un caractère de plus le tronque', () => {
    assert.equal(un({ titre: 'x'.repeat(240) })[0].titre, 'x'.repeat(240));
    assert.equal(un({ titre: 'x'.repeat(241) })[0].titre, tronque('x', 240));
    assert.equal(un({ details: 'd'.repeat(5000) })[0].details, 'd'.repeat(5000));
    assert.equal(un({ details: 'd'.repeat(5001) })[0].details, tronque('d', 5000));
    assert.equal(un({ options: [{ label: 'l'.repeat(80) }] })[0].options[0].label, 'l'.repeat(80));
    assert.equal(un({ options: [{ label: 'l'.repeat(81) }] })[0].options[0].label, tronque('l', 80));
    assert.equal(un({ options: [{ label: 'l', description: 'd'.repeat(120) }] })[0].options[0].description, 'd'.repeat(120));
    assert.equal(un({ options: [{ label: 'l', description: 'd'.repeat(121) }] })[0].options[0].description, tronque('d', 120));
    assert.equal(un({ statut: 'repondue', traite: iso(T0), reponse: 'r'.repeat(600) })[0].reponse, 'r'.repeat(600));
    assert.equal(un({ statut: 'repondue', traite: iso(T0), reponse: 'r'.repeat(601) })[0].reponse, tronque('r', 600));
  });

  test('six options au plus : la septième est écartée', () => {
    const options = Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` }));
    assert.deepEqual(un({ options })[0].options.map(o => o.label), ['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
    assert.equal(un({ options: options.slice(0, 6) })[0].options.length, 6);
  });

  test('la session va de un à cent vingt-huit caractères, l agent de un à trente-deux', () => {
    assert.equal(un({ session: 'x'.repeat(128) }).length, 1);
    assert.equal(un({ session: 'x'.repeat(129) }).length, 0);
    assert.equal(un({ session: 'x' }).length, 1);
    assert.equal(un({ agent: `a${'b'.repeat(31)}` }).length, 1);
    assert.equal(un({ agent: `a${'b'.repeat(32)}` }).length, 0);
    assert.equal(un({ agent: 'a' }).length, 1);
    assert.equal(un({ agent: '1a' }).length, 0);
    assert.equal(un({ agent: 'a-b1' }).length, 1);
  });

  test('un identifiant de ligne doit être exactement C- suivi de chiffres', () => {
    for (const derniereLigne of ['C-0866x', 'XC-0866', ' C-0866', 'C-0866 ', 'c-0866', 'C--1']) {
      assert.equal(N.normaliserEtat({ derniereLigne }).derniereLigne, null, derniereLigne);
      assert.deepEqual(N.normaliserEtat({ sautees: [derniereLigne] }).sautees, [], derniereLigne);
    }
    assert.equal(N.normaliserEtat({ derniereLigne: 'C-7' }).derniereLigne, 'C-7');
  });

  test('un titre de question, un titre de commande, une raison et une ligne ont leur largeur exacte', () => {
    assert.equal(N.questionsDeOutil({ questions: [{ question: 'q'.repeat(240) }] }).titre, 'q'.repeat(240));
    assert.equal(N.questionsDeOutil({ questions: [{ question: 'q'.repeat(241) }] }).titre, tronque('q', 240));
    assert.equal(N.actionDeGarde({ commande: 'c'.repeat(160) }).titre, `Commande en attente d'accord : ${'c'.repeat(160)}`);
    assert.equal(N.actionDeGarde({ commande: 'c'.repeat(161) }).titre, `Commande en attente d'accord : ${tronque('c', 160)}`);
    assert.equal(N.actionDeGarde({ raison: 'r'.repeat(600) }).details, 'r'.repeat(600));
    assert.equal(N.actionDeGarde({ raison: 'r'.repeat(601) }).details, tronque('r', 600));
    assert.equal(N.analyserSortieGarde({ continue: false, stopReason: 'r'.repeat(600) }).raison, 'r'.repeat(600));
    assert.equal(N.analyserSortieGarde({ continue: false, stopReason: 'r'.repeat(601) }).raison, tronque('r', 600));
    assert.ok(N.texteRefusGarde({ genre: 'bloc', raison: 'x'.repeat(300) }).includes(`(${'x'.repeat(300)})`));
    assert.ok(N.texteRefusGarde({ genre: 'bloc', raison: 'x'.repeat(301) }).includes(`(${tronque('x', 300)})`));
    const ligne = n => ({ id: 'C-0001', texte: 't'.repeat(n), statut: 'ouvert', session: 'S1' });
    const choisie = n => N.decisionContinuation({ etat: active(), reason: 'answer', lignes: [ligne(n)], session: 'S1' }).ligne.texte;
    assert.equal(choisie(160), 't'.repeat(160));
    assert.equal(choisie(161), tronque('t', 160));
  });

  test('la boîte garde cinquante entrées, la liste de lignes sautées cinquante identifiants', () => {
    const entrees = Array.from({ length: 51 }, (_, i) => entreeBrute({ id: i + 1, titre: `q${i + 1}` }));
    assert.equal(N.normaliserBoite({ entrees }).entrees.length, 50);
    assert.equal(N.normaliserBoite({ entrees: entrees.slice(0, 50) }).entrees.length, 50);
    const lignes = Array.from({ length: 51 }, (_, i) => `C-${String(i + 1).padStart(4, '0')}`);
    assert.equal(N.normaliserEtat({ sautees: lignes }).sautees.length, 50);
    assert.equal(N.normaliserEtat({ sautees: lignes.slice(0, 50) }).sautees.length, 50);
  });

  test('la liste du récap garde dix entrées exactement : la onzième ouvre la ligne « Et N autres »', () => {
    let boite = N.boiteParDefaut();
    for (let i = 1; i <= 11; i++) boite = N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: `Question ${i}`, maintenant: T0 + i * MIN }).boite;
    const t = N.texteRecap(vide(), boite, { maintenant: T0 });
    assert.ok(t.endsWith('Et 1 autre : /nuit boite.'), t);
    assert.ok(!N.texteRecap(vide(), N.normaliserBoite({ prochain: 11, entrees: boite.entrees.slice(0, 10) }), { maintenant: T0 }).includes('Et '));
  });

  test('le plafond de tours 500 et le délai d absence 1440 sont les dernières valeurs acceptées par les commandes', () => {
    assert.equal(N.analyserCommande('tours 500', vide(), N.boiteParDefaut(), { maintenant: T0 }).etat.maxTours, 500);
    assert.ok(N.analyserCommande('tours 501', vide(), N.boiteParDefaut(), { maintenant: T0 }).erreur);
    assert.equal(N.analyserCommande('absence 1440', vide(), N.boiteParDefaut(), { maintenant: T0 }).etat.absenceMinutes, 1440);
    assert.ok(N.analyserCommande('absence 1441', vide(), N.boiteParDefaut(), { maintenant: T0 }).erreur);
  });
});

describe('cas limites relevés par les mutations', () => {
  const entree = (extra = {}) => ({ id: 1, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'q', ...extra });
  const un = extra => N.normaliserBoite({ entrees: [entree(extra)] }).entrees;
  const id = n => `C-${String(n).padStart(4, '0')}`;
  const ligne = (n, extra = {}) => ({ id: id(n), texte: `Travail ${n}`, statut: 'ouvert', session: 'S1', ...extra });
  const decide = (extra = {}) => N.decisionContinuation({ etat: active(), reason: 'answer', lignes: [ligne(1), ligne(2), ligne(3)], session: 'S1', pause: false, quotaCritique: false, ...extra });
  const cmd = (args, { etat = vide(), boite = N.boiteParDefaut(), maintenant = T0 + 10 * MIN, lignesOuvertes = 5 } = {}) => N.analyserCommande(args, etat, boite, { maintenant, lignesOuvertes });
  const avecQuestion = () => N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom ?', maintenant: T0 }).boite;
  // Les alternatives, mot pour mot.
  const ALT = {
    suppression: 'Ne supprime pas en récursif depuis le shell : laisse le dossier en place, note-le pour le réveil de l\'utilisateur, et passe à une autre ligne ouverte.',
    checklist: "Fais réellement l'action de la checklist (migration appliquée, variable posée, fonction déployée, cron actif), confirme-la avec checklist-confirmer.js, puis relance le même commit ; sans action possible, laisse le commit pour le réveil.",
    noVerify: 'Ne contourne pas les hooks de git : corrige la cause de leur échec, puis recommence le commit.',
    force: "Ne force pas le push : aucun push n'est fait sans l'ordre de l'utilisateur, garde le commit en local.",
    reset: 'Ne jette pas de modifications : utilise git stash, ou git restore limité aux fichiers voulus.',
    sauvegarde: 'Ne supprime et ne renomme jamais une branche protégée : travaille sur une autre branche.',
    wrangler: "Ne déploie pas sans l'ordre de l'utilisateur ; si ce déploiement est demandé, ajoute --keep-vars.",
    push: "Aucun push ni déploiement sans l'ordre explicite de l'utilisateur : garde le travail en local et continue sans pousser.",
    generale: "Cherche une autre voie qui respecte la règle ; s'il n'y en a pas, note la demande et passe à une autre ligne ouverte.",
  };

  test('un identifiant de ligne est un texte : un tableau qui s écrit comme lui ne passe pas', () => {
    assert.equal(N.normaliserEtat({ derniereLigne: ['C-0866'] }).derniereLigne, null);
    assert.deepEqual(N.normaliserEtat({ sautees: [['C-0001'], 5, null, { toString: () => 'C-0002' }] }).sautees, []);
    assert.equal(decide({ lignes: [ligne(1, { id: ['C-0099'] }), ligne(2)] }).ligne.id, 'C-0002');
  });

  test('le nombre de lignes ouvertes est un entier positif ou nul, ou inconnu', () => {
    for (const lignesAuDebut of ['5', 2.5, -1, null, undefined]) assert.equal(N.normaliserEtat({ lignesAuDebut }).lignesAuDebut, null, String(lignesAuDebut));
    for (const lignesOuvertes of ['5', 2.5, -1, null, undefined]) assert.equal(N.activer(vide(), { maintenant: T0, lignesOuvertes }).lignesAuDebut, null, String(lignesOuvertes));
    assert.equal(N.activer(vide(), { maintenant: T0, lignesOuvertes: 0 }).lignesAuDebut, 0);
  });

  test('désactiver sans instant lisible ne change rien', () => {
    for (const maintenant of [NaN, undefined, 'x']) assert.deepEqual(N.desactiver(active(), maintenant), active(), String(maintenant));
  });

  test('une entrée traitée sans sa réponse ou sans sa date redevient à décider', () => {
    assert.equal(un({ statut: 'repondue', traite: iso(T0), reponse: '   ' })[0].statut, 'en-attente');
    assert.equal(un({ statut: 'repondue', traite: iso(T0), reponse: undefined })[0].statut, 'en-attente');
    assert.equal(un({ statut: 'ecartee' })[0].statut, 'en-attente');
    assert.equal(un({ statut: 'ecartee', traite: 'hier' })[0].statut, 'en-attente');
  });

  test('répondre et écarter gardent le prochain identifiant de la boîte', () => {
    const b = N.normaliserBoite({ prochain: 10, entrees: [entree()] });
    assert.equal(N.repondre(b, 1, 'x', T0).boite.prochain, 10);
    assert.equal(N.ecarter(b, 1, T0).boite.prochain, 10);
  });

  test('les détails de plusieurs questions vont jusqu à six cents caractères', () => {
    const q = Array.from({ length: 8 }, (_, i) => ({ question: String(i).repeat(100) }));
    const long = N.questionsDeOutil({ questions: q }).details;
    assert.equal(long.length, 600);
    assert.ok(long.endsWith('...'));
    assert.equal(N.questionsDeOutil({ questions: q.slice(0, 4) }).details.length, 409, 'quatre questions de cent caractères et trois séparateurs');
  });

  test('l option recommandée est marquée à la fin du libellé, pas au milieu', () => {
    assert.equal(N.optionRecommandee([{ label: 'Garder (Recommended) tel quel' }]), null);
    assert.equal(N.optionRecommandee([{ label: 'Garder (Recommended)  ' }]), 'Garder');
  });

  test('le refus de la question est exactement ce texte, avec ou sans option recommandée', () => {
    const options = [{ label: 'Veilleur (Recommended)' }, { label: 'Nuit' }];
    assert.equal(N.texteRefusQuestion({ id: 4, enAttente: 2, options }), 'NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse. Elle est notée en boîte (n° 4, 2 à décider au réveil). Ne la repose pas. Choisis toi-même l\'option la plus sûre et réversible (de préférence « Veilleur », marquée recommandée), note ce choix et ses raisons dans le fichier contexte, puis continue. Si la suite dépend vraiment de cette réponse, passe à une autre ligne ouverte de ta liste de travail.');
    assert.equal(N.texteRefusQuestion({ id: 1, enAttente: 1, options: [{ label: 'A' }] }), 'NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse. Elle est notée en boîte (n° 1, 1 à décider au réveil). Ne la repose pas. Choisis toi-même l\'option la plus sûre et réversible, note ce choix et ses raisons dans le fichier contexte, puis continue. Si la suite dépend vraiment de cette réponse, passe à une autre ligne ouverte de ta liste de travail.');
  });

  test('un numéro de boîte qui n est pas un entier positif n est pas annoncé', () => {
    for (const numero of ['3', 0, -1, 1.5, null, undefined]) {
      assert.ok(N.texteRefusQuestion({ id: numero, enAttente: 1 }).includes('La boîte n\'a pas pu la noter'), String(numero));
      assert.ok(!N.texteRefusGarde({ genre: 'ask', raison: 'git push detecte', id: numero }).includes('boîte'), String(numero));
    }
  });

  test('chaque alternative du garde est exactement son texte, et le motif suffit', () => {
    const cas = [
      ['Suppression récursive forcée détectée', ALT.suppression], ['Suppression récursive Windows détectée', ALT.suppression], ['git clean avec -f détecté', ALT.suppression],
      ['COMMIT REFUSE', ALT.checklist], ['rappel avant commit', ALT.checklist],
      ['Option de saut des vérifications de git détectée', ALT.noVerify], ['--no-verify detecte', ALT.noVerify], ['Poussée forcée détectée', ALT.force], ['Force push detecte', ALT.force], ['git reset --hard détecté', ALT.reset],
      ['Suppression ou renommage d une branche protégée', ALT.sauvegarde], ['wrangler deploy sans --keep-vars', ALT.wrangler],
      ['git push détecté', ALT.push], ['Déploiement de production', ALT.push], ['--prod détecté', ALT.push],
      ['rien de connu', ALT.generale], ['', ALT.generale], [undefined, ALT.generale], [null, ALT.generale], [5, ALT.generale],
    ];
    for (const [raison, attendu] of cas) assert.equal(N.alternativePourGarde(raison), attendu, String(raison));
  });

  test('plusieurs motifs : les alternatives dans l ordre de la table, séparées d un espace, sans la voie générale', () => {
    const t = N.alternativePourGarde('Force push detecte | --no-verify detecte | git push detecte');
    assert.equal(t, `${ALT.noVerify} ${ALT.force} ${ALT.push}`);
    assert.ok(!t.includes(ALT.generale));
  });

  test('les motifs sont cherchés sans tenir compte de la casse', () => {
    assert.equal(N.alternativePourGarde('FORCE PUSH DETECTE'), ALT.force);
    assert.equal(N.alternativePourGarde('GIT RESET --HARD'), ALT.reset);
  });

  test('le refus du garde est exactement ce texte, et l alternative est cherchée dans la raison entière', () => {
    assert.equal(N.texteRefusGarde({ genre: 'ask', raison: 'git push detecte', id: 3 }), `NUIT : cette commande demande l'accord de l'utilisateur (git push detecte). Il est absent : elle n'est pas lancée. ${ALT.push} La demande est notée en boîte (n° 3) : il l'autorisera ou la refusera à son réveil.`);
    assert.equal(N.texteRefusGarde({ genre: 'ask', raison: 'git push detecte' }), `NUIT : cette commande demande l'accord de l'utilisateur (git push detecte). Il est absent : elle n'est pas lancée. ${ALT.push}`);
    assert.equal(N.texteRefusGarde({ genre: 'bloc', raison: '--no-verify detecte' }), `NUIT : le garde de sécurité refuse cette commande (--no-verify detecte). L'utilisateur est absent : ne t'arrête pas, change de voie. ${ALT.noVerify}`);
    const longue = `${'x'.repeat(400)} Force push detecte`;
    assert.ok(N.texteRefusGarde({ genre: 'bloc', raison: longue }).endsWith(ALT.force));
  });

  test('les lignes sont triées par numéro, pas par ordre alphabétique', () => {
    const lignes = [ligne(100), ligne(10), ligne(9)];
    const d = decide({ lignes });
    assert.equal(d.ligne.id, 'C-0009');
    assert.equal(N.decisionContinuation({ etat: active({ derniereLigne: 'C-0009', repetition: 3 }), reason: 'answer', lignes, session: 'S1' }).ligne.id, 'C-0010');
    assert.equal(N.decisionContinuation({ etat: active(), reason: 'answer', lignes: [{ id: 'C-9', texte: 'a', statut: 'ouvert', session: 'S1' }, { id: 'C-10', texte: 'b', statut: 'ouvert', session: 'S1' }], session: 'S1' }).ligne.id, 'C-9');
  });

  test('seul true arrête pour la pause ou le quota : une valeur approchante ne bloque pas la nuit', () => {
    for (const valeur of [1, 'oui', 'true', {}, []]) {
      assert.equal(decide({ pause: valeur }).continuer, true, `pause ${JSON.stringify(valeur)}`);
      assert.equal(decide({ quotaCritique: valeur }).continuer, true, `quota ${JSON.stringify(valeur)}`);
    }
  });

  test('la liste des lignes laissées de côté ne dépasse jamais cinquante identifiants', () => {
    const sautees = Array.from({ length: 50 }, (_, i) => id(1001 + i));
    const d = N.decisionContinuation({ etat: active({ sautees, derniereLigne: 'C-0001', repetition: 3 }), reason: 'answer', lignes: [ligne(1), ligne(2)], session: 'S1' });
    assert.equal(d.ligne.id, 'C-0002');
    assert.equal(d.etat.sautees.length, 50);
    assert.ok(!d.etat.sautees.includes('C-0001'), 'la cinquante et unième ne rentre pas');
  });

  test('quand toutes les lignes restantes ont déjà été laissées de côté, l arrêt est la répétition, pas la fin du travail', () => {
    const d = decide({ etat: active({ sautees: ['C-0001', 'C-0002', 'C-0003'] }) });
    assert.deepEqual([d.continuer, d.motif, d.etat.arret], [false, 'repetition', 'repetition']);
  });

  test('restantes ne compte ni les lignes déjà laissées de côté ni celle que ce tour laisse de côté', () => {
    assert.equal(decide({ etat: active({ sautees: ['C-0001'] }) }).restantes, 2);
    const d = decide({ etat: active({ derniereLigne: 'C-0001', repetition: 3 }) });
    assert.equal(d.ligne.id, 'C-0002');
    assert.equal(d.restantes, 2);
  });

  test('continuer remet l arrêt à zéro, et le texte dit le rang et le plafond réels', () => {
    const d = decide({ etat: active({ arret: 'pause', tours: 5, maxTours: 20 }) });
    assert.equal(d.etat.arret, null);
    assert.ok(d.texte.endsWith('(enchaînement 6 sur 20)'), d.texte);
    assert.ok(decide().texte.endsWith('(enchaînement 1 sur 60)'));
  });

  test('une durée nulle est moins d une minute, pas une durée inconnue', () => {
    assert.equal(N.texteDuree(0), 'moins d\'une minute');
  });

  test('le statut ne compte que les entrées à décider, et dit le plafond et le délai réels', () => {
    let boite = avecQuestion();
    boite = N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Autre ?', maintenant: T0 }).boite;
    boite = N.repondre(boite, 2, 'x', T0 + MIN).boite;
    assert.ok(N.texteStatut(vide(), boite, T0).endsWith(' 1 à décider en boîte.'));
    assert.ok(N.texteStatut(active({ maxTours: 20 }), boite, T0).includes(' sur 20, '));
    assert.ok(N.texteStatut(N.normaliserEtat({ absenceMinutes: 90 }), boite, T0).includes('après 90 min sans message'));
  });

  test('le récap dit le mode réel, le plafond réel, les lignes seulement si on les connaît, et les refus de chaque genre', () => {
    const absence = N.activer(vide(), { mode: 'absence', maintenant: T0, lignesOuvertes: 5, });
    assert.ok(N.texteRecap({ ...absence, maxTours: 20 }, N.boiteParDefaut(), { maintenant: T0 + MIN, lignesMaintenant: 0 }).includes('(absence de l\'utilisateur). 0 enchaînement sur 20 au plus.'));
    assert.ok(N.texteRecap(absence, N.boiteParDefaut(), { maintenant: T0 + MIN, lignesMaintenant: 0 }).includes('Lignes ouvertes : 5 au coucher, 0 maintenant.'), 'zéro ligne restante s affiche');
    const inconnu = N.activer(vide(), { mode: 'nuit', maintenant: T0 });
    assert.ok(!N.texteRecap(inconnu, N.boiteParDefaut(), { maintenant: T0 + MIN, lignesMaintenant: 3 }).includes('Lignes ouvertes'), 'sans nombre au coucher, rien');
    const actions = N.texteRecap({ ...absence, refus: { question: 0, garde: 0, action: 2 } }, N.boiteParDefaut(), { maintenant: T0 });
    assert.ok(actions.includes('2 commandes en attente d\'accord.'), actions);
    assert.ok(!actions.includes('Aucun refus'), actions);
  });

  test('la commande coupe les mots sur toute espace, tabulation et saut de ligne compris', () => {
    assert.equal(cmd('absence\t90').etat.absenceMinutes, 90);
    assert.equal(cmd('tours\n20').etat.maxTours, 20);
    assert.equal(cmd('repondre 1\tOui\nvolontiers', { boite: avecQuestion() }).reponse.texte, 'Oui volontiers');
  });

  test('la commande refuse une réponse trop longue sans la tronquer', () => {
    const boite = avecQuestion();
    const r = cmd(`repondre 1 ${'x'.repeat(700)}`, { boite });
    assert.deepEqual(r, { erreur: 'Boîte : la réponse dépasse 600 caractères.' });
    assert.equal(boite.entrees[0].statut, 'en-attente');
  });
});

describe('réponse de l\'utilisateur transmise au modèle', () => {
  const question = { id: 3, titre: 'Quel nom pour le module ?', type: 'question', reponse: 'Veilleur' };

  test('la réponse à une question dit le numéro, la question et la réponse', () => {
    assert.equal(N.texteReponse(question), 'NUIT : réponse de l\'utilisateur à la question n° 3 (« Quel nom pour le module ? ») : Veilleur. Applique-la maintenant.');
    assert.ok(N.texteReponse(question).startsWith(N.PREFIXE_CONTINUATION));
  });

  test('la décision sur une commande dit si elle peut être lancée', () => {
    const base = { id: 5, titre: 'Commande en attente d\'accord : git push origin main', type: 'action' };
    assert.equal(N.texteReponse({ ...base, reponse: 'Autoriser' }), 'NUIT : décision de l\'utilisateur sur la commande n° 5 (« Commande en attente d\'accord : git push origin main ») : Autoriser. Tu peux la lancer.');
    assert.equal(N.texteReponse({ ...base, reponse: 'Refuser' }), 'NUIT : décision de l\'utilisateur sur la commande n° 5 (« Commande en attente d\'accord : git push origin main ») : Refuser. Ne la lance pas.');
    assert.equal(N.texteReponse({ ...base, reponse: 'autoriser' }).endsWith('Tu peux la lancer.'), true, 'sans tenir compte de la casse');
    assert.equal(N.texteReponse({ ...base, reponse: 'Peut-être demain' }), 'NUIT : décision de l\'utilisateur sur la commande n° 5 (« Commande en attente d\'accord : git push origin main ») : Peut-être demain.');
  });

  test('seul le mot Autoriser ou Refuser, entier, vaut permission ou interdiction', () => {
    const base = { id: 5, titre: 'git push', type: 'action' };
    for (const reponse of ['Ne pas autoriser', 'autoriser demain', 'Non, refuser plutôt', 'Refuser tout', 'Ne pas refuser']) {
      const t = N.texteReponse({ ...base, reponse });
      assert.ok(!t.includes('Tu peux la lancer') && !t.includes('Ne la lance pas'), t);
    }
    assert.ok(N.texteReponse({ ...base, reponse: 'REFUSER' }).endsWith('Ne la lance pas.'));
    assert.ok(N.texteReponse({ ...base, reponse: 'Autoriser' }).endsWith('Tu peux la lancer.'));
  });

  test('le titre de la réponse est nettoyé et borné', () => {
    const t = N.texteReponse({ id: 2, type: 'question', titre: `  ${'t'.repeat(400)}\n fin `, reponse: 'oui' });
    assert.ok(t.includes(`(« ${'t'.repeat(237)}... »)`), t);
  });

  test('la réponse d une entrée traitée vient de la boîte, nettoyée', () => {
    const boite = N.repondre(N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom ?', maintenant: T0 }).boite, 1, '  Veilleur\n Nuit ', T0 + MIN);
    assert.equal(N.texteReponse(boite.entree), 'NUIT : réponse de l\'utilisateur à la question n° 1 (« Quel nom ? ») : Veilleur Nuit. Applique-la maintenant.');
  });

  test('une entrée écartée ou sans réponse ne donne pas de texte', () => {
    for (const entree of [null, undefined, 'x', {}, { ...question, reponse: null }, { ...question, reponse: '' }, { ...question, id: 0 }, { ...question, id: '3' }, { ...question, id: 1.5 }, { ...question, type: 'autre' }]) {
      assert.equal(N.texteReponse(entree), null, JSON.stringify(entree));
    }
  });
});

describe('bande de statut', () => {
  const avecQuestions = n => {
    let boite = N.boiteParDefaut();
    for (let i = 1; i <= n; i++) boite = N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: `Question ${i}`, maintenant: T0 + i * MIN }).boite;
    return boite;
  };

  test('rien à dire hors nuit et sans question en boîte', () => {
    assert.equal(N.texteBande(vide(), N.boiteParDefaut(), T0), undefined);
    assert.equal(N.texteBande(N.desactiver(active(), T0 + MIN), N.boiteParDefaut(), T0 + 2 * MIN), undefined);
    const traitee = N.repondre(avecQuestions(1), 1, 'oui', T0 + 5 * MIN).boite;
    assert.equal(N.texteBande(vide(), traitee, T0 + 6 * MIN), undefined, 'une question déjà traitée ne compte pas');
  });

  test('hors nuit, les questions en boîte à décider sont annoncées', () => {
    assert.equal(N.texteBande(vide(), avecQuestions(3), T0), 'Nuit : 3 à décider en boîte (/nuit boite)');
    assert.equal(N.texteBande(vide(), avecQuestions(1), T0), 'Nuit : 1 à décider en boîte (/nuit boite)');
    const melangee = N.repondre(avecQuestions(3), 2, 'oui', T0 + 9 * MIN).boite;
    assert.equal(N.texteBande(vide(), melangee, T0 + 10 * MIN), 'Nuit : 2 à décider en boîte (/nuit boite)', 'les questions traitées ne comptent pas');
  });

  test('pendant la nuit, la bande dit la durée, les enchaînements et la boîte', () => {
    assert.equal(N.texteBande(active({ tours: 14 }), avecQuestions(2), T0 + 130 * MIN), 'Nuit active depuis 2 h 10 min : 14/60 enchaînements, 2 à décider');
    assert.equal(N.texteBande(active({ tours: 0, maxTours: 20 }), N.boiteParDefaut(), T0 + 5 * MIN), 'Nuit active depuis 5 min : 0/20 enchaînements, 0 à décider');
    assert.equal(N.texteBande(N.activer(vide(), { mode: 'absence', maintenant: T0 }), N.boiteParDefaut(), T0 + MIN), 'Nuit active depuis 1 min : 0/60 enchaînements, 0 à décider');
  });

  test('quand l enchaînement est arrêté, la bande le dit', () => {
    assert.equal(N.texteBande(active({ arret: 'termine' }), N.boiteParDefaut(), T0 + MIN), 'Nuit active depuis 1 min : 0/60 enchaînements (arrêté), 0 à décider');
  });
});

describe('rappel pendant la nuit', () => {
  const BASE = "L'utilisateur est absent. Ne lui pose aucune question : l'outil de questions est refusé et ta question est notée en boîte pour son réveil. Un arrêt du garde de sécurité devient un refus avec une alternative : change de voie, ne t'arrête pas. Continue avec les lignes ouvertes de ta liste de travail. Aucun push, aucun déploiement sans son ordre.";

  test('pas de rappel hors nuit', () => {
    assert.equal(N.texteRappel(vide()), null);
    assert.equal(N.texteRappel(N.desactiver(active(), T0 + MIN)), null);
    assert.equal(N.texteRappel(null), null);
  });

  test('pendant la nuit, le rappel dit le mode et les règles', () => {
    assert.equal(N.texteRappel(active()), `NUIT EN COURS (nuit) : ${BASE}`);
    assert.equal(N.texteRappel(N.activer(vide(), { mode: 'absence', maintenant: T0 })), `NUIT EN COURS (absence de l'utilisateur) : ${BASE}`);
    assert.ok(sansTiretLong(N.texteRappel(active())));
  });

  test('quand l enchaînement s est arrêté, le rappel le dit', () => {
    assert.equal(N.texteRappel(active({ arret: 'quota' })), `NUIT EN COURS (nuit) : ${BASE} Enchaînement arrêté : le Garde-quota a atteint son seuil critique.`);
    assert.ok(N.texteRappel(active({ arret: 'plafond', maxTours: 12 })).endsWith('Enchaînement arrêté : le plafond de 12 enchaînements est atteint.'));
  });
});

describe('réglages', () => {
  test('compterRefus avance le compteur du genre donné, et ignore un genre inconnu', () => {
    const e = N.compterRefus(N.compterRefus(vide(), 'question'), 'question');
    assert.deepEqual(e.refus, { question: 2, garde: 0, action: 0 });
    assert.deepEqual(N.compterRefus(vide(), 'garde').refus, { question: 0, garde: 1, action: 0 });
    assert.deepEqual(N.compterRefus(vide(), 'action').refus, { question: 0, garde: 0, action: 1 });
    assert.deepEqual(N.compterRefus(vide(), 'autre'), vide());
    assert.deepEqual(N.compterRefus(vide(), '__proto__'), vide());
  });

  test('aucun message ne contient le tiret cadratin', () => {
    assert.ok(sansTiretLong(JSON.stringify(N.etatParDefaut())));
  });
});

// ---------------------------------------------------------------- lot : une entrée par question, commande entière gardée, autorisation consommable

describe('lot de la nuit : une entrée par question', () => {
  const trois = { questions: [
    { question: 'Première ?', options: [{ label: 'A (Recommended)', description: 'a' }, { label: 'B' }] },
    { question: 'Seconde ?', options: [{ label: 'Oui' }, { label: 'Non' }] },
    { title: 'Troisième ?' },
  ] };

  test('un appel de trois questions donne trois entrées, chacune avec SES options et son rang', () => {
    const e = N.entreesDeQuestions(trois);
    assert.equal(e.length, 3);
    assert.deepEqual(e.map(x => x.titre), ['Première ?', 'Seconde ?', 'Troisième ?']);
    assert.deepEqual(e.map(x => x.options.map(o => o.label)), [['A (Recommended)', 'B'], ['Oui', 'Non'], []]);
    assert.deepEqual(e.map(x => x.details), ['Question 1 sur 3 posées ensemble.', 'Question 2 sur 3 posées ensemble.', 'Question 3 sur 3 posées ensemble.']);
  });

  test('une question seule garde ses options, sans détail ; sans texte lisible, une entrée garde la trace', () => {
    assert.deepEqual(N.entreesDeQuestions({ questions: [trois.questions[1]] }), [{ titre: 'Seconde ?', details: '', options: [{ label: 'Oui', description: '' }, { label: 'Non', description: '' }] }]);
    for (const entree of [null, undefined, {}, { questions: [] }, { questions: [null, { question: '  ' }] }]) {
      assert.deepEqual(N.entreesDeQuestions(entree), [{ titre: 'Question sans texte lisible', details: '', options: [] }], JSON.stringify(entree));
    }
  });

  test('une question plus longue que le titre est gardée ENTIÈRE dans les détails', () => {
    const longue = `${'mot '.repeat(200)}fin ?`;
    const [e] = N.entreesDeQuestions({ questions: [{ question: longue }] });
    assert.equal(e.titre.length, 240);
    assert.ok(e.details.endsWith('fin ?'), e.details.slice(-40));
    assert.equal(e.details, `Question entière : ${longue}`);
  });

  test('les entrées d un même appel portent le même lot : le numéro de la première', () => {
    let boite = N.boiteParDefaut();
    const ids = [];
    let lot = null;
    for (const q of N.entreesDeQuestions(trois)) {
      const r = N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', ...q, maintenant: T0, lot: lot === null ? 'soi' : lot });
      boite = r.boite;
      ids.push(r.entree.id);
      lot = r.entree.lot;
    }
    assert.deepEqual(ids, [1, 2, 3]);
    assert.deepEqual(boite.entrees.map(e => e.lot), [1, 1, 1]);
    assert.deepEqual(N.normaliserBoite(JSON.parse(JSON.stringify(boite))), boite, 'le lot survit à l écriture et à la relecture');
    const seule = N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Seule ?', maintenant: T0 });
    assert.equal(Object.hasOwn(seule.entree, 'lot'), false, 'une question seule n a pas de lot');
    assert.equal(N.normaliserBoite({ prochain: 2, entrees: [{ ...boite.entrees[0], lot: 'x' }] }).entrees[0].lot, undefined);
  });

  test('la même question encore à décider ne se duplique pas ; deux questions qui ne diffèrent qu au-delà du titre restent deux entrées', () => {
    const [q] = N.entreesDeQuestions({ questions: [trois.questions[0]] });
    const a = N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', ...q, maintenant: T0 });
    const b = N.ajouterEntree(a.boite, { agent: 'claude', session: 'S1', type: 'question', ...q, maintenant: T0 + MIN });
    assert.deepEqual([b.deja, b.entree.id, b.boite.entrees.length], [true, 1, 1]);
    const [l1] = N.entreesDeQuestions({ questions: [{ question: `${'q'.repeat(300)} un` }] });
    const [l2] = N.entreesDeQuestions({ questions: [{ question: `${'q'.repeat(300)} deux` }] });
    assert.equal(l1.titre, l2.titre);
    const c = N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', ...l1, maintenant: T0 });
    const d = N.ajouterEntree(c.boite, { agent: 'claude', session: 'S1', type: 'question', ...l2, maintenant: T0 });
    assert.deepEqual([d.deja, d.boite.entrees.length], [false, 2]);
  });

  test('le refus rendu au modèle cite tous les numéros, le lot, et dit précisément ce qui n a pas été noté', () => {
    const t = N.texteRefusQuestion({ id: 7, enAttente: 9, lot: 7, questions: [
      { id: 7, titre: 'Première ?', options: trois.questions[0].options },
      { id: 8, titre: 'Seconde ?', options: trois.questions[1].options },
      { id: null, cause: 'pleine', titre: 'Troisième ?', options: [] },
    ] });
    assert.ok(t.startsWith('NUIT : L\'utilisateur est absent, tes 3 questions ne peuvent pas attendre sa réponse.'), t);
    assert.ok(t.includes('une entrée par question (lot n° 7 : leurs réponses vont ensemble) : n° 7 « Première ? » ; n° 8 « Seconde ? ». 9 à décider au réveil.'), t);
    assert.ok(t.includes('PAS notées en boîte : « Troisième ? » (la boîte est pleine : 50 entrées à décider). Écris-les dans le fichier contexte.'), t);
    assert.ok(t.includes('(marquées recommandées : n° 7 « A »)'), t);
    assert.ok(sansTiretLong(t));
    const toutes = N.texteRefusQuestion({ enAttente: 0, questions: [{ id: null, cause: 'verrou', titre: 'A ?' }, { id: null, cause: 'verrou', titre: 'B ?' }] });
    assert.ok(!toutes.includes('Notées en boîte'), toutes);
    assert.ok(toutes.includes('« A ? » (les fichiers de la nuit sont occupés par un autre agent) ; « B ? » (les fichiers de la nuit sont occupés par un autre agent)'), toutes);
  });

  test('une question seule non notée dit pourquoi ; la réponse d une question d un lot rappelle le lot', () => {
    assert.ok(N.texteRefusQuestion({ id: null, cause: 'verrou', enAttente: 0 }).includes("Elle n'a PAS pu être notée en boîte (les fichiers de la nuit sont occupés par un autre agent)"));
    const base = { id: 3, type: 'question', titre: 'Seconde ?', reponse: 'Oui' };
    assert.ok(N.texteReponse({ ...base, lot: 2 }).endsWith('Applique-la maintenant. Elle fait partie du lot n° 2 : les questions de ce lot ont été posées ensemble, leurs réponses vont ensemble.'));
    assert.ok(N.texteReponse(base).endsWith('Applique-la maintenant.'));
    assert.equal(N.texteBoite({ prochain: 4, entrees: [{ id: 3, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'Seconde ?', lot: 2 }] }), 'Boîte de la nuit : 1 à décider, 0 traitée.\n3. [question, lot 2] Seconde ?');
  });
});

describe('lot de la nuit : la commande entière est gardée et affichée', () => {
  const longue = `Set-Location 'C:\\travail\\x'; ${'git status; '.repeat(80)}git push origin "HEAD:refs/heads/branche-finale"`;

  test('le titre reste court, les détails portent la raison puis la commande ENTIÈRE', () => {
    assert.ok(longue.length > 900 && longue.length < 4000);
    const a = N.actionDeGarde({ commande: longue, raison: 'git push detecte' });
    assert.ok(a.titre.length <= 240 && a.titre.endsWith('...'));
    assert.equal(a.details, `git push detecte | Commande entière : ${longue}`);
    assert.equal(N.commandeEntiere('  a\n  b\t c  '), 'a b c');
    assert.equal(N.commandeEntiere(undefined), '');
  });

  test('au-delà de 4 000 caractères la coupure est annoncée, avec les deux longueurs', () => {
    assert.equal(N.commandeEntiere('c'.repeat(4000)), 'c'.repeat(4000));
    assert.equal(N.commandeEntiere('c'.repeat(4001)), `${'c'.repeat(4000)} [COMMANDE COUPÉE : 4001 caractères en tout, 4000 montrés]`);
    assert.ok(N.actionDeGarde({ commande: 'c'.repeat(9000), raison: 'r' }).details.endsWith('[COMMANDE COUPÉE : 9000 caractères en tout, 4000 montrés]'));
  });

  test('la boîte garde ces détails entiers, et /nuit boite les affiche sous l entrée à décider', () => {
    const r = N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'action', ...N.actionDeGarde({ commande: longue, raison: 'git push detecte' }), maintenant: T0 });
    assert.ok(r.entree.details.endsWith('git push origin "HEAD:refs/heads/branche-finale"'));
    const relue = N.normaliserBoite(JSON.parse(JSON.stringify(r.boite)));
    assert.equal(relue.entrees[0].details, r.entree.details);
    const t = N.texteBoite(relue);
    assert.ok(t.includes(`\n    git push detecte | Commande entière : ${longue}`), t);
    assert.ok(N.analyserCommande('boite', N.etatParDefaut(), relue, { maintenant: T0 }).message.includes('branche-finale"'));
    const traitee = N.repondre(relue, 1, 'Refuser', T0 + MIN).boite;
    assert.ok(!N.texteBoite(traitee).includes('Commande entière'), 'une entrée traitée reste sur une ligne');
  });

  test('une commande non notée le dit au modèle, avec la cause', () => {
    const t = N.texteRefusGarde({ genre: 'ask', raison: 'git push detecte', id: null, cause: 'verrou' });
    assert.ok(t.endsWith("La demande n'a PAS pu être notée en boîte (les fichiers de la nuit sont occupés par un autre agent) : note-la dans le fichier contexte pour son réveil."), t);
    assert.ok(!N.texteRefusGarde({ genre: 'bloc', raison: 'x', id: null, cause: 'verrou' }).includes('boîte'));
  });
});

describe('lot de la nuit : autorisation consommable', () => {
  const E1 = 'a'.repeat(64);
  const E2 = 'b'.repeat(64);
  const HEURE = 60 * MIN;
  const action = (extra = {}) => ({ id: 1, agent: 'claude', session: 'S1', type: 'action', ajoute: iso(T0), titre: 'Commande en attente d\'accord : git push', details: 'git push detecte', options: N.actionDeGarde().options, statut: 'repondue', reponse: 'Autoriser', traite: iso(T0 + MIN), empreinte: E1, ...extra });
  const boite = (extra = {}) => ({ prochain: 2, entrees: [action(extra)] });
  const demande = (extra = {}) => ({ agent: 'claude', session: 'S1', empreinte: E1, maintenant: T0 + 2 * MIN, attestees: [{ id: 1, empreinte: E1 }], ...extra });
  const valable = (b, d) => N.autorisationValable(b, d);

  test('une action répondue « Autoriser », attestée, même agent, même conversation, même empreinte, récente : valable', () => {
    assert.equal(valable(boite(), demande()).id, 1);
    assert.equal(N.REPONSE_AUTORISER, 'Autoriser');
    assert.equal(N.DUREE_AUTORISATION_MS, 12 * HEURE);
  });

  test('chaque condition manquante suffit à la refuser', () => {
    const cas = {
      'empreinte d une autre commande': [boite(), demande({ empreinte: E2, attestees: [{ id: 1, empreinte: E2 }] })],
      'autre conversation': [boite(), demande({ session: 'S2' })],
      'autre agent': [boite(), demande({ agent: 'codex' })],
      'réponse Refuser': [boite({ reponse: 'Refuser' }), demande()],
      'texte libre': [boite({ reponse: 'Autoriser, vas-y' }), demande()],
      'autre casse': [boite({ reponse: 'autoriser' }), demande()],
      'encore à décider': [boite({ statut: 'en-attente', reponse: null, traite: null }), demande()],
      'écartée': [boite({ statut: 'ecartee', reponse: null }), demande()],
      'une question, pas une action': [boite({ type: 'question' }), demande()],
      'entrée sans empreinte': [boite({ empreinte: undefined }), demande()],
      'déjà consommée': [boite({ consommee: iso(T0 + 90 * 1000) }), demande()],
      'répondue il y a 12 heures': [boite(), demande({ maintenant: T0 + MIN + 12 * HEURE })],
      'répondue dans le futur': [boite(), demande({ maintenant: T0 })],
      'sans attestation de l adaptateur': [boite(), demande({ attestees: undefined })],
      'attestation vide': [boite(), demande({ attestees: [] })],
      'attestation d une autre entrée': [boite(), demande({ attestees: [{ id: 2, empreinte: E1 }] })],
      'attestation d une autre empreinte': [boite(), demande({ attestees: [{ id: 1, empreinte: E2 }] })],
      'attestation mal formée': [boite(), demande({ attestees: [null, 1, 'x'] })],
      'instant illisible': [boite(), demande({ maintenant: NaN })],
      'empreinte mal formée': [boite(), demande({ empreinte: 'abc' })],
    };
    for (const [nom, [b, d]] of Object.entries(cas)) assert.equal(valable(b, d), null, nom);
    assert.equal(valable(boite(), demande({ maintenant: T0 + MIN + 12 * HEURE - 1 })).id, 1, 'une milliseconde avant 12 heures : encore valable');
  });

  test('la décision rendue au modèle dit de relancer la commande à l identique, seulement quand elle a une empreinte', () => {
    const t = N.texteReponse(action());
    assert.ok(t.endsWith("Autoriser. Tu peux la lancer. Relance-la exactement à l'identique, une seule fois : une différence, même d'un caractère, la remet en attente."), t);
    assert.ok(N.texteReponse(action({ empreinte: undefined })).endsWith('Autoriser. Tu peux la lancer.'));
    assert.ok(N.texteReponse(action({ reponse: 'Refuser' })).endsWith('Refuser. Ne la lance pas.'));
    assert.ok(sansTiretLong(t));
  });

  test('consommer marque l entrée, une seule fois, et la marque survit à la relecture', () => {
    const r = N.consommerAutorisation(boite(), 1, T0 + 2 * MIN);
    assert.equal(r.entree.consommee, iso(T0 + 2 * MIN));
    const relue = N.normaliserBoite(JSON.parse(JSON.stringify(r.boite)));
    assert.equal(relue.entrees[0].consommee, iso(T0 + 2 * MIN));
    assert.equal(valable(relue, demande({ maintenant: T0 + 3 * MIN })), null);
    assert.equal(N.consommerAutorisation(relue, 1, T0 + 3 * MIN), null);
    assert.equal(N.consommerAutorisation(boite(), 9, T0), null);
    assert.equal(N.consommerAutorisation(boite({ statut: 'en-attente', reponse: null, traite: null }), 1, T0), null);
    assert.equal(N.consommerAutorisation(boite(), 1, NaN), null);
  });

  test('deux commandes au même titre court restent deux entrées par leur empreinte ; la même ne se duplique pas', () => {
    const base = { agent: 'claude', session: 'S1', type: 'action', titre: 'Commande en attente d\'accord : x', maintenant: T0 };
    const a = N.ajouterEntree(N.boiteParDefaut(), { ...base, empreinte: E1 });
    assert.equal(a.entree.empreinte, E1);
    const b = N.ajouterEntree(a.boite, { ...base, empreinte: E2 });
    assert.deepEqual([b.deja, b.boite.entrees.length], [false, 2]);
    const c = N.ajouterEntree(b.boite, { ...base, empreinte: E1 });
    assert.deepEqual([c.deja, c.entree.id], [true, 1]);
    assert.equal(Object.hasOwn(N.ajouterEntree(N.boiteParDefaut(), { ...base, empreinte: 'pas une empreinte' }).entree, 'empreinte'), false);
    assert.equal(Object.hasOwn(N.ajouterEntree(N.boiteParDefaut(), { ...base, type: 'question', empreinte: E1 }).entree, 'empreinte'), false, 'une question n a pas d empreinte');
  });
});

describe('rotation des lignes d une nuit à l autre', () => {
  // Sans cette rotation, chaque nuit reprendrait la ligne ouverte la plus ancienne.
  const L = n => ({ id: `C-${String(n).padStart(4, '0')}`, texte: `travail ${n}`, statut: 'en-cours', session: 'S1' });
  const lignes = [L(1), L(2), L(3), L(4), L(5)];
  // Une nuit entière : les lignes proposées jusqu'à l'arrêt, le motif de l'arrêt, et l'état laissé.
  const nuit = (etatAvant, maxTours) => {
    let etat = { ...N.activer(etatAvant, { mode: 'nuit', maintenant: T0, lignesOuvertes: lignes.length }), maxTours };
    const proposees = [];
    for (;;) {
      const d = N.decisionContinuation({ etat, reason: 'answer', lignes, session: 'S1', pause: false, quotaCritique: false });
      etat = d.etat;
      if (!d.continuer) return { proposees, motif: d.motif, etat: N.desactiver(etat, T0 + MIN) };
      proposees.push(Number(d.ligne.id.slice(2)));
    }
  };

  test('la nuit suivante commence par les lignes qui n ont pas encore eu leurs enchaînements', () => {
    const n1 = nuit(vide(), 6);
    assert.deepEqual(n1.proposees, [1, 1, 1, 2, 2, 2]);
    assert.equal(n1.motif, 'plafond');
    assert.deepEqual(n1.etat.passages, { 'C-0001': 1, 'C-0002': 1 });
    const n2 = nuit(n1.etat, 6);
    assert.deepEqual(n2.proposees, [3, 3, 3, 4, 4, 4], 'la seconde nuit ne reprend pas les deux mêmes lignes');
    const n3 = nuit(n2.etat, 6);
    assert.deepEqual(n3.proposees, [5, 5, 5, 1, 1, 1], 'le tour fini, on revient aux premières');
    assert.deepEqual(n3.etat.passages, { 'C-0002': 1, 'C-0003': 1, 'C-0004': 1, 'C-0005': 1, 'C-0001': 2 });
    assert.deepEqual(Object.keys(n3.etat.passages), ['C-0002', 'C-0003', 'C-0004', 'C-0005', 'C-0001'], 'la ligne qui vient de passer est réinscrite en dernier (ce sont les derniers inscrits que la borne garde)');
  });

  test('une ligne coupée par le plafond avant son dernier enchaînement est reprise la nuit suivante', () => {
    const n1 = nuit(vide(), 4);
    assert.deepEqual(n1.proposees, [1, 1, 1, 2]);
    assert.deepEqual(n1.etat.passages, { 'C-0001': 1 });
    assert.deepEqual(nuit(n1.etat, 4).proposees, [2, 2, 2, 3]);
  });

  test('sans plafond gênant, toutes les lignes ont leurs enchaînements puis la nuit s arrête pour répétition', () => {
    const n1 = nuit(vide(), 60);
    assert.deepEqual(n1.proposees, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
    assert.equal(n1.motif, 'repetition');
    assert.deepEqual(n1.etat.sautees, ['C-0001', 'C-0002', 'C-0003', 'C-0004', 'C-0005']);
    assert.deepEqual(Object.values(n1.etat.passages), [1, 1, 1, 1, 1]);
  });

  test('une ligne fermée entre-temps ne compte plus, et sans passage gardé l ordre reste celui des numéros', () => {
    const etat = { ...N.activer({ ...vide(), passages: { 'C-0001': 2, 'C-0003': 1 } }, { mode: 'nuit', maintenant: T0 }), maxTours: 60 };
    const d = N.decisionContinuation({ etat, reason: 'answer', lignes: [L(1), L(3), L(4)], session: 'S1' });
    assert.equal(d.ligne.id, 'C-0004', 'la ligne sans passage passe avant celles qui en ont');
    const e = N.decisionContinuation({ etat, reason: 'answer', lignes: [L(1), L(3)], session: 'S1' });
    assert.equal(e.ligne.id, 'C-0003', 'à défaut, celle qui en a le moins');
    const f = N.decisionContinuation({ etat: { ...etat, passages: {} }, reason: 'answer', lignes: [L(3), L(1), L(4)], session: 'S1' });
    assert.equal(f.ligne.id, 'C-0001');
  });
});

describe('boîte pleine : l entrée qui laisse sa place est rendue', () => {
  const pleine = () => {
    let boite = N.boiteParDefaut();
    for (let i = 0; i < N.MAX_BOITE; i++) {
      boite = N.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: `question ${i + 1}`, maintenant: T0 + i }).boite;
      boite = N.repondre(boite, i + 1, 'oui', T0 + 1000 - i).boite; // la dernière posée est la plus anciennement répondue
    }
    return boite;
  };

  test('l entrée traitée la plus ancienne est rendue avec sa réponse, et quitte la boîte', () => {
    const r = N.ajouterEntree(pleine(), { agent: 'claude', session: 'S1', type: 'question', titre: 'nouvelle', maintenant: T0 + 5000 });
    assert.equal(r.evincee.id, 50);
    assert.deepEqual([r.evincee.statut, r.evincee.reponse, r.evincee.titre], ['repondue', 'oui', 'question 50']);
    assert.equal(r.boite.entrees.length, N.MAX_BOITE);
    assert.equal(r.boite.entrees.some(e => e.id === 50), false);
    assert.equal(r.entree.id, 51);
  });

  test('sans éviction, rien n est rendu de plus', () => {
    const r = N.ajouterEntree(N.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', titre: 'seule', maintenant: T0 });
    assert.equal(Object.hasOwn(r, 'evincee'), false);
    const deja = N.ajouterEntree(r.boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'seule', maintenant: T0 });
    assert.deepEqual([deja.deja, Object.hasOwn(deja, 'evincee')], [true, false]);
  });
});
