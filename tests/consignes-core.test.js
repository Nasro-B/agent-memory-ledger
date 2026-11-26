'use strict';
// Bancs des entrées-sorties des Consignes en vigueur (scripts/lib/consignes-core.js) et de la commande cockpit.js consignes.
// Lancement : node --test tests/consignes-core.test.js
// Jamais dans les vraies racines : chaque test a son dossier temporaire (AGENT_MEMORY_LEDGER_HOME, COCKPIT_DIR).
// Variables internes (preuves par mutation) : CONSIGNES_CORE_TESTE = noyau à tester (défaut : ../scripts/lib/consignes-core.js),
//   COCKPIT_CLI_TESTE = ligne de commande à tester (défaut : ../scripts/cockpit.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const core = require(process.env.CONSIGNES_CORE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'consignes-core.js'));
const CLI = process.env.COCKPIT_CLI_TESTE || path.join(__dirname, '..', 'scripts', 'cockpit.js'); // COCKPIT_CLI_TESTE : preuves par mutation de la ligne de commande

let n = 0;
let RUN;
let FICHIER;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `consignes-core-banc-${process.pid}-${++n}-`));
  process.env.COCKPIT_DIR = path.join(RUN, 'cockpit');
  process.env.AGENT_MEMORY_LEDGER_HOME = path.join(RUN, 'maison'); // jamais la vraie maison de l'utilisateur
  FICHIER = path.join(process.env.COCKPIT_DIR, 'consignes.json');
});

const cons = (id, texte, verrou = null, actif = true) => ({ id, texte, actif, verrou });
const poser = (consignes, prochain = 50) => { fs.mkdirSync(path.dirname(FICHIER), { recursive: true }); fs.writeFileSync(FICHIER, JSON.stringify({ prochain, consignes })); };
const lire = () => JSON.parse(fs.readFileSync(FICHIER, 'utf8'));

describe('lecture', () => {
  test('sans fichier : aucune consigne, et le fichier n est pas illisible', () => {
    assert.deepEqual(core.lireFichier(), { etat: { prochain: 1, consignes: [] }, illisible: false });
    assert.deepEqual(core.lireEtat(), { prochain: 1, consignes: [] });
  });

  test('un fichier valide est lu et normalisé', () => {
    poser([cons(2, 'Pas de push', 'push'), { id: 0, texte: 'invalide' }]);
    assert.deepEqual(core.lireFichier(), { etat: { prochain: 50, consignes: [cons(2, 'Pas de push', 'push')] }, illisible: false });
  });

  test('un fichier abîmé est illisible : aucune consigne appliquée, mais le fichier est signalé', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    for (const contenu of ['{pas du json', '', '{"consignes":']) {
      fs.writeFileSync(FICHIER, contenu);
      assert.deepEqual(core.lireFichier(), { etat: { prochain: 1, consignes: [] }, illisible: true }, JSON.stringify(contenu));
    }
  });

  test('un JSON qui n est pas un objet est lisible et vide ; un BOM en tête est toléré', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    for (const contenu of ['[]', '5', 'null', '"x"']) {
      fs.writeFileSync(FICHIER, contenu);
      assert.deepEqual(core.lireFichier(), { etat: { prochain: 1, consignes: [] }, illisible: false }, contenu);
    }
    fs.writeFileSync(FICHIER, `\uFEFF${JSON.stringify({ prochain: 3, consignes: [cons(1, 'a')] })}`);
    assert.deepEqual(core.lireFichier(), { etat: { prochain: 3, consignes: [cons(1, 'a')] }, illisible: false });
  });

  test('un dossier à la place du fichier est un fichier absent', () => {
    fs.mkdirSync(FICHIER, { recursive: true });
    assert.deepEqual(core.lireFichier(), { etat: { prochain: 1, consignes: [] }, illisible: false });
  });
});

describe('écriture', () => {
  test('ecrireEtat crée le dossier, normalise, date, et ne laisse aucun fichier temporaire', () => {
    core.ecrireEtat({ prochain: 4, consignes: [cons(3, ' a  b '), { id: 'x', texte: 'perdu' }], autre: 1 });
    const f = lire();
    assert.deepEqual(Object.keys(f).sort(), ['consignes', 'maj', 'prochain']);
    assert.deepEqual(f.consignes, [cons(3, 'a b')]);
    assert.equal(f.prochain, 4);
    assert.ok(!Number.isNaN(Date.parse(f.maj)));
    assert.deepEqual(fs.readdirSync(path.dirname(FICHIER)), ['consignes.json']);
  });

  test('l état écrit se relit à l identique', () => {
    const etat = { prochain: 6, consignes: [cons(1, 'Pas de push', 'push'), cons(5, 'Français', null, false)] };
    core.ecrireEtat(etat);
    assert.deepEqual(core.lireEtat(), etat);
  });
});

