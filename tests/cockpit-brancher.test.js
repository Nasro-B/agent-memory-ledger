'use strict';
// Bancs de l'outil de branchement du Cockpit dans les hooks Codex : scripts/codex/brancher.js
// Lancement : node --test tests/cockpit-brancher.test.js
// Ne touche jamais aux vrais hooks.json : chaque test travaille sur une copie temporaire.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, describe, beforeEach } = require('node:test');

// COCKPIT_BRANCHER_TESTE : outil à tester (preuves par mutation, qui lancent ce banc sur une copie mutée).
const OUTIL = process.env.COCKPIT_BRANCHER_TESTE || path.join(__dirname, '..', 'scripts', 'codex', 'brancher.js');
// Le dossier des hooks du dépôt, tel que l'outil l'écrit dans les commandes (barres obliques, entre guillemets : le chemin peut contenir des espaces).
const DOSSIER = path.join(__dirname, '..', 'scripts', 'codex').replace(/\\/g, '/');
const commandeDe = (script, agent) => `node "${DOSSIER}/${script}" --agent ${agent}`;
const COMMANDE = agent => commandeDe('cockpit.js', agent);

let n = 0;
let RUN;
beforeEach(() => { RUN = fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-brancher-${process.pid}-${++n}-`)); });

// Forme réelle des hooks.json de Codex (relevée dans un fichier réel) : groupes avec ou sans matcher, un ou plusieurs hooks.
const ORIGINAL = {
  hooks: {
    SessionStart: [
      { matcher: '^(startup|resume)$', hooks: [{ type: 'command', command: 'python C:/x/hooks.py --hook SessionStart', timeout: 10, statusMessage: 'Loading project context' }] },
      { hooks: [{ type: 'command', command: 'node C:/x/context-ledger.js', timeout: 15, statusMessage: 'Fichier contexte' }] },
    ],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'node C:/x/garde.js', timeout: 10, statusMessage: 'securite' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node C:/x/context-ledger.js', timeout: 15, statusMessage: 'enregistrement' }] }],
  },
};

function ecrire(nom, objet, { bom = false, finDeLigne = false, crlf = false } = {}) {
  const p = path.join(RUN, nom);
  const texte = `${JSON.stringify(objet, null, 2)}${finDeLigne ? '\n' : ''}`;
  fs.writeFileSync(p, `${bom ? '\uFEFF' : ''}${crlf ? texte.replace(/\n/g, '\r\n') : texte}`);
  return p;
}
const lire = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const outil = (...args) => spawnSync(process.execPath, [OUTIL, ...args], { encoding: 'utf8' });

describe('brancher', () => {
  test('ajoute un groupe à SessionStart, à UserPromptSubmit et à PostCompact sans toucher à rien d autre', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : SessionStart, UserPromptSubmit, PostCompact\n');
    const apres = lire(p);
    const attendu = JSON.parse(JSON.stringify(ORIGINAL));
    const groupe = { hooks: [{ type: 'command', command: COMMANDE('codex'), timeout: 15, statusMessage: 'Cockpit : etat du travail' }] };
    attendu.hooks.SessionStart.push(groupe);
    attendu.hooks.UserPromptSubmit.push(groupe);
    attendu.hooks.PostCompact = [groupe];
    assert.deepEqual(apres, attendu);
  });

  test('un fichier déjà branché avant PostCompact reçoit seulement le groupe PostCompact', () => {
    const groupe = { hooks: [{ type: 'command', command: COMMANDE('codex'), timeout: 15, statusMessage: 'Cockpit : etat du travail' }] };
    const ancien = JSON.parse(JSON.stringify(ORIGINAL));
    ancien.hooks.SessionStart.push(groupe);
    ancien.hooks.UserPromptSubmit.push(groupe);
    const p = ecrire('hooks.json', ancien);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : PostCompact\n');
    const attendu = JSON.parse(JSON.stringify(ancien));
    attendu.hooks.PostCompact = [groupe];
    assert.deepEqual(lire(p), attendu);
  });

  test('crée la sauvegarde du fichier d origine, une seule fois', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    const sauvegarde = `${p}.avant-agent-memory-ledger-cockpit`;
    assert.deepEqual(lire(sauvegarde), ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H');
    assert.deepEqual(lire(sauvegarde), ORIGINAL, 'la sauvegarde d origine n est jamais écrasée par un branchement suivant');
    outil('retirer', '--fichier', p, '--agent', 'codex');
    assert.deepEqual(lire(sauvegarde), ORIGINAL, 'ni par un retrait');
  });

  test('est idempotent : un second branchement ne change rien', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    const premier = fs.readFileSync(p, 'utf8');
    const r = outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(p, 'utf8'), premier);
    assert.match(r.stdout, /déjà branché/);
  });

  test('préserve le BOM, la fin de ligne finale et le style des retours à la ligne du fichier', () => {
    for (const [bom, finDeLigne, crlf] of [[true, false, false], [false, true, false], [true, true, false], [false, false, false], [false, true, true], [true, false, true]]) {
      const p = ecrire(`hooks-${bom}-${finDeLigne}-${crlf}.json`, ORIGINAL, { bom, finDeLigne, crlf });
      outil('brancher', '--fichier', p, '--agent', 'codex');
      const brut = fs.readFileSync(p, 'utf8');
      assert.equal(brut.startsWith('\uFEFF'), bom, `BOM ${bom}`);
      assert.equal(brut.endsWith('\n'), finDeLigne, `fin de ligne ${finDeLigne}`);
      assert.equal(brut.includes('\r\n'), crlf, `CRLF ${crlf}`);
      if (crlf) assert.equal((brut.match(/\r\n/g) || []).length, (brut.match(/\n/g) || []).length, 'aucun LF isolé en style CRLF');
    }
  });

  test('ne modifie aucune ligne existante : seules des lignes sont ajoutées', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const avant = fs.readFileSync(p, 'utf8');
    outil('brancher', '--fichier', p, '--agent', 'codex');
    const apres = fs.readFileSync(p, 'utf8');
    const lignesApres = apres.split('\n');
    assert.ok(lignesApres.length > avant.split('\n').length);
    for (const l of avant.split('\n')) assert.ok(lignesApres.includes(l), `ligne conservée : ${l}`);
  });

  test('le nom d agent entre dans la commande, et deepseek_H a la sienne', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H');
    assert.equal(lire(p).hooks.SessionStart.at(-1).hooks[0].command, COMMANDE('deepseek_H'));
  });

  test('crée l événement s il n existe pas encore', () => {
    const p = ecrire('hooks.json', { hooks: { PreToolUse: ORIGINAL.hooks.PreToolUse } });
    outil('brancher', '--fichier', p, '--agent', 'codex');
    const h = lire(p).hooks;
    assert.equal(h.SessionStart.length, 1);
    assert.equal(h.UserPromptSubmit.length, 1);
    assert.equal(h.PostCompact.length, 1);
    assert.deepEqual(h.PreToolUse, ORIGINAL.hooks.PreToolUse);
  });

  test('refuse un fichier absent, illisible ou sans clé hooks, et n écrit rien', () => {
    const absent = path.join(RUN, 'nulle-part.json');
    const r1 = outil('brancher', '--fichier', absent, '--agent', 'codex');
    assert.notEqual(r1.status, 0);
    assert.match(r1.stderr, /fichier illisible/);
    assert.equal(fs.existsSync(absent), false);
    assert.deepEqual(fs.readdirSync(RUN).filter(f => f.includes('bak')), [], 'aucune sauvegarde d un fichier absent');
    const casse = path.join(RUN, 'casse.json');
    fs.writeFileSync(casse, '{pas du json');
    const r2 = outil('brancher', '--fichier', casse, '--agent', 'codex');
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /JSON invalide/);
    assert.equal(fs.readFileSync(casse, 'utf8'), '{pas du json');
    const sansHooks = ecrire('sans-hooks.json', { autre: 1 });
    const r3 = outil('brancher', '--fichier', sansHooks, '--agent', 'codex');
    assert.notEqual(r3.status, 0);
    assert.match(r3.stderr, /pas de clé hooks/);
    assert.deepEqual(lire(sansHooks), { autre: 1 });
  });

  test('refuse un nom d agent invalide', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    for (const agent of ['../evil', 'A B', '', 'x'.repeat(40), 'AGENT', 'deepseek_h']) {
      const r = outil('brancher', '--fichier', p, '--agent', agent);
      assert.notEqual(r.status, 0, agent);
    }
    assert.deepEqual(lire(p), ORIGINAL);
  });
});

describe('composant regulateur', () => {
  const COMMANDE_REG = agent => commandeDe('regulateur.js', agent);
  const GROUPE_REG = agent => ({ matcher: 'spawn_agent', hooks: [{ type: 'command', command: COMMANDE_REG(agent), timeout: 10, statusMessage: "Regulateur d'agents : plafond et pause" }] });

  test('ajoute un groupe à PreToolUse seulement, avec le matcher du lancement d agent', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : PreToolUse\n');
    const attendu = JSON.parse(JSON.stringify(ORIGINAL));
    attendu.hooks.PreToolUse.push(GROUPE_REG('codex'));
    assert.deepEqual(lire(p), attendu);
  });

  test('a sa propre sauvegarde, distincte de celle du Cockpit, jamais écrasée', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    const sauvegarde = `${p}.avant-agent-memory-ledger-regulateur`;
    assert.deepEqual(lire(sauvegarde), ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'regulateur');
    assert.deepEqual(lire(sauvegarde), ORIGINAL, 'la sauvegarde du Régulateur reste celle d avant le Régulateur');
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-cockpit`), true);
  });

  test('est idempotent et indépendant du Cockpit : brancher l un ne retire pas l autre', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    const deux = fs.readFileSync(p, 'utf8');
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.match(r.stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), deux);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    const h = lire(p).hooks;
    assert.equal(h.PreToolUse.length, 1, 'le groupe du Régulateur est parti');
    assert.equal(h.SessionStart.at(-1).hooks[0].command, COMMANDE('codex'), 'celui du Cockpit reste');
  });

  test('verifier dit l événement branché, composant par composant', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur').stdout, /pas branché/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit').stdout, /branché : SessionStart, UserPromptSubmit, PostCompact/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur').stdout, /^branché : PreToolUse/);
  });

  test('un autre agent (deepseek_H) a son propre groupe ; un composant inconnu est refusé', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'regulateur');
    assert.deepEqual(lire(p).hooks.PreToolUse.at(-1), GROUPE_REG('deepseek_H'));
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'inconnu');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /composant inconnu/);
  });

  test('crée PreToolUse s il n existe pas puis le retire en retirant le groupe', () => {
    const sans = { hooks: { SessionStart: ORIGINAL.hooks.SessionStart } };
    const p = ecrire('hooks.json', sans);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.equal(lire(p).hooks.PreToolUse.length, 1);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.deepEqual(lire(p), sans);
  });
});

