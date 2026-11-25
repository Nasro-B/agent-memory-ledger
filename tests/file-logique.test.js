'use strict';
// Bancs de la logique de la file d'agents du Régulateur : scripts/lib/file-logique.mjs
// Module ES sans aucune dépendance : le même fichier est destiné à l'adaptateur Claude Code et chargé par require() par Codex.
// Lancement : node --test tests/file-logique.test.js
// Variable interne (preuves par mutation) : FILE_LOGIQUE_TESTE = fichier à tester (défaut : ../scripts/lib/file-logique.mjs)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, describe } = require('node:test');

const F = require(process.env.FILE_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'file-logique.mjs'));

const T0 = Date.parse('2026-03-02T20:00:00.000Z');
const MIN = 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const sansTiretLong = t => !/\u{2014}/u.test(t);
const demande = (n = 1) => ({ prompt: `Fais le travail ${n}`, description: `travail ${n}`, subagentType: 'general-purpose' });
const ajout = (etat, n = 1, extra = {}) => F.mettreEnFile(etat, { agent: 'claude', session: 'S1', description: `travail ${n}`, demande: demande(n), maintenant: T0, ...extra });
const vide = () => F.etatParDefaut();
// Une file de n entrées de claude / S1, ajoutées une par minute.
function remplie(n, extra = {}) {
  let etat = vide();
  for (let i = 1; i <= n; i++) etat = ajout(etat, i, { maintenant: T0 + i * MIN, ...extra }).etat;
  return etat;
}

describe('constantes', () => {
  test('les bornes sont celles de la conception', () => {
    assert.equal(F.MAX_FILE, 50);
    assert.equal(F.MAX_DEMANDE, 60000);
    assert.equal(F.MAX_RELANCES, 2);
    assert.equal(F.DELAI_ORDRE_MS, 10 * MIN);
    assert.equal(F.AGE_MAX_ENTREE_MS, 6 * 60 * MIN);
    assert.equal(F.MAX_PAR_ORDRE, 3);
  });
});

