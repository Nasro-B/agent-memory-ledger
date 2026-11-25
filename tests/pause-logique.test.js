'use strict';
// Bancs de la logique de la Pause : scripts/lib/pause-logique.mjs
// Module ES sans aucune dépendance : le même fichier est destiné à l'adaptateur Claude Code et chargé par require() par le noyau du Cockpit.
// Lancement : node --test tests/pause-logique.test.js
// Variable interne (preuves par mutation) : PAUSE_LOGIQUE_TESTE = fichier à tester (défaut : ../scripts/lib/pause-logique.mjs)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, describe } = require('node:test');

const L = require(process.env.PAUSE_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'pause-logique.mjs'));

const T0 = Date.parse('2026-03-03T12:00:00.000Z');
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const avant = ms => iso(T0 - ms);
const S1 = 'aaaa1111-0000-4000-8000-000000000001';
const S2 = 'bbbb2222-0000-4000-8000-000000000002';
const sansTiretLong = t => !/\u{2014}/u.test(t);

const agent = (nom = 'Revue', statut = 'running', pause = false, depuis = null) => ({ nom, statut, pause, depuis });
const session = (surcharge = {}) => ({ titre: '', vu: iso(T0), pause: false, depuis: null, agents: {}, ...surcharge });
const etatDe = sessions => ({ sessions });
// Deux sessions : la courante avec deux agents, une autre sans agent.
const deuxSessions = (s1 = {}, s2 = {}) => etatDe({
  [S1]: session({ titre: 'Principale', agents: { a1: agent('Revue'), a2: agent('Tests') }, ...s1 }),
  [S2]: session({ titre: 'Autre', ...s2 }),
});
const ctx = (surcharge = {}) => ({ session: S1, maintenant: T0, ...surcharge });

describe('état', () => {
  test('l\'état par défaut est inerte', () => {
    assert.deepEqual(L.etatParDefaut(), { sessions: {} });
    assert.deepEqual(L.doitAttendre(L.etatParDefaut(), S1), { attendre: false });
    assert.equal(L.texteBande(L.etatParDefaut(), S1, T0), undefined);
  });

  test('normaliserEtat garde les valeurs valides et retombe sur les défauts champ par champ', () => {
    const valide = etatDe({ [S1]: session({ titre: 'Mon titre', pause: true, depuis: avant(1000), agents: { a1: agent('Agent', 'running', true, avant(500)) } }) });
    assert.deepEqual(L.normaliserEtat(valide), valide);
    const abime = L.normaliserEtat({ sessions: { [S1]: { titre: 5, vu: 'x', pause: 'oui', depuis: 'pas une date', agents: 'x' } } });
    assert.deepEqual(abime, etatDe({ [S1]: session({ vu: null }) }));
    for (const pause of ['oui', 1, 0, null, {}, 'true']) assert.equal(L.normaliserEtat({ sessions: { [S1]: { pause } } }).sessions[S1].pause, false, `pause ${JSON.stringify(pause)}`);
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { vu: 'hier' } } }).sessions[S1].vu, null);
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { pause: true, depuis: 'hier' } } }).sessions[S1].depuis, null);
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { pause: true, depuis: avant(5) } } }).sessions[S1].depuis, avant(5));
    for (const brut of [null, undefined, [], 'x', 5, true, { sessions: [] }, { sessions: 'x' }]) assert.deepEqual(L.normaliserEtat(brut), { sessions: {} }, JSON.stringify(brut));
    assert.deepEqual(Object.keys(L.normaliserEtat({ sessions: { [S1]: { titre: 'a', autre: 1, maj: 'x' } }, maj: 'x' })), ['sessions']);
    assert.deepEqual(Object.keys(L.normaliserEtat({ sessions: { [S1]: { autre: 1 } } }).sessions[S1]).sort(), ['agents', 'depuis', 'pause', 'titre', 'vu']);
    assert.deepEqual(Object.keys(L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { autre: 1 } } } } }).sessions[S1].agents.a1).sort(), ['depuis', 'nom', 'pause', 'statut']);
  });

  test('les sessions et les agents qui ne sont pas des objets sont ignorés', () => {
    const e = L.normaliserEtat({ sessions: { a: 5, b: null, c: 'x', d: [], e: true, ok: { agents: { x: 5, y: null, z: 'a', w: [], v: { nom: 'bon' } } } } });
    assert.deepEqual(Object.keys(e.sessions), ['ok']);
    assert.deepEqual(Object.keys(e.sessions.ok.agents), ['v']);
    assert.deepEqual(L.normaliserEtat({ sessions: [{ pause: true }] }), { sessions: {} });
    assert.deepEqual(L.normaliserEtat({ sessions: { ok: { agents: [{ nom: 'x' }, { nom: 'y' }] } } }).sessions.ok.agents, {});
  });

  test('la date de début d\'un agent n\'existe que s\'il est en pause', () => {
    const a = L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { pause: false, depuis: avant(5) }, a2: { pause: true, depuis: avant(5) }, a3: { pause: true, depuis: 'x' } } } } }).sessions[S1].agents;
    assert.equal(a.a1.depuis, null);
    assert.equal(a.a2.depuis, avant(5));
    assert.equal(a.a3.depuis, null);
    for (const pause of ['oui', 1, null]) assert.equal(L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { pause } } } } }).sessions[S1].agents.a1.pause, false);
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { pause: false, depuis: avant(5) } } }).sessions[S1].depuis, null, 'une session qui n\'est pas en pause n\'a pas de date de début');
  });

  test('titres, noms et statuts tiennent sur une ligne et sont bornés', () => {
    const n = L.normaliserEtat({ sessions: { [S1]: { titre: `${'t'.repeat(80)}`, agents: { a1: { nom: 'n'.repeat(60), statut: 's'.repeat(30) } } } } }).sessions[S1];
    assert.equal(n.titre, `${'t'.repeat(57)}...`);
    assert.equal(n.agents.a1.nom, `${'n'.repeat(37)}...`);
    assert.equal(n.agents.a1.statut, `${'s'.repeat(17)}...`);
    const m = L.normaliserEtat({ sessions: { [S1]: { titre: '  un\n  titre\t sur  plusieurs lignes ', agents: { a1: { nom: 'a\r\nb' } } } } }).sessions[S1];
    assert.equal(m.titre, 'un titre sur plusieurs lignes');
    assert.equal(m.agents.a1.nom, 'a b');
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { titre: 't'.repeat(60) } } }).sessions[S1].titre, 't'.repeat(60));
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { nom: 'n'.repeat(40) } } } } }).sessions[S1].agents.a1.nom, 'n'.repeat(40));
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { statut: 's'.repeat(20) } } } } }).sessions[S1].agents.a1.statut, 's'.repeat(20));
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { titre: 't'.repeat(61) } } }).sessions[S1].titre, `${'t'.repeat(57)}...`);
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { nom: 'n'.repeat(41) } } } } }).sessions[S1].agents.a1.nom, `${'n'.repeat(37)}...`);
    assert.equal(L.normaliserEtat({ sessions: { [S1]: { agents: { a1: { statut: 's'.repeat(21) } } } } }).sessions[S1].agents.a1.statut, `${'s'.repeat(17)}...`);
  });

  test('les identifiants dangereux et les excédents sont écartés', () => {
    const brut = JSON.parse(`{"sessions":{"__proto__":{"pause":true},"":{"pause":true},"${'x'.repeat(129)}":{},"ok":{"agents":{"__proto__":{},"":{},"b":{}}}}}`);
    const etat = L.normaliserEtat(brut);
    assert.deepEqual(Object.keys(etat.sessions), ['ok']);
    assert.deepEqual(Object.keys(etat.sessions.ok.agents), ['b']);
    assert.equal(Object.getPrototypeOf(etat.sessions), Object.prototype);
    assert.equal(Object.getPrototypeOf(etat.sessions.ok.agents), Object.prototype);
    assert.deepEqual(Object.keys(L.normaliserEtat({ sessions: { ['y'.repeat(128)]: {} } }).sessions), ['y'.repeat(128)]);
    const trop = {};
    for (let i = 0; i < 25; i++) trop[`s${i}`] = { agents: Object.fromEntries(Array.from({ length: 60 }, (_, j) => [`a${j}`, {}])) };
    const borne = L.normaliserEtat({ sessions: trop }).sessions;
    assert.equal(Object.keys(borne).length, L.MAX_SESSIONS);
    assert.equal(Object.keys(borne.s0.agents).length, L.MAX_AGENTS);
    assert.deepEqual([L.MAX_SESSIONS, L.MAX_AGENTS, L.PREFIXE_MIN, L.AGE_SESSION_MORTE_MS], [20, 50, 4, 5 * MIN]);
  });
});