describe('composant consignes', () => {
  const COMMANDE_CONS = agent => commandeDe('consignes.js', agent);
  // Sans matcher : le nom de l'outil qui exécute une commande varie (Bash, exec_command...), l'adaptateur lit lui-même la commande.
  const GROUPE_CONS = agent => ({ hooks: [{ type: 'command', command: COMMANDE_CONS(agent), timeout: 10, statusMessage: 'Consignes en vigueur : commandes verrouillees' }] });

  test('ajoute un groupe à PreToolUse seulement, sans matcher', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : PreToolUse\n');
    const attendu = JSON.parse(JSON.stringify(ORIGINAL));
    attendu.hooks.PreToolUse.push(GROUPE_CONS('codex'));
    assert.deepEqual(lire(p), attendu);
    assert.equal('matcher' in lire(p).hooks.PreToolUse.at(-1), false);
  });

  test('a sa propre sauvegarde, distincte de celles du Cockpit et du Régulateur, jamais écrasée', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    const sauvegarde = `${p}.avant-agent-memory-ledger-consignes`;
    assert.deepEqual(lire(sauvegarde), ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.deepEqual(lire(sauvegarde), ORIGINAL, 'la sauvegarde des Consignes reste celle d avant les Consignes');
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-cockpit`), true);
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-regulateur`), true);
  });

  test('est idempotent et indépendant des autres composants : brancher l un ne retire pas les autres', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    const trois = fs.readFileSync(p, 'utf8');
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    assert.match(r.stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), trois);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    const h = lire(p).hooks;
    assert.equal(h.PreToolUse.length, 2, 'le groupe des Consignes est parti, celui du Régulateur reste');
    assert.equal(h.PreToolUse.at(-1).matcher, 'spawn_agent');
    assert.equal(h.SessionStart.at(-1).hooks[0].command, COMMANDE('codex'), 'celui du Cockpit reste');
  });

  test('verifier dit l événement branché, composant par composant', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'consignes').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'consignes').stdout, /^branché : PreToolUse/);
  });

  test('un autre agent (deepseek_H) a son propre groupe, et retirer l un ne touche pas l autre', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'consignes');
    assert.deepEqual(lire(p).hooks.PreToolUse.slice(-2), [GROUPE_CONS('codex'), GROUPE_CONS('deepseek_H')]);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    assert.deepEqual(lire(p).hooks.PreToolUse.at(-1), GROUPE_CONS('deepseek_H'));
    assert.equal(lire(p).hooks.PreToolUse.length, 2);
  });

  test('crée PreToolUse s il n existe pas puis le retire en retirant le groupe', () => {
    const sans = { hooks: { SessionStart: ORIGINAL.hooks.SessionStart } };
    const p = ecrire('hooks.json', sans);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    assert.equal(lire(p).hooks.PreToolUse.length, 1);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'consignes');
    assert.deepEqual(lire(p), sans);
  });
});

