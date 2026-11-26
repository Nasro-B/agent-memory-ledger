'use strict';
// Bancs du noyau de la Nuit (scripts/lib/nuit-core.js) et des commandes cockpit.js nuit et nuit-hook.
// Lancement : node --test tests/nuit-core.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR, CONTEXT_LEDGER_DIR).
// Variables internes (preuves par mutation) : NUIT_CORE_TESTE = noyau à tester (défaut : ../scripts/lib/nuit-core.js),
//   COCKPIT_CLI_TESTE = ligne de commande à tester (défaut : ../scripts/cockpit.js).
// La garde de sécurité interrogée par défaut est scripts/gardes/securite.js ; NUIT_GARDE désigne une fausse garde pour les tests qui en ont besoin.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, beforeEach } = require('node:test');

const { ecrireEtatLedger } = require('./lib/cockpit-fixtures.js');

const core = require(process.env.NUIT_CORE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'nuit-core.js'));
const cockpit = require(path.join(__dirname, '..', 'scripts', 'lib', 'cockpit-core.js'));
const regulateur = require(path.join(__dirname, '..', 'scripts', 'lib', 'regulateur-core.js'));

let n = 0;
let RUN;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `nuit-core-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.CONTEXT_LEDGER_DIR = path.join(RUN, 'contexte');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison'); // jamais la vraie maison de l'utilisateur (la garde de sécurité y lit gardes.json)
});

const T0 = Date.parse('2026-03-04T00:10:00.000Z');
const MIN = 60 * 1000;
const HEURE = 60 * MIN;
const iso = ms => new Date(ms).toISOString();
const sansTiretLong = t => !/\u{2014}/u.test(t);
const ctx = (extra = {}) => ({ agent: 'claude', session: 'S1', maintenant: T0, ...extra });
const fichier = nom => path.join(process.env.COCKPIT_DIR, nom);
const lire = nom => JSON.parse(fs.readFileSync(fichier(nom), 'utf8'));
const existe = nom => fs.existsSync(fichier(nom));
const ledger = (lignes, agent = 'claude', projet = 'P1') => ecrireEtatLedger(agent, projet, lignes);
const ligne = (texte, extra = {}) => ({ texte, statut: 'ouvert', ...extra });
const ouvrirNuit = (extra = {}) => core.appliquerCommande('on', ctx(extra));
const askClaude = { questions: [{ question: 'Quel nom pour le module ?', options: [{ label: 'Veilleur (Recommended)', description: 'court' }, { label: 'Nuit' }] }] };
// Les deux sorties de la garde de sécurité (scripts/gardes/securite.js) : un refus (deny) et une demande d'accord (ask, Claude Code).
const blocGarde = raison => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });
const demandeGarde = raison => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: raison } });
// Les raisons que la garde donne, telles que ses libellés les écrivent.
const RAISON_PUSH = "git push détecté : jamais automatique, uniquement sur ordre explicite de l'utilisateur.";
const RAISON_RESET = 'git reset --hard détecté : perte des modifications non commitées. Confirme explicitement.';
const RAISON_SAUT = 'Option de saut des vérifications de git détectée (elle contourne les hooks, dont le rappel avant commit).';

describe('fichiers d état et de boîte', () => {
  test('sans fichier, l état est inactif et la boîte vide', () => {
    assert.equal(core.lireEtat().actif, false);
    assert.deepEqual(core.lireBoite(), { prochain: 1, entrees: [] });
    assert.equal(existe('nuit.json'), false, 'lire n écrit rien');
  });

  test('un fichier abîmé ou illisible donne l état par défaut', () => {
    fs.mkdirSync(process.env.COCKPIT_DIR, { recursive: true });
    fs.writeFileSync(fichier('nuit.json'), '{pas du json');
    fs.writeFileSync(fichier('nuit-boite.json'), '[]');
    assert.equal(core.lireEtat().actif, false);
    assert.deepEqual(core.lireBoite(), { prochain: 1, entrees: [] });
  });

  test('un fichier précédé d un BOM UTF-8 est lu', () => {
    fs.mkdirSync(process.env.COCKPIT_DIR, { recursive: true });
    fs.writeFileSync(fichier('nuit.json'), `\uFEFF${JSON.stringify({ actif: true, mode: 'absence', depuis: iso(T0) })}`);
    const e = core.lireEtat();
    assert.deepEqual([e.actif, e.mode], [true, 'absence']);
  });

  test('écrire garde la forme normalisée avec la date de mise à jour, et le Cockpit y lit « actif »', () => {
    core.ecrireEtat({ actif: true, mode: 'nuit', depuis: iso(T0), inconnu: 'x' });
    const brut = lire('nuit.json');
    assert.equal(brut.actif, true);
    assert.equal(brut.inconnu, undefined);
    assert.ok(Number.isFinite(Date.parse(brut.maj)));
    assert.deepEqual(core.lireEtat(), { ...core.lireEtat(), actif: true, mode: 'nuit', depuis: iso(T0) });
    const lu = cockpit.instantane({ worktrees: [], plans: { dossier: path.join(RUN, 'rien'), exclure: [], profondeur: 1 } });
    assert.equal(lu.nuit.actif, true, 'le Cockpit relit nuit.json tel quel');
  });

  test('la boîte écrite est relue à l identique, sans champ inconnu', () => {
    const r = core.ecrireBoite({ prochain: 4, entrees: [{ id: 3, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(T0), titre: 'q', inconnu: 1 }] });
    assert.equal(r, undefined);
    const boite = core.lireBoite();
    assert.equal(boite.prochain, 4);
    assert.deepEqual(boite.entrees.map(e => e.id), [3]);
    assert.equal(lire('nuit-boite.json').entrees[0].inconnu, undefined);
  });

  test('écrire dans un dossier qui n existe pas le crée', () => {
    assert.equal(existe('nuit.json'), false);
    core.ecrireEtat({ actif: false });
    assert.equal(existe('nuit.json'), true);
  });
});

describe('lignes de la liste de travail', () => {
  test('lignesDe rend les lignes ouvertes de tous les projets de cet agent, avec leur session', () => {
    ledger({ 'C-0001': ligne('travail A'), 'C-0002': ligne('travail B', { statut: 'en-cours', session: 'S2' }) });
    ledger({ 'C-0001': ligne('travail C') }, 'claude', 'P2');
    ledger({ 'C-0009': ligne('travail codex') }, 'codex');
    const l = core.lignesDe('claude');
    assert.deepEqual(l.map(x => [x.id, x.session]), [['C-0001', 'S1'], ['C-0002', 'S2'], ['C-0001', 'S1']]);
    assert.deepEqual(core.lignesDe('codex').map(x => x.id), ['C-0009']);
  });

  test('lignesDe ne rend ni les lignes bloquées par l\'utilisateur, ni les lignes faites, ni les lignes d agents', () => {
    ledger({
      'C-0001': ligne('ouverte'), 'C-0002': ligne('bloquée', { statut: 'bloque-utilisateur' }), 'C-0003': ligne('faite', { statut: 'fait' }),
      'C-0004': { texte: '[agent] « A » (default, id-a) : x', statut: 'en-cours', note: 'agent en cours depuis 2026-03-03 22:00' },
    });
    assert.deepEqual(core.lignesDe('claude').map(x => x.id), ['C-0001']);
  });

  test('sans ledger, ou pour un agent inconnu, aucune ligne', () => {
    assert.deepEqual(core.lignesDe('claude'), []);
    ledger({ 'C-0001': ligne('x') });
    assert.deepEqual(core.lignesDe('inconnu'), []);
  });
});

describe('commande', () => {
  test('on commence la nuit, compte les lignes ouvertes de CETTE session, et écrit l état', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B'), 'C-0003': ligne('autre fil', { session: 'AUTRE' }), 'C-0004': ligne('bloquée', { statut: 'bloque-utilisateur' }) });
    const r = ouvrirNuit();
    assert.equal(r.erreur, undefined);
    assert.equal(r.effet, 'active');
    assert.match(r.message, /^Nuit : active\./);
    const e = lire('nuit.json');
    assert.deepEqual([e.actif, e.mode, e.depuis, e.lignesAuDebut], [true, 'nuit', iso(T0), 2]);
  });

  test('off met fin à la nuit, rend le récap avec les lignes restantes, et écrit la fin', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B') });
    ouvrirNuit();
    ledger({ 'C-0002': ligne('B') });
    const r = core.appliquerCommande('off', ctx({ maintenant: T0 + 3 * HEURE }));
    assert.equal(r.effet, 'reveil');
    assert.match(r.message, /^NUIT : récap\./);
    assert.ok(r.message.includes('Durée : 3 h (nuit).'), r.message);
    assert.ok(r.message.includes('Lignes ouvertes : 2 au coucher, 1 maintenant.'), r.message);
    const e = lire('nuit.json');
    assert.deepEqual([e.actif, e.fin], [false, iso(T0 + 3 * HEURE)]);
  });

  test('une commande invalide rend l usage sans rien écrire', () => {
    const r = core.appliquerCommande('demain', ctx());
    assert.match(r.erreur, /^Usage : \/nuit /);
    assert.equal(existe('nuit.json'), false);
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('une commande qui ne change rien n écrit rien', () => {
    for (const args of ['', 'statut', 'recap', 'boite']) {
      const r = core.appliquerCommande(args, ctx());
      assert.equal(r.erreur, undefined, args);
      assert.ok(r.message.length > 0, args);
    }
    assert.equal(existe('nuit.json'), false);
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('on pendant une nuit active ne réécrit pas le fichier', () => {
    ouvrirNuit();
    const avant = fs.statSync(fichier('nuit.json')).mtimeMs;
    const texteAvant = fs.readFileSync(fichier('nuit.json'), 'utf8');
    const r = core.appliquerCommande('on', ctx({ maintenant: T0 + MIN }));
    assert.match(r.message, /^Nuit : déjà active/);
    assert.equal(fs.readFileSync(fichier('nuit.json'), 'utf8'), texteAvant);
    assert.equal(fs.statSync(fichier('nuit.json')).mtimeMs, avant);
  });

  test('absence et tours se règlent et se gardent dans le fichier', () => {
    core.appliquerCommande('absence 120', ctx());
    core.appliquerCommande('tours 25', ctx());
    const e = lire('nuit.json');
    assert.deepEqual([e.absenceMinutes, e.maxTours], [120, 25]);
    core.appliquerCommande('absence off', ctx());
    assert.equal(lire('nuit.json').absenceMinutes, null);
    core.appliquerCommande('defaut', ctx());
    assert.deepEqual([lire('nuit.json').absenceMinutes, lire('nuit.json').maxTours], [60, 60]);
  });

  test('repondre note la réponse dans la boîte et rend le texte à donner au modèle', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = core.appliquerCommande('repondre 1 Veilleur', ctx({ maintenant: T0 + HEURE }));
    assert.equal(r.erreur, undefined);
    assert.equal(r.effet, 'reponse');
    assert.equal(r.message, 'Boîte : réponse notée pour la question n° 1.');
    assert.equal(r.prompt, 'NUIT : réponse de l\'utilisateur à la question n° 1 (« Quel nom pour le module ? ») : Veilleur. Applique-la maintenant.');
    const e = core.lireBoite().entrees[0];
    assert.deepEqual([e.statut, e.reponse, e.traite], ['repondue', 'Veilleur', iso(T0 + HEURE)]);
  });

  test('ecarter retire la question de celles à décider, sans texte pour le modèle', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = core.appliquerCommande('ecarter 1', ctx());
    assert.equal(r.effet, 'ecartee');
    assert.equal(r.prompt, undefined);
    assert.equal(core.lireBoite().entrees[0].statut, 'ecartee');
  });

  test('repondre à une question inconnue dit pourquoi, sans rien écrire de plus', () => {
    const r = core.appliquerCommande('repondre 9 oui', ctx());
    assert.equal(r.erreur, 'Boîte : question n° 9 introuvable.');
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('un fichier qui ne peut pas être écrit est dit, et la commande ne prétend rien', () => {
    fs.mkdirSync(fichier('nuit.json'), { recursive: true }); // un dossier occupe la place du fichier
    const r = core.appliquerCommande('on', ctx());
    assert.match(r.erreur, /^Écriture impossible dans .*nuit\.json .* : rien n'a changé\.$/);
    assert.equal(r.message, undefined);
  });
});

describe('activité de l\'utilisateur et réveil', () => {
  test('un message de l\'utilisateur date son activité', () => {
    const r = core.noterActivite(ctx());
    assert.deepEqual(r, { reveil: false });
    assert.equal(lire('nuit.json').derniereActivite, iso(T0));
  });

  test('un message de l\'utilisateur pendant la nuit la termine et rend le récap', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = core.noterActivite(ctx({ maintenant: T0 + 5 * HEURE }));
    assert.equal(r.reveil, true);
    assert.match(r.recap, /^NUIT : récap\./);
    assert.ok(r.recap.includes('Durée : 5 h (nuit).'), r.recap);
    assert.ok(r.recap.includes('1 question mise en boîte'), r.recap);
    assert.ok(r.recap.includes('À décider (1) :'), r.recap);
    assert.ok(r.recap.includes('Lignes ouvertes : 1 au coucher, 1 maintenant.'), r.recap);
    const e = lire('nuit.json');
    assert.deepEqual([e.actif, e.fin, e.derniereActivite], [false, iso(T0 + 5 * HEURE), iso(T0 + 5 * HEURE)]);
  });

  test('un message de l\'utilisateur ne compte pas les lignes d une autre session', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('autre', { session: 'AUTRE' }) });
    ouvrirNuit();
    const r = core.noterActivite(ctx({ maintenant: T0 + HEURE }));
    assert.ok(r.recap.includes('1 au coucher, 1 maintenant'), r.recap);
  });
});

describe('absence détectée', () => {
  const utilisateurEstParti = (minutes = 90) => core.noterActivite(ctx({ maintenant: T0 - minutes * MIN }));

  test('nuitActive est faux sans nuit et sans absence, et n écrit rien de plus', () => {
    assert.equal(core.nuitActive(ctx()), false);
    utilisateurEstParti(10);
    const avant = fs.readFileSync(fichier('nuit.json'), 'utf8');
    assert.equal(core.nuitActive(ctx()), false);
    assert.equal(fs.readFileSync(fichier('nuit.json'), 'utf8'), avant);
  });

  test('nuitActive est vrai pendant une nuit active', () => {
    ouvrirNuit();
    assert.equal(core.nuitActive(ctx({ maintenant: T0 + MIN })), true);
  });

  test('quand l\'utilisateur est absent depuis assez longtemps, la nuit commence en mode absence, avec les lignes du moment', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B') });
    utilisateurEstParti(90);
    assert.equal(core.nuitActive(ctx()), true);
    const e = lire('nuit.json');
    assert.deepEqual([e.actif, e.mode, e.depuis, e.lignesAuDebut], [true, 'absence', iso(T0), 2]);
    assert.equal(core.nuitActive(ctx({ maintenant: T0 + MIN })), true);
    assert.equal(lire('nuit.json').depuis, iso(T0), 'une seule activation');
  });

  test('sans détection d absence réglée, l\'utilisateur peut être parti longtemps sans que la nuit commence', () => {
    utilisateurEstParti(600);
    core.appliquerCommande('absence off', ctx());
    assert.equal(core.nuitActive(ctx()), false);
  });

  test('le message de l\'utilisateur qui revient met fin à la nuit d absence', () => {
    utilisateurEstParti(90);
    core.nuitActive(ctx());
    const r = core.noterActivite(ctx({ maintenant: T0 + 2 * HEURE }));
    assert.equal(r.reveil, true);
    assert.ok(r.recap.includes('(absence de l\'utilisateur)'), r.recap);
  });
});

describe('question refusée', () => {
  test('sans nuit, la question n est pas refusée et rien n est écrit', () => {
    assert.deepEqual(core.refuserQuestion({ ...ctx(), entreeOutil: askClaude }), { refuser: false });
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('pendant la nuit, la question est refusée, mise en boîte avec ses options, et comptée', () => {
    ouvrirNuit();
    const r = core.refuserQuestion({ ...ctx({ maintenant: T0 + MIN }), entreeOutil: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(r.id, 1);
    assert.ok(r.texte.startsWith('NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse. Elle est notée en boîte (n° 1, 1 à décider au réveil).'), r.texte);
    assert.ok(r.texte.includes('(de préférence « Veilleur », marquée recommandée)'), r.texte);
    assert.ok(sansTiretLong(r.texte));
    const e = core.lireBoite().entrees[0];
    assert.deepEqual([e.agent, e.session, e.type, e.statut, e.ajoute], ['claude', 'S1', 'question', 'en-attente', iso(T0 + MIN)]);
    assert.equal(e.titre, 'Quel nom pour le module ?');
    assert.deepEqual(e.options.map(o => o.label), ['Veilleur (Recommended)', 'Nuit']);
    assert.deepEqual(lire('nuit.json').refus, { question: 1, garde: 0, action: 0 });
  });

  test('la même question posée de nouveau reste une seule entrée, mais chaque refus est compté', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = core.refuserQuestion({ ...ctx({ maintenant: T0 + MIN }), entreeOutil: askClaude });
    assert.equal(r.id, 1);
    assert.equal(core.lireBoite().entrees.length, 1);
    assert.equal(lire('nuit.json').refus.question, 2);
  });

  test('une question de Codex (title) est notée de la même façon, avec son agent', () => {
    ledger({}, 'codex');
    core.appliquerCommande('on', ctx({ agent: 'codex' }));
    const r = core.refuserQuestion({ ...ctx({ agent: 'codex' }), entreeOutil: { questions: [{ title: 'Quelles ressources de test ?' }] } });
    assert.equal(r.id, 1);
    const e = core.lireBoite().entrees[0];
    assert.deepEqual([e.agent, e.titre, e.options], ['codex', 'Quelles ressources de test ?', []]);
  });

  test('une demande sans texte lisible laisse quand même une trace', () => {
    ouvrirNuit();
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: undefined });
    assert.equal(r.refuser, true);
    assert.equal(core.lireBoite().entrees[0].titre, 'Question sans texte lisible');
  });

  test('l absence atteinte active la nuit à l occasion de la question', () => {
    core.noterActivite(ctx({ maintenant: T0 - 2 * HEURE }));
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(lire('nuit.json').mode, 'absence');
  });

  test('une boîte pleine de questions à décider refuse quand même, sans promettre de les noter', () => {
    ouvrirNuit();
    for (let i = 1; i <= 50; i++) core.refuserQuestion({ ...ctx({ maintenant: T0 + i * MIN }), entreeOutil: { questions: [{ question: `Question ${i} ?` }] } });
    const r = core.refuserQuestion({ ...ctx({ maintenant: T0 + 60 * MIN }), entreeOutil: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(r.id, null);
    assert.ok(r.texte.includes('Elle n\'a PAS pu être notée en boîte (la boîte est pleine : 50 entrées à décider)'), r.texte);
    assert.equal(core.lireBoite().entrees.length, 50);
    assert.equal(lire('nuit.json').refus.question, 51, 'le refus est compté');
  });

  test('un fichier de boîte impossible à écrire refuse quand même la question, sans promettre de la noter', () => {
    ouvrirNuit();
    fs.mkdirSync(fichier('nuit-boite.json'), { recursive: true });
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(r.id, null);
    assert.ok(r.texte.includes('Elle n\'a PAS pu être notée en boîte (l\'écriture de la boîte a échoué)'), r.texte);
    assert.equal(lire('nuit.json').refus.question, 1, 'le refus est compté même si la boîte ne s écrit pas');
  });
});

describe('arrêt de garde transformé en refus', () => {
  const commande = 'git push origin main';

  test('sans nuit, ou sans arrêt du garde, rien n est refusé', () => {
    assert.deepEqual(core.refuserGarde({ ...ctx(), sortie: blocGarde('DANGER: x'), commande }), { refuser: false });
    ouvrirNuit();
    for (const sortie of [null, undefined, {}, { systemMessage: 'ATTENTION' }, 'x']) assert.deepEqual(core.refuserGarde({ ...ctx(), sortie, commande }), { refuser: false }, JSON.stringify(sortie));
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('un blocage devient un refus avec alternative, compté, sans entrée de boîte', () => {
    ouvrirNuit();
    const r = core.refuserGarde({ ...ctx(), sortie: blocGarde(RAISON_RESET), commande: 'git reset --hard' });
    assert.equal(r.refuser, true);
    assert.equal(r.genre, 'bloc');
    assert.equal(r.id, null);
    assert.ok(r.texte.startsWith(`NUIT : le garde de sécurité refuse cette commande (${RAISON_RESET}).`), r.texte);
    assert.ok(r.texte.includes('git stash'), r.texte);
    assert.deepEqual(lire('nuit.json').refus, { question: 0, garde: 1, action: 0 });
    assert.equal(existe('nuit-boite.json'), false);
  });

  test('une demande d accord devient un refus, notée en boîte avec deux boutons, comptée', () => {
    ouvrirNuit();
    const r = core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande });
    assert.equal(r.refuser, true);
    assert.equal(r.genre, 'ask');
    assert.equal(r.id, 1);
    assert.ok(r.texte.includes('La demande est notée en boîte (n° 1)'), r.texte);
    const e = core.lireBoite().entrees[0];
    assert.deepEqual([e.type, e.titre, e.options.map(o => o.label)], ['action', 'Commande en attente d\'accord : git push origin main', ['Autoriser', 'Refuser']]);
    assert.deepEqual(lire('nuit.json').refus, { question: 0, garde: 0, action: 1 });
  });

  test('la même demande d accord reste une seule entrée', () => {
    ouvrirNuit();
    core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande });
    const r = core.refuserGarde({ ...ctx({ maintenant: T0 + MIN }), sortie: demandeGarde(RAISON_PUSH), commande });
    assert.equal(r.id, 1);
    assert.equal(core.lireBoite().entrees.length, 1);
    assert.equal(lire('nuit.json').refus.action, 2);
  });

  test('une demande d accord qui ne peut pas être notée est quand même refusée, sans promettre de boîte', () => {
    ouvrirNuit();
    fs.mkdirSync(fichier('nuit-boite.json'), { recursive: true });
    const r = core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande });
    assert.equal(r.refuser, true);
    assert.equal(r.id, null);
    assert.ok(r.texte.includes('La demande n\'a PAS pu être notée en boîte (l\'écriture de la boîte a échoué)'), r.texte);
    assert.ok(!r.texte.includes('est notée en boîte'), r.texte);
    assert.equal(lire('nuit.json').refus.action, 1);
  });

  test('l absence atteinte active la nuit à l occasion de l arrêt du garde', () => {
    core.noterActivite(ctx({ maintenant: T0 - 2 * HEURE }));
    const r = core.refuserGarde({ ...ctx(), sortie: blocGarde(RAISON_SAUT), commande: 'git commit --no-verify' });
    assert.equal(r.refuser, true);
    assert.equal(lire('nuit.json').mode, 'absence');
  });
});

describe('enchaînement', () => {
  const quotaA = pct => cockpit.ecrireQuota('claude', { fenetres: [{ nom: '7 j', pct, resetsAt: iso(T0 + 3 * HEURE) }], source: 'garde-quota' });

  test('sans nuit, on ne continue pas, et rien n est écrit', () => {
    ledger({ 'C-0001': ligne('A') });
    const d = core.continuer({ ...ctx(), reason: 'answer' });
    assert.deepEqual([d.continuer, d.motif], [false, 'inactive']);
    assert.equal(existe('nuit.json'), false);
  });

  test('nuit active, tour terminé et lignes ouvertes de la session : on continue avec la première, et l état avance', () => {
    ledger({ 'C-0001': ligne('premier travail'), 'C-0002': ligne('second travail'), 'C-0003': ligne('autre fil', { session: 'AUTRE' }) });
    ouvrirNuit();
    const d = core.continuer({ ...ctx({ maintenant: T0 + MIN }), reason: 'answer' });
    assert.equal(d.continuer, true);
    assert.deepEqual(d.ligne, { id: 'C-0001', texte: 'premier travail' });
    assert.equal(d.restantes, 2);
    assert.ok(d.texte.startsWith('NUIT : L\'utilisateur est absent. Continue sans l\'attendre avec la ligne suivante de ta liste de travail : C-0001 « premier travail ».'), d.texte);
    const e = lire('nuit.json');
    assert.deepEqual([e.tours, e.derniereLigne, e.repetition], [1, 'C-0001', 1]);
  });

  test('un tour interrompu ou en erreur ne continue pas', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    for (const reason of ['aborted', 'error', 'refusal', undefined]) assert.equal(core.continuer({ ...ctx(), reason }).motif, 'interrompu', String(reason));
    assert.equal(lire('nuit.json').tours, 0);
  });

  test('la pause du Régulateur arrête l enchaînement et le dit', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    regulateur.appliquerCommande('pause');
    const d = core.continuer({ ...ctx(), reason: 'answer' });
    assert.deepEqual([d.continuer, d.motif], [false, 'pause']);
    assert.equal(lire('nuit.json').arret, 'pause');
    regulateur.appliquerCommande('reprendre');
    assert.equal(core.continuer({ ...ctx(), reason: 'answer' }).continuer, true, 'la reprise relance l enchaînement');
    assert.equal(lire('nuit.json').arret, null);
  });

  test('un quota au seuil critique arrête l enchaînement, un quota sous le seuil non', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    quotaA(95);
    const d = core.continuer({ ...ctx(), reason: 'answer' });
    assert.deepEqual([d.continuer, d.motif], [false, 'quota']);
    assert.equal(lire('nuit.json').arret, 'quota');
    quotaA(50);
    assert.equal(core.continuer({ ...ctx(), reason: 'answer' }).continuer, true);
  });

  test('un quota critique ne compte pas quand le blocage des agents est désactivé dans les réglages du Garde-quota', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    quotaA(95);
    require(path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js')).ecrireConfig({ bloquerAgents: false });
    assert.equal(core.continuer({ ...ctx(), reason: 'answer' }).continuer, true);
  });

  test('le quota de Codex se lit dans le rollout du fil donné', () => {
    ledger({ 'C-0001': ligne('A') }, 'codex');
    core.appliquerCommande('on', ctx({ agent: 'codex' }));
    const rollout = path.join(RUN, 'rollout.jsonl');
    const mesure = pct => JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round((T0 + 2 * HEURE) / 1000) }, secondary: null } } });
    fs.writeFileSync(rollout, `${mesure(95)}\n`);
    assert.equal(core.continuer({ ...ctx({ agent: 'codex' }), reason: 'answer', chemin: rollout }).motif, 'quota');
    fs.writeFileSync(rollout, `${mesure(10)}\n`);
    assert.equal(core.continuer({ ...ctx({ agent: 'codex' }), reason: 'answer', chemin: rollout }).continuer, true);
  });

  test('le plafond de tours arrête l enchaînement', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B') });
    core.appliquerCommande('tours 2', ctx());
    ouvrirNuit();
    assert.equal(core.continuer({ ...ctx(), reason: 'answer' }).continuer, true);
    assert.equal(core.continuer({ ...ctx(), reason: 'answer' }).continuer, true);
    const d = core.continuer({ ...ctx(), reason: 'answer' });
    assert.deepEqual([d.continuer, d.motif], [false, 'plafond']);
    assert.equal(lire('nuit.json').arret, 'plafond');
  });

  test('sans ligne ouverte pour cette session, le travail est fini', () => {
    ledger({ 'C-0001': ligne('autre fil', { session: 'AUTRE' }), 'C-0002': ligne('bloquée', { statut: 'bloque-utilisateur' }) });
    ouvrirNuit();
    const d = core.continuer({ ...ctx(), reason: 'answer' });
    assert.deepEqual([d.continuer, d.motif], [false, 'termine']);
    assert.equal(lire('nuit.json').arret, 'termine');
  });

  test('une ligne qui n avance pas est laissée de côté après trois propositions', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B') });
    ouvrirNuit();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(core.continuer({ ...ctx(), reason: 'answer' }).ligne.id);
    assert.deepEqual(ids, ['C-0001', 'C-0001', 'C-0001', 'C-0002']);
    assert.deepEqual(lire('nuit.json').sautees, ['C-0001']);
  });

  test('l absence atteinte active la nuit et l enchaînement commence', () => {
    ledger({ 'C-0001': ligne('A') });
    core.noterActivite(ctx({ maintenant: T0 - 2 * HEURE }));
    const d = core.continuer({ ...ctx(), reason: 'answer' });
    assert.equal(d.continuer, true);
    assert.equal(lire('nuit.json').mode, 'absence');
  });

  test('l enchaînement d un agent ne compte que ses propres lignes', () => {
    ledger({ 'C-0001': ligne('pour claude') });
    ledger({ 'C-0002': ligne('pour codex') }, 'codex');
    core.appliquerCommande('on', ctx({ agent: 'codex' }));
    const d = core.continuer({ ...ctx({ agent: 'codex' }), reason: 'answer' });
    assert.equal(d.ligne.id, 'C-0002');
  });

  test('si l état ne peut pas être écrit, l enchaînement échoue au lieu de continuer sans compter les tours', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    fs.chmodSync(fichier('nuit.json'), 0o444); // lecture seule : le remplacement par renommage est refusé
    try {
      assert.throws(() => core.continuer({ ...ctx(), reason: 'answer' }));
    } finally {
      fs.chmodSync(fichier('nuit.json'), 0o666);
    }
    assert.equal(lire('nuit.json').tours, 0, 'rien n a avancé');
  });

  test('un refus de question est rendu même si le compteur des refus ne peut pas être écrit', () => {
    ouvrirNuit();
    fs.chmodSync(fichier('nuit.json'), 0o444);
    try {
      const r = core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
      assert.equal(r.refuser, true);
      assert.equal(r.id, 1, 'la boîte a pris la question');
    } finally {
      fs.chmodSync(fichier('nuit.json'), 0o666);
    }
    assert.equal(lire('nuit.json').refus.question, 0, 'le compteur n a pas pu avancer');
  });
});

describe('cas limites relevés par les mutations', () => {
  const quota = require(path.join(__dirname, '..', 'scripts', 'lib', 'quota-core.js'));
  const quotaA = (agent, pct, fin) => cockpit.ecrireQuota(agent, { fenetres: [{ nom: '7 j', pct, resetsAt: iso(fin) }], source: 'garde-quota' });

  test('les fichiers écrits portent leur date de mise à jour, et un état brut mal formé est normalisé à la lecture', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.ok(Number.isFinite(Date.parse(lire('nuit.json').maj)));
    assert.ok(Number.isFinite(Date.parse(lire('nuit-boite.json').maj)));
    fs.writeFileSync(fichier('nuit.json'), JSON.stringify({ actif: 'oui', tours: -3, maxTours: 'x', inconnu: 1 }));
    assert.deepEqual([core.lireEtat().actif, core.lireEtat().tours, core.lireEtat().maxTours, core.lireEtat().inconnu], [false, 0, 60, undefined]);
    fs.writeFileSync(fichier('nuit-boite.json'), JSON.stringify({ prochain: 'x', entrees: [{ id: 'a' }, 5] }));
    assert.deepEqual(core.lireBoite(), { prochain: 1, entrees: [] });
  });

  test('repondre rend aussi la réponse notée, avec son entrée', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = core.appliquerCommande('repondre 1 Veilleur', ctx());
    assert.equal(r.reponse.id, 1);
    assert.equal(r.reponse.texte, 'Veilleur');
    assert.equal(r.reponse.entree.titre, 'Quel nom pour le module ?');
  });

  test('la question mise en boîte garde ses détails, sa session et son agent, même quand ce ne sont pas ceux des autres bancs', () => {
    ouvrirNuit({ session: 'S9' });
    core.refuserQuestion({ ...ctx({ session: 'S9' }), entreeOutil: askClaude });
    const e = core.lireBoite().entrees[0];
    assert.equal(e.session, 'S9');
    assert.equal(e.details, '', 'une question seule : ses options sont dans le champ options, plus dans les détails');
    assert.deepEqual(e.options.map(o => o.label), ['Veilleur (Recommended)', 'Nuit']);
    ledger({}, 'codex');
    core.appliquerCommande('on', ctx({ agent: 'deepseek_H', session: 'S9' }));
    core.refuserQuestion({ ...ctx({ agent: 'deepseek_H', session: 'S9' }), entreeOutil: { questions: [{ question: 'Autre ?' }] } });
    assert.equal(core.lireBoite().entrees[1].agent, 'deepseek-h', 'la boîte garde la clé d état de l agent du dépôt');
  });

  test('la commande à valider garde sa raison, sa date, sa session et son agent', () => {
    ouvrirNuit({ session: 'S9' });
    core.refuserGarde({ ...ctx({ session: 'S9', agent: 'codex', maintenant: T0 + 7 * MIN }), sortie: demandeGarde(RAISON_PUSH), commande: 'git push' });
    const e = core.lireBoite().entrees[0];
    assert.equal(e.details, `${RAISON_PUSH} | Commande entière : git push`);
    assert.equal(e.ajoute, iso(T0 + 7 * MIN));
    assert.deepEqual([e.session, e.agent], ['S9', 'codex']);
  });

  test('une question déjà en boîte n écrit pas la boîte une seconde fois', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    fs.chmodSync(fichier('nuit-boite.json'), 0o444); // lecture seule : toute écriture échouerait
    try {
      const r = core.refuserQuestion({ ...ctx({ maintenant: T0 + MIN }), entreeOutil: askClaude });
      assert.equal(r.id, 1, 'la question est reconnue sans réécriture');
    } finally {
      fs.chmodSync(fichier('nuit-boite.json'), 0o666);
    }
  });

  test('nuitActive n écrit rien quand ni la nuit ni l absence ne sont là', () => {
    core.noterActivite(ctx({ maintenant: T0 - 10 * MIN }));
    fs.chmodSync(fichier('nuit.json'), 0o444);
    try {
      assert.equal(core.nuitActive(ctx()), false);
    } finally {
      fs.chmodSync(fichier('nuit.json'), 0o666);
    }
  });

  test('une panne de la mesure du quota n arrête pas la nuit', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    const origine = quota.decisionAgentCodex;
    quota.decisionAgentCodex = () => { throw new Error('panne simulée du quota'); };
    try {
      assert.equal(core.continuer({ ...ctx(), reason: 'answer' }).continuer, true);
    } finally {
      quota.decisionAgentCodex = origine;
    }
  });

  test('le quota se juge pour l agent donné : la mesure gardée d un autre agent ne l arrête pas', () => {
    ledger({ 'C-0001': ligne('A') }, 'codex');
    core.appliquerCommande('on', ctx({ agent: 'codex' }));
    quotaA('claude', 95, T0 + 3 * HEURE);
    assert.equal(core.continuer({ ...ctx({ agent: 'codex' }), reason: 'answer' }).continuer, true);
    quotaA('codex', 95, T0 + 3 * HEURE);
    ledger({ 'C-0001': ligne('A') }, 'codex');
    assert.equal(core.continuer({ ...ctx({ agent: 'codex' }), reason: 'answer' }).motif, 'quota');
  });

  test('le quota se juge à l instant donné : une fenêtre déjà remise à zéro n arrête plus la nuit', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    quotaA('claude', 95, T0 + 3 * HEURE);
    assert.equal(core.continuer({ ...ctx({ maintenant: T0 + MIN }), reason: 'answer' }).motif, 'quota');
    assert.equal(core.continuer({ ...ctx({ maintenant: T0 + 4 * HEURE }), reason: 'answer' }).continuer, true);
  });

  test('l enchaînement suit la session donnée, quelle qu elle soit', () => {
    ledger({ 'C-0001': ligne('pour S9', { session: 'S9' }), 'C-0002': ligne('pour S1') });
    ouvrirNuit({ session: 'S9' });
    const d = core.continuer({ ...ctx({ session: 'S9' }), reason: 'answer' });
    assert.equal(d.ligne.id, 'C-0001');
    assert.equal(d.restantes, 1);
  });

  test('le récap garde la boîte à décider', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const t = core.recap(ctx({ maintenant: T0 + HEURE }));
    assert.ok(t.includes('À décider (1) :'), t);
    assert.ok(t.includes('1. [question] Quel nom pour le module ?'), t);
  });
});

describe('sans conversation connue (commande tapée dans un terminal)', () => {
  test('sans session, le nombre de lignes ouvertes au coucher est inconnu, pas zéro', () => {
    ledger({ 'C-0001': ligne('A') });
    core.appliquerCommande('on', { agent: 'claude', maintenant: T0 });
    assert.equal(lire('nuit.json').lignesAuDebut, null);
    const t = core.appliquerCommande('off', { agent: 'claude', maintenant: T0 + HEURE }).message;
    assert.ok(!t.includes('Lignes ouvertes'), t);
  });

  test('une session vide ou mal typée vaut une session absente', () => {
    ledger({ 'C-0001': ligne('A') });
    for (const session of ['', 5, null]) {
      core.appliquerCommande('on', { agent: 'claude', session, maintenant: T0 });
      assert.equal(lire('nuit.json').lignesAuDebut, null, String(session));
      core.appliquerCommande('off', { agent: 'claude', session, maintenant: T0 + MIN });
    }
  });

  test('sans session, l enchaînement ne prend la ligne de personne', () => {
    ledger({ 'C-0001': ligne('A') });
    core.appliquerCommande('on', { agent: 'claude', maintenant: T0 });
    assert.equal(core.continuer({ agent: 'claude', reason: 'answer', maintenant: T0 }).motif, 'termine');
  });
});

describe('opérations des hooks (entrée et sortie JSON)', () => {
  const entree = (extra = {}) => ({ agent: 'claude', session: 'S1', maintenant: T0, ...extra });
  const hook = (operation, extra) => core.executerHook(operation, entree(extra));
  // Un faux garde de sécurité : il note ce qu'il reçoit et rend la sortie donnée par l'environnement.
  function fauxGarde(sortie, { code = 0, brut = null, dormir = 0 } = {}) {
    const script = path.join(RUN, 'faux-garde.js');
    fs.writeFileSync(script, [
      "const fs = require('node:fs');",
      "let d = ''; process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(path.join(RUN, 'garde-entree.json'))}, d);`,
      `  fs.writeFileSync(${JSON.stringify(path.join(RUN, 'garde-args.json'))}, JSON.stringify(process.argv.slice(2)));`,
      dormir ? `  setTimeout(() => {}, ${dormir});` : '',
      `  ${brut !== null ? `process.stdout.write(${JSON.stringify(brut)});` : sortie === null ? '' : `process.stdout.write(JSON.stringify(${JSON.stringify(sortie)}));`}`,
      `  process.exitCode = ${code};`,
      '});',
    ].join('\n'));
    process.env.NUIT_GARDE = script;
    return () => (fs.existsSync(path.join(RUN, 'garde-entree.json')) ? JSON.parse(fs.readFileSync(path.join(RUN, 'garde-entree.json'), 'utf8')) : null);
  }
  const bash = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:/x' });

  beforeEach(() => { delete process.env.NUIT_GARDE; delete process.env.NUIT_GARDE_DELAI_MS; });

  test('une entrée invalide ou une opération inconnue donne une erreur, sans rien écrire', () => {
    for (const op of ['question', 'garde', 'continuer', 'activite']) {
      for (const mauvaise of [null, undefined, 'x', 5, {}, { agent: 'Claude', session: 'S1' }, { agent: 'claude' }, { agent: 'claude', session: '' }, { agent: 'claude', session: 5 }]) {
        assert.deepEqual(core.executerHook(op, mauvaise), { erreur: 'entrée invalide' }, `${op} ${JSON.stringify(mauvaise)}`);
      }
    }
    assert.deepEqual(hook('inconnue'), { erreur: 'opération inconnue : inconnue' });
    assert.equal(existe('nuit.json'), false);
  });

  test('question : refusée seulement pendant la nuit, avec l entrée de l outil', () => {
    assert.deepEqual(hook('question', { tool_input: askClaude }), { refuser: false });
    ouvrirNuit();
    const r = hook('question', { tool_input: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(r.id, 1);
    assert.equal(core.lireBoite().entrees[0].titre, 'Quel nom pour le module ?');
  });

  test('commande : la commande /nuit en JSON, avec son effet et le texte à donner au modèle', () => {
    ledger({ 'C-0001': ligne('A') });
    const on = hook('commande', { args: 'on' });
    assert.deepEqual([on.effet, on.message.startsWith('Nuit : active.')], ['active', true]);
    assert.equal(lire('nuit.json').lignesAuDebut, 1);
    assert.equal(lire('nuit.json').depuis, iso(T0), 'l instant donné par le hook fait foi');
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('pour S9', { session: 'S9' }), 'C-0003': ligne('pour S9 aussi', { session: 'S9' }) });
    hook('commande', { args: 'off' });
    core.executerHook('commande', entree({ session: 'S9', args: 'on' }));
    assert.equal(lire('nuit.json').lignesAuDebut, 2, 'les lignes comptées sont celles de la conversation donnée');
    hook('commande', { session: 'S9', args: 'off' });
    hook('commande', { args: 'on' });
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = hook('commande', { args: 'repondre 1 Veilleur' });
    assert.equal(r.effet, 'reponse');
    assert.equal(r.reponse.id, 1);
    assert.equal(r.prompt, 'NUIT : réponse de l\'utilisateur à la question n° 1 (« Quel nom pour le module ? ») : Veilleur. Applique-la maintenant.');
    const off = hook('commande', { args: 'off' });
    assert.equal(off.effet, 'reveil');
    assert.match(off.message, /^NUIT : récap\./);
  });

  test('commande : sans argument c est l état, un argument illisible ou invalide donne l erreur de la commande', () => {
    assert.match(hook('commande').message, /^Nuit : inactive\./);
    assert.match(hook('commande', { args: 5 }).message, /^Nuit : inactive\./, 'un argument qui n est pas un texte vaut aucun argument');
    assert.match(hook('commande', { args: 'demain' }).erreur, /^Usage : \/nuit /);
    assert.equal(existe('nuit.json'), false);
  });

  test('activite : date l activité de l\'utilisateur et rend le récap au réveil', () => {
    assert.deepEqual(hook('activite'), { reveil: false });
    ouvrirNuit();
    const r = hook('activite', { maintenant: T0 + HEURE });
    assert.equal(r.reveil, true);
    assert.match(r.recap, /^NUIT : récap\./);
  });

  test('continuer : rend la décision, avec le chemin du rollout et la raison de fin du tour', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    assert.equal(hook('continuer', { reason: 'aborted' }).motif, 'interrompu');
    const d = hook('continuer', { reason: 'answer', chemin: 5 });
    assert.equal(d.continuer, true);
    assert.equal(d.ligne.id, 'C-0001');
  });

  test('garde : hors nuit le garde n est même pas lancé', () => {
    const entreeDuGarde = fauxGarde(blocGarde('DANGER: x'));
    assert.deepEqual(hook('garde', bash('rm -rf x')), { refuser: false });
    assert.equal(entreeDuGarde(), null, 'le garde de sécurité n a pas tourné');
  });

  test('garde : un outil sans commande ne lance pas le garde', () => {
    ouvrirNuit();
    const entreeDuGarde = fauxGarde(blocGarde('DANGER: x'));
    for (const extra of [{ tool_name: 'Read', tool_input: { file_path: 'x' } }, { tool_name: 'Bash', tool_input: {} }, { tool_name: 'Bash', tool_input: { command: '' } }, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: 'x' }, { tool_name: 'Bash', tool_input: { command: 5 } }]) {
      assert.deepEqual(hook('garde', extra), { refuser: false }, JSON.stringify(extra));
    }
    assert.equal(entreeDuGarde(), null);
  });

  test('garde : le garde reçoit l entrée d un PreToolUse, et un blocage devient un refus avec alternative', () => {
    ouvrirNuit();
    const entreeDuGarde = fauxGarde(blocGarde(RAISON_RESET), { code: 2 });
    const r = hook('garde', bash('git reset --hard'));
    assert.equal(r.refuser, true);
    assert.equal(r.genre, 'bloc');
    assert.ok(r.texte.includes('git stash'), r.texte);
    assert.deepEqual(entreeDuGarde(), { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd: 'C:/x', session_id: 'S1' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(RUN, 'garde-args.json'), 'utf8')), ['--agent', 'claude'], 'la garde est lancée pour l agent qui demande');
    assert.deepEqual(lire('nuit.json').refus, { question: 0, garde: 1, action: 0 });
  });

  test('garde : la commande vient de command, de cmd, de script ou de input, dans cet ordre', () => {
    ouvrirNuit();
    fauxGarde(demandeGarde(RAISON_PUSH));
    for (const [tool_input, attendu] of [[{ command: 'git push a' }, 'git push a'], [{ script: 'git push b' }, 'git push b'], [{ input: 'git push c' }, 'git push c'], [{ command: 'git push d', script: 'x', input: 'y' }, 'git push d'],
      [{ cmd: 'git push e' }, 'git push e'], [{ command: '', cmd: 'git push f', script: 'x' }, 'git push f'], [{ cmd: 'git push g', script: 'x', input: 'y' }, 'git push g']]) {
      core.executerHook('garde', entree({ tool_name: 'Bash', tool_input }));
      assert.ok(core.lireBoite().entrees.some(e => e.titre === `Commande en attente d'accord : ${attendu}`), attendu);
    }
  });

  test('garde : une demande d accord devient un refus noté en boîte', () => {
    ouvrirNuit();
    fauxGarde(demandeGarde(RAISON_PUSH));
    const r = hook('garde', bash('git push origin main'));
    assert.deepEqual([r.refuser, r.genre, r.id], [true, 'ask', 1]);
    assert.equal(core.lireBoite().entrees[0].type, 'action');
  });

  test('garde : un garde qui laisse passer, plante, n écrit rien ou écrit autre chose que du JSON ne refuse rien', () => {
    ouvrirNuit();
    for (const [sortie, options] of [[{ systemMessage: 'ATTENTION' }, {}], [null, {}], [null, { brut: 'pas du json' }], [null, { brut: '' }], [{}, { code: 1 }]]) {
      fauxGarde(sortie, options);
      assert.deepEqual(hook('garde', bash('ls')), { refuser: false }, JSON.stringify([sortie, options]));
    }
    process.env.NUIT_GARDE = path.join(RUN, 'garde-absent.js');
    assert.deepEqual(hook('garde', bash('ls')), { refuser: false }, 'garde introuvable');
    assert.equal(lire('nuit.json').refus.garde, 0);
  });

  test('garde : un garde trop lent est laissé de côté', () => {
    ouvrirNuit();
    fauxGarde(blocGarde('DANGER: x'), { dormir: 5000 });
    process.env.NUIT_GARDE_DELAI_MS = '300';
    const debut = Date.now();
    assert.deepEqual(hook('garde', bash('ls')), { refuser: false });
    assert.ok(Date.now() - debut < 4000, 'le délai a coupé le garde');
  });

  test('garde : le vrai garde de sécurité arrête rm -rf et laisse passer ls', () => {
    ouvrirNuit();
    const r = hook('garde', bash('rm -rf dossier'));
    assert.equal(r.refuser, true);
    assert.equal(r.genre, 'bloc');
    assert.ok(r.texte.includes('laisse le dossier en place, note-le pour le réveil de l\'utilisateur'), r.texte);
    assert.deepEqual(hook('garde', bash('ls -la')), { refuser: false });
  });

  test('une panne du noyau est rendue comme une erreur qui cite sa cause, pas comme une exception', () => {
    ouvrirNuit();
    fs.chmodSync(fichier('nuit.json'), 0o444);
    try {
      ledger({ 'C-0001': ligne('A') });
      const r = hook('continuer', { reason: 'answer' });
      assert.match(r.erreur, /EPERM|EACCES|EBUSY/);
    } finally {
      fs.chmodSync(fichier('nuit.json'), 0o666);
    }
  });

  test('l instant donné par le hook fait foi ; sans instant, c est l instant présent', () => {
    ouvrirNuit();
    hook('activite', { maintenant: T0 + HEURE });
    assert.equal(lire('nuit.json').fin, iso(T0 + HEURE));
    for (const maintenant of [undefined, 'abc', NaN, null]) {
      const avant = Date.now();
      core.executerHook('activite', { agent: 'claude', session: 'S1', maintenant });
      const date = Date.parse(lire('nuit.json').derniereActivite);
      assert.ok(date >= avant && date <= Date.now(), `activité datée à l instant présent pour ${String(maintenant)}`);
    }
  });

  test('continuer lit le quota dans le rollout donné par le hook', () => {
    ledger({ 'C-0001': ligne('A') }, 'codex');
    core.appliquerCommande('on', ctx({ agent: 'codex' }));
    const rollout = path.join(RUN, 'rollout-hook.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: '2026-03-03T11:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 95, window_minutes: 10080, resets_at: Math.round((T0 + 2 * HEURE) / 1000) }, secondary: null } } })}\n`);
    // Un chemin qui n'est pas un texte est ignoré ; et comme aucune mesure n'est encore gardée, rien n'arrête la nuit.
    assert.equal(core.executerHook('continuer', entree({ agent: 'codex', reason: 'answer', chemin: 5 })).continuer, true);
    assert.equal(core.executerHook('continuer', entree({ agent: 'codex', reason: 'answer', chemin: rollout })).motif, 'quota');
  });
});

describe('ligne de commande', () => {
  const { spawnSync } = require('node:child_process');
  const CLI = process.env.COCKPIT_CLI_TESTE || path.join(__dirname, '..', 'scripts', 'cockpit.js'); // COCKPIT_CLI_TESTE : preuves par mutation de la ligne de commande
  const lancer = (args, { input, env } = {}) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
  const json = r => JSON.parse(r.stdout);

  beforeEach(() => { delete process.env.NUIT_GARDE; });

  test('cockpit.js nuit sans argument dit l état, et ne crée aucun fichier', () => {
    const r = lancer(['nuit']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Nuit : inactive\. Détection d'absence : après 60 min sans message de l\'utilisateur/);
    assert.equal(r.stderr, '');
    assert.equal(existe('nuit.json'), false);
  });

  test('cockpit.js nuit on commence la nuit, compte les lignes de la conversation donnée, et off rend le récap', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B'), 'C-0003': ligne('autre', { session: 'AUTRE' }) });
    const on = lancer(['nuit', 'on', '--session', 'S1']);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^Nuit : active\./);
    assert.ok(!on.stdout.includes('Texte à donner'), 'seule une réponse notée donne un texte pour l agent');
    assert.deepEqual([lire('nuit.json').actif, lire('nuit.json').lignesAuDebut], [true, 2]);
    const off = lancer(['nuit', '--session', 'S1', 'off']);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /^NUIT : récap\./);
    assert.ok(off.stdout.includes('Lignes ouvertes : 2 au coucher, 2 maintenant.'), off.stdout);
    assert.equal(lire('nuit.json').actif, false);
  });

  test('sans --session, les lignes ouvertes ne sont pas comptées', () => {
    ledger({ 'C-0001': ligne('A') });
    lancer(['nuit', 'on']);
    assert.equal(lire('nuit.json').lignesAuDebut, null);
  });

  test('--agent choisit l agent principal dont on compte les lignes ; claude par défaut', () => {
    ledger({ 'C-0001': ligne('pour claude') });
    ledger({ 'C-0002': ligne('pour codex 1'), 'C-0003': ligne('pour codex 2') }, 'codex');
    lancer(['nuit', 'on', '--agent', 'codex', '--session', 'S1']);
    assert.equal(lire('nuit.json').lignesAuDebut, 2);
    lancer(['nuit', 'off', '--agent', 'codex', '--session', 'S1']);
    lancer(['nuit', 'on', '--session', 'S1']);
    assert.equal(lire('nuit.json').lignesAuDebut, 1);
  });

  test('un agent invalide, ou une option sans valeur, donne une erreur et un code 2', () => {
    for (const args of [['nuit', 'on', '--agent', 'Codex'], ['nuit', 'on', '--agent'], ['nuit', 'on', '--agent', '../x']]) {
      const r = lancer(args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /^Agent invalide : /, args.join(' '));
      assert.equal(r.stdout, '');
    }
    assert.equal(existe('nuit.json'), false);
    assert.equal(lancer(['nuit', 'on', '--agent']).stderr, 'Agent invalide : (aucun)\n');
    assert.equal(lancer(['nuit', 'on', '--agent', 'Codex']).stderr, 'Agent invalide : Codex\n');
  });

  test('une commande inconnue donne l usage sur la sortie d erreur et un code 2', () => {
    const r = lancer(['nuit', 'demain']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Usage : \/nuit /);
    assert.equal(r.stdout, '');
  });

  test('repondre note la réponse et affiche le texte à donner à l agent', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    const r = lancer(['nuit', 'repondre', '1', 'Veilleur']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'Boîte : réponse notée pour la question n° 1.\nTexte à donner à l\'agent : NUIT : réponse de l\'utilisateur à la question n° 1 (« Quel nom pour le module ? ») : Veilleur. Applique-la maintenant.\n');
    assert.equal(core.lireBoite().entrees[0].statut, 'repondue');
  });

  test('les mots de la commande gardent leur casse et leurs espaces simples', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    lancer(['nuit', 'repondre', '1', 'Oui,', 'DEMO', 'Vision']);
    assert.equal(core.lireBoite().entrees[0].reponse, 'Oui, DEMO Vision');
  });

  test('nuit-hook question rend le refus en JSON sur une ligne', () => {
    ouvrirNuit();
    const r = lancer(['nuit-hook', 'question'], { input: JSON.stringify({ agent: 'claude', session: 'S1', tool_input: askClaude }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.endsWith('\n') && r.stdout.trim().split('\n').length === 1);
    const j = json(r);
    assert.deepEqual([j.refuser, j.id], [true, 1]);
    assert.ok(j.texte.startsWith('NUIT : L\'utilisateur est absent'));
  });

  test('nuit-hook activite, continuer et garde parlent le même noyau', () => {
    ledger({ 'C-0001': ligne('A') });
    ouvrirNuit();
    const fauxGarde = path.join(RUN, 'faux-garde.js');
    fs.writeFileSync(fauxGarde, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(blocGarde(RAISON_SAUT)))}));`);
    const g = json(lancer(['nuit-hook', 'garde'], { input: JSON.stringify({ agent: 'claude', session: 'S1', tool_name: 'Bash', tool_input: { command: 'git commit --no-verify' } }), env: { NUIT_GARDE: fauxGarde } }));
    assert.deepEqual([g.refuser, g.genre], [true, 'bloc']);
    const c = json(lancer(['nuit-hook', 'continuer'], { input: JSON.stringify({ agent: 'claude', session: 'S1', reason: 'answer' }) }));
    assert.deepEqual([c.continuer, c.ligne.id], [true, 'C-0001']);
    const a = json(lancer(['nuit-hook', 'activite'], { input: JSON.stringify({ agent: 'claude', session: 'S1' }) }));
    assert.equal(a.reveil, true);
    assert.match(a.recap, /^NUIT : récap\./);
  });

  test('nuit-hook : une entrée illisible, vide ou invalide, ou une opération inconnue, donne une erreur en JSON et le code 0', () => {
    for (const [args, input, attendu] of [
      [['nuit-hook', 'question'], 'pas du json', 'entrée illisible'],
      [['nuit-hook', 'question'], '', 'entrée illisible'],
      [['nuit-hook', 'question'], '{"agent":"Claude","session":"S1"}', 'entrée invalide'],
      [['nuit-hook', 'inconnue'], JSON.stringify({ agent: 'claude', session: 'S1' }), 'opération inconnue : inconnue'],
      [['nuit-hook'], JSON.stringify({ agent: 'claude', session: 'S1' }), 'opération inconnue : undefined'],
    ]) {
      const r = lancer(args, { input });
      assert.equal(r.status, 0, `${args.join(' ')} ${input}`);
      assert.deepEqual(json(r), { erreur: attendu }, `${args.join(' ')} ${input}`);
    }
  });

  test('cockpit.js sans commande connue cite nuit et nuit-hook dans son usage', () => {
    const r = lancer(['inconnue']);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('config, consignes, nuit, nuit-hook, pause, reprendre, pause-hook)'), r.stderr);
  });
});

