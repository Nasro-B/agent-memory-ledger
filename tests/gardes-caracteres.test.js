'use strict';
// Banc de la garde des caractères invisibles (scripts/gardes/caracteres.js) : refus avant écriture, lignes de commande
// de recherche et de nettoyage, mode fin de tour. Sans modèle. Lancement : node --test tests/gardes-caracteres.test.js
// Les caractères interdits ne sont jamais écrits en clair dans ce fichier : ils sont construits par leur code.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { creerMonde } = require('./aide-gardes.js');
const { erreursSortieCodex } = require('./schema.js');

const m = creerMonde('caracteres');
const garde = require(m.scripts('gardes', 'caracteres.js'));
const gardesConfig = require(m.scripts('lib', 'gardes-config.js'));
const { trouver, nettoyer, evaluer, evaluerReponse } = garde;

const C = cp => String.fromCodePoint(cp);
const NNBSP = C(0x202F);
const NBSP = C(0x00A0);
const ZWSP = C(0x200B);
const TIRET_LONG = C(0x2014);
const W = content => ({ tool_name: 'Write', tool_input: { file_path: 'x.txt', content } });
const MAISON = m.maison();
const cfgDe = gardes => m.avecMaison(gardes === undefined ? MAISON : m.maison(gardes), () => gardesConfig.charger());

function lancer(args, entree, maison = MAISON) {
  return spawnSync(process.execPath, [m.scripts('gardes', 'caracteres.js'), ...args], { input: entree, encoding: 'utf8', env: m.env(maison), windowsHide: true, timeout: 60000 });
}

// ------------------------------------------------------------------ avant une écriture

test('caracteres : chaque code de la liste est refusé', () => {
  const codes = [0x00A0, 0x202F, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x180E, 0x2007, 0x2009, 0x200A, 0x205F, 0x3000, 0x1680,
    0x200E, 0x200F, 0x061C, 0x202A, 0x202E, 0x2066, 0x2069, 0x2061, 0x2064, 0x206A, 0x206F, 0x00AD, 0x034F, 0x115F, 0x1160, 0x3164,
    0xFFA0, 0x17B4, 0x17B5, 0x2800, 0x2028, 0x2029, 0x0085, 0xFE00, 0xFE0F, 0xE0100, 0xE01EF, 0xE0000, 0xE007F, 0xFFF9, 0xFFFC, 0x0001, 0x001B, 0x007F, 0x009F,
    0x2000, 0x2001, 0x2006, 0x2008, 0x200C, 0x202B, 0x202D, 0x2062, 0x2063, 0x206B, 0xFE0E, 0xFFFA, 0xFFFB, 0x0008, 0x000B, 0x000C, 0x000E, 0x001F];
  for (const cp of codes) {
    const t = trouver('a' + C(cp) + 'b');
    assert.equal(t.length, 1, 'U+' + cp.toString(16) + ' non détecté');
    assert.notEqual(evaluer(W('a' + C(cp) + 'b')), null);
  }
  assert.ok(codes.length >= 60);
});

test('caracteres : texte normal, accents, guillemets français, tabulation, retour chariot et saut de ligne passent', () => {
  assert.deepEqual(trouver('Éléphant à l\'été : « oui » ?\r\n\tfin'), []);
  assert.deepEqual(trouver('tiret simple - et deux-points : ok, (parenthèses) ; point.'), []);
  assert.equal(evaluer(W('rien à signaler')), null);
  assert.equal(evaluer(W('espace normale et ' + C(0x20))), null);
  assert.deepEqual(trouver(TIRET_LONG), [], 'le tiret long n\'est pas un caractère invisible : seule la fin de tour le contrôle, si le réglage le demande');
});

test('caracteres : exceptions étroites : marque en tête, direction dans un texte arabe, sélecteur collé à un pictogramme', () => {
  assert.deepEqual(trouver(C(0xFEFF) + 'texte'), []);
  assert.equal(trouver('a' + C(0xFEFF) + 'b').length, 1);
  assert.deepEqual(trouver('\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}' + C(0x200F) + '\u{0639}\u{0627}\u{0644}\u{0645}'), []);
  assert.equal(trouver('hello' + C(0x200F) + 'world').length, 1);
  assert.deepEqual(trouver(C(0x26A0) + C(0xFE0F)), []);
  assert.deepEqual(trouver('1' + C(0xFE0F) + C(0x20E3)), []);
  assert.equal(trouver('a' + C(0xFE0F) + 'b').length, 1);
  assert.deepEqual(trouver(C(0x1F468) + C(0x200D) + C(0x1F469)), [], 'liant de largeur nulle entre deux pictogrammes');
  assert.equal(trouver('a' + C(0x200D) + 'b').length, 1);
});