describe('battement', () => {
  test('inscrire crée la session et ses agents', () => {
    const r = L.inscrire(L.etatParDefaut(), { session: S1, titre: 'Chat', agents: [{ id: 'a1', nom: 'Revue', statut: 'running' }] }, T0);
    assert.deepEqual(r, etatDe({ [S1]: session({ titre: 'Chat', agents: { a1: agent('Revue', 'running') } }) }));
  });

  test('inscrire garde les pauses connues, retire les agents partis et ajoute les nouveaux', () => {
    const connu = etatDe({ [S1]: session({ titre: 'Chat', vu: avant(MIN), pause: true, depuis: avant(2 * MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } }) });
    const r = L.inscrire(connu, { session: S1, titre: 'Chat', agents: [{ id: 'a1', nom: 'Revue', statut: 'idle' }, { id: 'a3', nom: 'Neuf', statut: 'pending' }] }, T0);
    const s = r.sessions[S1];
    assert.equal(s.vu, iso(T0));
    assert.equal(s.pause, true);
    assert.equal(s.depuis, avant(2 * MIN));
    assert.deepEqual(Object.keys(s.agents), ['a1', 'a3']);
    assert.deepEqual(s.agents.a1, agent('Revue', 'idle', true, avant(MIN)));
    assert.deepEqual(s.agents.a3, agent('Neuf', 'pending'));
  });

  test('inscrire sans titre garde le titre précédent, avec un titre le remplace', () => {
    const connu = etatDe({ [S1]: session({ titre: 'Ancien' }) });
    assert.equal(L.inscrire(connu, { session: S1, agents: [] }, T0).sessions[S1].titre, 'Ancien');
    assert.equal(L.inscrire(connu, { session: S1, titre: '   ', agents: [] }, T0).sessions[S1].titre, 'Ancien');
    assert.equal(L.inscrire(connu, { session: S1, titre: 'Nouveau', agents: [] }, T0).sessions[S1].titre, 'Nouveau');
    assert.equal(L.inscrire(L.etatParDefaut(), { session: S1 }, T0).sessions[S1].titre, '');
  });

  test('inscrire ignore les agents illisibles et borne leur nombre', () => {
    const agents = [null, 5, {}, { id: '' }, { id: '__proto__' }, { id: 'ok', nom: 'Bon' }, ...Array.from({ length: 60 }, (_, i) => ({ id: `z${i}` }))];
    const s = L.inscrire(L.etatParDefaut(), { session: S1, agents }, T0).sessions[S1];
    assert.equal(Object.keys(s.agents).length, L.MAX_AGENTS);
    assert.equal(s.agents.ok.nom, 'Bon');
    assert.equal(Object.hasOwn(s.agents, '__proto__'), false);
    assert.equal(Object.getPrototypeOf(s.agents), Object.prototype);
    assert.deepEqual(Object.keys(L.inscrire(L.etatParDefaut(), { session: S1, agents: 'x' }, T0).sessions[S1].agents), []);
  });

  test('inscrire écarte une fiche ou un instant illisible sans rien changer', () => {
    const connu = deuxSessions();
    for (const fiche of [null, undefined, 5, 'x', [], {}, { session: '' }, { session: '__proto__' }, { session: 5 }, { session: 'a'.repeat(129) }]) {
      assert.deepEqual(L.inscrire(connu, fiche, T0), connu, JSON.stringify(fiche));
    }
    for (const t of [NaN, undefined, 'x', Infinity]) assert.deepEqual(L.inscrire(connu, { session: S1, titre: 'Autre titre' }, t), connu, String(t));
    const abime = L.inscrire({ sessions: { [S1]: { pause: 'oui' } } }, null, T0);
    assert.equal(abime.sessions[S1].pause, false);
  });

  test('inscrire garde l\'état tel quel, sessions mortes comprises, quand la fiche est illisible', () => {
    const avecMorte = etatDe({ vivante: session({ vu: iso(T0) }), morte: session({ vu: avant(10 * MIN), pause: true, depuis: avant(20 * MIN) }) });
    for (const fiche of [null, {}, { session: '' }]) assert.deepEqual(L.inscrire(avecMorte, fiche, T0), avecMorte, JSON.stringify(fiche));
    assert.deepEqual(L.inscrire(avecMorte, { session: 'vivante' }, NaN), avecMorte);
  });

  test('inscrire lit une liste d\'agents absente, vide ou mal formée comme aucun agent', () => {
    for (const agents of [undefined, null, {}, 5, 'x', true]) {
      assert.deepEqual(L.inscrire(L.etatParDefaut(), { session: S1, agents }, T0).sessions[S1].agents, {}, JSON.stringify(agents));
    }
  });

  test('inscrire ne confond pas un identifiant de session ou d\'agent avec une propriété de l\'objet', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
      const premier = L.inscrire(L.etatParDefaut(), { session: id, agents: [{ id, nom: 'N' }] }, T0);
      const s = premier.sessions[id];
      assert.equal(s.titre, '', id);
      assert.equal(s.pause, false, id);
      assert.equal(s.depuis, null, id);
      assert.deepEqual(s.agents[id], agent('N', ''), id);
      // second battement : la session et l'agent existent maintenant, et l'agent n'hérite de rien de l'objet
      const autre = L.inscrire(premier, { session: S1, agents: [{ id, nom: 'N2' }] }, T0);
      assert.deepEqual(autre.sessions[S1].agents[id], agent('N2', ''), id);
      const second = L.inscrire(premier, { session: id, agents: [{ id: `${id}x`, nom: 'M' }, { id, nom: 'N3' }] }, T0).sessions[id];
      assert.deepEqual(second.agents[`${id}x`], agent('M', ''), id);
      assert.deepEqual(second.agents[id], agent('N3', ''), id);
    }
    // une session déjà inscrite dont un agent porte un nom d'objet : le nouvel agent du même nom n'en hérite pas
    const avecPropre = L.inscrire(L.etatParDefaut(), { session: S1, agents: [{ id: 'a1' }] }, T0);
    for (const id of ['constructor', 'toString', 'valueOf']) {
      const r = L.inscrire(avecPropre, { session: S1, agents: [{ id, nom: 'Z' }] }, T0).sessions[S1].agents[id];
      assert.deepEqual(r, agent('Z', ''), id);
    }
  });

  test('inscrire borne le nom et le statut des agents', () => {
    const a = L.inscrire(L.etatParDefaut(), { session: S1, agents: [{ id: 'a1', nom: 'n'.repeat(60), statut: 's'.repeat(30) }, { id: 'a2', nom: '  a\nb ', statut: ' x\ty ' }] }, T0).sessions[S1].agents;
    assert.equal(a.a1.nom, `${'n'.repeat(37)}...`);
    assert.equal(a.a1.statut, `${'s'.repeat(17)}...`);
    assert.equal(a.a2.nom, 'a b');
    assert.equal(a.a2.statut, 'x y');
    assert.equal(L.inscrire(L.etatParDefaut(), { session: S1, titre: 't'.repeat(80) }, T0).sessions[S1].titre, `${'t'.repeat(57)}...`);
  });

  test('inscrire purge les sessions mortes et refuse la vingt et unième session vivante', () => {
    const vivantes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`v${i}`, session({ vu: avant(MIN) })]));
    const plein = L.inscrire(etatDe(vivantes), { session: 'neuve' }, T0);
    assert.equal(Object.hasOwn(plein.sessions, 'neuve'), false);
    assert.equal(Object.keys(plein.sessions).length, 20);
    const enMiseAJour = L.inscrire(etatDe(vivantes), { session: 'v3', titre: 'maj' }, T0);
    assert.equal(enMiseAJour.sessions.v3.titre, 'maj');
    assert.equal(enMiseAJour.sessions.v3.vu, iso(T0));
    const avecMorte = etatDe({ ...vivantes, v7: session({ vu: avant(10 * MIN), pause: true, depuis: avant(20 * MIN) }) });
    const libre = L.inscrire(avecMorte, { session: 'neuve' }, T0);
    assert.equal(Object.hasOwn(libre.sessions, 'neuve'), true);
    assert.equal(Object.hasOwn(libre.sessions, 'v7'), false);
    assert.equal(Object.keys(libre.sessions).length, 20);
  });

  test('purger retire les sessions sans battement lisible depuis plus de cinq minutes', () => {
    const etat = etatDe({
      pile: session({ vu: avant(5 * MIN) }),
      trop: session({ vu: avant(5 * MIN + 1) }),
      sans: session({ vu: null }),
      neuve: session({ vu: iso(T0) }),
      futur: session({ vu: iso(T0 + MIN) }),
    });
    const r = L.purger(etat, T0);
    assert.deepEqual(Object.keys(r.etat.sessions).sort(), ['futur', 'neuve', 'pile']);
    assert.equal(r.retirees, 2);
    assert.deepEqual(L.purger(etat, NaN), { etat: L.normaliserEtat(etat), retirees: 0 });
    assert.deepEqual(L.purger(deuxSessions(), T0), { etat: deuxSessions(), retirees: 0 });
  });
});

