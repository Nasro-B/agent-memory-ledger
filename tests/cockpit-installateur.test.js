'use strict';
// Bancs du branchement du Cockpit par l'installateur de Codex : scripts/installer-codex.js --cockpit (qui s'appuie sur scripts/codex/brancher.js).
// Lancement : node --test tests/cockpit-installateur.test.js
// Ne touche jamais au vrai dossier de Codex : chaque test travaille dans un dossier temporaire (--home, et CODEX_HOME y pointe aussi).
// Variable interne (preuves par mutation) : INSTALLER_CODEX_TESTE = installateur à tester (défaut : ../scripts/installer-codex.js)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

const INSTALLATEUR = process.env.INSTALLER_CODEX_TESTE || path.join(__dirname, '..', 'scripts', 'installer-codex.js');
const BRANCHER = path.join(__dirname, '..', 'scripts', 'codex', 'brancher.js');
const DOSSIER = path.join(__dirname, '..', 'scripts', 'codex').replace(/\\/g, '/');
const COMPOSANTS = ['cockpit', 'regulateur', 'consignes', 'file', 'nuit', 'nuit-tours', 'cockpit-outils', 'regulateur-resultat'];

let n = 0;
let RUN;
let HOME;
beforeEach(() => {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-installateur-${process.pid}-${++n}-`));
  HOME = path.join(RUN, 'codex');
  fs.mkdirSync(HOME, { recursive: true });
});

// Forme réelle d'un hooks.json de Codex : groupes avec ou sans matcher, un ou plusieurs hooks.
const ORIGINAL = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node C:/x/mon-hook.js', timeout: 15, statusMessage: 'mon hook' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'node C:/x/ma-garde.js', timeout: 10, statusMessage: 'ma garde' }] }],
  },
};

function ecrire(objet, { bom = false, crlf = false } = {}) {
  const texte = `${JSON.stringify(objet, null, 2)}\n`;
  const p = path.join(HOME, 'hooks.json');
  fs.writeFileSync(p, `${bom ? '\uFEFF' : ''}${crlf ? texte.replace(/\n/g, '\r\n') : texte}`);
  return p;
}
const octets = p => fs.readFileSync(p);
const lire = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const installer = (...args) => spawnSync(process.execPath, [INSTALLATEUR, ...args, '--home', HOME], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: HOME }, timeout: 60000 });
const verifier = (p, composant, agent = 'codex') => spawnSync(process.execPath, [BRANCHER, 'verifier', '--fichier', p, '--agent', agent, '--composant', composant], { encoding: 'utf8' }).stdout.trim();
// Les commandes des hooks du Cockpit (scripts/codex/{cockpit,regulateur,consignes,nuit}.js), pas celles des hooks de base (context-ledger.js...).
const commandesDuCockpit = p => Object.values(lire(p).hooks).flatMap(groupes => groupes.flatMap(g => g.hooks.map(h => h.command))).filter(c => c.startsWith(`node "${DOSSIER}/`) && /\/(cockpit|regulateur|consignes|nuit)\.js" --agent /.test(c));

describe('--cockpit', () => {
  test('sans --cockpit, l installateur ajoute les hooks de base et aucun hook du Cockpit', () => {
    const r = installer('--appliquer');
    assert.equal(r.status, 0, r.stderr);
    const p = path.join(HOME, 'hooks.json');
    assert.ok(Object.values(lire(p).hooks).flat().length > 0, 'les hooks de base sont là');
    assert.deepEqual(commandesDuCockpit(p), []);
    for (const composant of COMPOSANTS) assert.equal(verifier(p, composant), 'pas branché', composant);
  });

  test('--cockpit sans --appliquer montre l état de chaque composant et n écrit rien', () => {
    const p = ecrire(ORIGINAL);
    const avant = octets(p);
    const r = installer('--cockpit');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /^Fichier : .*hooks\.json \(agent : codex\)\n/);
    for (const [composant, evenements] of [['cockpit', 'SessionStart, UserPromptSubmit, PostCompact'], ['regulateur', 'PreToolUse'], ['consignes', 'PreToolUse'], ['file', 'Stop'], ['nuit', 'PreToolUse'], ['nuit-tours', 'Stop, UserPromptSubmit'], ['cockpit-outils', 'PostToolUse'], ['regulateur-resultat', 'PostToolUse']]) {
      assert.ok(r.stdout.includes(`à ajouter  ${composant} : ${evenements}\n`), `${composant}\n${r.stdout}`);
    }
    assert.match(r.stdout, /Rien n'a été écrit\. Relance avec --appliquer pour ajouter 8 composant\(s\)\./);
    assert.deepEqual(octets(p), avant);
    assert.deepEqual(fs.readdirSync(HOME), ['hooks.json'], 'ni sauvegarde ni fichier temporaire');
  });

  test('--cockpit --appliquer branche les huit composants, sauvegarde chacun une fois, et un second passage ne change rien', () => {
    const p = ecrire(ORIGINAL);
    const r = installer('--cockpit', '--appliquer');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /8 composant\(s\) du Cockpit ajouté\(s\)\. Ouvre Codex et approuve les nouveaux hooks/);
    for (const composant of COMPOSANTS) {
      assert.match(verifier(p, composant), /^branché : /, composant);
      assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-${composant}`), true, `sauvegarde de ${composant}`);
    }
    assert.deepEqual(lire(`${p}.avant-agent-memory-ledger-cockpit`), ORIGINAL, 'la première sauvegarde est le fichier d origine');
    assert.equal(commandesDuCockpit(p).length, 11, 'trois événements du Cockpit, deux pour nuit-tours, un pour chacun des six autres composants');
    assert.ok(commandesDuCockpit(p).every(c => c.startsWith(`node "${DOSSIER}/`) && c.endsWith(' --agent codex')), 'dossier entre guillemets, agent codex');
    const apres = octets(p);
    const encore = installer('--cockpit', '--appliquer');
    assert.equal(encore.status, 0, encore.stderr);
    assert.match(encore.stdout, /Tous les composants du Cockpit sont déjà en place : rien à faire\./);
    assert.ok(encore.stdout.includes('déjà en place  cockpit\n'), encore.stdout);
    assert.doesNotMatch(encore.stdout, /ajouté\(s\)|Rien n'a été écrit/, 'rien à ajouter : ni phrase de fin d ajout ni invitation à relancer');
    assert.deepEqual(octets(p), apres);
    assert.deepEqual(lire(p).hooks.SessionStart[0], ORIGINAL.hooks.SessionStart[0], 'un hook existant n est ni modifié ni déplacé');
  });

  test('--agent deepseek_H : les commandes portent cet agent ; --composant n en branche qu un seul', () => {
    const p = ecrire(ORIGINAL);
    const r = installer('--cockpit', '--appliquer', '--agent', 'deepseek_H', '--composant', 'nuit');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(agent : deepseek_H\)/);
    assert.match(r.stdout, /1 composant\(s\) du Cockpit ajouté\(s\)\./);
    assert.deepEqual(commandesDuCockpit(p), [`node "${DOSSIER}/nuit.js" --agent deepseek_H`]);
    assert.equal(verifier(p, 'nuit', 'deepseek_H'), 'branché : PreToolUse');
    assert.equal(verifier(p, 'nuit', 'codex'), 'pas branché', 'l autre agent n est pas branché');
    assert.equal(verifier(p, 'cockpit', 'deepseek_H'), 'pas branché');
    assert.match(installer('--cockpit', '--appliquer', '--agent', 'deepseek_H', '--composant', 'nuit').stdout, /déjà en place  nuit\n/, 'un second passage pour cet agent ne change rien');
    installer('--cockpit', '--appliquer');
    const autre = installer('--cockpit', '--agent', 'deepseek_H');
    assert.ok(autre.stdout.includes('à ajouter  cockpit : SessionStart, UserPromptSubmit, PostCompact\n'), 'le branchement de codex ne vaut pas pour cet agent');
    assert.ok(autre.stdout.includes('déjà en place  nuit\n'), autre.stdout);
  });

  test('un composant déjà branché, ou déjà retiré, n est pas compté', () => {
    const p = ecrire(ORIGINAL);
    installer('--cockpit', '--appliquer', '--composant', 'nuit');
    const ajout = installer('--cockpit', '--appliquer');
    assert.ok(ajout.stdout.includes('déjà en place  nuit\n'), ajout.stdout);
    assert.match(ajout.stdout, /7 composant\(s\) du Cockpit ajouté\(s\)\./);
    assert.match(installer('--cockpit', '--retirer', '--appliquer', '--composant', 'nuit').stdout, /1 composant\(s\) du Cockpit retiré\(s\)\./);
    const retrait = installer('--cockpit', '--retirer', '--appliquer');
    assert.ok(retrait.stdout.includes('pas branché  nuit\n'), retrait.stdout);
    assert.match(retrait.stdout, /7 composant\(s\) du Cockpit retiré\(s\)\./);
    assert.deepEqual(lire(p), ORIGINAL);
  });

  test('un agent invalide, un composant inconnu ou un fichier absent ou illisible sont refusés, sans rien écrire', () => {
    const p = ecrire(ORIGINAL);
    const avant = octets(p);
    for (const [args, motif] of [[['--agent', 'AGENT'], /--agent invalide/], [['--agent', 'deepseek_h'], /--agent invalide/], [['--agent'], /--agent invalide/], [['--composant', 'inconnu'], /composant inconnu : inconnu \(attendu : cockpit, regulateur/], [['--composant'], /composant inconnu/], [['--composant', 'constructor'], /composant inconnu : constructor/], [['--composant', '__proto__'], /composant inconnu : __proto__/]]) {
      const r = installer('--cockpit', '--appliquer', ...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, motif, args.join(' '));
      assert.equal(r.stderr.trim().split('\n').length, 1, `${args.join(' ')} : un seul message`);
      assert.equal(r.stdout, '', args.join(' '));
    }
    assert.deepEqual(octets(p), avant);
    fs.writeFileSync(p, '{pas du json');
    const casse = installer('--cockpit', '--appliquer');
    assert.equal(casse.status, 2);
    assert.match(casse.stderr, /JSON invalide/);
    assert.equal(casse.stderr.trim().split('\n').length, 1, 'un seul message');
    assert.equal(casse.stdout, '', 'rien n est dit sur la sortie standard');
    assert.equal(fs.readFileSync(p, 'utf8'), '{pas du json');
    fs.unlinkSync(p);
    const absent = installer('--cockpit', '--appliquer');
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /n'existe pas : lance d'abord « node scripts\/installer-codex\.js --appliquer »/);
    assert.equal(absent.stderr.trim().split('\n').length, 1, 'un seul message');
    assert.equal(absent.stdout, '', 'rien n est dit sur la sortie standard');
    assert.deepEqual(fs.readdirSync(HOME), [], 'rien n est créé');
  });

  test('une panne pendant l écriture est dite sur la sortie d erreur, code 1 ; les composants déjà branchés le restent', () => {
    const p = ecrire({ hooks: { ...ORIGINAL.hooks, PreToolUse: 'pas une liste' } });
    const r = installer('--cockpit', '--appliquer');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PreToolUse n'est pas une liste dans .*hooks\.json/);
    assert.match(r.stdout, /^Fichier : /, 'l état a été montré avant d écrire');
    assert.doesNotMatch(r.stdout, /ajouté\(s\)/, 'pas de phrase de réussite');
    assert.match(verifier(p, 'cockpit'), /^branché : /, 'le composant écrit avant la panne reste branché');
    assert.equal(lire(p).hooks.PreToolUse, 'pas une liste', 'le contenu qui bloquait n est pas touché');
  });

  test('--cockpit --retirer --appliquer remet exactement le fichier d origine, avec son BOM et ses retours à la ligne', () => {
    for (const [bom, crlf] of [[false, false], [true, false], [false, true], [true, true]]) {
      const p = ecrire(ORIGINAL, { bom, crlf });
      const avant = octets(p);
      installer('--cockpit', '--appliquer');
      assert.notDeepEqual(octets(p), avant);
      const montre = installer('--cockpit', '--retirer');
      assert.match(montre.stdout, /à retirer  cockpit : SessionStart, UserPromptSubmit, PostCompact\n/);
      assert.match(montre.stdout, /Rien n'a été écrit\. Relance avec --appliquer pour retirer 8 composant\(s\)\./);
      const r = installer('--cockpit', '--retirer', '--appliquer');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /8 composant\(s\) du Cockpit retiré\(s\)\./);
      assert.deepEqual(octets(p), avant, `BOM ${bom}, CRLF ${crlf}`);
      const rien = installer('--cockpit', '--retirer', '--appliquer');
      assert.match(rien.stdout, /Aucun composant du Cockpit à retirer\./);
      assert.ok(rien.stdout.includes('pas branché  cockpit\n'), rien.stdout);
      assert.doesNotMatch(rien.stdout, /retiré\(s\)|Rien n'a été écrit/, 'rien à retirer : ni phrase de fin de retrait ni invitation à relancer');
      for (const f of fs.readdirSync(HOME)) if (f !== 'hooks.json') fs.unlinkSync(path.join(HOME, f));
    }
  });

  test('le retrait de base retire aussi les hooks du Cockpit de ce dépôt, et rien d autre', () => {
    const p = ecrire(ORIGINAL);
    installer('--appliquer');
    installer('--cockpit', '--appliquer');
    assert.ok(commandesDuCockpit(p).length > 0);
    const r = installer('--retirer', '--appliquer');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lire(p), ORIGINAL);
  });

  test('le dossier de Codex est celui de --home, sinon CODEX_HOME : jamais un autre', () => {
    const autre = path.join(RUN, 'autre');
    fs.mkdirSync(autre);
    fs.writeFileSync(path.join(autre, 'hooks.json'), JSON.stringify(ORIGINAL));
    const r = spawnSync(process.execPath, [INSTALLATEUR, '--cockpit', '--appliquer'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: autre }, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(path.join(autre, 'hooks.json')), r.stdout);
    assert.ok(commandesDuCockpit(path.join(autre, 'hooks.json')).length > 0);
    assert.deepEqual(fs.readdirSync(HOME), [], 'le dossier --home n a pas été touché');
  });
});