describe('composant file', () => {
  // Le même script que le Régulateur, sur un autre événement : la fin du tour, où il demande au modèle de lancer le suivant de la file.
  const COMMANDE_REG = agent => commandeDe('regulateur.js', agent);
  const GROUPE_FILE = agent => ({ hooks: [{ type: 'command', command: COMMANDE_REG(agent), timeout: 10, statusMessage: "Regulateur d'agents : file d'attente" }] });
  const AVEC_STOP = { hooks: { ...ORIGINAL.hooks, Stop: [{ hooks: [{ type: 'command', command: 'node C:/x/memory-checkpoint.js', timeout: 10, statusMessage: 'memoire' }] }] } };

  test('ajoute un groupe à Stop seulement, sans matcher, après les groupes existants', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : Stop\n');
    const attendu = JSON.parse(JSON.stringify(AVEC_STOP));
    attendu.hooks.Stop.push(GROUPE_FILE('codex'));
    assert.deepEqual(lire(p), attendu);
    assert.equal('matcher' in lire(p).hooks.Stop.at(-1), false);
  });

  test('a sa propre sauvegarde, distincte de celles des autres composants, jamais écrasée', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    const sauvegarde = `${p}.avant-agent-memory-ledger-file`;
    assert.deepEqual(lire(sauvegarde), AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.deepEqual(lire(sauvegarde), AVEC_STOP, 'la sauvegarde de la file reste celle d avant la file');
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-regulateur`), true);
  });

  test('est indépendant du composant régulateur malgré le même script : chacun voit et retire seulement ses événements', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'file').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'file').stdout, /^branché : Stop/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur').stdout, /^branché : PreToolUse/);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    const h = lire(p).hooks;
    assert.equal(h.Stop.length, 1, 'le groupe de la file est parti, celui de la mémoire reste');
    assert.equal(h.PreToolUse.at(-1).matcher, 'spawn_agent', 'celui du Régulateur reste');
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.deepEqual(lire(p), AVEC_STOP);
  });

  test('est idempotent', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    const une = fs.readFileSync(p, 'utf8');
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    assert.match(r.stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), une);
  });

  test('un autre agent (deepseek_H) a son propre groupe, et retirer l un ne touche pas l autre', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'file');
    assert.deepEqual(lire(p).hooks.Stop.slice(-2), [GROUPE_FILE('codex'), GROUPE_FILE('deepseek_H')]);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    assert.deepEqual(lire(p).hooks.Stop.at(-1), GROUPE_FILE('deepseek_H'));
    assert.equal(lire(p).hooks.Stop.length, 2);
  });

  test('crée Stop s il n existe pas puis le retire en retirant le groupe', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    assert.equal(lire(p).hooks.Stop.length, 1);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    assert.deepEqual(lire(p), ORIGINAL);
  });
});

describe('composant nuit', () => {
  // L'outil de questions : PreToolUse limité par un matcher à request_user_input (_async), pour que la Nuit refuse les questions pendant l'absence.
  const COMMANDE_NUIT = agent => commandeDe('nuit.js', agent);
  const COMMANDE_REG = agent => commandeDe('regulateur.js', agent);
  const GROUPE_NUIT = agent => ({ matcher: 'request_user_input', hooks: [{ type: 'command', command: COMMANDE_NUIT(agent), timeout: 10, statusMessage: 'Nuit : questions en boite' }] });

  test('ajoute un groupe à PreToolUse seulement, avec le matcher des questions, après les groupes existants', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : PreToolUse\n');
    const attendu = JSON.parse(JSON.stringify(ORIGINAL));
    attendu.hooks.PreToolUse.push(GROUPE_NUIT('codex'));
    assert.deepEqual(lire(p), attendu);
  });

  test('a sa propre sauvegarde, distincte de celles des autres composants, jamais écrasée', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    const sauvegarde = `${p}.avant-agent-memory-ledger-nuit`;
    assert.deepEqual(lire(sauvegarde), ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.deepEqual(lire(sauvegarde), ORIGINAL, 'la sauvegarde de la nuit reste celle d avant la nuit');
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-regulateur`), true);
  });

  test('est indépendant du Régulateur sur le même événement : chacun voit et retire seulement son groupe', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'nuit').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'nuit').stdout, /^branché : PreToolUse/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur').stdout, /^branché : PreToolUse/);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    const h = lire(p).hooks;
    assert.equal(h.PreToolUse.at(-1).matcher, 'spawn_agent', 'celui du Régulateur reste');
    assert.equal(h.PreToolUse.length, 2);
    assert.equal(h.PreToolUse.some(g => g.matcher === 'request_user_input'), false);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.deepEqual(lire(p), ORIGINAL);
  });

  test('est idempotent, et un autre agent (deepseek_H) a son propre groupe', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    const une = fs.readFileSync(p, 'utf8');
    assert.match(outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit').stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), une);
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'nuit');
    assert.deepEqual(lire(p).hooks.PreToolUse.slice(-2), [GROUPE_NUIT('codex'), GROUPE_NUIT('deepseek_H')]);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    assert.deepEqual(lire(p).hooks.PreToolUse.at(-1), GROUPE_NUIT('deepseek_H'));
    assert.equal(lire(p).hooks.PreToolUse.length, 2);
  });

  test('le groupe du Régulateur et celui de la Nuit se distinguent par leur commande, même avec le même matcher de départ', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit');
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    const commandes = lire(p).hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command));
    assert.ok(commandes.includes(COMMANDE_NUIT('codex')) && commandes.includes(COMMANDE_REG('codex')));
  });
});