describe('récap', () => {
  test('recap rend le récap courant, avec les lignes du moment', () => {
    ledger({ 'C-0001': ligne('A'), 'C-0002': ligne('B') });
    ouvrirNuit();
    const t = core.recap(ctx({ maintenant: T0 + 90 * MIN }));
    assert.match(t, /^NUIT : récap \(nuit en cours\)\./);
    assert.ok(t.includes('Durée : 1 h 30 min (nuit).'), t);
    assert.ok(t.includes('Lignes ouvertes : 2 au coucher, 2 maintenant.'), t);
  });

  test('recap sans nuit enregistrée le dit', () => {
    assert.match(core.recap(ctx()), /^NUIT : récap\.\nAucune nuit enregistrée\./);
  });
});

// ---------------------------------------------------------------- une entrée par question, verrou, autorisation, archive

describe('une entrée par question, commande entière', () => {
  const trois = { questions: [
    { question: 'Première ?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] },
    { question: 'Seconde ?', options: [{ label: 'Oui' }, { label: 'Non' }] },
    { question: 'Troisième ?', options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] },
  ] };

  test('un questionnaire de trois questions donne trois entrées, chacune avec ses boutons, reliées par un lot', () => {
    ouvrirNuit();
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: trois });
    assert.deepEqual([r.refuser, r.id, r.ids, r.lot], [true, 1, [1, 2, 3], 1]);
    const entrees = core.lireBoite().entrees;
    assert.deepEqual(entrees.map(e => [e.id, e.titre, e.lot, e.options.map(o => o.label)]), [
      [1, 'Première ?', 1, ['A (Recommended)', 'B']],
      [2, 'Seconde ?', 1, ['Oui', 'Non']],
      [3, 'Troisième ?', 1, ['X', 'Y', 'Z']],
    ]);
    for (const n of ['n° 1 « Première ? »', 'n° 2 « Seconde ? »', 'n° 3 « Troisième ? »', 'lot n° 1', '3 à décider au réveil']) assert.ok(r.texte.includes(n), `${n} : ${r.texte}`);
    assert.equal(lire('nuit.json').refus.question, 3, 'trois questions refusées');
    const encore = core.refuserQuestion({ ...ctx({ maintenant: T0 + MIN }), entreeOutil: trois });
    assert.deepEqual([encore.ids, encore.lot, core.lireBoite().entrees.length], [[1, 2, 3], 1, 3], 'le même appel ne duplique rien');
    const rep = core.appliquerCommande('repondre 2 Non', ctx({ maintenant: T0 + 2 * MIN }));
    assert.ok(rep.prompt.includes('question n° 2') && rep.prompt.includes('lot n° 1'), rep.prompt);
  });

  test('une boîte qui ne peut pas toutes les prendre le dit pour chacune', () => {
    ouvrirNuit();
    for (let i = 1; i <= 49; i++) core.refuserQuestion({ ...ctx({ maintenant: T0 + i * MIN }), entreeOutil: { questions: [{ question: `Question ${i} ?` }] } });
    const r = core.refuserQuestion({ ...ctx({ maintenant: T0 + 60 * MIN }), entreeOutil: trois });
    assert.deepEqual(r.ids, [50, null, null]);
    assert.ok(r.texte.includes('n° 50 « Première ? »'), r.texte);
    assert.ok(r.texte.includes('PAS notées en boîte : « Seconde ? » (la boîte est pleine : 50 entrées à décider) ; « Troisième ? » (la boîte est pleine : 50 entrées à décider)'), r.texte);
    assert.equal(core.lireBoite().entrees.length, 50);
  });

  test('la commande à autoriser est gardée ENTIÈRE, avec son empreinte, et /nuit boite la montre', () => {
    ouvrirNuit();
    const commande = `Set-Location 'C:\\travail'; ${'git status; '.repeat(60)}git push origin "HEAD:refs/heads/fin-de-la-commande"`;
    assert.ok(commande.length > 700);
    const r = core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande });
    assert.deepEqual([r.refuser, r.id], [true, 1]);
    const e = core.lireBoite().entrees[0];
    assert.equal(e.details, `${RAISON_PUSH} | Commande entière : ${commande}`);
    assert.equal(e.empreinte, core.empreinteCommande('claude', 'S1', commande));
    assert.match(e.empreinte, /^[0-9a-f]{64}$/);
    assert.ok(e.titre.length <= 240);
    assert.ok(core.appliquerCommande('boite', ctx()).message.includes('git push origin "HEAD:refs/heads/fin-de-la-commande"'));
    const autre = core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande: `${commande} --tags` });
    assert.equal(autre.id, 2, 'une commande qui ne diffère qu au-delà du titre est une autre entrée');
    assert.equal(core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande }).id, 1, 'la même, encore à décider, ne se duplique pas');
  });
});

