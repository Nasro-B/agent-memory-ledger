'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
// Bancs de la lecture native du quota de Codex (scripts/lib/quota-native.cjs) : un faux serveur d'application tient la place de Codex,
// aucun vrai binaire n'est lancé et la vraie configuration de Codex n'est jamais lue.
// Variable interne (preuves par mutation) : QUOTA_NATIVE_TESTE = module à tester (défaut : ../scripts/lib/quota-native.cjs)
const native = require(process.env.QUOTA_NATIVE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'quota-native.cjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-native-banc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const server = path.join(root, 'server.cjs');
fs.writeFileSync(server, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') return process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fixture' } }) + '\\n');
  if (request.method !== 'account/rateLimits/read') process.exit(3);
  if (process.argv[2] === 'timeout') return;
  if (process.argv[2] === 'error') return process.stdout.write(JSON.stringify({ id: 2, error: { code: -1, message: 'unavailable fixture' } }) + '\\n');
  const codex = { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: process.env.CODEX_HOME.endsWith('autre') ? 23 : 49, windowDurationMins: 10080, resetsAt: 1773000000 }, secondary: null, credits: null, planType: 'pro' };
  const other = { limitId: 'fixture-other', limitName: 'Fixture', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1773000000 }, secondary: null, credits: null, planType: 'pro' };
  process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: other, rateLimitsByLimitId: process.argv[2] === 'other-only' ? { 'fixture-other': other } : { codex, 'fixture-other': other } } }) + '\\n');
});
`);
const read = (home, mode = '') => native.lire({ binary: process.execPath, home, args: [server, mode], timeoutMs: mode === 'timeout' ? 200 : 2000 });

// Deux dossiers de configuration de Codex pour le faux serveur (il répond selon le dossier qu'il reçoit dans CODEX_HOME).
const HOME_CODEX = path.join(root, 'fixture', 'codex');
const HOME_AUTRE = path.join(root, 'fixture', 'autre');

// Où se trouvent le binaire de Codex et son dossier : rien n'est supposé de la machine (variables AML_CODEX_BINAIRE, PATH, CODEX_HOME).
const faux = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
const autre = path.join(root, process.platform === 'win32' ? 'autre.exe' : 'autre');
for (const f of [faux, autre]) { fs.writeFileSync(f, ''); fs.chmodSync(f, 0o755); }
const home = path.join(root, 'dossier-codex');
const homeParDefaut = path.join(os.homedir(), '.codex');

test('runtime : seul l agent codex a une lecture native', () => {
  for (const agent of ['claude', 'deepseek_H', 'deepseek-h', 'codex-autre', 'Codex', undefined, null, 5]) assert.equal(native.runtime(agent, { PATH: root }), null, String(agent));
  assert.deepEqual(native.runtime('codex', { PATH: root, CODEX_HOME: home }), { binary: faux, home: path.resolve(home) });
});

test('runtime : le binaire vient de AML_CODEX_BINAIRE, qui prime sur le PATH ; donné mais absent, rien n est lu', () => {
  assert.deepEqual(native.runtime('codex', { AML_CODEX_BINAIRE: autre, PATH: root }), { binary: path.resolve(autre), home: homeParDefaut });
  assert.equal(native.runtime('codex', { AML_CODEX_BINAIRE: path.join(root, 'absent'), PATH: root }), null, 'pas de repli sur le PATH quand la variable est donnée');
  assert.equal(native.runtime('codex', { AML_CODEX_BINAIRE: root, PATH: root }), null, 'un dossier n est pas un binaire');
  assert.equal(native.runtime('codex', { AML_CODEX_BINAIRE: `  ${faux}  `, PATH: '' }).binary, path.resolve(faux), 'les blancs autour de la valeur sont ignorés');
  assert.equal(native.runtime('codex', { AML_CODEX_BINAIRE: '   ', PATH: root }).binary, faux, 'une valeur blanche n est pas une valeur');
  assert.equal(native.runtime('codex', { AML_CODEX_BINAIRE: path.relative(process.cwd(), autre), PATH: '' }).binary, path.resolve(autre), 'un chemin relatif est résolu depuis le dossier courant');
});

test('runtime : sans variable, le premier codex du PATH ; sans rien, aucun binaire', () => {
  const vide = path.join(root, 'vide');
  fs.mkdirSync(vide, { recursive: true });
  const dossierNomme = path.join(root, 'faux-dossier');
  fs.mkdirSync(path.join(dossierNomme, process.platform === 'win32' ? 'codex.exe' : 'codex'), { recursive: true });
  assert.equal(native.runtime('codex', { PATH: [vide, root].join(path.delimiter) }).binary, faux, 'le PATH est parcouru dossier par dossier');
  assert.equal(native.runtime('codex', { PATH: ['', vide, root].join(path.delimiter) }).binary, faux, 'un élément vide est sauté');
  assert.equal(native.runtime('codex', { PATH: [dossierNomme, root].join(path.delimiter) }).binary, faux, 'un dossier nommé codex n est pas un binaire');
  assert.equal(native.runtime('codex', { PATH: vide }), null);
  assert.equal(native.runtime('codex', { PATH: '' }), null);
  assert.equal(native.runtime('codex', {}), null);
  assert.equal(native.runtime('codex', { PATH: path.join(root, 'absent') }), null);
  if (process.platform !== 'win32') {
    const sansDroit = path.join(root, 'sans-droit');
    fs.mkdirSync(sansDroit, { recursive: true });
    fs.writeFileSync(path.join(sansDroit, 'codex'), '');
    fs.chmodSync(path.join(sansDroit, 'codex'), 0o644);
    assert.equal(native.runtime('codex', { PATH: sansDroit }), null, 'un fichier non exécutable n est pas un binaire');
  }
});

test('runtime : le dossier de Codex vient de CODEX_HOME, sinon de ~/.codex ; la variable PATH s écrit aussi Path', () => {
  assert.equal(native.runtime('codex', { PATH: root, CODEX_HOME: home }).home, path.resolve(home));
  assert.equal(native.runtime('codex', { PATH: root, CODEX_HOME: `  ${home}  ` }).home, path.resolve(home));
  assert.equal(native.runtime('codex', { PATH: root, CODEX_HOME: '  ' }).home, homeParDefaut);
  assert.equal(native.runtime('codex', { PATH: root }).home, homeParDefaut);
  assert.equal(native.runtime('codex', { Path: root }).binary, faux);
});

test('runtime : sans environnement donné, c est celui du processus', () => {
  const avant = { binaire: process.env.AML_CODEX_BINAIRE, home: process.env.CODEX_HOME };
  process.env.AML_CODEX_BINAIRE = autre;
  process.env.CODEX_HOME = home;
  try { assert.deepEqual(native.runtime('codex'), { binary: path.resolve(autre), home: path.resolve(home) }); } finally {
    if (avant.binaire === undefined) delete process.env.AML_CODEX_BINAIRE; else process.env.AML_CODEX_BINAIRE = avant.binaire;
    if (avant.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = avant.home;
  }
});

test('quota natif : selection codex et absence de fenetre secondaire, pas zero invente', async () => {
  const value = await read(HOME_CODEX);
  assert.deepEqual(value.fenetres, [{ nom: '7 j', pct: 49, resetsAt: new Date(1773000000 * 1000).toISOString() }]);
  assert.equal(value.limitId, 'codex');
  assert.equal(value.source, 'app-server');
  assert.ok(Number.isFinite(Date.parse(value.sourceAt)));
});
test('quota natif : chaque requete utilise son home sans modifier le parent', async () => {
  const before = process.env.CODEX_HOME;
  assert.equal((await read(HOME_AUTRE)).fenetres[0].pct, 23);
  assert.equal((await read(HOME_CODEX)).fenetres[0].pct, 49);
  assert.equal(process.env.CODEX_HOME, before);
});
test('quota natif : une autre limite seule ne devient pas le quota Codex', async () => {
  assert.equal(await read(HOME_CODEX, 'other-only'), null);
});
test('quota natif : panne ou delai depasse rendent inconnu, jamais un faux zero', async () => {
  assert.equal(await read(HOME_AUTRE, 'error'), null);
  const start = Date.now();
  assert.equal(await read(HOME_AUTRE, 'timeout'), null);
  assert.ok(Date.now() - start < 2000);
});