describe('composant nuit-tours', () => {
  // La fin du tour (le modèle reçoit l'ordre de continuer) et le message de l'utilisateur (le réveil) : le même script que le composant nuit.
  const COMMANDE_NUIT = agent => commandeDe('nuit.js', agent);
  const GROUPE_TOURS = agent => ({ hooks: [{ type: 'command', command: COMMANDE_NUIT(agent), timeout: 10, statusMessage: 'Nuit : enchainement et reveil' }] });
  const AVEC_STOP = { hooks: { ...ORIGINAL.hooks, Stop: [{ hooks: [{ type: 'command', command: 'node C:/x/memory-checkpoint.js', timeout: 10, statusMessage: 'memoire' }] }] } };

  test('ajoute un groupe à Stop et à UserPromptSubmit, sans matcher, après les groupes existants', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : Stop, UserPromptSubmit\n');
    const attendu = JSON.parse(JSON.stringify(AVEC_STOP));
    attendu.hooks.Stop.push(GROUPE_TOURS('codex'));
    attendu.hooks.UserPromptSubmit.push(GROUPE_TOURS('codex'));
    assert.deepEqual(lire(p), attendu);
    assert.equal('matcher' in lire(p).hooks.Stop.at(-1), false);
  });

  test('a sa propre sauvegarde, jamais écrasée', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    const sauvegarde = `${p}.avant-agent-memory-ledger-nuit-tours`;
    assert.deepEqual(lire(sauvegarde), AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.deepEqual(lire(sauvegarde), AVEC_STOP);
  });

  test('est indépendant de la file et du Cockpit sur les mêmes événements : chacun voit et retire seulement son groupe', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'file');
    outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours').stdout, /^branché : Stop, UserPromptSubmit/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'file').stdout, /^branché : Stop/);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'file').stdout, /^branché : Stop/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex').stdout, /^branché : SessionStart, UserPromptSubmit, PostCompact/);
    assert.equal(lire(p).hooks.Stop.length, 2, 'la mémoire et la file restent');
    assert.equal(lire(p).hooks.UserPromptSubmit.length, 2, 'le fichier contexte et le Cockpit restent');
  });

  test('est idempotent, et crée puis retire les événements qui manquent', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    const une = fs.readFileSync(p, 'utf8');
    assert.match(outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours').stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), une);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    assert.deepEqual(lire(p), ORIGINAL);
  });

  test('un autre agent (deepseek_H) a son propre groupe', () => {
    const p = ecrire('hooks.json', AVEC_STOP);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'nuit-tours');
    assert.deepEqual(lire(p).hooks.Stop.slice(-2), [GROUPE_TOURS('codex'), GROUPE_TOURS('deepseek_H')]);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'nuit-tours');
    assert.deepEqual(lire(p).hooks.Stop.at(-1), GROUPE_TOURS('deepseek_H'));
    assert.equal(lire(p).hooks.Stop.length, 2);
  });
});