describe('commande', () => {
  test('la liste n écrit rien et rend le texte de la liste', () => {
    poser([cons(1, 'Pas de push', 'push')]);
    const avant = fs.readFileSync(FICHIER, 'utf8');
    const r = core.appliquerCommande('');
    assert.equal(r.message, 'Consignes en vigueur : 1 active sur 1.\n1. [actif] Pas de push [verrou : push]');
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avant);
  });

  test('ajouter écrit le fichier (la première fois, il est créé) et rend le message', () => {
    const r = core.appliquerCommande('ajouter Uniquement les worktrees suivis');
    assert.equal(r.message, 'Consigne 1 ajoutée.');
    assert.equal(r.erreur, undefined);
    assert.deepEqual(r.etat, { prochain: 2, consignes: [cons(1, 'Uniquement les worktrees suivis')] });
    assert.deepEqual(lire().consignes, [cons(1, 'Uniquement les worktrees suivis')]);
    assert.equal(lire().prochain, 2);
  });

  test('verrou, pause, reprendre et retirer changent le fichier', () => {
    poser([cons(1, 'Pas de push'), cons(2, 'Français')]);
    core.appliquerCommande('verrou 1 push');
    assert.equal(lire().consignes[0].verrou, 'push');
    core.appliquerCommande('pause 2');
    assert.equal(lire().consignes[1].actif, false);
    core.appliquerCommande('reprendre 2');
    assert.equal(lire().consignes[1].actif, true);
    core.appliquerCommande('retirer 1');
    assert.deepEqual(lire().consignes.map(c => c.id), [2]);
    assert.equal(lire().prochain, 50);
  });

  test('une erreur de saisie rend { erreur } et n écrit rien', () => {
    poser([cons(1, 'a')]);
    const avant = fs.readFileSync(FICHIER, 'utf8');
    for (const [args, attendu] of [['xyz', /^Usage : \/consignes /], ['retirer 99', /^Consigne 99 introuvable \(identifiants : 1\)\.$/], ['ajouter', /^Texte manquant\./], ['verrou 1 inconnu', /^Usage : /]]) {
      const r = core.appliquerCommande(args);
      assert.match(r.erreur, attendu, args);
      assert.equal(r.message, undefined, args);
      assert.equal(r.etat, undefined, args);
    }
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avant);
  });

  test('une commande sans effet n écrit rien : le fichier garde sa date', () => {
    poser([cons(1, 'a', 'push')]);
    const avant = fs.readFileSync(FICHIER, 'utf8');
    const mtime = fs.statSync(FICHIER).mtimeMs;
    core.appliquerCommande('reprendre 1');
    core.appliquerCommande('verrou 1 push');
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avant);
    assert.equal(fs.statSync(FICHIER).mtimeMs, mtime);
  });

  test('un fichier illisible n est jamais écrasé : la commande le dit, sans rien écrire', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER, '{pas du json');
    for (const args of ['', 'liste', 'ajouter x', 'retirer 1', 'verrou 1 push', 'xyz']) {
      const r = core.appliquerCommande(args);
      assert.match(r.erreur, /consignes\.json est illisible : corrige-le ou supprime-le, puis recommence \(rien n'a été écrit\)\.$/, args);
    }
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), '{pas du json');
  });

  test('une écriture impossible est dite, sans rien casser', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.mkdirSync(FICHIER); // un dossier occupe la place du fichier : le renommage échoue
    const r = core.appliquerCommande('ajouter x');
    assert.match(r.erreur, /^Écriture impossible dans .*consignes\.json \(.+\) : rien n'a changé\.$/);
    assert.ok(fs.statSync(FICHIER).isDirectory());
    assert.deepEqual(fs.readdirSync(path.dirname(FICHIER)), ['consignes.json'], 'aucun fichier temporaire ne reste');
  });
});

describe('décisions et injection', () => {
  test('sans fichier ou sans consigne active, tout est autorisé et rien n est à injecter', () => {
    assert.equal(core.texteInjection(), null);
    assert.deepEqual(core.decisionCommande('git push'), { autorise: true });
    assert.deepEqual(core.decisionAgent(), { autorise: true });
    poser([cons(1, 'Pas de push', 'push', false), cons(2, 'Pas d agent', 'agent', false)]);
    assert.equal(core.texteInjection(), null);
    assert.deepEqual(core.decisionCommande('git push'), { autorise: true });
    assert.deepEqual(core.decisionAgent(), { autorise: true });
  });

  test('les consignes actives sont injectées et leurs verrous appliqués, fichier relu à chaque appel', () => {
    poser([cons(1, 'Pas de push', 'push'), cons(2, 'Aucun nouvel agent', 'agent'), cons(3, 'Français')]);
    assert.match(core.texteInjection(), /^CONSIGNES EN VIGUEUR DE L'UTILISATEUR[^\n]*\n1\. Pas de push \[verrou : push\]\n2\. Aucun nouvel agent \[verrou : agent\]\n3\. Français$/);
    assert.equal(core.decisionCommande('git push origin main').autorise, false);
    assert.equal(core.decisionCommande('git status').autorise, true);
    assert.equal(core.decisionAgent().autorise, false);
    poser([cons(3, 'Français')]);
    assert.deepEqual(core.decisionCommande('git push'), { autorise: true });
    assert.deepEqual(core.decisionAgent(), { autorise: true });
    assert.doesNotMatch(core.texteInjection(), /push/);
  });

  test('un fichier illisible n applique rien : un fichier abîmé ne bloque pas le travail', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER, '{pas du json');
    assert.equal(core.texteInjection(), null);
    assert.deepEqual(core.decisionCommande('git push'), { autorise: true });
    assert.deepEqual(core.decisionAgent(), { autorise: true });
  });
});

