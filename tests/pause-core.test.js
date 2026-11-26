'use strict';
// Bancs des entrées-sorties de la Pause (scripts/lib/pause-core.js) et des commandes `cockpit.js pause`, `reprendre` et `pause-hook`.
// Lancement : node --test tests/pause-core.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variables internes (preuves par mutation) : PAUSE_CORE_TESTE = fichier à tester (défaut : ../scripts/lib/pause-core.js),
//   COCKPIT_CLI_TESTE = ligne de commande à tester (défaut : ../scripts/cockpit.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const CORE = process.env.PAUSE_CORE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'pause-core.js');
const CLI = process.env.COCKPIT_CLI_TESTE || path.join(__dirname, '..', 'scripts', 'cockpit.js'); // COCKPIT_CLI_TESTE : preuves par mutation de la ligne de commande
const pause = require(CORE);

// L'instant du banc est l'instant réel : les commandes sans instant donné datent de maintenant, et les sessions du banc doivent être vivantes.
const T0 = Date.now();
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const avant = ms => iso(T0 - ms);
const S1 = 'aaaa1111-0000-4000-8000-000000000001';
const S2 = 'bbbb2222-0000-4000-8000-000000000002';

let n = 0;
let RUN;
let FICHIER;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `pause-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison'); // jamais la vraie maison de l'utilisateur
  FICHIER = path.join(process.env.COCKPIT_DIR, 'pause.json');
});

const brut = () => JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
const poser = valeur => { fs.mkdirSync(path.dirname(FICHIER), { recursive: true }); fs.writeFileSync(FICHIER, typeof valeur === 'string' ? valeur : JSON.stringify(valeur)); };
const session = (surcharge = {}) => ({ titre: '', vu: iso(T0), pause: false, depuis: null, agents: {}, ...surcharge });
const agent = (nom = 'Revue', statut = 'running', pausee = false, depuis = null) => ({ nom, statut, pause: pausee, depuis });
// Deux sessions vivantes ; la première a deux agents.
const deuxSessions = (s1 = {}, s2 = {}) => ({
  sessions: {
    [S1]: session({ titre: 'Principale', agents: { a1: agent('Revue'), a2: agent('Tests') }, ...s1 }),
    [S2]: session({ titre: 'Autre', ...s2 }),
  },
});

describe('lire et écrire l\'état', () => {
  test('sans fichier, l\'état est vide et rien n\'est créé', () => {
    assert.deepEqual(pause.lireEtat(), { sessions: {} });
    assert.equal(fs.existsSync(FICHIER), false);
    assert.deepEqual(pause.doitAttendre(S1), { attendre: false });
    assert.equal(fs.existsSync(FICHIER), false);
  });

  test('un fichier abîmé ou mal typé se lit comme vide, champ par champ', () => {
    poser('{pas du json');
    assert.deepEqual(pause.lireEtat(), { sessions: {} });
    assert.deepEqual(pause.doitAttendre(S1, 'a1'), { attendre: false });
    poser('"texte"');
    assert.deepEqual(pause.lireEtat(), { sessions: {} });
    poser({ sessions: { [S1]: { pause: 'oui', titre: 5, agents: 'x' } } });
    assert.deepEqual(pause.lireEtat(), { sessions: { [S1]: session({ vu: null }) } });
    poser(`\uFEFF${JSON.stringify(deuxSessions())}`);
    assert.deepEqual(Object.keys(pause.lireEtat().sessions), [S1, S2], 'un fichier écrit avec une marque d\'ordre des octets se lit');
  });

  test('ecrireEtat écrit l\'état normalisé et l\'heure de la modification', () => {
    pause.ecrireEtat({ sessions: { [S1]: { pause: 'oui', titre: 'T', vu: iso(T0), autre: 1 } }, extra: 1 });
    const e = brut();
    assert.deepEqual(Object.keys(e).sort(), ['maj', 'sessions']);
    assert.deepEqual(e.sessions, { [S1]: session({ titre: 'T' }) });
    assert.ok(Math.abs(Date.parse(e.maj) - Date.now()) < 60_000);
  });
});

describe('battre', () => {
  test('inscrit la session, ses agents et son battement', () => {
    const r = pause.battre({ session: S1, titre: 'Chat', agents: [{ id: 'a1', nom: 'Revue', statut: 'running' }], maintenant: T0 });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(brut().sessions, { [S1]: session({ titre: 'Chat', agents: { a1: agent('Revue', 'running') } }) });
  });

  test('un battement garde les pauses et met à jour la liste des agents', () => {
    poser(deuxSessions({ vu: avant(MIN), pause: true, depuis: avant(2 * MIN), agents: { a1: agent('Revue', 'running', true, avant(MIN)) } }));
    pause.battre({ session: S1, titre: 'Principale', agents: [{ id: 'a1', nom: 'Revue', statut: 'idle' }, { id: 'a9', nom: 'Neuf', statut: 'pending' }], maintenant: T0 });
    const s = brut().sessions[S1];
    assert.equal(s.pause, true);
    assert.equal(s.depuis, avant(2 * MIN));
    assert.equal(s.vu, iso(T0));
    assert.deepEqual(s.agents, { a1: agent('Revue', 'idle', true, avant(MIN)), a9: agent('Neuf', 'pending') });
    assert.equal(brut().sessions[S2].titre, 'Autre', 'les autres sessions restent');
  });

  test('une fiche illisible ne change rien et n\'écrit rien', () => {
    assert.deepEqual(pause.battre({ session: '', maintenant: T0 }), { ok: false });
    assert.deepEqual(pause.battre({ session: undefined, maintenant: T0 }), { ok: false });
    assert.deepEqual(pause.battre({ session: 5, maintenant: T0 }), { ok: false });
    assert.deepEqual(pause.battre({ session: '__proto__', maintenant: T0 }), { ok: false });
    assert.equal(fs.existsSync(FICHIER), false);
  });

  test('l\'état plein de sessions vivantes refuse une nouvelle session, les mortes sont purgées', () => {
    const vivantes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`v${i}`, session({ vu: iso(T0) })]));
    poser({ sessions: vivantes });
    assert.deepEqual(pause.battre({ session: 'neuve', maintenant: T0 }), { ok: false });
    assert.equal(Object.hasOwn(brut().sessions, 'neuve'), false);
    poser({ sessions: { ...vivantes, v3: session({ vu: avant(10 * MIN), pause: true, depuis: avant(20 * MIN) }) } });
    assert.deepEqual(pause.battre({ session: 'neuve', maintenant: T0 }), { ok: true });
    assert.equal(Object.hasOwn(brut().sessions, 'v3'), false);
    assert.equal(Object.keys(brut().sessions).length, 20);
  });

  test('sans instant donné, le battement date de maintenant', () => {
    pause.battre({ session: S1 });
    assert.ok(Math.abs(Date.parse(brut().sessions[S1].vu) - Date.now()) < 60_000);
  });
});

describe('appliquerCommande', () => {
  const ctx = (surcharge = {}) => ({ session: S1, maintenant: T0, ...surcharge });

  test('/pause arrête la session, l\'écrit et dit le message', () => {
    poser(deuxSessions());
    const r = pause.appliquerCommande('pause', '', ctx());
    assert.match(r.message, /^Pause : cette session est en pause avec 2 agents\./);
    assert.equal(brut().sessions[S1].pause, true);
    assert.equal(brut().sessions[S1].depuis, iso(T0));
    assert.equal(brut().sessions[S2].pause, false);
    assert.deepEqual(pause.doitAttendre(S1), { attendre: true, cible: 'session', depuis: iso(T0) });
    assert.deepEqual(pause.doitAttendre(S1, 'a1'), { attendre: true, cible: 'session', depuis: iso(T0) });
  });

  test('/reprendre lève la pause et l\'écrit', () => {
    poser(deuxSessions({ pause: true, depuis: avant(MIN) }));
    const r = pause.appliquerCommande('reprendre', '', ctx());
    assert.match(r.message, /^Reprise : cette session reprend/);
    assert.equal(brut().sessions[S1].pause, false);
    assert.deepEqual(pause.doitAttendre(S1), { attendre: false });
  });

  test('une commande sans effet n\'écrit pas dans le fichier', () => {
    poser(deuxSessions());
    const avantContenu = fs.readFileSync(FICHIER, 'utf8');
    const r = pause.appliquerCommande('reprendre', '', ctx());
    assert.match(r.message, /n'est pas en pause/);
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avantContenu);
    const statut = pause.appliquerCommande('pause', 'statut', ctx());
    assert.match(statut.message, /^Pause : 2 sessions ouvertes/);
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avantContenu);
  });

  test('une erreur ne change rien et n\'écrit rien', () => {
    poser(deuxSessions());
    const avantContenu = fs.readFileSync(FICHIER, 'utf8');
    for (const args of ['bidule', 'agent', 'session zzzz', 'agent absent']) {
      const r = pause.appliquerCommande('pause', args, ctx());
      assert.equal(typeof r.erreur, 'string', args);
      assert.equal('message' in r, false, args);
    }
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avantContenu);
  });

  test('un sens inconnu est refusé', () => {
    poser(deuxSessions());
    for (const sens of ['arreter', '', undefined, 'PAUSE']) assert.equal(pause.appliquerCommande(sens, '', ctx()).erreur, `Sens inconnu : ${String(sens)} (pause ou reprendre).`, String(sens));
  });

  test('la fiche inscrit la session avant la commande', () => {
    const r = pause.appliquerCommande('pause', '', ctx({ fiche: { titre: 'Neuve', agents: [{ id: 'a1', nom: 'Revue', statut: 'running' }] } }));
    assert.match(r.message, /^Pause : cette session est en pause avec 1 agent\./);
    assert.equal(brut().sessions[S1].titre, 'Neuve');
    assert.equal(brut().sessions[S1].pause, true);
  });

  test('sans session ni fiche, la commande dit comment désigner la session', () => {
    poser(deuxSessions());
    assert.equal(pause.appliquerCommande('pause', '', {}).erreur, 'Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».');
    assert.match(pause.appliquerCommande('pause', 'tout', {}).message, /^Pause : tout est en pause \(2 sessions/);
  });

  test('sessionRef désigne la session par identifiant abrégé ou par titre', () => {
    poser(deuxSessions());
    const r = pause.appliquerCommande('pause', '', { sessionRef: 'bbbb' });
    assert.match(r.message, /^Pause : la session bbbb2222 « Autre » est en pause/);
    assert.equal(brut().sessions[S2].pause, true);
    assert.equal(brut().sessions[S1].pause, false);
    assert.match(pause.appliquerCommande('pause', 'agents', { sessionRef: 'principale' }).message, /^Pause : 2 agents sont en pause/);
    assert.equal(brut().sessions[S1].agents.a1.pause, true);
    assert.equal(brut().sessions[S1].pause, false);
    assert.match(pause.appliquerCommande('reprendre', '', { sessionRef: 'zzzz' }).erreur, /^Session « zzzz » introuvable/);
    for (const ref of ['', '  ']) assert.equal(pause.appliquerCommande('pause', '', { sessionRef: ref }).erreur, 'Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».');
    for (const ref of ['', '  ']) assert.equal(pause.appliquerCommande('pause', '', { session: S1, sessionRef: ref, maintenant: T0 }).erreur, 'Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».', 'une référence vide ne se replie pas sur la session courante');
    assert.equal(brut().sessions[S1].pause, false);
    assert.equal(pause.appliquerCommande('pause', '', { session: S1, sessionRef: 'bbbb', maintenant: T0 }).message.startsWith('Pause : la session bbbb2222'), true, 'la référence prime sur la session courante');
  });

  test('la cible est la session visée sans être la courante, la référence prime sur la cible', () => {
    poser(deuxSessions());
    const r = pause.appliquerCommande('pause', '', { cible: S2, maintenant: T0 });
    assert.match(r.message, /^Pause : la session bbbb2222 « Autre » est en pause/);
    assert.equal(brut().sessions[S2].pause, true);
    assert.equal(brut().sessions[S1].pause, false);
    const prime = pause.appliquerCommande('pause', '', { cible: S2, sessionRef: 'aaaa', maintenant: T0 });
    assert.match(prime.message, /^Pause : la session aaaa1111 « Principale » est en pause/);
    assert.equal(brut().sessions[S1].pause, true);
    assert.match(pause.appliquerCommande('reprendre', 'agents', { session: S2, cible: S1, maintenant: T0 }).message, /^Reprise : 2 agents/, 'les agents sont ceux de la cible');
  });

  test('une écriture impossible est dite, sans rien casser', () => {
    fs.mkdirSync(RUN, { recursive: true });
    fs.writeFileSync(process.env.COCKPIT_DIR, 'je suis un fichier, pas un dossier');
    const r = pause.appliquerCommande('pause', '', ctx({ fiche: { titre: 'T' } }));
    assert.match(r.erreur, /^Écriture impossible dans .*pause\.json \(.+\) : rien n'a changé\.$/);
    assert.doesNotMatch(r.erreur, /\(Error:/, 'le message de l\'erreur, pas son nom');
    assert.equal('message' in r, false);
  });
});

describe('attendre', () => {
  test('rend la main tout de suite quand rien n\'est en pause', async () => {
    poser(deuxSessions());
    const debut = Date.now();
    assert.deepEqual(await pause.attendre({ session: S1, dureeMaxMs: 5000 }), { enPause: false });
    assert.deepEqual(await pause.attendre({ session: S1, agentId: 'a1', dureeMaxMs: 5000 }), { enPause: false });
    assert.deepEqual(await pause.attendre({ session: 'inconnue', dureeMaxMs: 5000 }), { enPause: false });
    assert.ok(Date.now() - debut < 5000);
  });

  test('attend la durée donnée tant que la pause dure, et dit qui est en pause', async () => {
    poser(deuxSessions({ pause: true, depuis: avant(3 * MIN) }));
    const debut = Date.now();
    const r = await pause.attendre({ session: S1, dureeMaxMs: 200, periodeMs: 20 });
    const duree = Date.now() - debut;
    assert.deepEqual(r, { enPause: true, cible: 'session', depuis: avant(3 * MIN) });
    assert.ok(duree >= 190, `a attendu ${duree} ms`);
    assert.ok(duree < 8000, `a attendu ${duree} ms`);
    poser(deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests') } }));
    assert.deepEqual(await pause.attendre({ session: S1, agentId: 'a1', dureeMaxMs: 60, periodeMs: 20 }), { enPause: true, cible: 'agent', depuis: avant(MIN) });
    assert.deepEqual(await pause.attendre({ session: S1, agentId: 'a2', dureeMaxMs: 60, periodeMs: 20 }), { enPause: false });
  });

  test('rend la main dès que la pause est levée, sans attendre la fin de la durée', async () => {
    poser(deuxSessions({ pause: true, depuis: avant(MIN) }));
    setTimeout(() => pause.appliquerCommande('reprendre', '', { session: S1 }), 150);
    const debut = Date.now();
    const r = await pause.attendre({ session: S1, dureeMaxMs: 10_000, periodeMs: 20 });
    const duree = Date.now() - debut;
    assert.deepEqual(r, { enPause: false });
    assert.ok(duree >= 100, `a attendu ${duree} ms`);
    assert.ok(duree < 8000, `a attendu ${duree} ms, la durée demandée était de dix secondes`);
  });

  test('la période d\'interrogation par défaut est une demi-seconde, et l\'attente ne dépasse pas la durée donnée', async () => {
    poser(deuxSessions({ pause: true, depuis: avant(MIN) }));
    const debut = Date.now();
    assert.equal((await pause.attendre({ session: S1, dureeMaxMs: 100, periodeMs: 5000 })).enPause, true);
    const duree = Date.now() - debut;
    assert.ok(duree >= 90 && duree < 4000, `a attendu ${duree} ms avec une période plus longue que la durée`);
  });

  test('l\'attente interroge l\'état à la période demandée, jamais au-delà du temps qui reste', async () => {
    poser(deuxSessions({ pause: true, depuis: avant(MIN) }));
    const demandes = [];
    const vrai = global.setTimeout;
    global.setTimeout = (fn, ms, ...reste) => { demandes.push(ms); return vrai(fn, 0, ...reste); };
    try {
      const r = await pause.attendre({ session: S1, dureeMaxMs: 120, periodeMs: 30 });
      assert.equal(r.enPause, true);
    } finally {
      global.setTimeout = vrai;
    }
    assert.ok(demandes.length >= 3, `${demandes.length} interrogations`);
    assert.equal(demandes[0], 30, 'la première attente dure une période');
    assert.ok(demandes.every(ms => ms >= 0 && ms <= 30), demandes.join(', '));
    assert.ok(demandes.some(ms => ms < 30), 'la dernière attente est écourtée au temps qui reste');
    const defaut = [];
    global.setTimeout = (fn, ms, ...reste) => { defaut.push(ms); return vrai(fn, 0, ...reste); };
    try {
      await pause.attendre({ session: S1, dureeMaxMs: 600 });
    } finally {
      global.setTimeout = vrai;
    }
    assert.equal(defaut[0], 500, 'sans période donnée, l\'état est interrogé toutes les demi-secondes');
    assert.ok(defaut.every(ms => ms <= 500), defaut.join(', '));
    const longue = [];
    global.setTimeout = (fn, ms, ...reste) => { longue.push(ms); return vrai(fn, 0, ...reste); };
    try {
      await pause.attendre({ session: S1, dureeMaxMs: 3 });
    } finally {
      global.setTimeout = vrai;
    }
    assert.ok(longue.every(ms => ms <= 3));
  });

  test('rend la main quand la session sort de l\'état pendant l\'attente', async () => {
    poser(deuxSessions({ pause: true, depuis: avant(MIN) }));
    setTimeout(() => poser({ sessions: {} }), 100);
    const r = await pause.attendre({ session: S1, dureeMaxMs: 10_000, periodeMs: 20 });
    assert.deepEqual(r, { enPause: false });
  });

  test('la durée est bornée à neuf minutes ; une durée illisible ou négative vaut vingt secondes', () => {
    assert.equal(pause.dureeBornee(1000), 1000);
    assert.equal(pause.dureeBornee(0), 0);
    assert.equal(pause.dureeBornee(9 * MIN), 9 * MIN);
    assert.equal(pause.dureeBornee(9 * MIN + 1), 9 * MIN);
    assert.equal(pause.dureeBornee(60 * MIN), 9 * MIN);
    for (const ms of [undefined, null, NaN, -1, 'x', Infinity, {}]) assert.equal(pause.dureeBornee(ms), 20_000, String(ms));
  });
});

// Toute lecture suivie d'une écriture de pause.json passe par un verrou entre processus : deux sessions qui battent en même temps, ou un
// battement qui croise un clic sur Pause, ne doivent pas s'écraser (une pause perdue serait une session qui repart sans l'avoir demandé).
describe('verrou d\'écriture', () => {
  const VERROU = () => `${FICHIER}.verrou`;
  const creerVerrou = () => { fs.mkdirSync(path.dirname(FICHIER), { recursive: true }); fs.writeFileSync(VERROU(), ''); };

  test('battre et appliquerCommande libèrent le verrou, même quand leur résultat est une erreur', () => {
    pause.battre({ session: S1, titre: 'T', agents: [] });
    assert.equal(fs.existsSync(VERROU()), false);
    assert.equal(brut().sessions[S1].titre, 'T');
    pause.appliquerCommande('pause', '', { session: S1 });
    assert.equal(fs.existsSync(VERROU()), false);
    assert.equal(brut().sessions[S1].pause, true);
    assert.ok(pause.appliquerCommande('pause', 'n importe quoi', { session: S1 }).erreur);
    assert.equal(fs.existsSync(VERROU()), false);
  });

  test('avecVerrou : le verrou existe pendant la section, disparaît après, même si elle jette, et rend son résultat', () => {
    let vu = null;
    assert.equal(pause.avecVerrou(() => { vu = fs.existsSync(VERROU()); return 42; }), 42);
    assert.equal(vu, true);
    assert.equal(fs.existsSync(VERROU()), false);
    assert.throws(() => pause.avecVerrou(() => { throw new Error('boum'); }), /boum/);
    assert.equal(fs.existsSync(VERROU()), false, 'libéré malgré l\'exception');
  });

  test('avecVerrou crée le dossier de l\'état quand il manque', () => {
    assert.equal(fs.existsSync(path.dirname(FICHIER)), false);
    assert.equal(pause.avecVerrou(() => 7), 7);
    assert.equal(fs.existsSync(path.dirname(FICHIER)), true);
    assert.equal(fs.existsSync(VERROU()), false);
  });

  // Les tests qui attendent un autre processus ont un délai : un verrou qui ne se libère plus fait échouer le test au lieu de le suspendre.
  test('un verrou tenu par un autre processus retarde la section jusqu\'à sa libération', { timeout: 30_000 }, async () => {
    creerVerrou();
    const autre = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").unlinkSync(process.argv[1]), 300)', VERROU()], { stdio: 'ignore' });
    const fini = new Promise(resolve => autre.on('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 100)); // l'enfant a démarré : ses 300 ms sont lancées
    const debut = Date.now();
    pause.avecVerrou(() => {});
    const duree = Date.now() - debut;
    await fini;
    assert.ok(duree >= 100 && duree < 1200, `a attendu ${duree} ms`);
    assert.equal(fs.existsSync(VERROU()), false);
  });

  // Une section verrouillée lancée dans un autre processus, avec un délai : un verrou qui boucle sans fin fait échouer le test au lieu de le
  // suspendre (une boucle synchrone ne se laisse pas interrompre de l'intérieur). L'enfant écrit sur sa sortie le temps que la section a attendu.
  const enEnfant = (delai = 10_000, ageVerrou) => {
    const preparation = ageVerrou === undefined ? '' : `const fs = require('node:fs'); const age = new Date(Date.now() - ${ageVerrou}); fs.utimesSync(${JSON.stringify(VERROU())}, age, age);`;
    const code = 'const pause = require(process.argv[1]); ' + preparation + ' const debut = Date.now(); pause.avecVerrou(() => process.stdout.write(String(Date.now() - debut)));';
    const r = spawnSync(process.execPath, ['-e', code, CORE], { env: process.env, encoding: 'utf8', timeout: delai });

    return { tue: Boolean(r.error), attente: Number(r.stdout) };
  };
  const vieillir = ms => { const age = new Date(Date.now() - ms); fs.utimesSync(VERROU(), age, age); };
  // Surveille des enfants qui exécutent le code testé dès leur lancement : la promesse rendue se résout à la fin de TOUS les enfants, par true si le
  // délai les a fait arrêter. Sans cela un verrou qui boucle sans fin laisserait les enfants tourner à plein régime et le banc entier suspendu
  // (un verrou qui boucle sans fin laissait quatre processus à plein régime pendant que la mutation « retrait sans effet » attendait son délai).
  const surveiller = (enfants, delai = 20_000) => new Promise(resolve => {
    let tue = false;
    let restants = enfants.length;
    const minuteur = setTimeout(() => { tue = true; for (const e of enfants) e.kill(); }, delai);
    for (const e of enfants) {
      e.on('close', () => {
        restants -= 1;
        if (restants === 0) { clearTimeout(minuteur); resolve(tue); }
      });
    }
  });

  test('un verrou périmé (plus de cinq secondes) est repris sans attendre', () => {
    creerVerrou();
    vieillir(10_000);
    const r = enEnfant();
    assert.equal(r.tue, false, 'la section est restée bloquée');
    assert.ok(r.attente < 1000, `a attendu ${r.attente} ms`);
    assert.equal(fs.existsSync(VERROU()), false);
  });

  test('un verrou de quatre secondes n\'est pas encore périmé : il est repris une seconde plus tard, quand il atteint cinq secondes', () => {
    creerVerrou();
    vieillir(4_000);
    const r = enEnfant(10_000, 4_000);
    assert.equal(r.tue, false, 'la section est restée bloquée');
    assert.ok(r.attente >= 800 && r.attente < 1700, `a attendu ${r.attente} ms`);
    assert.equal(fs.existsSync(VERROU()), false);
  });

  for (const [nom, code] of [
    ['battre', 'pause.battre({ session: process.argv[2], titre: "T", agents: [] });'],
    ['appliquerCommande', 'pause.appliquerCommande("pause", "", { session: process.argv[2], fiche: { titre: "T", agents: [] } });'],
  ]) {
    test(`${nom} attend le verrou avant d'écrire l'état, puis l'écrit une fois le verrou libéré`, { timeout: 30_000 }, async () => {
      creerVerrou();
      const enfant = spawn(process.execPath, ['-e', `const pause = require(process.argv[1]); ${code}`, CORE, S1], { env: process.env, stdio: 'ignore' });
      const fini = surveiller([enfant]);
      await new Promise(resolve => setTimeout(resolve, 700)); // l'enfant a démarré et attend le verrou
      assert.equal(fs.existsSync(FICHIER), false, 'l\'état est écrit alors que le verrou est tenu par un autre');
      fs.unlinkSync(VERROU());
      assert.equal(await fini, false, 'le processus est resté bloqué après la libération du verrou');
      assert.ok(brut().sessions[S1], 'la session est inscrite une fois le verrou libéré');
      assert.equal(fs.existsSync(VERROU()), false);
    });
  }

  // Windows refuse (EPERM) de créer un fichier dont la suppression est en cours : c'est un verrou qui se libère, pas l'absence de verrou.
  const fsAvecRefus = (code, nombre, f) => {
    const vrai = fs.openSync;
    let refus = 0;
    fs.openSync = (p, ...reste) => {
      if (String(p).endsWith('.verrou') && refus < nombre) {
        refus += 1;
        throw Object.assign(new Error(code), { code });
      }
      return vrai(p, ...reste);
    };
    try { return f(); } finally { fs.openSync = vrai; }
  };

  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`${code} à la création du verrou : la section attend et ne s'exécute qu'une fois le verrou pris`, () => {
      let pendant = null;
      fsAvecRefus(code, 3, () => pause.avecVerrou(() => { pendant = fs.existsSync(VERROU()); }));
      assert.equal(pendant, true);
      assert.equal(fs.existsSync(VERROU()), false);
    });
  }

  test('une autre erreur (disque plein) ne fait pas attendre : la section s\'exécute sans verrou', () => {
    let pendant = null;
    const debut = Date.now();
    fsAvecRefus('ENOSPC', 1_000_000, () => pause.avecVerrou(() => { pendant = fs.existsSync(VERROU()); }));
    assert.equal(pendant, false);
    assert.ok(Date.now() - debut < 500, `a attendu ${Date.now() - debut} ms`);
  });

  test('un verrou jamais libéré ne bloque pas : au bout de deux secondes la section s\'exécute quand même, sans toucher au verrou d\'un autre', () => {
    creerVerrou();
    const r = enEnfant();
    assert.equal(r.tue, false, 'la section est restée bloquée par un verrou jamais libéré');
    assert.ok(r.attente >= 1900 && r.attente < 4500, `a attendu ${r.attente} ms`);
    assert.equal(fs.existsSync(VERROU()), true, 'le verrou appartient à un autre processus : on ne le supprime pas');
  });

  test('quatre processus qui incrémentent un compteur en concurrence n\'en perdent aucun', { timeout: 30_000 }, async () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    const compteur = path.join(RUN, 'compteur.txt');
    fs.writeFileSync(compteur, '0');
    const script = [
      'const pause = require(process.argv[1]); const fs = require("node:fs");',
      'const dormir = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      'for (let i = 0; i < 15; i++) pause.avecVerrou(() => { const n = Number(fs.readFileSync(process.argv[2], "utf8")); dormir(3); fs.writeFileSync(process.argv[2], String(n + 1)); });',
    ].join('\n');
    const enfants = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', script, CORE, compteur], { env: process.env, stdio: 'ignore' }));
    assert.equal(await surveiller(enfants), false, 'des processus sont restés bloqués : un verrou qui boucle sans fin');
    assert.equal(fs.readFileSync(compteur, 'utf8'), '60');
    assert.equal(fs.existsSync(VERROU()), false);
  });
});