describe('état', () => {
  test('l état par défaut est vide, et chaque appel en rend un neuf', () => {
    assert.deepEqual(F.etatParDefaut(), { prochain: 1, entrees: [], relances: {} });
    assert.notEqual(F.etatParDefaut(), F.etatParDefaut());
    assert.notEqual(F.etatParDefaut().entrees, F.etatParDefaut().entrees);
  });

  test('un brut qui n est pas un objet donne l état par défaut', () => {
    for (const brut of [null, undefined, [], 'x', 5, true]) assert.deepEqual(F.normaliserEtat(brut), vide(), String(brut));
    assert.deepEqual(F.normaliserEtat({ entrees: 'x', relances: [] }), vide());
  });

  test('une entrée valide est gardée telle quelle, avec ses champs et rien d autre', () => {
    const brute = { id: 3, agent: 'autre-agent', session: 'S9', ajoute: iso(T0), description: 'travail', demande: { message: 'x' }, essais: 1, statut: 'ordonne', ordre: iso(T0 + MIN), autre: 'x' };
    const e = F.normaliserEtat({ prochain: 10, entrees: [brute] });
    assert.deepEqual(e.entrees, [{ id: 3, agent: 'autre-agent', session: 'S9', ajoute: iso(T0), description: 'travail', demande: { message: 'x' }, essais: 1, statut: 'ordonne', ordre: iso(T0 + MIN) }]);
    assert.equal(e.prochain, 10);
  });

  test('une entrée mal formée est écartée, les autres sont gardées', () => {
    const bonne = { id: 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { prompt: 'x' } };
    const mauvaises = [
      null, 'x', 5, [], {},
      { ...bonne, id: 0 }, { ...bonne, id: 1.5 }, { ...bonne, id: '2' }, { ...bonne, id: -1 },
      { ...bonne, id: 2, agent: '' }, { ...bonne, id: 2, agent: 'Claude' }, { ...bonne, id: 2, agent: '1claude' }, { ...bonne, id: 2, agent: 'a'.repeat(33) }, { ...bonne, id: 2, agent: 5 },
      { ...bonne, id: 2, session: '' }, { ...bonne, id: 2, session: 5 }, { ...bonne, id: 2, session: 'x'.repeat(129) },
      { ...bonne, id: 2, ajoute: 'hier' }, { ...bonne, id: 2, ajoute: 5 }, { ...bonne, id: 2, ajoute: undefined },
      { ...bonne, id: 2, demande: null }, { ...bonne, id: 2, demande: [] }, { ...bonne, id: 2, demande: 'x' }, { ...bonne, id: 2, demande: undefined },
      { ...bonne, id: 2, demande: { prompt: 'x'.repeat(F.MAX_DEMANDE) } },
    ];
    const e = F.normaliserEtat({ entrees: [...mauvaises, bonne] });
    assert.deepEqual(e.entrees.map(x => x.id), [1]);
  });

  test('un agent de trente-deux caractères et une session de cent vingt-huit sont acceptés, un caractère de plus non', () => {
    const base = { ajoute: iso(T0), description: 'a', demande: { a: 1 } };
    const agent32 = `a${'b'.repeat(31)}`;
    const session128 = 's'.repeat(128);
    assert.equal(F.normaliserEtat({ entrees: [{ ...base, id: 1, agent: agent32, session: 'S' }] }).entrees.length, 1);
    assert.equal(F.normaliserEtat({ entrees: [{ ...base, id: 1, agent: 'claude', session: session128 }] }).entrees.length, 1);
    assert.equal(F.normaliserEtat({ entrees: [{ ...base, id: 1, agent: `${agent32}b`, session: 'S' }] }).entrees.length, 0);
    assert.equal(F.normaliserEtat({ entrees: [{ ...base, id: 1, agent: 'claude', session: `${session128}s` }] }).entrees.length, 0);
    assert.equal(F.mettreEnFile(vide(), { agent: agent32, session: session128, description: 'a', demande: { a: 1 }, maintenant: T0 }).refus, undefined);
    assert.equal(F.normaliserEtat({ entrees: [{ ...base, id: 1, agent: 'autre-agent', session: 'S' }] }).entrees.length, 1, 'le tiret est permis dans un nom d agent');
    assert.equal(F.normaliserEtat({ entrees: [{ ...base, id: 1, agent: 'agent2', session: 'S' }] }).entrees.length, 1, 'les chiffres aussi');
  });

  test('une demande qui ne se met pas en forme (cycle, grand entier) est écartée ou refusée sans erreur', () => {
    const cycle = { a: 1 };
    cycle.moi = cycle;
    const grand = { n: 10n };
    const base = { id: 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a' };
    assert.deepEqual(F.normaliserEtat({ entrees: [{ ...base, demande: cycle }, { ...base, id: 2, demande: grand }] }).entrees, []);
    assert.deepEqual(ajout(vide(), 1, { demande: cycle }), { refus: 'invalide' });
    assert.deepEqual(ajout(vide(), 1, { demande: grand }), { refus: 'invalide' });
    assert.equal(F.reconnaitre(remplie(1), 'claude', 'S1', cycle), null);
    assert.equal(F.reconnaitre(remplie(1), 'claude', 'S1', grand), null);
  });

  test('un brut qui n est pas un objet ordinaire ne livre rien, même s il porte des propriétés ou des champs de mauvais type', () => {
    const valide = { id: 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { a: 1 } };
    assert.deepEqual(F.normaliserEtat(Object.assign([], { entrees: [valide], relances: { A: 1 } })), vide());
    for (const entrees of [{ a: 1 }, 5, true, null, 'abc']) assert.deepEqual(F.normaliserEtat({ entrees }).entrees, [], JSON.stringify(entrees));
    for (const relances of [[1], [2], 'abc', 5, true, null]) assert.deepEqual(F.normaliserEtat({ relances }).relances, {}, JSON.stringify(relances));
    assert.deepEqual(F.normaliserEtat({ entrees: [{ ...valide, session: ['S1'] }, { ...valide, id: 2, session: { length: 3 } }] }).entrees, []);
  });

  test('un identifiant déjà vu est écarté, le premier reste', () => {
    const a = { id: 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'premier', demande: { a: 1 } };
    const e = F.normaliserEtat({ entrees: [a, { ...a, description: 'second', demande: { a: 2 } }, { ...a, id: 2, demande: { a: 3 } }] });
    assert.deepEqual(e.entrees.map(x => [x.id, x.description]), [[1, 'premier'], [2, 'premier']]);
  });

  test('le statut inconnu devient en attente, l ordre n est gardé que pour une entrée ordonnée', () => {
    const base = { agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { a: 1 } };
    const e = F.normaliserEtat({
      entrees: [
        { ...base, id: 1, statut: 'fini', ordre: iso(T0) },
        { ...base, id: 2, statut: 'en-attente', ordre: iso(T0) },
        { ...base, id: 3, statut: 'ordonne', ordre: iso(T0) },
        { ...base, id: 4, statut: 'ordonne', ordre: 'jamais' },
        { ...base, id: 5, statut: 'ordonne' },
        { ...base, id: 6 },
      ],
    });
    assert.deepEqual(e.entrees.map(x => [x.id, x.statut, x.ordre]), [[1, 'en-attente', null], [2, 'en-attente', null], [3, 'ordonne', iso(T0)], [4, 'en-attente', null], [5, 'en-attente', null], [6, 'en-attente', null]]);
  });

  test('les essais hors de 0 à 2 retombent à 0, la description est nettoyée et coupée', () => {
    const base = { agent: 'claude', session: 'S1', ajoute: iso(T0), demande: { a: 1 } };
    const e = F.normaliserEtat({
      entrees: [
        { ...base, id: 1, essais: 2, description: 'a' }, { ...base, id: 2, essais: 3, description: 'a' }, { ...base, id: 3, essais: -1, description: 'a' },
        { ...base, id: 4, essais: 1.5, description: 'a' }, { ...base, id: 5, essais: '1', description: 'a' },
        { ...base, id: 6, description: '  deux\n\nlignes   ici ' }, { ...base, id: 7, description: 'x'.repeat(100) }, { ...base, id: 8, description: 5 }, { ...base, id: 9 },
      ],
    });
    assert.deepEqual(e.entrees.map(x => x.essais), [2, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(e.entrees[5].description, 'deux lignes ici');
    assert.equal(e.entrees[6].description, `${'x'.repeat(77)}...`);
    assert.equal(e.entrees[7].description, '');
    assert.equal(e.entrees[8].description, '');
  });

  test('au plus cinquante entrées sont gardées, les premières', () => {
    const entrees = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { n: i } }));
    const e = F.normaliserEtat({ entrees });
    assert.equal(e.entrees.length, 50);
    assert.equal(e.entrees[0].id, 1);
    assert.equal(e.entrees.at(-1).id, 50);
  });

  test('le prochain identifiant dépasse toujours le plus grand identifiant, et vaut au moins 1', () => {
    const base = { agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { a: 1 } };
    assert.equal(F.normaliserEtat({ prochain: 2, entrees: [{ ...base, id: 7 }] }).prochain, 8);
    assert.equal(F.normaliserEtat({ prochain: 20, entrees: [{ ...base, id: 7 }] }).prochain, 20);
    for (const p of [0, -3, 1.5, '4', null, undefined]) assert.equal(F.normaliserEtat({ prochain: p }).prochain, 1, String(p));
  });

  test('les relances gardent des clés non vides et des compteurs de 1 à 2', () => {
    const e = F.normaliserEtat({ relances: { A: 1, B: 2, C: 3, D: 0, E: -1, F: 1.5, G: '1', '': 1, [`${'k'.repeat(201)}`]: 1, H: null } });
    assert.deepEqual(e.relances, { A: 1, B: 2 });
  });

  test('normaliser ne modifie pas son argument et rend un état déjà normal à l identique', () => {
    const brut = { prochain: 3, entrees: [{ id: 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { a: [1, { b: 2 }] } }], relances: { A: 1 } };
    const copie = JSON.parse(JSON.stringify(brut));
    const e = F.normaliserEtat(brut);
    assert.deepEqual(brut, copie);
    assert.deepEqual(F.normaliserEtat(e), e);
    e.entrees[0].demande.a[1].b = 99;
    assert.equal(brut.entrees[0].demande.a[1].b, 2, 'la demande est copiée, pas partagée');
  });
});

describe('signature d une demande', () => {
  test('elle ne dépend pas de l ordre des clés, même imbriquées', () => {
    assert.equal(F.signature({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }), F.signature({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }));
  });

  test('elle distingue les valeurs, l ordre d un tableau et les types', () => {
    const sigs = [{ a: 1 }, { a: 2 }, { a: '1' }, { a: [1, 2] }, { a: [2, 1] }, { a: null }, { b: 1 }, {}];
    assert.equal(new Set(sigs.map(F.signature)).size, sigs.length);
  });
});