describe('verrou sur nuit.json et nuit-boite.json', () => {
  const { spawn, spawnSync } = require('node:child_process');
  const CLI = process.env.COCKPIT_CLI_TESTE || path.join(__dirname, '..', 'scripts', 'cockpit.js');
  const verrou = () => fichier('nuit.verrou');
  const tenir = (contenu = JSON.stringify({ pid: process.pid, ts: Date.now() })) => { fs.mkdirSync(process.env.COCKPIT_DIR, { recursive: true }); fs.writeFileSync(verrou(), contenu); };

  beforeEach(() => { process.env.NUIT_VERROU_DELAI_MS = '150'; });

  test('verrou tenu par un autre : la question est refusée et le modèle lit qu elle n a PAS été notée', () => {
    ouvrirNuit();
    tenir();
    const debut = Date.now();
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.ok(Date.now() - debut < 5000, 'l attente est bornée');
    assert.deepEqual([r.refuser, r.id], [true, null]);
    assert.ok(r.texte.includes("Elle n'a PAS pu être notée en boîte (les fichiers de la nuit sont occupés par un autre agent)"), r.texte);
    assert.equal(existe('nuit-boite.json'), false, 'rien n a été écrit sans le verrou');
    assert.equal(lire('nuit.json').refus.question, 0, 'le compteur non plus');
    assert.equal(fs.existsSync(verrou()), true, 'le verrou d un autre n est pas volé');
  });

  test('verrou tenu : la commande à autoriser est refusée, non notée, et dite non notée ; une commande /nuit qui écrit rend une erreur', () => {
    ouvrirNuit();
    tenir();
    const r = core.refuserGarde({ ...ctx(), sortie: demandeGarde(RAISON_PUSH), commande: 'git push' });
    assert.deepEqual([r.refuser, r.genre, r.id], [true, 'ask', null]);
    assert.ok(r.texte.includes("La demande n'a PAS pu être notée en boîte (les fichiers de la nuit sont occupés par un autre agent)"), r.texte);
    assert.equal(existe('nuit-boite.json'), false);
    // Une commande qui écrit PENDANT la nuit : off (les réglages, tours compris, y sont refusés avant tout verrou).
    const c = core.appliquerCommande('off', ctx());
    assert.match(c.erreur, /^Nuit : fichiers de la nuit occupés depuis plus de 150 ms : rien n'a changé/);
    assert.equal(lire('nuit.json').actif, true, 'la nuit n a pas été éteinte');
    assert.equal(lire('nuit.json').maxTours, 60);
    assert.equal(typeof core.appliquerCommande('statut', ctx()).message, 'string', 'une lecture ne demande pas le verrou');
    assert.deepEqual(core.executerHook('activite', ctx()), { erreur: 'fichiers de la nuit occupés depuis plus de 150 ms' });
    assert.equal(lire('nuit.json').actif, true, 'sans verrou, l activité n a rien écrit');
  });

  test('un verrou laissé par un processus mort, ou périmé, est repris ; le verrou est rendu après chaque opération', () => {
    ouvrirNuit();
    assert.equal(fs.existsSync(verrou()), false, 'rendu après la commande');
    const mort = spawnSync(process.execPath, ['-e', '']).pid;
    tenir(JSON.stringify({ pid: mort, ts: Date.now() }));
    assert.equal(core.refuserQuestion({ ...ctx(), entreeOutil: askClaude }).id, 1);
    tenir(JSON.stringify({ pid: process.pid, ts: Date.now() - 31 * 1000 }));
    assert.equal(core.refuserQuestion({ ...ctx(), entreeOutil: { questions: [{ question: 'Autre ?' }] } }).id, 2);
    assert.equal(fs.existsSync(verrou()), false);
  });

  test('douze processus qui ajoutent en même temps donnent autant d entrées distinctes, aux numéros distincts', async () => {
    ouvrirNuit();
    const PROCESSUS = 12;
    const lancer = i => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [CLI, 'nuit-hook', 'question'], { env: { ...process.env, NUIT_VERROU_DELAI_MS: '60000' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let sortie = '';
      p.stdout.on('data', c => { sortie += c; });
      p.on('error', reject);
      p.on('close', () => { try { resolve(JSON.parse(sortie)); } catch (e) { reject(new Error(`processus ${i} : ${sortie}`)); } });
      p.stdin.end(JSON.stringify({ agent: 'claude', session: `S${i}`, maintenant: T0 + i, tool_input: { questions: [{ question: `Question A du processus ${i} ?` }, { question: `Question B du processus ${i} ?` }] } }));
    });
    const rendus = await Promise.all(Array.from({ length: PROCESSUS }, (_, i) => lancer(i + 1)));
    const boite = core.lireBoite();
    const ids = boite.entrees.map(e => e.id).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 2 * PROCESSUS }, (_, i) => i + 1), 'aucune entrée perdue, aucun numéro pris deux fois');
    assert.equal(new Set(boite.entrees.map(e => e.titre)).size, 2 * PROCESSUS);
    assert.equal(boite.prochain, 2 * PROCESSUS + 1);
    assert.deepEqual(rendus.flatMap(r => r.ids).sort((a, b) => a - b), ids, 'chaque processus a reçu ses propres numéros');
    for (const r of rendus) assert.equal(r.ids[1], r.ids[0] + 1, 'les deux questions d un appel se suivent : le lot est ajouté d un bloc');
    assert.equal(lire('nuit.json').refus.question, 2 * PROCESSUS, 'aucun refus perdu au compteur');
    assert.equal(fs.existsSync(verrou()), false);
  });
});