describe('opérations des hooks', () => {
  test('battre, commande et attendre', async () => {
    assert.deepEqual(await pause.executerHook('battre', { session: S1, titre: 'T', agents: [{ id: 'a1', nom: 'Revue', statut: 'running' }] }), { ok: true });
    const c = await pause.executerHook('commande', { sens: 'pause', args: '', session: S1 });
    assert.match(c.message, /^Pause : cette session est en pause avec 1 agent/);
    const debut = Date.now();
    assert.deepEqual(await pause.executerHook('attendre', { session: S1, dureeMs: 50 }), { enPause: true, cible: 'session', depuis: brut().sessions[S1].depuis });
    assert.ok(Date.now() - debut < 5000, 'la durée demandée est respectée');
    assert.deepEqual(await pause.executerHook('attendre', { session: S1, agentId: 'a1', dureeMs: 50 }), { enPause: true, cible: 'session', depuis: brut().sessions[S1].depuis });
    assert.deepEqual(await pause.executerHook('attendre', { session: S2, dureeMs: 50 }), { enPause: false });
    const r = await pause.executerHook('commande', { sens: 'reprendre', args: '', sessionRef: 'aaaa' });
    assert.match(r.message, /^Reprise : la session aaaa1111 « T » reprend/);
  });

  test('attendre : un agent en pause seul attend, un identifiant d\'agent qui n\'est pas du texte est ignoré', async () => {
    poser(deuxSessions({ agents: { a1: agent('Revue', 'running', true, avant(MIN)), a2: agent('Tests'), 5: agent('Cinq', 'running', true, avant(MIN)) } }));
    assert.deepEqual(await pause.executerHook('attendre', { session: S1, agentId: 'a1', dureeMs: 30 }), { enPause: true, cible: 'agent', depuis: avant(MIN) });
    assert.deepEqual(await pause.executerHook('attendre', { session: S1, agentId: 'a2', dureeMs: 30 }), { enPause: false });
    assert.deepEqual(await pause.executerHook('attendre', { session: S1, dureeMs: 30 }), { enPause: false }, 'la boucle principale n\'attend pas pour un agent');
    assert.deepEqual(await pause.executerHook('attendre', { session: S1, agentId: 5, dureeMs: 30 }), { enPause: false }, 'un identifiant en nombre n\'est pas l\'agent « 5 »');
  });

  test('commande : les arguments du hook sont ceux de la commande', async () => {
    poser(deuxSessions());
    const r = await pause.executerHook('commande', { sens: 'pause', args: 'tout', session: S1 });
    assert.match(r.message, /^Pause : tout est en pause \(2 sessions/);
    assert.equal(brut().sessions[S2].pause, true);
    const a = await pause.executerHook('commande', { sens: 'reprendre', args: 'agents', session: S1 });
    assert.match(a.message, /^Reprise : 2 agents/);
  });

  test('un instant illisible vaut maintenant et date bien le battement', async () => {
    poser(deuxSessions({ vu: avant(2 * MIN) }));
    assert.deepEqual(await pause.executerHook('battre', { session: S1, maintenant: 'x' }), { ok: true });
    assert.ok(Math.abs(Date.parse(brut().sessions[S1].vu) - Date.now()) < 30_000);
    assert.notEqual(brut().sessions[S1].vu, avant(2 * MIN));
    assert.deepEqual(await pause.executerHook('battre', { session: S1, maintenant: null }), { ok: true });
    assert.deepEqual(await pause.executerHook('battre', { session: S1 }), { ok: true });
  });

  test('la commande lit une fiche, ignore une fiche ou une référence mal typée', async () => {
    const r = await pause.executerHook('commande', { sens: 'pause', args: '', session: S1, fiche: { titre: 'Neuve', agents: [] } });
    assert.match(r.message, /^Pause : cette session est en pause/);
    assert.equal(brut().sessions[S1].titre, 'Neuve');
    for (const fiche of ['x', 5, [], null]) {
      const e = await pause.executerHook('commande', { sens: 'pause', args: '', session: 'autre', fiche });
      assert.match(e.erreur, /n'est pas dans l'état/, JSON.stringify(fiche));
    }
    const sansArgs = await pause.executerHook('commande', { sens: 'pause', args: 5, session: S1 });
    assert.match(sansArgs.message, /déjà en pause/, 'des arguments qui ne sont pas du texte valent aucun argument');
    for (const sessionRef of [5, null, {}]) {
      const e = await pause.executerHook('commande', { sens: 'pause', args: '', session: S1, sessionRef });
      assert.match(e.message, /déjà en pause/, JSON.stringify(sessionRef));
    }
  });

  test('une entrée invalide, un instant illisible ou une opération inconnue rendent une erreur', async () => {
    for (const entree of [null, undefined, 'x', 5, []]) assert.deepEqual(await pause.executerHook('battre', entree), { erreur: 'entrée invalide' }, String(entree));
    assert.deepEqual(await pause.executerHook('attendre', {}), { erreur: 'entrée invalide' });
    assert.deepEqual(await pause.executerHook('attendre', { session: '' }), { erreur: 'entrée invalide' });
    assert.deepEqual(await pause.executerHook('attendre', { session: 5 }), { erreur: 'entrée invalide' });
    assert.deepEqual(await pause.executerHook('bidule', { session: S1 }), { erreur: 'opération inconnue : bidule' });
    assert.deepEqual(await pause.executerHook('battre', { session: '' }), { ok: false });
    assert.equal((await pause.executerHook('commande', { sens: 'zzz', session: S1 })).erreur.startsWith('Sens inconnu'), true);
    const bat = await pause.executerHook('battre', { session: S1, maintenant: T0 });
    assert.deepEqual(bat, { ok: true });
    assert.equal(brut().sessions[S1].vu, iso(T0), 'un instant donné est utilisé');
    await pause.executerHook('battre', { session: S1, maintenant: 'x' });
    assert.ok(Math.abs(Date.parse(brut().sessions[S1].vu) - Date.now()) < 60_000, 'un instant illisible vaut maintenant');
  });

  test('une panne se rend en erreur, jamais en exception', async () => {
    fs.mkdirSync(RUN, { recursive: true });
    fs.writeFileSync(process.env.COCKPIT_DIR, 'fichier à la place du dossier');
    const r = await pause.executerHook('battre', { session: S1, titre: 'T' });
    assert.equal(typeof r.erreur, 'string');
    assert.ok(r.erreur.length > 0);
  });
});

describe('ligne de commande', () => {
  // Un délai : une commande qui bouclerait sans fin fait échouer le test (statut absent) au lieu de suspendre le banc.
  const cli = (args, entree) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: entree, timeout: 30_000, env: { ...process.env, COCKPIT_DIR: process.env.COCKPIT_DIR, CONTEXT_LEDGER_DIR: process.env.CONTEXT_LEDGER_DIR } });

  test('pause tout et reprendre tout', () => {
    poser(deuxSessions());
    const p = cli(['pause', 'tout']);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^Pause : tout est en pause \(2 sessions/);
    assert.equal(p.stdout.endsWith('.\n'), true, 'le message se termine par un retour à la ligne');
    assert.equal(p.stdout.split('\n').length, 2);
    assert.equal(p.stderr, '');
    assert.equal(brut().sessions[S1].pause, true);
    assert.equal(brut().sessions[S2].pause, true);
    const r = cli(['reprendre', 'tout']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Reprise : tout reprend \(2 sessions reprises\)/);
    assert.equal(brut().sessions[S1].pause, false);
  });

  test('--session désigne la session, où qu\'il soit dans la ligne', () => {
    poser(deuxSessions());
    assert.match(cli(['pause', '--session', 'bbbb']).stdout, /^Pause : la session bbbb2222 « Autre » est en pause/);
    assert.equal(brut().sessions[S2].pause, true);
    assert.match(cli(['pause', 'agent', 'revue', '--session', 'principale']).stdout, /^Pause : l'agent « Revue » est en pause/);
    assert.equal(brut().sessions[S1].agents.a1.pause, true);
    assert.match(cli(['reprendre', '--session', 'bbbb']).stdout, /^Reprise : la session bbbb2222/);
  });

  test('sans --session, la commande dit comment faire, code 2, et ne change rien', () => {
    poser(deuxSessions());
    const contenu = fs.readFileSync(FICHIER, 'utf8');
    const r = cli(['pause']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'Aucune session désignée : ajoute --session <id ou titre>, ou utilise « tout ».\n');
    const sansValeur = cli(['pause', '--session']);
    assert.equal(sansValeur.status, 2);
    assert.match(sansValeur.stderr, /Aucune session désignée/);
    const inconnue = cli(['pause', '--session', 'zzzz']);
    assert.equal(inconnue.status, 2);
    assert.match(inconnue.stderr, /introuvable/);
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), contenu);
  });

  test('un argument inconnu est refusé avec l\'usage, code 2', () => {
    poser(deuxSessions());
    const r = cli(['pause', 'bidule']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Usage : \/pause \[tout/);
    assert.match(cli(['reprendre', 'bidule']).stderr, /^Usage : \/reprendre \[tout/);
  });

  test('pause-hook lit un JSON sur l\'entrée standard et rend un JSON sur une ligne', () => {
    const b = cli(['pause-hook', 'battre'], JSON.stringify({ session: S1, titre: 'Chat', agents: [{ id: 'a1', nom: 'Revue', statut: 'running' }] }));
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(JSON.parse(b.stdout), { ok: true });
    assert.equal(b.stdout, '{"ok":true}\n', 'une seule ligne, terminée par un retour à la ligne');
    const c = cli(['pause-hook', 'commande'], JSON.stringify({ sens: 'pause', args: '', session: S1 }));
    assert.match(JSON.parse(c.stdout).message, /^Pause : cette session est en pause/);
    const a = cli(['pause-hook', 'attendre'], JSON.stringify({ session: S1, dureeMs: 100 }));
    assert.equal(JSON.parse(a.stdout).enPause, true);
    const lib = cli(['pause-hook', 'attendre'], JSON.stringify({ session: S2, dureeMs: 100 }));
    assert.deepEqual(JSON.parse(lib.stdout), { enPause: false });
  });

  test('pause-hook rend une erreur en JSON, code 0, pour une entrée illisible ou une opération inconnue', () => {
    for (const entree of ['', 'pas du json']) {
      const r = cli(['pause-hook', 'battre'], entree);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '{"erreur":"entrée illisible"}\n', entree);
    }
    const tableau = cli(['pause-hook', 'battre'], '[]');
    assert.equal(tableau.status, 0, tableau.stderr);
    assert.equal(tableau.stdout, '{"erreur":"entrée invalide"}\n', 'un JSON lisible mais pas un objet');
    const inconnue = cli(['pause-hook', 'bidule'], '{}');
    assert.equal(inconnue.status, 0);
    assert.deepEqual(JSON.parse(inconnue.stdout), { erreur: 'opération inconnue : bidule' });
    assert.deepEqual(JSON.parse(cli(['pause-hook'], '{}').stdout), { erreur: 'opération inconnue : undefined' });
  });

  test('une commande inconnue cite pause, reprendre et pause-hook', () => {
    const r = cli(['bidule']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /pause, reprendre, pause-hook\)/);
  });
});