describe('mise en file', () => {
  test('la première entrée reçoit l identifiant 1, la date, l état en attente et zéro essai', () => {
    const r = ajout(vide(), 1);
    assert.equal(r.refus, undefined);
    assert.deepEqual(r.entree, { id: 1, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'travail 1', demande: demande(1), essais: 0, statut: 'en-attente', ordre: null });
    assert.deepEqual(r.etat.entrees, [r.entree]);
    assert.equal(r.etat.prochain, 2);
    assert.equal(r.position, 1);
    assert.equal(r.deja, false);
  });

  test('les entrées suivantes gardent l ordre d arrivée et la position compte les entrées en attente', () => {
    let etat = vide();
    for (let i = 1; i <= 3; i++) {
      const r = ajout(etat, i);
      assert.equal(r.position, i);
      assert.equal(r.entree.id, i);
      etat = r.etat;
    }
    assert.deepEqual(etat.entrees.map(e => e.id), [1, 2, 3]);
  });

  test('la position ne compte que l agent et la session de l entrée, pas les autres', () => {
    let etat = ajout(vide(), 1).etat;
    etat = F.mettreEnFile(etat, { agent: 'codex', session: 'S1', description: 'x', demande: demande(2), maintenant: T0 }).etat;
    etat = F.mettreEnFile(etat, { agent: 'claude', session: 'S2', description: 'x', demande: demande(3), maintenant: T0 }).etat;
    const r = ajout(etat, 4);
    assert.equal(r.position, 2);
    assert.equal(F.mettreEnFile(r.etat, { agent: 'codex', session: 'S1', description: 'x', demande: demande(5), maintenant: T0 }).position, 2);
  });

  test('une entrée ordonnée ne compte pas dans la position', () => {
    let etat = ajout(vide(), 1).etat;
    etat = F.ordonner(etat, [1], T0);
    assert.equal(ajout(etat, 2).position, 1);
  });

  test('la description est nettoyée et coupée à quatre-vingts caractères', () => {
    assert.equal(ajout(vide(), 1, { description: '  a\n b  ' }).entree.description, 'a b');
    assert.equal(ajout(vide(), 1, { description: 'x'.repeat(80) }).entree.description, 'x'.repeat(80));
    assert.equal(ajout(vide(), 1, { description: 'x'.repeat(81) }).entree.description, `${'x'.repeat(77)}...`);
    assert.equal(ajout(vide(), 1, { description: undefined }).entree.description, '');
  });

  test('les essais et la mise en tête sont ceux demandés', () => {
    const r = ajout(remplie(2), 3, { essais: 1, enTete: true, maintenant: T0 + 10 * MIN });
    assert.equal(r.entree.essais, 1);
    assert.deepEqual(r.etat.entrees.map(e => e.id), [3, 1, 2]);
    assert.equal(r.position, 1);
    assert.equal(ajout(remplie(2), 3, { essais: 7 }).entree.essais, 0, 'des essais hors bornes retombent à zéro');
  });

  test('les demandes invalides, trop grandes ou une file pleine sont refusées sans toucher à l état', () => {
    const etat = remplie(2);
    const avant = JSON.stringify(etat);
    for (const d of [null, undefined, 'x', 5, [], [{ a: 1 }]]) assert.deepEqual(ajout(etat, 9, { demande: d }), { refus: 'invalide' }, JSON.stringify(d));
    for (const agent of ['', 'Claude', '9a', 5, undefined]) assert.deepEqual(ajout(etat, 9, { agent }), { refus: 'invalide' }, String(agent));
    for (const session of ['', 5, undefined, 'x'.repeat(129)]) assert.deepEqual(ajout(etat, 9, { session }), { refus: 'invalide' }, String(session));
    for (const maintenant of ['hier', '5', null, true, NaN, Infinity, undefined]) assert.deepEqual(ajout(etat, 9, { maintenant }), { refus: 'invalide' }, String(maintenant));
    for (const session of [['S1'], { length: 3 }]) assert.deepEqual(ajout(etat, 9, { session }), { refus: 'invalide' }, JSON.stringify(session));
    assert.deepEqual(F.mettreEnFile(etat), { refus: 'invalide' }, 'sans aucun argument');
    assert.deepEqual(F.mettreEnFile(etat, undefined), { refus: 'invalide' });
    assert.equal(JSON.stringify(etat), avant);
  });

  test('la taille de la demande est bornée à soixante mille caractères une fois mise en forme', () => {
    const taille = F.signature({ prompt: '' }).length;
    const juste = { prompt: 'x'.repeat(F.MAX_DEMANDE - taille) };
    assert.equal(F.signature(juste).length, F.MAX_DEMANDE);
    assert.equal(ajout(vide(), 1, { demande: juste }).refus, undefined);
    assert.deepEqual(ajout(vide(), 1, { demande: { prompt: `${juste.prompt}y` } }), { refus: 'trop-grande' });
  });

  test('cinquante entrées sont acceptées, la cinquante et unième est refusée', () => {
    const pleine = remplie(50);
    assert.equal(pleine.entrees.length, 50);
    assert.deepEqual(ajout(pleine, 51), { refus: 'pleine' });
    assert.equal(ajout(remplie(49), 50).refus, undefined);
  });

  test('la même demande mise en file deux fois ne crée pas de doublon', () => {
    const premier = ajout(remplie(2), 7);
    const second = ajout(premier.etat, 7, { maintenant: T0 + 99 * MIN });
    assert.equal(second.deja, true);
    assert.equal(second.etat.entrees.length, 3);
    assert.equal(second.entree.id, premier.entree.id);
    assert.equal(second.entree.ajoute, iso(T0), 'la date d origine est gardée');
    assert.equal(second.position, 3);
    assert.equal(second.etat.prochain, premier.etat.prochain, 'aucun identifiant consommé');
  });

  test('la même demande dans une autre session ou pour un autre agent est une autre entrée', () => {
    const a = ajout(vide(), 1).etat;
    const b = F.mettreEnFile(a, { agent: 'claude', session: 'S2', description: 'x', demande: demande(1), maintenant: T0 });
    const c = F.mettreEnFile(b.etat, { agent: 'codex', session: 'S1', description: 'x', demande: demande(1), maintenant: T0 });
    assert.deepEqual([b.deja, c.deja, c.etat.entrees.length], [false, false, 3]);
  });

  test('une demande déjà ordonnée redevient en attente quand elle est remise en file', () => {
    const ordonnee = F.ordonner(ajout(vide(), 1).etat, [1], T0);
    const r = ajout(ordonnee, 1, { maintenant: T0 + MIN });
    assert.equal(r.deja, true);
    assert.deepEqual([r.entree.statut, r.entree.ordre], ['en-attente', null]);
    assert.deepEqual([r.etat.entrees[0].statut, r.etat.entrees[0].ordre], ['en-attente', null]);
    assert.equal(r.position, 1);
  });

  test('l état d origine n est jamais modifié', () => {
    const etat = remplie(2);
    const avant = JSON.stringify(etat);
    ajout(etat, 3);
    ajout(etat, 2);
    ajout(etat, 3, { enTete: true });
    F.ordonner(etat, [1], T0);
    F.retirer(etat, 1);
    F.vider(etat);
    assert.equal(JSON.stringify(etat), avant);
  });

  test('un état brut est normalisé avant l ajout', () => {
    const r = F.mettreEnFile({ prochain: 'x', entrees: [{ id: 5, agent: 'claude', session: 'S1', ajoute: iso(T0), description: 'a', demande: { z: 1 } }, null] }, { agent: 'claude', session: 'S1', description: 'b', demande: { y: 1 }, maintenant: T0 });
    assert.equal(r.entree.id, 6);
    assert.deepEqual(r.etat.entrees.map(e => e.id), [5, 6]);
  });
});