describe('« Autoriser » autorise une fois, et seulement sur la décision de l\'utilisateur', () => {
  const { spawnSync } = require('node:child_process');
  const CLI = process.env.COCKPIT_CLI_TESTE || path.join(__dirname, '..', 'scripts', 'cockpit.js');
  const PUSH = 'git push origin "HEAD:refs/heads/travail-a"';
  const ask = () => demandeGarde(RAISON_PUSH);
  const garde = (extra = {}) => core.refuserGarde({ ...ctx({ maintenant: T0 + 10 * MIN }), sortie: ask(), commande: PUSH, ...extra });
  // Ce que l'adaptateur garde dans la mémoire du moteur quand l'utilisateur répond lui-même : le numéro de l'entrée et son empreinte.
  const attestation = id => [{ id, empreinte: core.lireBoite().entrees.find(e => e.id === id).empreinte }];
  // Une commande mise en boîte (n° 1) puis répondue : par défaut « Autoriser », une minute après.
  function decidee(reponse = 'Autoriser') {
    ouvrirNuit();
    assert.equal(core.refuserGarde({ ...ctx(), sortie: ask(), commande: PUSH }).id, 1);
    const r = core.appliquerCommande(`repondre 1 ${reponse}`, ctx({ maintenant: T0 + MIN }));
    assert.equal(r.erreur, undefined);
  }

  beforeEach(() => { delete process.env.NUIT_GARDE; delete process.env.NUIT_VERROU_DELAI_MS; });

  test('la commande autorisée par l\'utilisateur passe UNE fois, relancée à l identique ; le deuxième essai est refusé et remis en boîte', () => {
    decidee();
    const r = garde({ attestees: attestation(1) });
    assert.deepEqual(r, { refuser: false, autorisee: 1 });
    const e = core.lireBoite().entrees[0];
    assert.equal(e.consommee, iso(T0 + 10 * MIN), 'marquée consommée avant de laisser passer');
    assert.equal(lire('nuit.json').refus.action, 1, 'le passage n est pas compté comme un refus');
    const encore = garde({ attestees: attestation(1), maintenant: T0 + 11 * MIN });
    assert.deepEqual([encore.refuser, encore.genre, encore.id], [true, 'ask', 2]);
    assert.equal(lire('nuit.json').refus.action, 2);
  });

  test('une commande différente d un seul caractère est refusée', () => {
    decidee();
    for (const autre of [`${PUSH} `, `${PUSH}x`, PUSH.slice(0, -1), PUSH.replace('travail-a', 'travail-b'), ` ${PUSH}`]) {
      const r = core.refuserGarde({ ...ctx({ maintenant: T0 + 10 * MIN }), sortie: ask(), commande: autre, attestees: [{ id: 1, empreinte: core.empreinteCommande('claude', 'S1', autre) }, ...attestation(1)] });
      assert.equal(r.refuser, true, JSON.stringify(autre));
    }
    assert.equal(core.lireBoite().entrees[0].consommee, undefined);
    assert.deepEqual(garde({ attestees: attestation(1) }), { refuser: false, autorisee: 1 }, 'la commande exacte passe encore');
  });

  test('une autre conversation ou un autre agent sont refusés, même avec l attestation', () => {
    decidee();
    for (const extra of [{ session: 'S2' }, { agent: 'codex' }, { agent: 'codex', session: 'S2' }]) {
      const c = ctx({ maintenant: T0 + 10 * MIN, ...extra });
      const r = core.refuserGarde({ ...c, sortie: ask(), commande: PUSH, attestees: [...attestation(1), { id: 1, empreinte: core.empreinteCommande(c.agent, c.session, PUSH) }] });
      assert.equal(r.refuser, true, JSON.stringify(extra));
    }
    assert.equal(core.lireBoite().entrees[0].consommee, undefined);
  });

  test('« Refuser » ne laisse rien passer ; une action n accepte pas de texte libre', () => {
    decidee('Refuser');
    assert.equal(garde({ attestees: attestation(1) }).refuser, true);
    assert.equal(core.appliquerCommande('repondre 2 oui vas-y', ctx({ maintenant: T0 + 20 * MIN })).erreur, 'Boîte : cette action exige le libellé exact d’une option déclarée.');
    assert.equal(garde({ attestees: attestation(2), maintenant: T0 + 21 * MIN }).refuser, true);
  });

  test('une réponse de 12 heures ou plus ne vaut plus', () => {
    decidee();
    assert.equal(garde({ attestees: attestation(1), maintenant: T0 + MIN + 12 * HEURE }).refuser, true);
    assert.equal(core.lireBoite().entrees[0].consommee, undefined);
  });

  test('une réponse écrite par la ligne de commande n est jamais consommable : sans l attestation de l adaptateur, c est une simple note', () => {
    ouvrirNuit();
    assert.equal(core.refuserGarde({ ...ctx(), sortie: ask(), commande: PUSH }).id, 1);
    const env = { ...process.env };
    const cli = spawnSync(process.execPath, [CLI, 'nuit', 'repondre', '1', 'Autoriser'], { encoding: 'utf8', env, timeout: 60000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual([core.lireBoite().entrees[0].statut, core.lireBoite().entrees[0].reponse], ['repondue', 'Autoriser']);
    assert.equal(garde().refuser, true, 'sans attestation');
    assert.equal(garde({ attestees: [] }).refuser, true);
    assert.equal(garde({ attestees: [{ id: 1 }] }).refuser, true, 'une attestation sans empreinte ne vaut rien');
    // L'agent lance lui-même l'opération des hooks, sans rien pouvoir attester : le noyau refuse.
    const faux = path.join(RUN, 'faux-garde.js');
    fs.writeFileSync(faux, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(ask()))}));`);
    const hook = spawnSync(process.execPath, [CLI, 'nuit-hook', 'garde'], { input: JSON.stringify({ agent: 'claude', session: 'S1', tool_name: 'Bash', tool_input: { command: PUSH } }), encoding: 'utf8', env: { ...env, NUIT_GARDE: faux }, timeout: 60000 });
    assert.equal(JSON.parse(hook.stdout).refuser, true, hook.stdout);
    assert.equal(core.lireBoite().entrees[0].consommee, undefined);
  });

  test('un refus ferme du garde n est JAMAIS levé par la boîte', () => {
    decidee();
    const r = core.refuserGarde({ ...ctx({ maintenant: T0 + 10 * MIN }), sortie: blocGarde('Poussée forcée détectée (--force, --force-with-lease, -f ou refspec « + »).'), commande: PUSH, attestees: attestation(1) });
    assert.deepEqual([r.refuser, r.genre, r.id], [true, 'bloc', null]);
    assert.equal(core.lireBoite().entrees[0].consommee, undefined, 'l autorisation n est même pas consommée');
  });

  test('si la consommation ne peut pas être écrite (verrou tenu), la commande est refusée : jamais de passage sans marque', () => {
    decidee();
    const att = attestation(1);
    process.env.NUIT_VERROU_DELAI_MS = '150';
    fs.writeFileSync(fichier('nuit.verrou'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const r = garde({ attestees: att });
    assert.deepEqual([r.refuser, r.id], [true, null]);
    fs.unlinkSync(fichier('nuit.verrou'));
    assert.equal(core.lireBoite().entrees[0].consommee, undefined);
  });

  test('de bout en bout par l opération des hooks : l adaptateur transmet ses attestations, le noyau laisse passer une fois', () => {
    decidee();
    const faux = path.join(RUN, 'faux-garde.js');
    fs.writeFileSync(faux, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(ask()))}));`);
    process.env.NUIT_GARDE = faux;
    const entree = { agent: 'claude', session: 'S1', maintenant: T0 + 10 * MIN, tool_name: 'PowerShell', tool_input: { command: PUSH }, cwd: 'C:/x' };
    assert.deepEqual(core.executerHook('garde', { ...entree, autorisees: attestation(1) }), { refuser: false, autorisee: 1 });
    assert.equal(core.executerHook('garde', { ...entree, autorisees: attestation(1) }).refuser, true);
  });
});