describe('composant cockpit-outils', () => {
  // Le même script que le Cockpit, sur PostToolUse : le premier outil qui suit un compactage réinjecte le bloc.
  const GROUPE_OUTILS = agent => ({ hooks: [{ type: 'command', command: COMMANDE(agent), timeout: 15, statusMessage: 'Cockpit : etat du travail apres compactage' }] });
  const AVEC_OUTIL = { hooks: { ...ORIGINAL.hooks, PostToolUse: [{ hooks: [{ type: 'command', command: 'node C:/x/preuves.js', timeout: 15, statusMessage: 'preuves' }] }] } };

  test('ajoute un groupe à PostToolUse seulement, sans matcher, après les groupes existants', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : PostToolUse\n');
    const attendu = JSON.parse(JSON.stringify(AVEC_OUTIL));
    attendu.hooks.PostToolUse.push(GROUPE_OUTILS('codex'));
    assert.deepEqual(lire(p), attendu);
    assert.equal('matcher' in lire(p).hooks.PostToolUse.at(-1), false);
  });

  test('a sa propre sauvegarde, distincte de celle du Cockpit, jamais écrasée', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    const sauvegarde = `${p}.avant-agent-memory-ledger-cockpit-outils`;
    assert.deepEqual(lire(sauvegarde), AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.deepEqual(lire(sauvegarde), AVEC_OUTIL, 'la sauvegarde reste celle d avant le composant');
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-cockpit`), true);
  });

  test('est indépendant du composant cockpit malgré le même script : chacun voit et retire seulement ses événements', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils').stdout, /^branché : PostToolUse/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex').stdout, /^branché : SessionStart, UserPromptSubmit, PostCompact/);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex').stdout, /^branché : SessionStart, UserPromptSubmit, PostCompact/);
    assert.equal(lire(p).hooks.PostCompact.length, 1, 'celui du Cockpit reste');
    assert.deepEqual(lire(p).hooks.PostToolUse, AVEC_OUTIL.hooks.PostToolUse, 'celui des preuves reste, celui des outils est parti');
  });

  test('est idempotent, et un autre agent (deepseek_H) a son propre groupe', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    const une = fs.readFileSync(p, 'utf8');
    assert.match(outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils').stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), une);
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'cockpit-outils');
    assert.deepEqual(lire(p).hooks.PostToolUse.slice(-2), [GROUPE_OUTILS('codex'), GROUPE_OUTILS('deepseek_H')]);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.deepEqual(lire(p).hooks.PostToolUse.at(-1), GROUPE_OUTILS('deepseek_H'));
    assert.equal(lire(p).hooks.PostToolUse.length, 2);
  });

  test('crée PostToolUse s il n existe pas puis le retire en retirant le groupe', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.equal(lire(p).hooks.PostToolUse.length, 1);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.deepEqual(lire(p), ORIGINAL);
  });
});

describe('composant regulateur-resultat', () => {
  // Le même script que le Régulateur, sur le résultat du lancement d'agent : il acquitte la réservation de la demande de la file.
  const COMMANDE_REG = agent => commandeDe('regulateur.js', agent);
  const GROUPE_RESULTAT = agent => ({ matcher: 'spawn_agent', hooks: [{ type: 'command', command: COMMANDE_REG(agent), timeout: 10, statusMessage: "Regulateur d'agents : resultat du lancement" }] });
  const AVEC_OUTIL = { hooks: { ...ORIGINAL.hooks, PostToolUse: [{ hooks: [{ type: 'command', command: 'node C:/x/preuves.js', timeout: 15, statusMessage: 'preuves' }] }] } };

  test('ajoute un groupe à PostToolUse seulement, avec le matcher du lancement d agent, après les groupes existants', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    const r = outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'branché : PostToolUse\n');
    const attendu = JSON.parse(JSON.stringify(AVEC_OUTIL));
    attendu.hooks.PostToolUse.push(GROUPE_RESULTAT('codex'));
    assert.deepEqual(lire(p), attendu);
  });

  test('a sa propre sauvegarde, distincte de celle du Régulateur, jamais écrasée', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat');
    const sauvegarde = `${p}.avant-agent-memory-ledger-regulateur-resultat`;
    assert.deepEqual(lire(sauvegarde), AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    assert.deepEqual(lire(sauvegarde), AVEC_OUTIL, 'la sauvegarde reste celle d avant le composant');
    assert.equal(fs.existsSync(`${p}.avant-agent-memory-ledger-regulateur`), true);
  });

  test('est indépendant du Régulateur, de la file et du composant cockpit-outils : chacun voit et retire seulement son groupe', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur');
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'cockpit-outils');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat').stdout, /^branché : PostToolUse/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur').stdout, /^branché : PreToolUse/);
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex', '--composant', 'file').stdout, /pas branché/);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat');
    const h = lire(p).hooks;
    assert.equal(h.PostToolUse.length, 2, 'celui des preuves et celui des outils restent');
    assert.equal(h.PostToolUse.at(-1).matcher, undefined, 'celui des outils reste, sans matcher');
    assert.equal(h.PreToolUse.at(-1).matcher, 'spawn_agent', 'celui du Régulateur reste');
  });

  test('est idempotent, et un autre agent (deepseek_H) a son propre groupe', () => {
    const p = ecrire('hooks.json', AVEC_OUTIL);
    outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat');
    const une = fs.readFileSync(p, 'utf8');
    assert.match(outil('brancher', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat').stdout, /déjà branché/);
    assert.equal(fs.readFileSync(p, 'utf8'), une);
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H', '--composant', 'regulateur-resultat');
    assert.deepEqual(lire(p).hooks.PostToolUse.slice(-2), [GROUPE_RESULTAT('codex'), GROUPE_RESULTAT('deepseek_H')]);
    outil('retirer', '--fichier', p, '--agent', 'codex', '--composant', 'regulateur-resultat');
    assert.deepEqual(lire(p).hooks.PostToolUse.at(-1), GROUPE_RESULTAT('deepseek_H'));
    assert.equal(lire(p).hooks.PostToolUse.length, 2);
  });
});

describe('retirer et verifier', () => {
  test('retirer remet exactement l état d avant et ne retire que le groupe du Cockpit', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    const r = outil('retirer', '--fichier', p, '--agent', 'codex');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lire(p), ORIGINAL);
  });

  test('retirer supprime la clé d un événement que le branchement avait créé', () => {
    const p = ecrire('hooks.json', { hooks: { PreToolUse: ORIGINAL.hooks.PreToolUse } });
    outil('brancher', '--fichier', p, '--agent', 'codex');
    outil('retirer', '--fichier', p, '--agent', 'codex');
    assert.deepEqual(lire(p), { hooks: { PreToolUse: ORIGINAL.hooks.PreToolUse } });
  });

  test('retirer ne retire que le hook du Cockpit d un groupe qui contient aussi d autres hooks', () => {
    const melange = JSON.parse(JSON.stringify(ORIGINAL));
    melange.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'node C:/x/autre.js', timeout: 5 }, { type: 'command', command: COMMANDE('codex'), timeout: 15, statusMessage: 'Cockpit : etat du travail' }] });
    const p = ecrire('hooks.json', melange);
    outil('retirer', '--fichier', p, '--agent', 'codex');
    const groupe = lire(p).hooks.SessionStart.at(-1);
    assert.deepEqual(groupe.hooks.map(h => h.command), ['node C:/x/autre.js']);
  });

  test('retirer ne touche pas le groupe d un autre agent', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    outil('brancher', '--fichier', p, '--agent', 'deepseek_H');
    outil('retirer', '--fichier', p, '--agent', 'codex');
    const h = lire(p).hooks;
    assert.equal(h.SessionStart.at(-1).hooks[0].command, COMMANDE('deepseek_H'));
    assert.equal(h.SessionStart.length, 3);
  });

  test('retirer sur un fichier non branché ne change rien', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const avant = fs.readFileSync(p, 'utf8');
    const r = outil('retirer', '--fichier', p, '--agent', 'codex');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(p, 'utf8'), avant);
    assert.match(r.stdout, /pas branché/);
  });

  test('verifier dit l état sans rien écrire', () => {
    const p = ecrire('hooks.json', ORIGINAL);
    const avant = fs.readFileSync(p, 'utf8');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex').stdout, /pas branché/);
    outil('brancher', '--fichier', p, '--agent', 'codex');
    const branche = fs.readFileSync(p, 'utf8');
    assert.match(outil('verifier', '--fichier', p, '--agent', 'codex').stdout, /branché : SessionStart, UserPromptSubmit, PostCompact/);
    assert.equal(fs.readFileSync(p, 'utf8'), branche);
    assert.notEqual(branche, avant);
  });

  test('une commande inconnue est refusée', () => {
    const r = outil('nimporte');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /commande inconnue/);
  });
});