describe('jetons {worktrees} et {plans}', () => {
  const ecrireConfig = c => { fs.mkdirSync(path.dirname(FICHIER), { recursive: true }); fs.writeFileSync(path.join(path.dirname(FICHIER), 'config.json'), JSON.stringify(c)); };

  test('sans config.json, les consignes disent « (aucun) » pour les worktrees et « (non configuré) » pour le dossier des plans', () => {
    poser([cons(1, 'Seulement dans {worktrees}'), cons(2, 'Plans : {plans}')]);
    const t = core.texteInjection();
    assert.match(t, /\n1\. Seulement dans \(aucun\)\n/);
    assert.match(t, /\n2\. Plans : \(non configuré\)$/);
    assert.ok(!t.includes('{'));
  });

  test('changer les réglages change tout de suite le texte rappelé, sans toucher à consignes.json', () => {
    poser([cons(1, 'Seulement dans {worktrees}'), cons(2, 'Plans : {plans}')]);
    const avant = fs.readFileSync(FICHIER, 'utf8');
    ecrireConfig({ worktrees: [{ nom: 'APP', chemin: 'C:/travail/app' }], plans: { dossier: 'C:/travail/plans' } });
    const t = core.texteInjection();
    assert.match(t, /\n1\. Seulement dans APP \(C:\/travail\/app\)\n2\. Plans : C:\/travail\/plans$/);
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), avant);
    ecrireConfig({ worktrees: [], plans: { dossier: 'C:/travail/plans' } });
    assert.match(core.texteInjection(), /\n1\. Seulement dans \(aucun\)\n/);
  });

  test('la liste de /consignes et la raison d un refus citent les valeurs courantes', () => {
    poser([cons(1, 'Pas de push dans {worktrees}', 'push'), cons(2, 'Pas d agent hors de {plans}', 'agent')]);
    ecrireConfig({ worktrees: [{ nom: 'APP', chemin: 'C:/travail/app' }], plans: { dossier: 'C:/travail/plans' } });
    assert.match(core.appliquerCommande('liste').message, /1\. \[actif\] Pas de push dans APP \(C:\/travail\/app\) \[verrou : push\]/);
    assert.match(core.decisionCommande('git push').raison, /« Pas de push dans APP \(C:\/travail\/app\) »/);
    assert.match(core.decisionAgent().raison, /« Pas d agent hors de C:\/travail\/plans »/);
  });

  test('un config.json abîmé donne les défauts, et le fichier des consignes garde ses jetons après une commande', () => {
    poser([cons(1, 'Plans : {plans}')]);
    fs.writeFileSync(path.join(path.dirname(FICHIER), 'config.json'), '{pas du json');
    assert.match(core.texteInjection(), /Plans : \(non configuré\)$/);
    core.appliquerCommande('ajouter une autre');
    assert.equal(lire().consignes[0].texte, 'Plans : {plans}');
  });
});

describe('ligne de commande', () => {
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });

  test('cockpit.js consignes change la liste comme /consignes et la relit', () => {
    const a = cli('consignes', 'ajouter', 'Pas', 'de', 'push');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, 'Consigne 1 ajoutée.\n');
    assert.equal(cli('consignes', 'verrou', '1', 'push').stdout, 'Consigne 1 : verrou push.\n');
    assert.equal(lire().consignes[0].verrou, 'push');
    assert.equal(cli('consignes').stdout, 'Consignes en vigueur : 1 active sur 1.\n1. [actif] Pas de push [verrou : push]\n');
    assert.equal(cli('consignes', 'pause', '1').stdout, "Consigne 1 en pause (elle n'est plus rappelée ni appliquée).\n");
  });

  test('une commande invalide donne l usage sur stderr et le code 2, sans rien écrire', () => {
    const r = cli('consignes', 'xyz');
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage : \/consignes /);
    assert.equal(fs.existsSync(FICHIER), false);
  });

  test('un fichier illisible est dit sur stderr avec le code 2, et reste tel quel', () => {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER, '{pas du json');
    const r = cli('consignes', 'ajouter', 'x');
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /consignes\.json est illisible/);
    assert.equal(fs.readFileSync(FICHIER, 'utf8'), '{pas du json');
  });
});

describe('texte du statut', () => {
  test('texteStatut rend la ligne de statut, ou undefined sans consigne active', () => {
    assert.equal(core.texteStatut(), undefined);
    poser([cons(1, 'a', 'push'), cons(2, 'b')]);
    assert.equal(core.texteStatut(), 'Consignes : 2 actives (1 verrouillée)');
  });
});