describe('décision d\'attente', () => {
  test('une session inconnue, un état illisible ou un identifiant piège n\'attendent jamais', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(MIN) });
    for (const id of ['inconnue', '', '__proto__', 'constructor', 'toString']) {
      assert.deepEqual(L.doitAttendre(etat, id), { attendre: false }, id);
      assert.deepEqual(L.doitAttendre(etat, id, 'a1'), { attendre: false }, `${id} avec un agent`);
    }
    for (const brut of [null, undefined, 'x', 5, [], { sessions: 'x' }]) assert.deepEqual(L.doitAttendre(brut, S1, 'a1'), { attendre: false });
    const etatAgent = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)) } });
    for (const aid of ['__proto__', 'constructor', 'toString', 'inconnu']) assert.deepEqual(L.doitAttendre(etatAgent, S1, aid), { attendre: false }, aid);
  });

  test('une session en pause fait attendre sa boucle principale et ses agents', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(3 * MIN) });
    assert.deepEqual(L.doitAttendre(etat, S1), { attendre: true, cible: 'session', depuis: avant(3 * MIN) });
    assert.deepEqual(L.doitAttendre(etat, S1, 'a1'), { attendre: true, cible: 'session', depuis: avant(3 * MIN) });
    assert.deepEqual(L.doitAttendre(etat, S1, 'inconnu'), { attendre: true, cible: 'session', depuis: avant(3 * MIN) });
    assert.deepEqual(L.doitAttendre(etat, S2), { attendre: false });
  });

  test('un agent en pause attend seul, sans arrêter sa session ni ses voisins', () => {
    const etat = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(2 * MIN)), a2: agent('Tests') } });
    assert.deepEqual(L.doitAttendre(etat, S1, 'a1'), { attendre: true, cible: 'agent', depuis: avant(2 * MIN) });
    assert.deepEqual(L.doitAttendre(etat, S1), { attendre: false });
    assert.deepEqual(L.doitAttendre(etat, S1, 'a2'), { attendre: false });
    assert.deepEqual(L.doitAttendre(etat, S2, 'a1'), { attendre: false });
  });

  test('la pause de la session prime sur celle de l\'agent', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(5 * MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)) } });
    assert.deepEqual(L.doitAttendre(etat, S1, 'a1'), { attendre: true, cible: 'session', depuis: avant(5 * MIN) });
  });
});

