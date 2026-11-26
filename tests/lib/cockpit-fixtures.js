'use strict';
// Aides communes aux bancs du Cockpit : liste de travail de banc et dépôt git temporaire.
// Elles n'écrivent que dans les dossiers donnés ou désignés par CONTEXT_LEDGER_DIR (toujours un dossier temporaire).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=banc', '-c', 'user.email=banc@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Écrit .etat/<projet>.<agent>.json dans le ledger de banc, au format du vrai ledger (context-ledger-core.js).
// Une ligne sans `maj` donnée a été modifiée à l'instant : un agent « en cours » ainsi écrit est récent, pas obsolète.
function ecrireEtatLedger(agent, projet, lignes, demandes = {}) {
  const dir = path.join(process.env.CONTEXT_LEDGER_DIR, '.etat');
  fs.mkdirSync(dir, { recursive: true });
  const ts = '2026-03-02T05:00:00.000Z';
  const maintenant = new Date().toISOString();
  const l = {};
  for (const [id, v] of Object.entries(lignes)) l[id] = { texte: v.texte, de: null, date: '2026-03-02 06:00', ts, statut: v.statut, note: v.note || null, preuve: null, citationUtilisateur: null, maj: v.maj || maintenant, session: v.session || 'S1' };
  const d = {};
  for (const [id, v] of Object.entries(demandes)) d[id] = { texte: v.texte, date: '2026-03-02 06:00', ts, session: 'S1', promptId: null, statut: v.statut, lignes: [], raison: null, maj: ts };
  fs.writeFileSync(path.join(dir, `${projet}.${agent}.json`), JSON.stringify({ projet, agent, demandes: d, lignes: l }, null, 2));
}

// Dépôt distant nu, dépôt principal (main) et worktree de travail, comme un dépôt réel, sous le dossier `run`.
function monter(run) {
  const remote = path.join(run, 'remote.git');
  const main = path.join(run, 'main');
  const wt = path.join(run, 'wt');
  fs.mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  git(main, 'init', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', '.'); git(main, 'commit', '-m', 'A');
  git(main, 'remote', 'add', 'origin', remote);
  git(main, 'push', '-u', 'origin', 'main');
  git(main, 'worktree', 'add', '-b', 'travail', wt);
  git(wt, 'push', '-u', 'origin', 'travail');
  return { remote, main, wt, depot: { nom: 'T', chemin: wt } };
}

module.exports = { git, ecrireEtatLedger, monter };