describe('demande d un lancement et arguments pour le rejouer', () => {
  const spawn = (extra = {}) => ({ prompt: 'Fais X', description: 'travail X', subagentType: 'Explore', fork: false, background: true, tool_use_id: 'T1', provider: { plugin: 'engine' }, ...extra });

  test('la demande garde le prompt, la description et le type, et ajoute model, name et cwd seulement quand ils sont donnés', () => {
    assert.deepEqual(F.demandeDeLancement(spawn()), { prompt: 'Fais X', description: 'travail X', subagentType: 'Explore' });
    assert.deepEqual(F.demandeDeLancement(spawn({ model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' })), { prompt: 'Fais X', description: 'travail X', subagentType: 'Explore', model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' });
    assert.deepEqual(Object.keys(F.demandeDeLancement(spawn({ model: undefined, name: undefined, cwd: undefined }))).sort(), ['description', 'prompt', 'subagentType']);
  });

  test('un champ qui n est pas un texte n entre pas dans la demande', () => {
    assert.deepEqual(F.demandeDeLancement(spawn({ model: 5, name: null, cwd: {}, description: 7 })), { prompt: 'Fais X', subagentType: 'Explore' });
    for (const e of [null, undefined, 'x', 5, []]) assert.deepEqual(F.demandeDeLancement(e), {}, String(e));
  });

  test('seuls les six champs connus sont gardés, même quand un autre champ est un texte', () => {
    assert.deepEqual(F.demandeDeLancement(spawn({ fork: 'oui', isTeammate: 'x', agentId: 'a1' })), { prompt: 'Fais X', description: 'travail X', subagentType: 'Explore' });
  });

  test('les arguments du lancement sont ceux de la demande, sans champ inventé ni tiré d ailleurs', () => {
    const d = { prompt: 'Fais X', description: 'travail X', subagentType: 'Explore', model: 'haiku', name: 'audit', cwd: 'C:/travail/wt', autre: 'x', fork: true };
    assert.deepEqual(F.argumentsDeLancement(d), { prompt: 'Fais X', description: 'travail X', subagentType: 'Explore', model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' });
    assert.deepEqual(F.argumentsDeLancement({ prompt: 'Fais X' }), { prompt: 'Fais X' });
    assert.deepEqual(F.argumentsDeLancement({ prompt: 'Fais X', model: 5, name: undefined }), { prompt: 'Fais X' });
  });

  test('sans prompt texte, les arguments portent un prompt vide : le lanceur le refuse', () => {
    for (const d of [{}, { prompt: 5 }, null, undefined, 'x']) assert.equal(F.argumentsDeLancement(d).prompt, '', String(d));
  });

  test('une demande rejouée donne les mêmes arguments que la demande d origine', () => {
    const e = spawn({ model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' });
    assert.deepEqual(F.argumentsDeLancement(F.demandeDeLancement(e)), { prompt: 'Fais X', description: 'travail X', subagentType: 'Explore', model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' });
  });
});

describe('entrées en attente', () => {
  test('enAttente rend les entrées de l agent et de la session qui attendent, pas les ordonnées ni celles des autres', () => {
    let etat = F.ordonner(remplie(3), [2], T0);
    etat = F.mettreEnFile(etat, { agent: 'claude', session: 'S2', description: 'x', demande: demande(8), maintenant: T0 }).etat;
    etat = F.mettreEnFile(etat, { agent: 'codex', session: 'S1', description: 'x', demande: demande(9), maintenant: T0 }).etat;
    assert.deepEqual(F.enAttente(etat, 'claude', 'S1').map(e => e.id), [1, 3]);
    assert.deepEqual(F.enAttente(etat, 'claude', 'S2').map(e => e.id), [4]);
    assert.deepEqual(F.enAttente(etat, 'codex', 'S1').map(e => e.id), [5]);
    assert.deepEqual(F.enAttente(etat, 'agent-inconnu', 'S1'), []);
    assert.deepEqual(F.enAttente(vide(), 'claude', 'S1'), []);
    assert.deepEqual(F.enAttente({ entrees: 'x' }, 'claude', 'S1'), []);
  });
});

describe('sélection, ordre, retrait', () => {
  test('les entrées lançables sont celles de l agent et de la session, dans l ordre de la file', () => {
    let etat = remplie(3);
    etat = F.mettreEnFile(etat, { agent: 'claude', session: 'S2', description: 'x', demande: demande(8), maintenant: T0 }).etat;
    etat = F.mettreEnFile(etat, { agent: 'codex', session: 'S1', description: 'x', demande: demande(9), maintenant: T0 }).etat;
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 10, T0 + 99 * MIN).map(e => e.id), [1, 2, 3]);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S2', 10, T0).map(e => e.id), [4]);
    assert.deepEqual(F.prochaines(etat, 'codex', 'S1', 10, T0).map(e => e.id), [5]);
    assert.deepEqual(F.prochaines(etat, 'autre-agent', 'S1', 10, T0), []);
  });

  test('au plus n entrées sont rendues, et n invalide en rend zéro', () => {
    const etat = remplie(5);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 2, T0).map(e => e.id), [1, 2]);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 5, T0).map(e => e.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 0, T0), []);
    for (const n of [-1, 1.5, '2', null, undefined, NaN]) assert.deepEqual(F.prochaines(etat, 'claude', 'S1', n, T0), [], String(n));
  });

  test('une entrée ordonnée récemment n est pas lançable, une ordonnée depuis dix minutes ou plus l est de nouveau', () => {
    const etat = F.ordonner(remplie(3), [1, 2], T0);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 10, T0).map(e => e.id), [3]);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 10, T0 + 10 * MIN - 1).map(e => e.id), [3]);
    assert.deepEqual(F.prochaines(etat, 'claude', 'S1', 10, T0 + 10 * MIN).map(e => e.id), [1, 2, 3]);
  });

  test('ordonner marque les entrées nommées avec la date, et ignore les identifiants inconnus', () => {
    const etat = F.ordonner(remplie(3), [2, 99], T0 + 5 * MIN);
    assert.deepEqual(etat.entrees.map(e => [e.id, e.statut, e.ordre]), [[1, 'en-attente', null], [2, 'ordonne', iso(T0 + 5 * MIN)], [3, 'en-attente', null]]);
    assert.deepEqual(F.ordonner(remplie(1), [], T0), remplie(1));
    assert.deepEqual(F.ordonner(remplie(1), 'x', T0), remplie(1));
  });

  test('ordonner ne fait rien quand les identifiants ne sont pas une liste ou quand la date est invalide', () => {
    const etat = remplie(3);
    for (const ids of ['1', '123', null, undefined, 1, { length: 1, 0: 1 }]) assert.deepEqual(F.ordonner(etat, ids, T0), etat, JSON.stringify(ids));
    for (const maintenant of [NaN, undefined, null, 'hier', Infinity]) assert.deepEqual(F.ordonner(etat, [1], maintenant), etat, String(maintenant));
  });

  test('une prochaine sélection de zéro entrée ne rend rien, et un nombre fractionnaire non plus', () => {
    assert.deepEqual(F.prochaines(remplie(3), 'claude', 'S1', 0, T0), []);
    assert.deepEqual(F.prochaines(remplie(3), 'claude', 'S1', 0.5, T0), []);
  });

  test('reconnaître retrouve l entrée de même demande, en attente ou ordonnée, pour le même agent et la même session', () => {
    const etat = F.ordonner(remplie(3), [2], T0);
    assert.equal(F.reconnaitre(etat, 'claude', 'S1', demande(1)).id, 1);
    assert.equal(F.reconnaitre(etat, 'claude', 'S1', demande(2)).id, 2);
    assert.equal(F.reconnaitre(etat, 'claude', 'S1', { subagentType: 'general-purpose', description: 'travail 3', prompt: 'Fais le travail 3' }).id, 3);
    assert.equal(F.reconnaitre(etat, 'claude', 'S1', demande(9)), null);
    assert.equal(F.reconnaitre(etat, 'claude', 'S2', demande(1)), null);
    assert.equal(F.reconnaitre(etat, 'codex', 'S1', demande(1)), null);
    assert.equal(F.reconnaitre(etat, 'claude', 'S1', null), null);
  });

  test('retirer enlève l entrée nommée, et ne change rien pour un identifiant inconnu', () => {
    const etat = remplie(3);
    assert.deepEqual(F.retirer(etat, 2).entrees.map(e => e.id), [1, 3]);
    assert.equal(F.retirer(etat, 2).prochain, etat.prochain, 'les identifiants ne sont jamais réutilisés');
    assert.deepEqual(F.retirer(etat, 99), etat);
    assert.deepEqual(F.retirer(etat, '1'), etat);
  });

  test('vider enlève tout, ou seulement l agent et la session donnés, et compte les entrées retirées', () => {
    let etat = remplie(2);
    etat = F.mettreEnFile(etat, { agent: 'codex', session: 'S1', description: 'x', demande: demande(8), maintenant: T0 }).etat;
    etat = F.mettreEnFile(etat, { agent: 'claude', session: 'S2', description: 'x', demande: demande(9), maintenant: T0 }).etat;
    assert.deepEqual([F.vider(etat).retirees, F.vider(etat).etat.entrees.length], [4, 0]);
    assert.deepEqual([F.vider(etat, 'claude').retirees, F.vider(etat, 'claude').etat.entrees.map(e => e.id)], [3, [3]]);
    assert.deepEqual([F.vider(etat, 'claude', 'S1').retirees, F.vider(etat, 'claude', 'S1').etat.entrees.map(e => e.id)], [2, [3, 4]]);
    assert.deepEqual([F.vider(etat, null, 'S1').retirees, F.vider(etat, null, 'S1').etat.entrees.map(e => e.id)], [3, [4]]);
    assert.equal(F.vider(etat).etat.prochain, etat.prochain);
    assert.deepEqual(F.vider(vide()), { etat: vide(), retirees: 0 });
  });

  test('purger avec une date invalide ne retire rien : une horloge cassée ne vide jamais la file', () => {
    const etat = remplie(3);
    for (const maintenant of [NaN, undefined, null, 'hier', Infinity]) assert.deepEqual(F.purger(etat, maintenant), { etat, retirees: 0 }, String(maintenant));
  });

  test('purger enlève les entrées de plus de six heures, pas celles de six heures pile', () => {
    const etat = F.mettreEnFile(F.mettreEnFile(vide(), { agent: 'claude', session: 'S1', description: 'a', demande: demande(1), maintenant: T0 }).etat, { agent: 'claude', session: 'S1', description: 'b', demande: demande(2), maintenant: T0 + 60 * MIN }).etat;
    assert.deepEqual(F.purger(etat, T0 + 6 * 60 * MIN).etat.entrees.map(e => e.id), [1, 2]);
    const p = F.purger(etat, T0 + 6 * 60 * MIN + 1);
    assert.deepEqual([p.etat.entrees.map(e => e.id), p.retirees], [[2], 1]);
    assert.deepEqual(F.purger(etat, T0 + 8 * 60 * MIN).etat.entrees, []);
    assert.equal(F.purger(etat, T0 + 8 * 60 * MIN).retirees, 2);
    assert.deepEqual(F.purger(vide(), T0), { etat: vide(), retirees: 0 });
  });
});

