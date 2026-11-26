'use strict';
// Lecture native du quota de Codex : le serveur d'application de Codex (`codex app-server`, protocole JSON par lignes sur son entrée et sa
// sortie standard) répond à account/rateLimits/read. Le résultat est une mesure { fenetres, source: 'app-server', sourceAt, limitId } ou null
// (binaire introuvable, délai dépassé, réponse d'une autre limite : jamais un faux zéro). Lancé par quota-core.js (rafraichirNatif) :
//   node quota-native.cjs codex      écrit la mesure en JSON sur la sortie standard, ou null
//
// Où chercher (rien n'est supposé de la machine) :
//   le binaire : la variable AML_CODEX_BINAIRE (chemin du binaire ; si elle est donnée et que le fichier n'existe pas, rien n'est lu),
//                sinon le premier « codex » du PATH (« codex.exe » sous Windows : un lanceur .cmd ne se démarre pas sans shell) ;
//   le dossier de configuration de Codex : CODEX_HOME, sinon ~/.codex (comme scripts/installer-codex.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const logique = require('./quota-logique.mjs');

const estFichier = chemin => { try { return fs.statSync(chemin).isFile(); } catch (_) { return false; } };
const estExecutable = chemin => {
  if (!estFichier(chemin)) return false;
  if (process.platform === 'win32') return true;
  try { fs.accessSync(chemin, fs.constants.X_OK); return true; } catch (_) { return false; }
};

// Le chemin du binaire de Codex, ou null.
function trouverBinaire(env) {
  const donne = typeof env.AML_CODEX_BINAIRE === 'string' ? env.AML_CODEX_BINAIRE.trim() : '';
  if (donne !== '') return estExecutable(donne) ? path.resolve(donne) : null;
  const nom = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dossier of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dossier === '') continue;
    const candidat = path.join(dossier, nom);
    if (estExecutable(candidat)) return candidat;
  }
  return null;
}

// { binary, home } pour l'agent codex (le seul qui ait une lecture native), ou null quand le binaire est introuvable.
function runtime(agent, env = process.env) {
  if (agent !== 'codex') return null;
  const binary = trouverBinaire(env);
  if (binary === null) return null;
  const donne = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== '';
  return { binary, home: donne ? path.resolve(env.CODEX_HOME.trim()) : path.join(os.homedir(), '.codex') };
}

function lire({ binary, home, timeoutMs = 2500, args = ['app-server', '--listen', 'stdio://'] }) {
  return new Promise(resolve => {
    let child, pending = '', result = null, done = false;
    const finish = value => {
      if (done) return;
      done = true; result = value; clearTimeout(timer);
      child.stdin.end();
      child.kill();
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawn(binary, args, { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (_) { clearTimeout(timer); resolve(null); return; }
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => finish(null));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(result); });
    child.stdout.on('data', chunk => {
      if (done) return;
      pending += chunk.toString();
      if (pending.length > 65536) { finish(null); return; }
      let boundary;
      while (!done && (boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        if (message.id === 1) {
          if (message.error) { finish(null); return; }
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2) {
          const response = message.result || {};
          const limits = response.rateLimitsByLimitId?.codex || response.rateLimits;
          if (message.error || !limits || (limits.limitId && limits.limitId !== 'codex')) { finish(null); return; }
          const window = value => value && ({ used_percent: value.usedPercent, window_minutes: value.windowDurationMins, resets_at: value.resetsAt });
          const fenetres = logique.normaliserFenetresCodex({ primary: window(limits.primary), secondary: window(limits.secondary) });
          finish(fenetres.length ? { fenetres, source: 'app-server', sourceAt: new Date().toISOString(), limitId: limits.limitId || 'codex' } : null);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-memory-ledger-quota', version: '1.0' }, capabilities: { experimentalApi: true } } });
  });
}

module.exports = { runtime, lire };
if (require.main === module) {
  const selected = runtime(process.argv[2]);
  (selected ? lire(selected) : Promise.resolve(null)).then(value => process.stdout.write(JSON.stringify(value))).catch(() => process.stdout.write('null'));
}