describe('commandes', () => {
  const pause = (args, etat = deuxSessions(), c = ctx()) => L.appliquerCommande('pause', args, etat, c);
  const reprise = (args, etat = deuxSessions(), c = ctx()) => L.appliquerCommande('reprendre', args, etat, c);

  test('/pause sans argument arrête la session courante et dit ce qui se passe', () => {
    const r = pause('');
    assert.equal(r.etat.sessions[S1].pause, true);
    assert.equal(r.etat.sessions[S1].depuis, iso(T0));
    assert.deepEqual(r.etat.sessions[S2], deuxSessions().sessions[S2]);
    assert.deepEqual(r.etat.sessions[S1].agents, deuxSessions().sessions[S1].agents);
    assert.match(r.message, /^Pause : cette session est en pause avec 2 agents\. /);
    assert.match(r.message, /avant sa prochaine étape/);
    // Un /reprendre tapé dans une session retenue reste en file jusqu'à la
    // fin de son tour, donc ne la libère pas : le message ne renvoie pas à la commande, il dit par où reprendre.
    assert.match(r.message, /Reprise : bouton Reprendre ou panneau Cockpit \(un \/reprendre tapé ici attendrait la fin du tour\)\.$/);
    for (const rien of [undefined, null]) assert.equal(pause(rien).etat.sessions[S1].pause, true);
    assert.equal(pause('session').etat.sessions[S1].pause, true);
    assert.match(L.appliquerCommande('pause', '', etatDe({ [S1]: session() }), ctx()).message, /^Pause : cette session est en pause\. /, 'sans agent, pas de « avec »');
    assert.match(L.appliquerCommande('pause', '', etatDe({ [S1]: session({ agents: { a1: agent() } }) }), ctx()).message, /en pause avec 1 agent\. /);
  });

  test('/pause visant une AUTRE session dit de la reprendre par /reprendre session, car la session qui tape n\'est pas retenue', () => {
    const r = pause('session bbbb');
    assert.equal(r.etat.sessions[S2].pause, true);
    assert.equal(r.etat.sessions[S1].pause, false);
    assert.match(r.message, /^Pause : la session bbbb2222 « Autre » est en pause\. /);
    assert.match(r.message, /Reprise : \/reprendre session bbbb2222\.$/);
    assert.ok(!r.message.includes('attendrait la fin du tour'));
    // Sans session courante (ligne de commande, bouton du Cockpit) : la session visée n'est jamais « cette session ».
    const cli = L.appliquerCommande('pause', '', deuxSessions(), { cible: S2, maintenant: T0 });
    assert.match(cli.message, /^Pause : la session bbbb2222 « Autre » est en pause\. /);
    assert.match(cli.message, /Reprise : \/reprendre session bbbb2222\.$/);
  });

  test('/pause sur une session déjà en pause ne change rien', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(3 * MIN) });
    const r = pause('', etat);
    assert.deepEqual(r.etat, etat);
    assert.equal(r.message, 'Pause : cette session est déjà en pause depuis 3 min.');
  });

  test('/reprendre lève la pause de la session et celles de ses agents', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } });
    const r = reprise('', etat);
    assert.deepEqual(r.etat, deuxSessions());
    assert.equal(r.message, 'Reprise : cette session reprend avec 2 agents.');
    const seul = reprise('', etatDe({ [S1]: session({ pause: true, depuis: avant(MIN) }) }));
    assert.equal(seul.message, 'Reprise : cette session reprend.');
    const agentsSeuls = reprise('', deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } }));
    assert.equal(agentsSeuls.etat.sessions[S1].agents.a1.pause, false);
    assert.equal(agentsSeuls.etat.sessions[S1].agents.a1.depuis, null);
    assert.match(agentsSeuls.message, /^Reprise : cette session reprend/);
  });

  test('/reprendre sur une session qui n\'est pas en pause ne change rien', () => {
    const etat = deuxSessions();
    const r = reprise('', etat);
    assert.deepEqual(r.etat, etat);
    assert.equal(r.message, 'Reprise : cette session n\'est pas en pause.');
  });

  test('/pause tout et /reprendre tout visent toutes les sessions', () => {
    const r = pause('tout');
    assert.equal(r.etat.sessions[S1].pause, true);
    assert.equal(r.etat.sessions[S2].pause, true);
    assert.equal(r.etat.sessions[S1].depuis, iso(T0));
    assert.match(r.message, /^Pause : tout est en pause \(2 sessions, leurs agents avec\)\. /);
    assert.match(r.message, /Reprise : bouton Reprendre ou panneau Cockpit, ou « node cockpit\.js reprendre tout » \(un \/reprendre tapé dans une session à l'arrêt attend la fin de son tour\)\.$/);
    for (const mot of ['toutes', 'tous', 'TOUT', '  Tout  ']) assert.equal(pause(mot).etat.sessions[S2].pause, true, mot);
    const dejaS1 = pause('tout', deuxSessions({ pause: true, depuis: avant(7 * MIN) })).etat.sessions[S1];
    assert.equal(dejaS1.depuis, avant(7 * MIN), 'une pause déjà en cours garde sa date');
    const toutDeja = deuxSessions({ pause: true, depuis: avant(MIN) }, { pause: true, depuis: avant(MIN) });
    assert.deepEqual(pause('tout', toutDeja), { etat: toutDeja, message: 'Pause : tout est déjà en pause (2 sessions).' });
    const reprisTout = reprise('tout', toutDeja);
    assert.deepEqual(reprisTout.etat, deuxSessions());
    assert.equal(reprisTout.message, 'Reprise : tout reprend (2 sessions reprises).');
    assert.equal(reprise('tout', deuxSessions({ pause: true, depuis: avant(MIN) })).message, 'Reprise : tout reprend (1 session reprise).');
    assert.deepEqual(reprise('tout', deuxSessions()), { etat: deuxSessions(), message: 'Reprise : rien n\'est en pause.' });
    assert.equal(reprise('tout', deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)) } })).etat.sessions[S1].agents.a1.pause, false, 'un agent seul en pause compte');
    assert.deepEqual(pause('tout', L.etatParDefaut()), { erreur: 'Aucune session ouverte dans l\'état de la pause.' });
    assert.deepEqual(reprise('tout', L.etatParDefaut()), { erreur: 'Aucune session ouverte dans l\'état de la pause.' });
    assert.equal(pause('tout').etat.sessions[S1].agents.a1.pause, false, 'tout arrête les sessions, pas la pause propre de leurs agents');
  });

  test('/pause session <ref> désigne une autre session par identifiant abrégé ou par titre', () => {
    const r = pause('session bbbb');
    assert.equal(r.etat.sessions[S2].pause, true);
    assert.equal(r.etat.sessions[S1].pause, false);
    assert.match(r.message, /^Pause : la session bbbb2222 « Autre » est en pause\. /);
    assert.equal(pause('session AUTR').etat.sessions[S2].pause, true, 'morceau du titre, casse ignorée');
    assert.equal(pause(`session ${S2}`).etat.sessions[S2].pause, true, 'identifiant complet');
    assert.equal(pause('session  autre ').etat.sessions[S2].pause, true, 'espaces ignorés');
    assert.match(pause('session bbb').erreur, /introuvable/, 'un préfixe de 3 caractères ne désigne rien');
    assert.match(pause('session 2222').erreur, /introuvable/, 'un morceau du milieu de l\'identifiant ne désigne rien');
    assert.equal(pause(`session ${S2.toUpperCase()}`).etat.sessions[S2].pause, true, 'identifiant complet, casse ignorée');
    assert.match(pause('session zzzz').erreur, /^Session « zzzz » introuvable/);
    assert.match(pause('session principale').message, /^Pause : cette session est en pause/, 'la courante se dit « cette session »');
    const ambigu = etatDe({ [S1]: session({ titre: 'Chat un' }), [S2]: session({ titre: 'Chat deux' }) });
    const e = pause('session chat', ambigu);
    assert.match(e.erreur, /^Session « chat » ambiguë : aaaa1111 « Chat un », bbbb2222 « Chat deux »\.$/);
    assert.equal('etat' in e, false);
    assert.equal(pause('session aaaa', ambigu).etat.sessions[S1].pause, true);
    assert.match(reprise(`session ${S2}`, deuxSessions({}, { pause: true, depuis: avant(MIN) })).message, /^Reprise : la session bbbb2222 « Autre » reprend\.$/);
  });

  test('/pause agent <ref> désigne un agent de la session par nom, identifiant ou préfixe', () => {
    const etat = etatDe({ [S1]: session({ agents: { a1b2c3d4: agent('Revue de code'), e5f6a7b8: agent('Tests') } }) });
    const r = pause('agent revue', etat);
    assert.equal(r.etat.sessions[S1].agents.a1b2c3d4.pause, true);
    assert.equal(r.etat.sessions[S1].agents.a1b2c3d4.depuis, iso(T0));
    assert.equal(r.etat.sessions[S1].agents.e5f6a7b8.pause, false);
    assert.equal(r.etat.sessions[S1].pause, false);
    assert.equal(r.message, 'Pause : l\'agent « Revue de code » est en pause. Reprise : /reprendre.');
    assert.equal(pause('agent a1b2', etat).etat.sessions[S1].agents.a1b2c3d4.pause, true, 'préfixe de 4 caractères');
    assert.equal(pause('agent E5F6A7B8', etat).etat.sessions[S1].agents.e5f6a7b8.pause, true, 'identifiant complet, casse ignorée');
    assert.match(pause('agent a1b', etat).erreur, /^Agent « a1b » introuvable/, 'préfixe de 3 caractères');
    assert.match(pause('agent absent', etat).erreur, /introuvable/);
    const deux = etatDe({ [S1]: session({ agents: { a1: agent('Revue 1'), a2: agent('Revue 2') } }) });
    assert.match(pause('agent revue', deux).erreur, /^Agent « revue » ambiguë : a1 « Revue 1 », a2 « Revue 2 »\.$/);
    assert.equal(pause('agent revue 2', deux).etat.sessions[S1].agents.a2.pause, true);
    assert.equal(pause('agent a1', deux).etat.sessions[S1].agents.a1.pause, true, 'identifiant exact plus court que le préfixe minimal');
    assert.equal(pause('agent', etat).erreur, 'Usage : /pause [tout | session [id ou titre] | agent <nom ou id> | agents | statut]');
    assert.match(pause('agent revue', etatDe({ [S1]: session({ agents: { a1: agent('') } }) })).erreur, /introuvable/);
    assert.equal(pause('agent a1', etatDe({ [S1]: session({ agents: { a1: agent('') } }) })).message, 'Pause : l\'agent « a1 » est en pause. Reprise : /reprendre.');
    const dejaPause = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } });
    assert.deepEqual(pause('agent revue', dejaPause), { etat: dejaPause, message: 'Pause : l\'agent « Revue » est déjà en pause.' });
  });

  test('les mots-clés et les références se lisent sans tenir compte de la casse', () => {
    const etat = etatDe({ [S1]: session({ titre: 'Principale', agents: { ABCD1234: agent('Revue'), a1: agent('Autre'), Xy: agent('Zorro') } }), [S2]: session({ titre: 'Seconde' }) });
    assert.equal(pause('agent xy', etat).etat.sessions[S1].agents.Xy.pause, true, 'identifiant court en majuscules, désigné en minuscules');
    assert.equal(pause('Agent  revue', etat).etat.sessions[S1].agents.ABCD1234.pause, true, 'mot-clé avec majuscule et avec reste');
    assert.equal(pause('AGENT revue', etat).etat.sessions[S1].agents.ABCD1234.pause, true);
    assert.equal(pause('SESSION seconde', etat).etat.sessions[S2].pause, true);
    assert.equal(pause('AGENTS', etat).etat.sessions[S1].agents.a1.pause, true);
    assert.equal(pause('agent abcd', etat).etat.sessions[S1].agents.ABCD1234.pause, true, 'préfixe en minuscules d\'un identifiant en majuscules');
    assert.equal(pause('agent ABCD1234', etat).etat.sessions[S1].agents.ABCD1234.pause, true, 'identifiant complet');
    assert.equal(pause('agent A1', etat).etat.sessions[S1].agents.a1.pause, true, 'identifiant exact plus court que le préfixe minimal, casse ignorée');
    assert.equal(pause('agent a1', etat).etat.sessions[S1].agents.ABCD1234.pause, false);
  });

  test('une référence introuvable ou ambiguë est dite en entier, et bornée si elle est longue', () => {
    const etat = etatDe({ [S1]: session({ agents: { a1: agent('Revue 1'), a2: agent('Revue 2') } }), [S2]: session({ titre: 'Chat un' }), autre: session({ titre: 'Chat deux' }) });
    assert.equal(pause('agent absent', etat).erreur, 'Agent « absent » introuvable (identifiants d\'au moins 4 caractères, ou un morceau du nom).');
    assert.equal(pause('session absente', etat).erreur, 'Session « absente » introuvable (identifiants d\'au moins 4 caractères, ou un morceau du nom).');
    const longue = 'x'.repeat(60);
    assert.equal(pause(`agent ${longue}`, etat).erreur, `Agent « ${'x'.repeat(37)}... » introuvable (identifiants d'au moins 4 caractères, ou un morceau du nom).`);
    assert.equal(pause(`session ${longue}`, etat).erreur, `Session « ${'x'.repeat(37)}... » introuvable (identifiants d'au moins 4 caractères, ou un morceau du nom).`);
    const ambigu = etatDe({ [S1]: session({ agents: { [`a${'1'.repeat(60)}`]: agent('Revue 1'), [`b${'2'.repeat(60)}`]: agent('Revue 2') } }) });
    assert.match(pause('agent revue', ambigu).erreur, /^Agent « revue » ambiguë : a1{7} « Revue 1 », b2{7} « Revue 2 »\.$/);
    const sansNom = etatDe({ [S1]: session({ agents: { aaaa1: agent(''), aaaa2: agent('') } }) });
    assert.equal(pause('agent aaaa', sansNom).erreur, 'Agent « aaaa » ambiguë : aaaa1, aaaa2.');
    const deuxMemes = etatDe({ [S1]: session({ titre: 'Même nom' }), [S2]: session({ titre: 'Même nom' }) });
    assert.equal(pause('session même', deuxMemes).erreur, 'Session « même » ambiguë : aaaa1111 « Même nom », bbbb2222 « Même nom ».');
    const refLongueAmbigue = etatDe({ [S1]: session({ titre: `${'x'.repeat(60)}` }), [S2]: session({ titre: `${'x'.repeat(60)} bis` }) });
    assert.equal(pause(`session ${'x'.repeat(10)}`, refLongueAmbigue).erreur.startsWith(`Session « ${'x'.repeat(10)} » ambiguë`), true);
    assert.equal(pause(`session ${'x'.repeat(50)}`, refLongueAmbigue).erreur.startsWith(`Session « ${'x'.repeat(37)}... » ambiguë`), true);
  });

  test('/reprendre agents lève seulement les pauses qui existent', () => {
    const mixte = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } });
    const r = reprise('agents', mixte);
    assert.equal(r.etat.sessions[S1].agents.a1.pause, false);
    assert.equal(r.etat.sessions[S1].agents.a1.depuis, null);
    assert.equal(r.etat.sessions[S1].agents.a2.pause, false);
    assert.equal(r.message, 'Reprise : 2 agents reprennent.');
    const sessionEnPause = deuxSessions({ pause: true, depuis: avant(MIN), agents: { a1: agent('Revue'), a2: agent('Tests') } });
    assert.equal(reprise('agents', sessionEnPause).message, 'Reprise : 2 agents n\'ont pas de pause propre, mais leur session est en pause (/reprendre la relance).');
    const sessionEtAgents = deuxSessions({ pause: true, depuis: avant(MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } });
    assert.equal(reprise('agents', sessionEtAgents).message, 'Reprise : 2 agents reprennent (leur session reste en pause).');
  });

  test('/pause agents arrête tous les agents sans toucher à la session', () => {
    const r = pause('agents');
    assert.equal(r.etat.sessions[S1].pause, false);
    assert.equal(r.etat.sessions[S1].agents.a1.pause, true);
    assert.equal(r.etat.sessions[S1].agents.a2.pause, true);
    assert.equal(r.message, 'Pause : 2 agents sont en pause. Reprise : /reprendre.');
    const un = pause('agents', etatDe({ [S1]: session({ agents: { a1: agent() } }) }));
    assert.equal(un.message, 'Pause : 1 agent est en pause. Reprise : /reprendre.');
    const garde = pause('agents', deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(9 * MIN)), a2: agent('Tests') } }));
    assert.equal(garde.etat.sessions[S1].agents.a1.depuis, avant(9 * MIN), 'un agent déjà en pause garde sa date');
    assert.equal(garde.etat.sessions[S1].agents.a2.depuis, iso(T0));
    const tousDeja = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests', 'running', true, avant(MIN)) } });
    assert.equal(pause('agents', tousDeja).message, 'Pause : 2 agents sont déjà en pause.');
    assert.deepEqual(pause('agents', etatDe({ [S1]: session() })), { etat: etatDe({ [S1]: session() }), message: 'Pause : aucun agent dans cette session.' });
    const repris = reprise('agents', tousDeja);
    assert.equal(repris.etat.sessions[S1].agents.a1.pause, false);
    assert.equal(repris.etat.sessions[S1].agents.a1.depuis, null);
    assert.equal(repris.message, 'Reprise : 2 agents reprennent.');
    assert.equal(reprise('agents').message, 'Reprise : 2 agents ne sont pas en pause.');
    assert.equal(pause('agents x').erreur, 'Usage : /pause [tout | session [id ou titre] | agent <nom ou id> | agents | statut]');
  });

  test('/reprendre agent : l\'avertissement quand la session est elle-même en pause', () => {
    const sessionEnPause = deuxSessions({ pause: true, depuis: avant(MIN), agents: { a1: agent('Revue'), a2: agent('Tests') } });
    const sansPropre = reprise('agent revue', sessionEnPause);
    assert.deepEqual(sansPropre.etat, sessionEnPause);
    assert.equal(sansPropre.message, 'Reprise : l\'agent « Revue » n\'a pas de pause propre, mais sa session est en pause (/reprendre la relance).');
    const avecPropre = deuxSessions({ pause: true, depuis: avant(MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } });
    const r = reprise('agent revue', avecPropre);
    assert.equal(r.etat.sessions[S1].agents.a1.pause, false);
    assert.equal(r.etat.sessions[S1].pause, true);
    assert.equal(r.message, 'Reprise : l\'agent « Revue » reprend (sa session reste en pause).');
    const simple = reprise('agent revue', deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } }));
    assert.equal(simple.message, 'Reprise : l\'agent « Revue » reprend.');
    assert.equal(reprise('agent revue').message, 'Reprise : l\'agent « Revue » n\'est pas en pause.');
  });

  test('/pause statut, etat, état et liste décrivent l\'état sans rien changer', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(3 * MIN) });
    for (const mot of ['statut', 'etat', 'état', 'liste', 'STATUT', ' Liste ']) {
      for (const sens of ['pause', 'reprendre']) {
        const r = L.appliquerCommande(sens, mot, etat, ctx());
        assert.deepEqual(r.etat, etat, `${sens} ${mot}`);
        assert.match(r.message, /^Pause : 2 sessions ouvertes, 1 en pause, 2 agents arrêtés\./);
      }
    }
    for (const sens of ['pause', 'reprendre']) {
      assert.match(L.appliquerCommande(sens, 'statut x', etat, ctx()).erreur, /^Usage : \/(pause|reprendre) \[/);
    }
    assert.equal(L.appliquerCommande('pause', 'statut', etat, ctx({ maintenant: NaN })).etat.sessions[S1].pause, true, 'le statut se lit même sans instant');
  });

  test('le statut montre chaque session, ses agents et ce qui les arrête', () => {
    const etat = etatDe({
      [S1]: session({ titre: 'Principale', pause: true, depuis: avant(3 * MIN), agents: { a1: agent('Revue', 'running') } }),
      [S2]: session({ titre: 'Autre', agents: { b1: agent('Seul', 'idle', true, avant(2 * MIN)), b2: agent('Libre', '') } }),
    });
    assert.equal(L.texteStatut(etat, S1, T0), [
      'Pause : 2 sessions ouvertes, 1 en pause, 2 agents arrêtés.',
      '- cette session aaaa1111 « Principale » : en pause depuis 3 min',
      '    agent a1 « Revue » (running) : arrêté par sa session',
      '- session bbbb2222 « Autre » : active',
      '    agent b1 « Seul » (idle) : en pause depuis 2 min',
      '    agent b2 « Libre » : actif',
    ].join('\n'));
    assert.equal(L.texteStatut(L.etatParDefaut(), S1, T0), 'Pause : aucune session ouverte dans l\'état.');
    assert.match(L.texteStatut(etatDe({ [S1]: session() }), S1, T0), /^Pause : 1 session ouverte, 0 en pause, 0 agent arrêté\.\n- cette session aaaa1111 : active$/);
    assert.match(L.texteStatut(etat, 'inconnue', T0), /\n- session aaaa1111 « Principale »/, 'sans « cette session » quand la session n\'est pas dans l\'état');
  });

  test('l\'usage est dit pour un mot inconnu ou un reste en trop, et rien ne change', () => {
    const usageP = 'Usage : /pause [tout | session [id ou titre] | agent <nom ou id> | agents | statut]';
    const usageR = 'Usage : /reprendre [tout | session [id ou titre] | agent <nom ou id> | agents | statut]';
    for (const args of ['bidule', 'tout le monde', 'agents x', 'agent', 'statut x', 'toutes x']) {
      assert.deepEqual(pause(args), { erreur: usageP }, args);
      assert.deepEqual(reprise(args), { erreur: usageR }, args);
    }
  });

  test('la fiche inscrit la session de la commande, sans fiche une session inconnue est refusée', () => {
    const fiche = { titre: 'Neuve', agents: [{ id: 'a1', nom: 'Revue', statut: 'running' }] };
    const r = L.appliquerCommande('pause', '', L.etatParDefaut(), ctx({ fiche }));
    assert.equal(r.etat.sessions[S1].pause, true);
    assert.equal(r.etat.sessions[S1].titre, 'Neuve');
    assert.deepEqual(Object.keys(r.etat.sessions[S1].agents), ['a1']);
    assert.match(r.message, /^Pause : cette session est en pause avec 1 agent\./);
    const e = L.appliquerCommande('pause', '', L.etatParDefaut(), ctx());
    assert.match(e.erreur, /^Cette session n'est pas dans l'état de la pause/);
    assert.match(L.appliquerCommande('pause', 'agents', L.etatParDefaut(), ctx()).erreur, /n'est pas dans l'état/);
    assert.match(L.appliquerCommande('pause', 'agent revue', L.etatParDefaut(), ctx()).erreur, /n'est pas dans l'état/);
    assert.match(L.appliquerCommande('pause', 'session', L.etatParDefaut(), ctx()).erreur, /n'est pas dans l'état/);
    assert.equal(L.appliquerCommande('pause', '', deuxSessions(), ctx({ fiche })).etat.sessions[S1].titre, 'Neuve');
  });

  test('sans session désignée (ligne de commande), seuls « tout » et le statut fonctionnent', () => {
    const sansSession = { maintenant: T0 };
    const dite = 'Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».';
    for (const args of ['', 'session', 'agents', 'agent revue']) {
      assert.deepEqual(L.appliquerCommande('pause', args, deuxSessions(), sansSession), { erreur: dite }, args);
      assert.deepEqual(L.appliquerCommande('reprendre', args, deuxSessions(), sansSession), { erreur: dite }, args);
    }
    for (const session of [undefined, null, '', '__proto__', 5]) assert.deepEqual(L.appliquerCommande('pause', '', deuxSessions(), { maintenant: T0, session }), { erreur: dite }, String(session));
    assert.match(L.appliquerCommande('pause', '', deuxSessions(), { maintenant: T0, session: 'fantome' }).erreur, /^Cette session n'est pas dans l'état de la pause/, 'une session valide mais inconnue garde son message');
    assert.equal(L.appliquerCommande('pause', 'tout', deuxSessions(), sansSession).etat.sessions[S1].pause, true);
    assert.match(L.appliquerCommande('pause', 'statut', deuxSessions(), sansSession).message, /^Pause : 2 sessions ouvertes/);
    assert.equal(L.appliquerCommande('pause', 'session bbbb', deuxSessions(), sansSession).etat.sessions[S2].pause, true, 'une session désignée par son identifiant se passe de session courante');
  });

  test('la cible est la session visée quand les arguments n\'en nomment aucune, la session courante reste « cette session »', () => {
    const sansCourante = { cible: S2, maintenant: T0 };
    const r = L.appliquerCommande('pause', '', deuxSessions(), sansCourante);
    assert.equal(r.etat.sessions[S2].pause, true);
    assert.equal(r.etat.sessions[S1].pause, false);
    assert.match(r.message, /^Pause : la session bbbb2222 « Autre » est en pause\./);
    assert.match(L.appliquerCommande('reprendre', '', deuxSessions({}, { pause: true, depuis: avant(MIN) }), sansCourante).message, /^Reprise : la session bbbb2222 « Autre » reprend\.$/);
    const avecCourante = L.appliquerCommande('pause', '', deuxSessions(), { session: S1, cible: S2, maintenant: T0 });
    assert.equal(avecCourante.etat.sessions[S2].pause, true, 'la cible prime sur la session courante');
    assert.equal(avecCourante.etat.sessions[S1].pause, false);
    assert.match(avecCourante.message, /^Pause : la session bbbb2222/);
    assert.match(L.appliquerCommande('pause', 'session', deuxSessions(), { session: S1, cible: S2, maintenant: T0 }).message, /^Pause : la session bbbb2222/, 'le mot session sans référence vise aussi la cible');
    assert.match(L.appliquerCommande('pause', '', deuxSessions(), { session: S1, cible: S1, maintenant: T0 }).message, /^Pause : cette session est en pause/, 'la cible est la courante');
    assert.match(L.appliquerCommande('pause', 'agent revue', deuxSessions(), sansCourante).erreur, /^Agent « revue » introuvable/, 'la session visée (S2) n\'a aucun agent, ceux de S1 ne comptent pas');
    const deuxAvecAgents = etatDe({ [S1]: session({ agents: { a1: agent('Revue') } }), [S2]: session({ agents: { b1: agent('Revue de la cible') } }) });
    const surCible = L.appliquerCommande('pause', 'agent revue', deuxAvecAgents, { session: S1, cible: S2, maintenant: T0 });
    assert.equal(surCible.etat.sessions[S2].agents.b1.pause, true, 'les agents sont cherchés dans la session visée');
    assert.equal(surCible.etat.sessions[S1].agents.a1.pause, false);
    assert.equal(L.appliquerCommande('pause', 'agents', deuxAvecAgents, { cible: S1, maintenant: T0 }).etat.sessions[S1].agents.a1.pause, true);
    assert.match(L.appliquerCommande('pause', '', deuxSessions(), { session: S1, cible: 'fantome', maintenant: T0 }).erreur, /^Cette session n'est pas dans l'état de la pause/);
    assert.match(L.appliquerCommande('pause', 'agents', deuxSessions(), { session: S1, cible: 'fantome', maintenant: T0 }).erreur, /^Cette session n'est pas dans l'état de la pause/);
    assert.match(L.appliquerCommande('pause', '', deuxSessions(), { session: S1, cible: 5, maintenant: T0 }).erreur, /^Aucune session désignée/, 'une cible mal typée n\'est pas remplacée par la session courante');
    for (const cible of ['', 0, false]) assert.match(L.appliquerCommande('pause', '', deuxSessions(), { session: S1, cible, maintenant: T0 }).erreur, /^Aucune session désignée/, `cible ${JSON.stringify(cible)}`);
    for (const cible of [undefined, null]) assert.equal(L.appliquerCommande('pause', '', deuxSessions(), { session: S1, cible, maintenant: T0 }).etat.sessions[S1].pause, true, `sans cible (${cible})`);
    assert.equal(L.appliquerCommande('pause', 'session aaaa', deuxSessions(), { session: S2, cible: S2, maintenant: T0 }).etat.sessions[S1].pause, true, 'une référence dans les arguments prime sur la cible');
  });

  test('trouverSession retrouve une session par identifiant, début d\'identifiant ou titre', () => {
    const etat = deuxSessions();
    assert.deepEqual(L.trouverSession(etat, S1), { id: S1 });
    assert.deepEqual(L.trouverSession(etat, 'bbbb'), { id: S2 });
    assert.deepEqual(L.trouverSession(etat, 'AUTRE'), { id: S2 });
    assert.deepEqual(L.trouverSession(etat, '  principale '), { id: S1 });
    assert.match(L.trouverSession(etat, 'zzzz').erreur, /^Session « zzzz » introuvable/);
    assert.match(L.trouverSession(etatDe({ [S1]: session({ titre: 'Chat 1' }), [S2]: session({ titre: 'Chat 2' }) }), 'chat').erreur, /^Session « chat » ambiguë/);
    for (const ref of ['', '   ', undefined, null, 5, {}]) assert.deepEqual(L.trouverSession(etat, ref), { erreur: 'Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».' }, String(ref));
    assert.match(L.trouverSession(null, 'bbbb').erreur, /introuvable/);
  });

  test('un instant illisible refuse toute modification', () => {
    for (const maintenant of [NaN, undefined, 'x']) {
      for (const args of ['', 'tout', 'agents', 'agent revue', 'session']) {
        assert.deepEqual(L.appliquerCommande('pause', args, deuxSessions(), ctx({ maintenant })), { erreur: 'Pause : instant illisible, rien n\'a changé.' }, `${args} ${maintenant}`);
      }
    }
    assert.deepEqual(L.appliquerCommande('pause', 'bidule', deuxSessions(), ctx({ maintenant: NaN })), { erreur: 'Pause : instant illisible, rien n\'a changé.' });
    assert.equal(L.appliquerCommande('pause', '', deuxSessions(), { session: S1 }).erreur, 'Pause : instant illisible, rien n\'a changé.');
  });

  test('la commande lit un état abîmé comme un état vide', () => {
    for (const brut of [null, undefined, 'x', 5, []]) {
      assert.match(L.appliquerCommande('pause', '', brut, ctx()).erreur, /n'est pas dans l'état/);
      assert.equal(L.appliquerCommande('pause', '', brut, ctx({ fiche: { titre: 't' } })).etat.sessions[S1].pause, true);
    }
    assert.deepEqual(L.appliquerCommande('pause', '', deuxSessions()).erreur, 'Pause : instant illisible, rien n\'a changé.', 'sans contexte');
  });
});