test('caracteres : Edit et MultiEdit : seul le texte écrit compte, l\'ancien texte peut contenir l\'invisible', () => {
  const ok = { tool_name: 'Edit', tool_input: { file_path: 'f', old_string: 'a' + NNBSP + 'b', new_string: 'a b' } };
  assert.equal(evaluer(ok), null);
  const ko = { tool_name: 'Edit', tool_input: { file_path: 'f', old_string: 'a b', new_string: 'a' + NNBSP + 'b' } };
  assert.notEqual(evaluer(ko), null);
  const multi = { tool_name: 'MultiEdit', tool_input: { file_path: 'f', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'x', new_string: 'y' + ZWSP }] } };
  assert.notEqual(evaluer(multi), null);
  assert.equal(evaluer({ tool_name: 'Write', tool_input: { file_path: 'x' + NBSP + '.txt', content: 'propre' } }), null, 'un chemin n\'est pas un texte écrit');
  assert.notEqual(evaluer({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb', new_source: 'a' + NBSP + 'b' } }), null);
});

test('caracteres : commande de shell et patch : le texte écrit est contrôlé, la liste de travail est exemptée', () => {
  assert.notEqual(evaluer({ tool_name: 'Bash', tool_input: { command: 'echo "a' + NBSP + 'b" > f' } }), null);
  assert.equal(evaluer({ tool_name: 'Bash', tool_input: { command: 'rg -nP "[\\x{00A0}]" f' } }), null, 'une classe écrite par son échappement passe');
  assert.equal(evaluer({ tool_name: 'Bash', tool_input: { command: 'node "C:/outils/context-ledger.js" ajouter "a' + NNBSP + 'b"' } }), null, 'la liste cite les messages mot pour mot');
  assert.notEqual(evaluer({ tool_name: 'Bash', tool_input: { command: 'echo "a' + NNBSP + 'b" # context-ledger.js' } }), null, 'l\'exemption ne vaut que pour la commande de la liste');
  const patch = '*** Begin Patch\n*** Update File: f\n-ancien' + NNBSP + '\n+nouveau' + NNBSP + '\n*** End Patch';
  assert.notEqual(evaluer({ tool_name: 'apply_patch', tool_input: { command: patch } }), null);
  const retrait = '*** Begin Patch\n*** Update File: f\n-ancien' + NNBSP + '\n+nouveau\n*** End Patch';
  assert.equal(evaluer({ tool_name: 'apply_patch', tool_input: { command: retrait } }), null, 'retirer un invisible reste possible');
  assert.notEqual(evaluer({ tool_name: 'apply_patch', tool_input: { patch: '+a' + NBSP + 'b' } }), null);
  assert.notEqual(evaluer({ tool_name: 'write_file', tool_input: { path: 'f', text: 'a' + ZWSP + 'b' } }), null, 'outil d\'écriture d\'un autre agent');
  assert.notEqual(evaluer({ tool_name: 'mcp__quelconque__envoyer', tool_input: { corps: 'a' + ZWSP + 'b' } }), null, 'outil MCP');
  assert.equal(evaluer({ tool_name: 'Read', tool_input: { file_path: 'f' } }), null);
});

test('caracteres : le refus dit quoi faire, avec les codes, la position et la commande de nettoyage', () => {
  const r = evaluer(W('ligne un\nab' + NNBSP + 'cd' + ZWSP));
  for (const motif of [/2 caractère\(s\) invisible\(s\)/, /U\+202F x1/, /U\+200B x1/, /ligne 2 colonne 3/, /<U\+202F>/, /espace normale U\+0020/, /échappement/, /--fix <fichier>/]) assert.match(r, motif);
  assert.match(r, /node "[^"]+caracteres\.js" --fix/);
  assert.doesNotMatch(r, new RegExp('[' + NNBSP + ZWSP + TIRET_LONG + ']'), 'le message ne contient aucun caractère interdit');
});

test('caracteres : nettoyer : espaces larges en espace, séparateurs en saut de ligne, le reste supprimé, exceptions gardées', () => {
  assert.equal(nettoyer('a' + NNBSP + 'b' + NBSP + 'c' + ZWSP + 'd' + C(0x2028) + 'e'), 'a b cd\ne');
  assert.equal(nettoyer(C(0x26A0) + C(0xFE0F) + ' ok'), C(0x26A0) + C(0xFE0F) + ' ok');
  assert.equal(nettoyer('a' + C(0xE0041) + 'b'), 'ab', 'caractère de tag hors du plan de base');
  assert.equal(nettoyer('propre'), 'propre');
});

test('caracteres : processus : refus en code 2 et JSON deny, passage en code 0 sans sortie, entrée illisible laissée passer', () => {
  const ko = lancer([], JSON.stringify(W('a' + NNBSP + 'b')));
  assert.equal(ko.status, 2);
  assert.equal(JSON.parse(ko.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(erreursSortieCodex('PreToolUse', ko.stdout), []);
  assert.match(ko.stderr, /REFUSÉ par la garde des caractères invisibles/);
  const ok = lancer([], JSON.stringify(W('a b')));
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
  for (const brut of ['{pas du json', '', '   ', '"texte"', 'null']) {
    const r = lancer([], brut);
    assert.equal(r.status, 0, JSON.stringify(brut));
    assert.equal(r.stdout, '');
  }
});

test('caracteres : lignes de commande : --scan liste et rend 1, --fix remplace, un fichier absent rend 2', () => {
  const f = path.join(m.run, 'sale.txt');
  fs.writeFileSync(f, 'ligne\nab' + NBSP + 'cd' + ZWSP + '\n');
  const scan = lancer(['--scan', f], '');
  assert.equal(scan.status, 1);
  assert.match(scan.stdout, /sale\.txt:2:3 U\+00A0/);
  assert.match(scan.stdout, /sale\.txt:2:6 U\+200B/);
  const fix = lancer(['--fix', f], '');
  assert.equal(fix.status, 0);
  assert.match(fix.stdout, /2 remplacé\(s\)/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'ligne\nab cd\n');
  assert.equal(lancer(['--scan', f], '').status, 0);
  const absent = lancer(['--scan', path.join(m.run, 'absent.txt')], '');
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /lecture impossible/);
});

// ------------------------------------------------------------------ fin de tour

test('caracteres : fin de tour : réponse propre, invisible bloqué avec ses codes, tiret long seulement si le réglage le demande', () => {
  assert.equal(evaluerReponse({ last_assistant_message: 'Tout va bien : voilà (ok).' }).raison, null);
  assert.match(evaluerReponse({ last_assistant_message: 'a' + NNBSP + 'b' }).raison, /U\+202F x1/);
  assert.match(evaluerReponse({ last_assistant_message: 'a' + NNBSP + 'b' }, { tiretLong: true }).raison, /U\+202F x1/);
  const tiret = { last_assistant_message: 'a ' + TIRET_LONG + ' b' };
  assert.equal(evaluerReponse(tiret).raison, null, 'par défaut le tiret long n\'est pas contrôlé');
  assert.equal(evaluerReponse(tiret, {}).raison, null);
  const r = evaluerReponse(tiret, { tiretLong: true });
  assert.match(r.raison, /U\+2014 x1/);
  assert.match(r.raison, /tiret long/);
  assert.doesNotMatch(r.raison, new RegExp(TIRET_LONG), 'le message ne contient pas le caractère qu\'il reproche');
  assert.doesNotMatch(evaluerReponse({ last_assistant_message: 'a' + NNBSP + 'b' }).raison, /tiret long/);
});

test('caracteres : fin de tour : une seule relance par message et jamais pour un sous-agent', () => {
  const sale = { last_assistant_message: 'a' + NNBSP + 'b' };
  assert.notEqual(evaluerReponse(sale).raison, null);
  assert.equal(evaluerReponse(Object.assign({ stop_hook_active: true }, sale)).raison, null);
  assert.equal(evaluerReponse(Object.assign({ agent_id: 'x' }, sale)).raison, null);
  assert.equal(evaluerReponse(Object.assign({ agent_type: 'general' }, sale)).raison, null);
  assert.notEqual(evaluerReponse(Object.assign({ stop_hook_active: false }, sale)).raison, null);
});

test('caracteres : fin de tour : repli sur la transcription, dernier tour de l\'assistant seulement', () => {
  const f = path.join(m.run, 't.jsonl');
  const l = o => JSON.stringify(o);
  const texte = t => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  fs.writeFileSync(f, [
    l({ type: 'user', message: { role: 'user', content: 'ancien' } }),
    l(texte('ancien' + ZWSP)),
    l({ type: 'user', message: { role: 'user', content: 'question' } }),
    l({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' + NNBSP }, { type: 'text', text: 'propre' }] } }),
    l({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
    l(texte('fin')),
  ].join('\n'));
  assert.equal(evaluerReponse({ transcript_path: f }).raison, null, 'ni l\'ancien tour ni la réflexion ne comptent');
  fs.appendFileSync(f, '\n' + l(texte('sale' + NBSP + 'ici')));
  assert.match(evaluerReponse({ transcript_path: f }).raison, /U\+00A0/);
  assert.equal(evaluerReponse({ transcript_path: path.join(m.run, 'absent.jsonl') }).raison, null, 'transcription illisible : rien à reprocher');
  assert.equal(evaluerReponse({}).raison, null);
});

test('caracteres : fin de tour : processus : sortie conforme au schéma de Stop, rien si propre ou si l\'entrée est cassée, journal écrit', () => {
  const maison = m.maison();
  const ko = lancer(['--stop', '--agent', 'essai'], JSON.stringify({ session_id: 's', last_assistant_message: 'a' + NNBSP + 'b' }), maison);
  assert.equal(ko.status, 0);
  assert.equal(JSON.parse(ko.stdout).decision, 'block');
  assert.deepEqual(erreursSortieCodex('Stop', ko.stdout), []);
  assert.equal(lancer(['--stop'], JSON.stringify({ session_id: 's', last_assistant_message: 'ok' }), maison).stdout, '');
  assert.equal(lancer(['--stop'], '{casse', maison).stdout, '');
  assert.equal(lancer(['--stop'], '', maison).stdout, '');
  const journal = fs.readFileSync(path.join(maison, 'etat', 'garde-caracteres-fin-de-tour.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.equal(journal.length, 2, 'un passage propre et un refus sont journalisés, pas l\'entrée cassée');
  assert.equal(journal[0].agent, 'essai');
  assert.equal(journal[0].refuse, true);
  assert.equal(journal[1].refuse, false);
  assert.ok(!JSON.stringify(journal).includes(NNBSP), 'le journal ne garde pas le texte de la réponse');
});

// ------------------------------------------------------------------ configuration

test('caracteres : configuration : défauts actifs sans le tiret long, réglage du tiret long, garde éteinte', () => {
  const defaut = cfgDe();
  assert.equal(defaut.caracteres.actif, true);
  assert.equal(defaut.caracteres.tiretLongFinDeTour, false);
  const tiret = { last_assistant_message: 'a ' + TIRET_LONG + ' b' };
  const brut = JSON.stringify(tiret);
  assert.equal(garde.executerFin(brut, 'essai', cfgDe()), '', 'défaut : le tiret long passe');
  const avecTiret = cfgDe({ caracteres: { tiretLongFinDeTour: true } });
  assert.equal(avecTiret.caracteres.tiretLongFinDeTour, true);
  const sortie = m.avecMaison(m.maison(), () => garde.executerFin(brut, 'essai', avecTiret));
  assert.equal(JSON.parse(sortie).decision, 'block');
  const eteint = cfgDe({ caracteres: { actif: false } });
  assert.equal(eteint.caracteres.actif, false);
  const sale = JSON.stringify(W('a' + NNBSP + 'b'));
  assert.deepEqual(garde.executerAvant(sale, eteint), { stdout: '', stderr: '', code: 0 }, 'éteinte : aucun refus avant écriture');
  assert.equal(m.avecMaison(m.maison(), () => garde.executerFin(JSON.stringify({ last_assistant_message: 'a' + NNBSP + 'b' }), 'essai', eteint)), '', 'éteinte : aucun refus en fin de tour');
  assert.equal(garde.executerAvant(sale, defaut).code, 2, 'la même écriture est refusée avec le réglage par défaut');
  assert.equal(cfgDe({ caracteres: { actif: 'non' } }).caracteres.actif, true, 'une valeur mal formée ne désarme pas');
  assert.equal(cfgDe({ caracteres: { tiretLongFinDeTour: 'oui' } }).caracteres.tiretLongFinDeTour, false);
});

test('caracteres : configuration : un gardes.json illisible ne désarme pas la garde, et elle le dit dans son refus', () => {
  const maison = m.maison('{ pas du json');
  const cfg = m.avecMaison(maison, () => gardesConfig.charger());
  assert.equal(cfg.illisible, true);
  assert.equal(cfg.caracteres.actif, true);
  const r = lancer([], JSON.stringify(W('a' + NNBSP + 'b')), maison);
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /illisible/);
  assert.equal(lancer([], JSON.stringify(W('a b')), maison).stdout, '', 'une écriture propre passe sans bruit');
  const stop = lancer(['--stop'], JSON.stringify({ last_assistant_message: 'a' + NNBSP + 'b' }), maison);
  assert.equal(JSON.parse(stop.stdout).decision, 'block');
});

// ------------------------------------------------------------------ mutations

test('mutation : chaque protection de la garde des caractères, défaite dans une copie des scripts, rend son banc rouge', { skip: m.EN_MUTATION }, () => {
  const G = 'gardes/caracteres.js';
  const rouge = nom => new RegExp('not ok \\d+ - caracteres : ' + nom);
  m.mutations(__filename, '^caracteres', [
    ['classe-plage', '  \'\' + // MUTATION : la plage des espaces larges et des marques n\'est plus interdite', rouge('chaque code de la liste'), G, '^caracteres : chaque code'],
    ['bom-en-tete', '    if (false) continue; // MUTATION : la marque d\'ordre des octets en tête est refusée', rouge('exceptions étroites'), G, '^caracteres : exceptions'],
    ['direction-rtl', '    if (false) continue; // MUTATION : la direction dans un texte arabe est refusée', rouge('exceptions étroites'), G, '^caracteres : exceptions'],
    ['selecteur-pictogramme', '      if (false) continue; // MUTATION : le sélecteur collé à un pictogramme est refusé', rouge('exceptions étroites'), G, '^caracteres : exceptions'],
    ['exemption-liste', '    if (false) return []; // MUTATION : la liste de travail n\'est plus exemptée', rouge('commande de shell et patch'), G, '^caracteres : commande de shell'],
    ['anti-boucle', '  if (false) return { raison: null, source: \'ignore\' }; // MUTATION : aucune protection contre la boucle', rouge('fin de tour : une seule relance'), G, '^caracteres : fin de tour : une seule'],
    ['tiret-long', '  if (true) { // MUTATION : le tiret long est toujours contrôlé', rouge('fin de tour : réponse propre'), G, '^caracteres : fin de tour : réponse propre'],
    ['actif-avant', '  if (!brut.trim()) return { stdout: \'\', stderr: \'\', code: 0 }; // MUTATION : la garde éteinte refuse encore', rouge('configuration : défauts actifs'), G, '^caracteres : configuration : défauts'],
    ['actif-fin', '  if (!brut.trim()) return \'\'; // MUTATION : la garde éteinte bloque encore en fin de tour', rouge('configuration : défauts actifs'), G, '^caracteres : configuration : défauts'],
    ['refus-code', '    code: 0, // MUTATION : le refus sort en code 0', rouge('processus : refus en code 2'), G, '^caracteres : processus : refus'],
    ['fin-bloque', '  return \'\'; // MUTATION : la fin de tour ne bloque jamais', rouge('fin de tour : processus'), G, '^caracteres : fin de tour : processus'],
    ['journal', '  // MUTATION : aucun journal', rouge('fin de tour : processus'), G, '^caracteres : fin de tour : processus'],
    ['defaut-illisible', '    valeur = { caracteres: { actif: false } }; // MUTATION : un fichier illisible éteint la garde', rouge('configuration : un gardes.json illisible'), 'lib/gardes-config.js', '^caracteres : configuration : un gardes.json'],
    ['booleen-strict', '  if (typeof valeur === \'boolean\' || valeur === \'non\') return valeur === \'non\' ? false : valeur; // MUTATION : « non » éteint la garde', rouge('configuration : défauts actifs'), 'lib/gardes-config.js', '^caracteres : configuration : défauts'],
  ]);
});