describe('relances des agents échoués', () => {
  test('une clé jamais relancée peut l être deux fois, pas trois', () => {
    let etat = vide();
    assert.deepEqual([F.relancesFaites(etat, 'A'), F.peutRelancer(etat, 'A')], [0, true]);
    etat = F.compterRelance(etat, 'A');
    assert.deepEqual([F.relancesFaites(etat, 'A'), F.peutRelancer(etat, 'A')], [1, true]);
    etat = F.compterRelance(etat, 'A');
    assert.deepEqual([F.relancesFaites(etat, 'A'), F.peutRelancer(etat, 'A')], [2, false]);
    etat = F.compterRelance(etat, 'A');
    assert.equal(F.relancesFaites(etat, 'A'), 2, 'le compteur ne dépasse pas le maximum');
  });

  test('chaque clé a son compteur, et oublier remet une clé à zéro', () => {
    let etat = F.compterRelance(F.compterRelance(vide(), 'A'), 'B');
    assert.deepEqual([F.relancesFaites(etat, 'A'), F.relancesFaites(etat, 'B')], [1, 1]);
    etat = F.oublierRelances(etat, 'A');
    assert.deepEqual([F.relancesFaites(etat, 'A'), F.relancesFaites(etat, 'B')], [0, 1]);
    assert.deepEqual(F.oublierRelances(vide(), 'Z'), vide());
  });

  test('une clé vide ou trop longue ne compte rien', () => {
    for (const cle of ['', 5, null, undefined, 'k'.repeat(201)]) {
      assert.deepEqual(F.compterRelance(vide(), cle), vide(), String(cle));
      assert.equal(F.peutRelancer(vide(), cle), false, String(cle));
    }
    assert.equal(F.peutRelancer(vide(), 'k'.repeat(200)), true);
  });

  test('un nom qui existe déjà sur tout objet (constructor, toString) ou qui vise le prototype n est jamais une relance faite', () => {
    for (const cle of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(F.relancesFaites(vide(), cle), 0, cle);
      assert.equal(F.peutRelancer(vide(), cle), true, cle);
      assert.equal(F.relancesFaites(F.compterRelance(vide(), cle), cle), 1, cle);
    }
    assert.deepEqual(F.compterRelance(vide(), '__proto__'), vide());
    assert.equal(F.peutRelancer(vide(), '__proto__'), false);
    assert.deepEqual(F.normaliserEtat(JSON.parse('{"relances":{"__proto__":1,"A":1}}')).relances, { A: 1 });
    assert.equal(Object.getPrototypeOf(F.compterRelance(vide(), 'A').relances), Object.prototype);
  });

  test('une clé invalide ne compte rien : ni tableau, ni objet qui ressemble à une chaîne', () => {
    for (const cle of [['A'], { length: 1 }]) {
      assert.deepEqual(F.compterRelance(vide(), cle), vide(), JSON.stringify(cle));
      assert.equal(F.peutRelancer(vide(), cle), false, JSON.stringify(cle));
    }
  });

  test('l état d origine n est pas modifié', () => {
    const etat = vide();
    F.compterRelance(etat, 'A');
    F.oublierRelances(F.compterRelance(etat, 'A'), 'A');
    assert.deepEqual(etat, vide());
  });
});