describe('textes', () => {
  test('texteDuree : moins d\'une minute, minutes, heures et jours', () => {
    for (const ms of [0, 1, 59_999, -5, NaN, Infinity, undefined, null, 'x']) assert.equal(L.texteDuree(ms), 'moins d\'une minute', String(ms));
    assert.equal(L.texteDuree(MIN), '1 min');
    assert.equal(L.texteDuree(59 * MIN + 59_999), '59 min');
    assert.equal(L.texteDuree(60 * MIN), '1 h 00');
    assert.equal(L.texteDuree(65 * MIN), '1 h 05');
    assert.equal(L.texteDuree(47 * 60 * MIN + 59 * MIN), '47 h 59');
    assert.equal(L.texteDuree(48 * 60 * MIN), '2 j 0 h');
    assert.equal(L.texteDuree(100 * 60 * MIN), '4 j 4 h');
  });

  test('resume compte les sessions, les agents arrêtés et décrit la session demandée', () => {
    const etat = etatDe({
      [S1]: session({ titre: 'Principale', pause: true, depuis: avant(MIN), agents: { a1: agent('Revue', 'running'), a2: agent('Tests', 'idle', true, avant(MIN)) } }),
      [S2]: session({ titre: 'Autre', agents: { b1: agent('Seul', 'running', true, avant(2 * MIN)), b2: agent('Libre') } }),
    });
    const r = L.resume(etat, S1);
    assert.equal(r.sessions, 2);
    assert.equal(r.sessionsEnPause, 1);
    assert.equal(r.agentsArretes, 3);
    assert.deepEqual(r.cette, {
      pause: true,
      depuis: avant(MIN),
      titre: 'Principale',
      agents: [
        { id: 'a1', nom: 'Revue', statut: 'running', propre: false, arrete: true, depuis: null },
        { id: 'a2', nom: 'Tests', statut: 'idle', propre: true, arrete: true, depuis: avant(MIN) },
      ],
    });
    assert.deepEqual(L.resume(etat, S2).cette.agents.map(a => [a.id, a.propre, a.arrete]), [['b1', true, true], ['b2', false, false]]);
    assert.equal(L.resume(etat, 'inconnue').cette, null);
    assert.equal(L.resume(etat, '__proto__').cette, null);
    assert.deepEqual(L.resume(null, S1), { sessions: 0, sessionsEnPause: 0, agentsArretes: 0, cette: null });
  });

  test('listeSessions décrit chaque session et ses agents pour le panneau', () => {
    const etat = etatDe({
      [S1]: session({ titre: 'Principale', pause: true, depuis: avant(MIN), agents: { a1: agent('Revue', 'running'), a2: agent('Tests', 'idle', true, avant(2 * MIN)) } }),
      [S2]: session({ titre: 'Autre', vu: avant(MIN), agents: { b1: agent('Seul', 'running', true, avant(3 * MIN)), b2: agent('Libre', '') } }),
    });
    assert.deepEqual(L.listeSessions(etat), [
      {
        id: S1, court: 'aaaa1111', titre: 'Principale', vu: iso(T0), pause: true, depuis: avant(MIN),
        agents: [
          { id: 'a1', nom: 'Revue', statut: 'running', propre: false, arrete: true, depuis: null },
          { id: 'a2', nom: 'Tests', statut: 'idle', propre: true, arrete: true, depuis: avant(2 * MIN) },
        ],
      },
      {
        id: S2, court: 'bbbb2222', titre: 'Autre', vu: avant(MIN), pause: false, depuis: null,
        agents: [
          { id: 'b1', nom: 'Seul', statut: 'running', propre: true, arrete: true, depuis: avant(3 * MIN) },
          { id: 'b2', nom: 'Libre', statut: '', propre: false, arrete: false, depuis: null },
        ],
      },
    ]);
    for (const brut of [null, undefined, 'x', 5, [], {}, { sessions: 'x' }]) assert.deepEqual(L.listeSessions(brut), [], JSON.stringify(brut));
  });

  test('la bande dit ce qui est à l\'arrêt et s\'efface sinon', () => {
    assert.equal(L.texteBande(deuxSessions(), S1, T0), undefined);
    assert.equal(L.texteBande(deuxSessions({ pause: true, depuis: avant(3 * MIN) }), S1, T0), 'Pause : cette session en pause depuis 3 min');
    assert.equal(L.texteBande(deuxSessions({ pause: true, depuis: avant(3 * MIN) }), S1, NaN), 'Pause : cette session en pause');
    const unAgent = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } });
    assert.equal(L.texteBande(unAgent, S1, T0), 'Pause : 1 agent en pause');
    const deuxAgents = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests', 'running', true, avant(MIN)) } });
    assert.equal(L.texteBande(deuxAgents, S1, T0), 'Pause : 2 agents en pause');
    assert.equal(L.texteBande(deuxSessions({}, { pause: true, depuis: avant(MIN) }), S1, T0), 'Pause : 1 autre session en pause');
    const troisSessions = etatDe({ [S1]: session(), [S2]: session({ pause: true, depuis: avant(MIN) }), x: session({ pause: true, depuis: avant(MIN) }) });
    assert.equal(L.texteBande(troisSessions, S1, T0), 'Pause : 2 autres sessions en pause');
    const tout = deuxSessions({ pause: true, depuis: avant(MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)) } }, { pause: true, depuis: avant(MIN) });
    assert.equal(L.texteBande(tout, S1, T0), 'Pause : cette session en pause depuis 1 min ; 1 autre session en pause', 'les agents d\'une session en pause ne sont pas recomptés');
    const cumul = deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)) } }, { pause: true, depuis: avant(MIN) });
    assert.equal(L.texteBande(cumul, S1, T0), 'Pause : 1 agent en pause ; 1 autre session en pause');
    assert.equal(L.texteBande(deuxSessions({ pause: true, depuis: avant(MIN) }), 'inconnue', T0), 'Pause : 1 autre session en pause', 'session inconnue : toutes les pauses sont celles des autres');
  });

  test('la ligne d\'attente dit qui est à l\'arrêt, depuis quand, et comment reprendre', () => {
    // Une session retenue ne traite pas un /reprendre tapé (il attend la fin de son tour) : son texte renvoie au bouton et au panneau, pas à la commande.
    // Un agent retenu seul, lui, laisse la session principale libre : un /reprendre tapé dans celle-ci marche.
    assert.equal(L.texteAttente('session', avant(3 * MIN), T0), 'Pause : cette session est à l\'arrêt depuis 3 min (reprise : bouton Reprendre ou panneau Cockpit, pas /reprendre)');
    assert.equal(L.texteAttente('agent', avant(3 * MIN), T0), 'Pause : cet agent est à l\'arrêt depuis 3 min (reprise : bouton Reprendre ou /reprendre)');
    assert.equal(L.texteAttente('session', null, T0), 'Pause : cette session est à l\'arrêt (reprise : bouton Reprendre ou panneau Cockpit, pas /reprendre)');
    assert.equal(L.texteAttente('session', avant(3 * MIN), NaN), 'Pause : cette session est à l\'arrêt (reprise : bouton Reprendre ou panneau Cockpit, pas /reprendre)');
    assert.equal(L.texteAttente(undefined, null, T0).startsWith('Pause : cette session est'), true);
  });

  test('aucun texte ne contient de tiret cadratin', () => {
    const etat = deuxSessions({ pause: true, depuis: avant(MIN) });
    const textes = [
      L.texteBande(etat, S1, T0), L.texteStatut(etat, S1, T0), L.texteAttente('session', avant(MIN), T0), L.texteAttente('agent', null, T0),
      ...['', 'tout', 'agents', 'agent revue', 'statut', 'session bbbb', 'bidule', 'session zzzz'].flatMap(a => ['pause', 'reprendre'].map(s => {
        const r = L.appliquerCommande(s, a, etat, ctx());
        return r.message ?? r.erreur;
      })),
    ];
    for (const t of textes) assert.equal(sansTiretLong(t), true, t);
  });
});