describe('archive de la boîte et conversation d origine', () => {
  const logique = require(path.join(__dirname, '..', 'scripts', 'lib', 'nuit-logique.mjs'));
  // Une boîte pleine d'entrées déjà répondues : la n° 50 est la plus anciennement répondue.
  const boitePleine = () => {
    let boite = logique.boiteParDefaut();
    for (let i = 0; i < logique.MAX_BOITE; i++) {
      boite = logique.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: `question ${i + 1}`, maintenant: T0 + i }).boite;
      boite = logique.repondre(boite, i + 1, `réponse ${i + 1}`, T0 + 1000 - i).boite;
    }
    return boite;
  };

  test('sans archive, la lecture rend une liste vide et n écrit rien', () => {
    assert.deepEqual(core.lireArchive(), []);
    assert.equal(existe('nuit-boite-archive.jsonl'), false);
  });

  test('une décision de l\'utilisateur qui laisse sa place dans la boîte pleine est gardée dans l archive', () => {
    core.ecrireBoite(boitePleine());
    ouvrirNuit();
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(r.id, 51);
    const boite = core.lireBoite();
    assert.equal(boite.entrees.length, logique.MAX_BOITE);
    assert.equal(boite.entrees.some(e => e.id === 50), false, 'la plus anciennement répondue a quitté la boîte');
    const archive = core.lireArchive();
    assert.equal(archive.length, 1);
    assert.deepEqual([archive[0].id, archive[0].statut, archive[0].reponse, archive[0].titre], [50, 'repondue', 'réponse 50', 'question 50']);
    assert.ok(Number.isFinite(Date.parse(archive[0].archiveLe)));
    const r2 = core.refuserQuestion({ ...ctx(), entreeOutil: { questions: [{ question: 'Autre question ?' }] } });
    assert.equal(r2.id, 52);
    assert.deepEqual(core.lireArchive().map(e => e.id), [50, 49], 'l archive s allonge, elle n est jamais réécrite');
  });

  test('une entrée qui ne déplace personne n écrit pas d archive', () => {
    ouvrirNuit();
    core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.equal(existe('nuit-boite-archive.jsonl'), false);
  });

  test('si l archive ne peut pas être écrite, la boîte n est pas réécrite et la question est dite non notée', () => {
    core.ecrireBoite(boitePleine());
    ouvrirNuit();
    fs.mkdirSync(fichier('nuit-boite-archive.jsonl')); // un dossier à la place du fichier : l'ajout échoue
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: askClaude });
    assert.equal(r.refuser, true);
    assert.equal(r.id, null);
    assert.match(r.texte, /PAS pu être notée/);
    assert.equal(core.lireBoite().entrees.some(e => e.id === 50), true, 'la décision de l\'utilisateur est restée dans la boîte');
  });

  test('une ligne abîmée de l archive est ignorée, les autres sont lues', () => {
    fs.mkdirSync(process.env.COCKPIT_DIR, { recursive: true });
    fs.writeFileSync(fichier('nuit-boite-archive.jsonl'), `${JSON.stringify({ id: 3, statut: 'repondue' })}\n{pas du json\n\n${JSON.stringify({ id: 4 })}\n${JSON.stringify(['x'])}\n`);
    assert.deepEqual(core.lireArchive().map(e => e.id), [3, 4]);
  });

  test('répondre à une question posée par une AUTRE conversation le dit à l\'utilisateur et au modèle', () => {
    core.ecrireBoite(logique.ajouterEntree(logique.boiteParDefaut(), { agent: 'claude', session: 'conversation-origine', type: 'question', titre: 'Quel nom ?', maintenant: T0 }).boite);
    const r = core.appliquerCommande('repondre 1 Veilleur', ctx({ session: 'S1' }));
    assert.match(r.message, /^Boîte : réponse notée pour la question n° 1\. Attention : cette question a été posée par une autre conversation \(conversa\)/);
    assert.match(r.prompt, /^NUIT : réponse de l'utilisateur à la question n° 1/);
    assert.match(r.prompt, /vient d.une autre conversation, conversa/);
    assert.ok(sansTiretLong(r.message + r.prompt));
  });

  test('répondre dans la conversation qui a posé la question, ou sans conversation connue, ne dit rien de plus', () => {
    core.ecrireBoite(logique.ajouterEntree(logique.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom ?', maintenant: T0 }).boite);
    const r = core.appliquerCommande('repondre 1 Veilleur', ctx({ session: 'S1' }));
    assert.equal(r.message, 'Boîte : réponse notée pour la question n° 1.');
    assert.doesNotMatch(r.prompt, /autre conversation/);
    core.ecrireBoite(logique.ajouterEntree(logique.boiteParDefaut(), { agent: 'claude', session: 'S9', type: 'question', titre: 'Quel nom ?', maintenant: T0 }).boite);
    const s = core.appliquerCommande('repondre 1 Veilleur', { agent: 'claude', session: undefined, maintenant: T0 });
    assert.equal(s.message, 'Boîte : réponse notée pour la question n° 1.');
    assert.doesNotMatch(s.prompt, /autre conversation/);
  });
});


describe('réglages pendant une nuit active et réponses dites sans attendre', () => {
  const logique = require(path.join(__dirname, '..', 'scripts', 'lib', 'nuit-logique.mjs'));

  test('pendant une nuit active, tours, absence et defaut sont refusés et rien ne change', () => {
    assert.equal(core.appliquerCommande('tours 40', ctx()).message, "Plafond d'enchaînements : 40 par nuit.");
    ouvrirNuit();
    for (const commande of ['tours 6', 'TOURS 500', 'absence 5', 'absence off', 'defaut', '  tours 1']) {
      const r = core.appliquerCommande(commande, ctx());
      assert.match(r.erreur, /ne se changent pas pendant une nuit active/, commande);
    }
    const e = core.lireEtat();
    assert.deepEqual([e.actif, e.maxTours, e.absenceMinutes], [true, 40, 60], 'le plafond réglé par l\'utilisateur avant la nuit est resté');
    // Ce qui ne règle rien reste permis pendant la nuit.
    for (const commande of ['statut', 'recap', 'boite']) assert.equal(core.appliquerCommande(commande, ctx()).erreur, undefined, commande);
    assert.equal(core.appliquerCommande('off', ctx()).effet, 'reveil');
    assert.equal(core.appliquerCommande('tours 60', ctx()).message, "Plafond d'enchaînements : 60 par nuit.", 'la nuit finie, l\'utilisateur règle de nouveau');
  });

  test('une réponse donnée dans la boîte depuis le début du tour est rendue une fois, à la conversation qui a posé la question', () => {
    let boite = logique.ajouterEntree(logique.boiteParDefaut(), { agent: 'claude', session: 'S1', type: 'question', titre: 'Quel nom ?', maintenant: T0 }).boite;
    boite = logique.ajouterEntree(boite, { agent: 'claude', session: 'S2', type: 'question', titre: 'Autre ?', maintenant: T0 }).boite;
    boite = logique.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Ancienne ?', maintenant: T0 }).boite;
    boite = logique.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Sans réponse ?', maintenant: T0 }).boite;
    boite = logique.repondre(boite, 1, 'Veilleur', T0 + 10 * MIN).boite;
    boite = logique.repondre(boite, 2, 'non', T0 + 10 * MIN).boite;
    boite = logique.repondre(boite, 3, 'oui', T0 + MIN).boite;
    boite = logique.ajouterEntree(boite, { agent: 'claude', session: 'S1', type: 'question', titre: 'Écartée ?', maintenant: T0 }).boite;
    boite = logique.ecarter(boite, 5, T0 + 10 * MIN).boite; // écartée pendant le tour : ce n'est pas une réponse à dire
    core.ecrireBoite(boite);
    const appel = () => core.reponsesALivrer({ agent: 'claude', session: 'S1', depuis: T0 + 5 * MIN, maintenant: T0 + 11 * MIN });
    const r = appel();
    assert.equal(r.length, 1, 'ni la réponse d avant le tour, ni celle d une autre conversation, ni la question sans réponse');
    assert.match(r[0], /^NUIT : réponse de l'utilisateur à la question n° 1 \(« Quel nom \? »\) : Veilleur\. Applique-la maintenant\. \(Dite ici sans attendre la fin de ton tour/);
    assert.ok(sansTiretLong(r[0]));
    assert.deepEqual(appel(), [], 'dite une seule fois');
    assert.deepEqual(Object.keys(lire('nuit-livraisons.json')), ['1']);
    assert.deepEqual(core.reponsesALivrer({ agent: 'claude', session: 'S2', depuis: T0 + 5 * MIN }).length, 1, 'l autre conversation reçoit la sienne');
    for (const mauvais of [{ agent: 'x y' }, { session: '' }, { depuis: NaN }, { depuis: undefined }]) {
      assert.deepEqual(core.reponsesALivrer({ agent: 'claude', session: 'S1', depuis: 0, ...mauvais }), [], JSON.stringify(mauvais));
    }
    assert.equal(core.lireBoite().entrees.length, 5, 'la boîte n est pas modifiée');
  });

  test('une commande autorisée : pendant la nuit elle se relance à l identique, la nuit finie le garde redemandera l accord', () => {
    const action = { agent: 'claude', session: 'S1', type: 'action', ...logique.actionDeGarde({ commande: 'git push', raison: RAISON_PUSH }), empreinte: 'a'.repeat(64), maintenant: T0 };
    core.ecrireBoite(logique.repondre(logique.ajouterEntree(logique.boiteParDefaut(), action).boite, 1, 'Autoriser', T0 + 10 * MIN).boite);
    ouvrirNuit();
    const pendant = core.reponsesALivrer({ agent: 'claude', session: 'S1', depuis: T0 });
    assert.match(pendant[0], /décision de l'utilisateur sur la commande n° 1/);
    assert.match(pendant[0], /Relance-la exactement à l'identique/);
    assert.doesNotMatch(pendant[0], /La nuit est terminée/);
    fs.rmSync(fichier('nuit-livraisons.json'));
    core.appliquerCommande('off', ctx());
    const apres = core.reponsesALivrer({ agent: 'claude', session: 'S1', depuis: T0 });
    assert.match(apres[0], /La nuit est terminée : l'accord donné dans la boîte ne valait que pendant la nuit\. Relance la commande normalement/);
  });
});


// Deux comportements que des mutations réalignées laissaient survivre : les tests qui les protègent.
describe('absence détectée : fichiers de la nuit occupés', () => {
  test('L\'utilisateur présent et verrou tenu par un autre : la nuit n est pas dite active, sa question n est pas refusée', () => {
    const delai = process.env.NUIT_VERROU_DELAI_MS;
    process.env.NUIT_VERROU_DELAI_MS = '150';
    try {
      core.noterActivite(ctx({ maintenant: T0 - 10 * MIN })); // dix minutes sans message : pas une absence (seuil : 60)
      fs.writeFileSync(fichier('nuit.verrou'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      assert.equal(core.nuitActive(ctx()), false, 'sans absence, le verrou n est même pas demandé');
      assert.deepEqual(core.refuserQuestion({ ...ctx(), entreeOutil: askClaude }), { refuser: false });
      assert.equal(existe('nuit-boite.json'), false);
    } finally {
      fs.rmSync(fichier('nuit.verrou'), { force: true });
      if (delai === undefined) delete process.env.NUIT_VERROU_DELAI_MS; else process.env.NUIT_VERROU_DELAI_MS = delai;
    }
  });
});

describe('agents du dépôt : un nom comme deepseek_H est converti en clé d état', () => {
  const entree = (extra = {}) => ({ agent: 'deepseek_H', session: 'S1', maintenant: T0, ...extra });
  const lireArgs = () => JSON.parse(fs.readFileSync(path.join(RUN, 'garde-args.json'), 'utf8'));

  test('la liste de travail est lue sous le nom du dépôt comme sous la clé, et la boîte garde la clé', () => {
    ledger({ 'C-0001': ligne('travail A'), 'C-0002': ligne('travail B') }, 'deepseek_H');
    assert.deepEqual(core.lignesDe('deepseek_H').map(l => l.id), ['C-0001', 'C-0002']);
    assert.deepEqual(core.lignesDe('deepseek-h').map(l => l.id), ['C-0001', 'C-0002']);
    assert.equal(core.executerHook('commande', entree({ args: 'on' })).effet, 'active');
    assert.equal(lire('nuit.json').lignesAuDebut, 2, 'les lignes de l agent du dépôt sont comptées');
    const r = core.executerHook('question', entree({ tool_input: askClaude }));
    assert.deepEqual([r.refuser, r.id], [true, 1]);
    assert.equal(core.lireBoite().entrees[0].agent, 'deepseek-h');
    assert.equal(core.executerHook('continuer', entree({ reason: 'answer' })).ligne.id, 'C-0001', 'l enchaînement lit les lignes sous le nom du dépôt');
  });

  test('l empreinte d une commande et les réponses à livrer ne dépendent pas de la forme du nom', () => {
    assert.equal(core.empreinteCommande('deepseek_H', 'S1', 'git push'), core.empreinteCommande('deepseek-h', 'S1', 'git push'));
    assert.notEqual(core.empreinteCommande('deepseek_H', 'S1', 'git push'), core.empreinteCommande('claude', 'S1', 'git push'));
    core.executerHook('commande', entree({ args: 'on' }));
    core.executerHook('question', entree({ tool_input: askClaude }));
    core.appliquerCommande('repondre 1 Veilleur', ctx({ agent: 'deepseek_H', maintenant: T0 + MIN }));
    for (const agent of ['deepseek_H', 'deepseek-h']) {
      fs.rmSync(fichier('nuit-livraisons.json'), { force: true });
      assert.equal(core.reponsesALivrer({ agent, session: 'S1', depuis: T0, maintenant: T0 + 2 * MIN }).length, 1, agent);
    }
  });

  test('la garde reçoit le nom du dépôt après --agent, quelle que soit la forme donnée, et choisit seule pour un agent inconnu', () => {
    const script = path.join(RUN, 'faux-garde.js');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(path.join(RUN, 'garde-args.json'))}, JSON.stringify(process.argv.slice(2))); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(demandeGarde(RAISON_PUSH)))}));`);
    process.env.NUIT_GARDE = script;
    try {
      core.executerHook('commande', entree({ args: 'on' }));
      for (const [agent, attendu] of [['deepseek_H', 'deepseek_H'], ['deepseek-h', 'deepseek_H'], ['claude', 'claude']]) {
        core.executerHook('garde', { agent, session: 'S1', maintenant: T0, tool_name: 'Bash', tool_input: { command: `git push ${agent}` }, cwd: 'C:/x' });
        assert.deepEqual(lireArgs(), ['--agent', attendu], agent);
      }
      assert.deepEqual(core.lireBoite().entrees.map(e => e.agent), ['deepseek-h', 'deepseek-h', 'claude'], 'la demande d accord est notée en boîte sous la clé d état');
      core.executerHook('garde', { agent: 'autre-agent', session: 'S1', maintenant: T0, tool_name: 'Bash', tool_input: { command: 'git push x' }, cwd: 'C:/x' });
      assert.deepEqual(lireArgs(), []);
    } finally { delete process.env.NUIT_GARDE; }
  });

  test('un nom qui n est ni un agent du dépôt ni une clé valide reste refusé', () => {
    for (const agent of ['Claude', 'deepseek_h', 'Deepseek_H', 'x y', '../x', 'deepseek_H ', '', 5, null]) {
      assert.deepEqual(core.executerHook('activite', { agent, session: 'S1' }), { erreur: 'entrée invalide' }, String(agent));
    }
    assert.equal(existe('nuit.json'), false);
  });
});

describe('question refusée : détails gardés en boîte', () => {
  test('deux questions posées ensemble : chaque entrée de boîte garde ses détails, une question longue garde son texte entier', () => {
    ouvrirNuit();
    const r = core.refuserQuestion({ ...ctx(), entreeOutil: { questions: [{ question: 'Premier choix ?' }, { question: 'Second choix ?' }] } });
    assert.deepEqual(r.ids, [1, 2]);
    assert.deepEqual(core.lireBoite().entrees.map(e => e.details), ['Question 1 sur 2 posées ensemble.', 'Question 2 sur 2 posées ensemble.']);
    const longue = `${'Faut-il garder ce comportement pour les clients déjà inscrits ? '.repeat(6)}Fin.`;
    assert.ok(longue.length > 240);
    core.refuserQuestion({ ...ctx(), entreeOutil: { questions: [{ question: longue }] } });
    assert.equal(core.lireBoite().entrees[2].details, `Question entière : ${longue}`);
  });
});