describe('textes', () => {
  test('le refus avec lancement par le code dit la position, le total, et de ne rien relancer', () => {
    const t = F.texteRefus({ position: 2, total: 5, mode: 'code' });
    assert.match(t, /^Régulateur d'agents : maximum atteint\. Cet agent est mis en file \(n° 2 sur 5\)/);
    assert.match(t, /lancé automatiquement dès qu'un créneau se libère/);
    assert.match(t, /sa réponse t'arrivera comme un message/);
    assert.match(t, /Ne le relance pas/);
    assert.ok(sansTiretLong(t));
  });

  test('le refus avec ordre au modèle dit que le Régulateur demandera le lancement, avec les mêmes arguments', () => {
    const t = F.texteRefus({ position: 1, total: 1, mode: 'modele' });
    assert.match(t, /^Régulateur d'agents : maximum atteint\. Cet agent est mis en file \(n° 1 sur 1\)/);
    assert.match(t, /Dès qu'un créneau se libère, le Régulateur te demandera de le lancer, avec exactement les mêmes arguments/);
    assert.match(t, /Ne le relance pas toi-même/);
    assert.ok(sansTiretLong(t));
    assert.notEqual(t, F.texteRefus({ position: 1, total: 1, mode: 'code' }));
  });

  test('le refus d une file pleine ou d une demande trop grande retombe sur le refus classique, avec la raison', () => {
    assert.match(F.texteRefusSansFile('pleine'), /^Régulateur d'agents : maximum atteint, et la file est pleine \(50 agents\)\. Ne lance pas celui-ci maintenant/);
    assert.match(F.texteRefusSansFile('trop-grande'), /^Régulateur d'agents : maximum atteint, et cette demande est trop grande pour la file \(60000 caractères au plus\)\. Ne lance pas celui-ci maintenant/);
    assert.match(F.texteRefusSansFile('invalide'), /^Régulateur d'agents : maximum atteint, et cette demande ne peut pas être mise en file\. Ne lance pas celui-ci maintenant/);
    assert.match(F.texteRefusSansFile('ecriture'), /^Régulateur d'agents : maximum atteint, et la file d'attente ne peut pas être écrite\. Ne lance pas celui-ci maintenant : dès qu'un agent finit, lance le suivant de ta liste\.$/);
    assert.ok(['pleine', 'trop-grande', 'invalide', 'ecriture'].every(r => sansTiretLong(F.texteRefusSansFile(r))));
    assert.match(F.texteRefusSansFile('inconnue'), /ne peut pas être mise en file/);
  });

  test('l ordre au modèle numérote les demandes, cite les créneaux libres et reste borné', () => {
    const e = F.prochaines(remplie(2), 'claude', 'S1', 5, T0);
    const t = F.texteOrdre(e, 2);
    assert.match(t, /^RÉGULATEUR D'AGENTS : 2 créneaux libres et 2 agents en file\. Lance maintenant, avec spawn_agent et exactement ces arguments, les agents suivants de la file\./);
    assert.match(t, new RegExp(`\\n1\\. ${F.signature(demande(1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n2\\. `));
    assert.match(t, /Ne lance rien d'autre/);
    assert.ok(sansTiretLong(t));
    const un = F.texteOrdre(F.prochaines(remplie(1), 'claude', 'S1', 5, T0), 1);
    assert.match(un, /^RÉGULATEUR D'AGENTS : 1 créneau libre et 1 agent en file\. Lance maintenant, avec spawn_agent et exactement ces arguments, l'agent suivant de la file\./);
  });

  test('zéro créneau libre s écrit au pluriel, comme tout nombre autre que un', () => {
    assert.match(F.texteOrdre(F.prochaines(remplie(1), 'claude', 'S1', 5, T0), 0), /^RÉGULATEUR D'AGENTS : 0 créneaux libres et 1 agent en file\./);
    assert.match(F.texteOrdre(F.prochaines(remplie(1), 'claude', 'S1', 5, T0), 3), /^RÉGULATEUR D'AGENTS : 3 créneaux libres et 1 agent en file\./);
  });

  test('le choix pour un ordre ne rend rien quand les créneaux ne sont pas un nombre entier de un ou plus, ou quand ce n est pas une liste', () => {
    const e = F.prochaines(remplie(3), 'claude', 'S1', 3, T0);
    for (const libres of [0, 1.5, '2', undefined, null, NaN, -1, Infinity]) assert.deepEqual(F.choisirPourOrdre(e, libres), [], String(libres));
    for (const entrees of [null, undefined, 'abc', {}, 5]) assert.deepEqual(F.choisirPourOrdre(entrees, 3), [], String(entrees));
  });

  test('les arguments de l ordre sont toujours écrits avec leurs clés triées, même pour une entrée non normalisée', () => {
    const t = F.texteOrdre([{ id: 1, demande: { zeta: 1, alpha: { y: 2, x: 1 } } }], 1);
    assert.match(t, /\n1\. \{"alpha":\{"x":1,"y":2\},"zeta":1\}\n/);
  });

  test('l ordre est complet à vingt mille caractères pile, une demande de plus est laissée au prochain ordre', () => {
    const taille = F.signature({ prompt: '' }).length;
    const dix = n => ({ prompt: `${n}`.padEnd(10000 - taille, 'x') });
    assert.equal(F.signature(dix(1)).length, 10000);
    let etat = vide();
    for (const d of [dix(1), dix(2), { prompt: 'y' }]) etat = F.mettreEnFile(etat, { agent: 'claude', session: 'S1', description: 'a', demande: d, maintenant: T0 }).etat;
    const e = F.prochaines(etat, 'claude', 'S1', 3, T0);
    assert.deepEqual(F.choisirPourOrdre(e, 3).map(x => x.id), [1, 2]);
    assert.deepEqual(F.choisirPourOrdre(e.slice(0, 2), 3).map(x => x.id), [1, 2], 'vingt mille pile passent');
  });

  test('sans plafond (créneaux inconnus), l ordre ne parle pas de créneaux', () => {
    const e = F.prochaines(remplie(2), 'claude', 'S1', 5, T0);
    const t = F.texteOrdre(e, null);
    assert.match(t, /^RÉGULATEUR D'AGENTS : 2 agents en file\. Lance maintenant, avec spawn_agent et exactement ces arguments, les agents suivants de la file\./);
    assert.doesNotMatch(t.split('\n')[0], /créneau/);
    assert.match(F.texteOrdre(e.slice(0, 1), undefined), /^RÉGULATEUR D'AGENTS : 1 agent en file\. Lance maintenant, avec spawn_agent et exactement ces arguments, l'agent suivant de la file\./);
    assert.match(F.texteOrdre(e, 1.5), /^RÉGULATEUR D'AGENTS : 2 agents en file\./);
    assert.match(F.texteOrdre(e, '2'), /^RÉGULATEUR D'AGENTS : 2 agents en file\./);
  });

  test('un ordre vide ne dit rien', () => {
    assert.equal(F.texteOrdre([], 3), null);
    assert.equal(F.texteOrdre(null, 3), null);
  });

  test('l ordre est borné à trois demandes et à vingt mille caractères, mais une demande seule passe toujours', () => {
    const six = F.prochaines(remplie(6), 'claude', 'S1', 6, T0);
    assert.equal(F.choisirPourOrdre(six, 6).length, 3);
    assert.equal(F.choisirPourOrdre(six, 2).length, 2, 'jamais plus que les créneaux libres');
    assert.equal(F.choisirPourOrdre(six, 0).length, 0);
    const grosses = F.prochaines(['A', 'B', 'C'].reduce((s, x, i) => ajout(s, 10 + i, { demande: { prompt: x.repeat(9000) } }).etat, vide()), 'claude', 'S1', 3, T0);
    assert.deepEqual(F.choisirPourOrdre(grosses, 3).map(e => e.id), [1, 2], 'la troisième ferait dépasser vingt mille caractères');
    const enorme = F.prochaines(ajout(vide(), 1, { demande: { prompt: 'x'.repeat(30000) } }).etat, 'claude', 'S1', 1, T0);
    assert.equal(F.choisirPourOrdre(enorme, 3).length, 1, 'une demande seule est toujours choisie');
  });

  test('l ordre de relance cite l agent échoué, son essai et le maximum', () => {
    const t = F.texteRelance([{ nom: 'Audit', essai: 1 }, { nom: 'Build', essai: 2 }]);
    assert.match(t, /^RÉGULATEUR D'AGENTS : 2 agents ont échoué\. Relance-les maintenant depuis leur point d'arrêt, sans repartir de zéro :/);
    assert.match(t, /\n1\. Audit \(relance 1 sur 2\)\n2\. Build \(relance 2 sur 2\)/);
    assert.match(F.texteRelance([{ nom: 'Audit', essai: 1 }]), /^RÉGULATEUR D'AGENTS : 1 agent a échoué\. Relance-le maintenant/);
    assert.equal(F.texteRelance([]), null);
    for (const x of [null, undefined, {}, 'abc', 5]) assert.equal(F.texteRelance(x), null, String(x));
    assert.ok(sansTiretLong(t));
  });

  test('le nom d un agent échoué est nettoyé, coupé à quarante caractères, et remplacé quand il est vide', () => {
    assert.match(F.texteRelance([{ nom: '  Audit\n final ', essai: 1 }]), /\n1\. Audit final \(relance 1 sur 2\)$/);
    assert.match(F.texteRelance([{ nom: 'N'.repeat(40), essai: 1 }]), new RegExp(`\\n1\\. ${'N'.repeat(40)} \\(relance`));
    assert.match(F.texteRelance([{ nom: 'N'.repeat(41), essai: 1 }]), new RegExp(`\\n1\\. ${'N'.repeat(37)}\\.\\.\\. \\(relance`));
    for (const nom of ['', undefined, null, 5]) assert.match(F.texteRelance([{ nom, essai: 2 }]), /\n1\. sans nom \(relance 2 sur 2\)$/, String(nom));
  });

  test('le message de /plafond file vider dit combien d agents ont été retirés', () => {
    assert.equal(F.texteVidee(0), "Agents : la file d'attente est déjà vide.");
    assert.equal(F.texteVidee(1), "Agents : file d'attente vidée (1 agent retiré).");
    assert.equal(F.texteVidee(2), "Agents : file d'attente vidée (2 agents retirés).");
    assert.equal(F.texteVidee(50), "Agents : file d'attente vidée (50 agents retirés).");
    for (const n of [-1, 1.5, '3', null, undefined, NaN]) assert.equal(F.texteVidee(n), "Agents : la file d'attente est déjà vide.", String(n));
    assert.ok([0, 1, 2].every(n => sansTiretLong(F.texteVidee(n))));
  });

  test('le statut de la file résume ce qui attend et ce qui est ordonné', () => {
    assert.equal(F.texteStatut(vide(), 'claude', 'S1'), undefined);
    const etat = F.ordonner(remplie(3), [1], T0);
    assert.equal(F.texteStatut(etat, 'claude', 'S1'), 'File : 2 en attente, 1 ordonné');
    assert.equal(F.texteStatut(remplie(1), 'claude', 'S1'), 'File : 1 en attente');
    assert.equal(F.texteStatut(remplie(2), 'claude', 'S1'), 'File : 2 en attente');
    assert.equal(F.texteStatut(remplie(2), 'claude', 'S2'), undefined);
    assert.equal(F.texteStatut(F.ordonner(remplie(1), [1], T0), 'claude', 'S1'), 'File : 0 en attente, 1 ordonné');
    assert.equal(F.texteStatut(F.ordonner(remplie(2), [1, 2], T0), 'claude', 'S1'), 'File : 0 en attente, 2 ordonnés');
  });

  test('le résumé compte les entrées, toutes sessions confondues, avec la plus ancienne', () => {
    assert.deepEqual(F.resume(vide()), { enAttente: 0, ordonnees: 0, plusAncienne: null });
    let etat = F.ordonner(remplie(3), [2], T0);
    etat = F.mettreEnFile(etat, { agent: 'codex', session: 'S9', description: 'x', demande: demande(9), maintenant: T0 - 30 * MIN }).etat;
    assert.deepEqual(F.resume(etat), { enAttente: 3, ordonnees: 1, plusAncienne: iso(T0 - 30 * MIN) });
    assert.deepEqual(F.resume(etat, 'claude'), { enAttente: 2, ordonnees: 1, plusAncienne: iso(T0 + MIN) });
    assert.deepEqual(F.resume(etat, 'codex'), { enAttente: 1, ordonnees: 0, plusAncienne: iso(T0 - 30 * MIN) });
    assert.deepEqual(F.resume(etat, 'agent-inconnu'), { enAttente: 0, ordonnees: 0, plusAncienne: null });
  });

  test('la plus ancienne entrée compte aussi quand elle est ordonnée', () => {
    const etat = F.ordonner(remplie(3), [1], T0 + 9 * MIN);
    assert.deepEqual(F.resume(etat), { enAttente: 2, ordonnees: 1, plusAncienne: iso(T0 + MIN) });
  });

  test('le message de fin d un agent suit l issue : terminé, relancé, abandonné, interrompu', () => {
    const fini = F.texteFinAgent({ description: 'Audit', issue: 'termine', reponse: 'Tout est bon.' });
    assert.equal(fini, "Régulateur d'agents : l'agent « Audit » (mis en file puis lancé automatiquement) a terminé. Sa réponse :\nTout est bon.");
    const relance = F.texteFinAgent({ description: 'Audit', issue: 'echec', essai: 1 });
    assert.equal(relance, "Régulateur d'agents : l'agent « Audit » a échoué. Il est relancé automatiquement (relance 1 sur 2).");
    assert.equal(F.texteFinAgent({ description: 'Audit', issue: 'echec', essai: 2 }), "Régulateur d'agents : l'agent « Audit » a échoué. Il est relancé automatiquement (relance 2 sur 2).");
    const abandon = F.texteFinAgent({ description: 'Audit', issue: 'abandon' });
    assert.equal(abandon, "Régulateur d'agents : l'agent « Audit » a échoué 3 fois (le premier lancement et 2 relances). Il n'est plus relancé : reprends-le toi-même si besoin.");
    const final = F.texteFinAgent({ description: 'Audit', issue: 'echec-final' });
    assert.equal(final, "Régulateur d'agents : l'agent « Audit » a échoué. Il n'est pas relancé automatiquement : reprends-le toi-même si besoin.");
    const stop = F.texteFinAgent({ description: 'Audit', issue: 'interrompu' });
    assert.equal(stop, "Régulateur d'agents : l'agent « Audit » a été interrompu. Il n'est pas relancé.");
    assert.ok([fini, relance, abandon, final, stop].every(sansTiretLong));
  });

  test('une réponse qui n est pas un texte est dite comme une absence de réponse', () => {
    for (const reponse of [5, { a: 1 }, ['x'], true, null]) {
      assert.match(F.texteFinAgent({ description: 'A', issue: 'termine', reponse }), /\nL'agent n'a rendu aucune réponse\.$/, JSON.stringify(reponse));
    }
  });

  test('une issue inconnue est dite comme une fin normale, jamais comme un échec ni un abandon', () => {
    for (const issue of [undefined, null, '', 'autre', 'ECHEC']) {
      const t = F.texteFinAgent({ description: 'Audit', issue, reponse: 'ok', essai: 1 });
      assert.equal(t, "Régulateur d'agents : l'agent « Audit » (mis en file puis lancé automatiquement) a terminé. Sa réponse :\nok", String(issue));
    }
  });

  test('la description d un agent est nettoyée et coupée dans les messages de fin', () => {
    assert.match(F.texteFinAgent({ description: '  deux\n lignes  ', issue: 'interrompu' }), /^Régulateur d'agents : l'agent « deux lignes » a été interrompu\./);
    assert.match(F.texteFinAgent({ description: 'x'.repeat(100), issue: 'interrompu' }), new RegExp(`« ${'x'.repeat(77)}\\.\\.\\. »`));
  });

  test('la réponse d un agent est rendue entière jusqu à soixante mille caractères, au delà elle est coupée en le disant', () => {
    const juste = 'r'.repeat(60000);
    assert.ok(F.texteFinAgent({ description: 'A', issue: 'termine', reponse: juste }).endsWith(`\n${juste}`));
    const trop = F.texteFinAgent({ description: 'A', issue: 'termine', reponse: `${juste}x` });
    assert.ok(trop.endsWith(`\n${juste}\n[réponse coupée : 60001 caractères, les 60000 premiers sont montrés]`));
    assert.match(F.texteFinAgent({ description: 'A', issue: 'termine', reponse: '' }), /\nL'agent n'a rendu aucune réponse\.$/);
    assert.match(F.texteFinAgent({ description: 'A', issue: 'termine' }), /\nL'agent n'a rendu aucune réponse\.$/);
    assert.match(F.texteFinAgent({ description: '', issue: 'termine', reponse: 'x' }), /^Régulateur d'agents : l'agent « sans description » \(mis en file/);
  });

  test('toutes les phrases produites restent sans tiret long', () => {
    const etat = F.ordonner(remplie(3), [1], T0);
    const textes = [
      F.texteRefus({ position: 1, total: 3, mode: 'code' }), F.texteRefus({ position: 1, total: 3, mode: 'modele' }),
      F.texteOrdre(F.prochaines(etat, 'claude', 'S1', 3, T0), 1), F.texteRelance([{ nom: 'A', essai: 1 }]), F.texteStatut(etat, 'claude', 'S1'),
    ];
    for (const t of textes) assert.ok(sansTiretLong(t), t);
  });
});
