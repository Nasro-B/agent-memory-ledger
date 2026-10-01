'use strict';
// Emplacements des données et détection du projet, communs à tous les scripts.
//
// Dossier des données (« maison ») : %AGENT_MEMORY_LEDGER_HOME%, sinon ~/.agent-memory-ledger.
//   contexte/                         liste de travail (fichier contexte), gérée par context-ledger
//   history/<projet>.<agent>.md       journal détaillé, un fichier par agent
//   Memory-Auto.md                    résumé commun à tous les agents, une section « ### <projet> »
//   etat/                             marqueurs de session, points de contrôle, drapeaux
//   projets.json                      (facultatif) table des projets
//
// Projet d'un dossier, dans cet ordre :
//   1. la table projets.json : { "projets": [ { "nom": "mon-projet", "motif": "mon-projet|autre-dossier" } ] }
//      (motif = expression régulière sans casse, appliquée au chemin ; le premier qui correspond gagne) ;
//   2. le nom du dossier racine du dépôt git qui contient le chemin (un worktree compte pour son dépôt) ;
//   3. aucun : les hooks de mémoire ne font rien, la liste de travail range tout dans « _general ».

const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENTS = ['claude', 'codex'];
const SIGNATURES = { claude: 'Claude', codex: 'Codex' };

function maison() {
  const e = process.env.AGENT_MEMORY_LEDGER_HOME;
  return path.resolve(e && e.trim() ? e.trim() : path.join(os.homedir(), '.agent-memory-ledger'));
}

function chemins() {
  const m = maison();
  return {
    maison: m,
    contexte: path.join(m, 'contexte'),
    history: path.join(m, 'history'),
    resume: path.join(m, 'Memory-Auto.md'),
    etat: path.join(m, 'etat'),
    projets: path.join(m, 'projets.json'),
  };
}

// Agent passé sur la ligne de commande du hook (--agent claude|codex). Jamais lu dans le payload.
function agentDepuisArgs(argv, defaut) {
  const i = argv.indexOf('--agent');
  const a = (i >= 0 ? String(argv[i + 1] || '') : String(defaut || '')).toLowerCase();
  return AGENTS.includes(a) ? a : null;
}

// Nom de projet utilisable dans un nom de fichier : lettres, chiffres, « _ », « . », « - ».
function nomSur(n) {
  const s = String(n || '').normalize('NFKD').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  return s && !s.includes('..') ? s : null;
}

let cacheTable = null;
function tableProjets() {
  const f = chemins().projets;
  let mtime = -1;
  try { mtime = fs.statSync(f).mtimeMs; } catch (_) { cacheTable = null; return []; }
  if (cacheTable && cacheTable.f === f && cacheTable.mtime === mtime) return cacheTable.liste;
  const liste = [];
  try {
    const brut = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    for (const p of (brut && Array.isArray(brut.projets) ? brut.projets : [])) {
      const nom = nomSur(p && p.nom);
      if (!nom || !p.motif) continue;
      try { liste.push({ nom, re: new RegExp(String(p.motif), 'i') }); } catch (_) { /* motif invalide : ignoré */ }
    }
  } catch (_) { /* table illisible : comme si elle était vide */ }
  cacheTable = { f, mtime, liste };
  return liste;
}

function sous(dossier, parent) {
  const rel = path.relative(parent, dossier);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Racine du dépôt git qui contient `chemin` (fichier ou dossier), sans lancer git. Un worktree
// (« .git » fichier qui pointe vers <dépôt>/.git/worktrees/<nom>) rend la racine du dépôt principal.
function racineDepot(chemin) {
  let d = path.resolve(String(chemin || ''));
  try { if (fs.statSync(d).isFile()) d = path.dirname(d); } catch (_) { /* chemin pas encore créé : on remonte quand même */ }
  for (let i = 0; i < 40; i++) {
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch (_) { st = null; }
    if (st && st.isDirectory()) return d;
    if (st && st.isFile()) {
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(g, 'utf8'));
        const cible = m ? path.resolve(d, m[1]) : '';
        const w = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(cible);
        return w ? w[1] : d;
      } catch (_) { return d; }
    }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

// Nom du projet pour un chemin (cwd ou fichier), ou null.
function detecterProjet(chemin) {
  const s = String(chemin || '');
  if (!s) return null;
  for (const p of tableProjets()) if (p.re.test(s)) return p.nom;
  const racine = racineDepot(s);
  if (!racine) return null;
  // Ni le dossier des données lui-même, ni un dépôt jetable créé sous le dossier temporaire (bancs, essais) :
  // ils rempliraient la mémoire d'entrées sans valeur.
  let temporaire = os.tmpdir();
  try { temporaire = fs.realpathSync(temporaire); } catch (_) { /* dossier temporaire absent : on garde son chemin */ }
  if (sous(racine, maison()) || sous(racine, temporaire) || sous(racine, os.tmpdir())) return null;
  return nomSur(path.basename(racine));
}

module.exports = { AGENTS, SIGNATURES, maison, chemins, agentDepuisArgs, nomSur, tableProjets, racineDepot, detecterProjet };
