#!/usr/bin/env node
'use strict';
// Hook PreCompact : sauve l'état du disque AVANT que le contexte soit résumé.
//   node avant-compactage.js --agent claude|codex [--dry]
//
// Un compactage garde les faits saillants de la conversation, pas l'état de travail. Ce hook écrit dans le
// journal de l'agent ce que le résumé perd : pour le dépôt en cours et ses worktrees, la branche, le dernier
// commit, le nombre de fichiers modifiés et non suivis, les commits non poussés. Le rappel d'après compactage
// (rappel.js) le retrouvera.
//
// Le dépôt du dossier courant est toujours inspecté ; les autres worktrees le sont dans la limite d'un budget
// de temps (un dépôt à cinquante worktrees prenait près d'une minute sans cette limite), et ceux qui restent
// sont comptés, jamais passés sous silence. Aucune erreur ne bloque le compactage.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');

const AGENT = config.agentDepuisArgs(process.argv);
const DRY = process.argv.includes('--dry');
const BUDGET_MS = 1500;

// Le dossier courant d'abord, puis ses worktrees (un seul appel git).
function depots(cwd) {
  const vus = new Set();
  const liste = [];
  const ajouter = p => {
    if (!p) return;
    let canonique;
    try { canonique = fs.realpathSync.native(p); } catch (_) { canonique = path.resolve(p); }
    canonique = path.normalize(canonique);
    if (process.platform === 'win32') canonique = canonique.toLowerCase();
    if (vus.has(canonique)) return;
    vus.add(canonique);
    liste.push(p);
  };
  ajouter(cwd);
  try {
    for (const ligne of memoire.git(['worktree', 'list', '--porcelain'], cwd).split('\n')) {
      if (ligne.startsWith('worktree ')) ajouter(ligne.slice(9).trim());
    }
  } catch (_) { /* pas un dépôt, ou git absent : le dossier courant seul */ }
  return liste;
}

memoire.avecEntree(input => {
  if (!AGENT || input.agent_id || input.agent_type) return;
  const cwd = input.cwd || process.cwd();
  const projet = config.detecterProjet(cwd);
  if (!projet) return;

  const tous = depots(cwd);
  const lignes = [];
  let inspectes = 0;
  const debut = Date.now();
  for (let i = 0; i < tous.length; i++) {
    if (i > 0 && Date.now() - debut > BUDGET_MS) break;
    const e = memoire.etatGit(tous[i]);
    inspectes++;
    if (!e) continue;
    const enVol = e.sale > 0 || e.nonSuivis > 0 ? `${e.sale} modifié(s), ${e.nonSuivis} non suivi(s)` : 'arbre propre';
    lignes.push(`- **${e.nom}** [${e.branche}] : ${enVol}${e.avance}`);
    lignes.push(`  dernier commit : ${e.dernier}`);
  }
  const ignores = tous.length - inspectes;
  if (ignores > 0) lignes.push(`- (${ignores} autre(s) worktree(s) non inspecté(s), budget de temps dépassé ; ${tous.length} au total)`);
  if (!lignes.length) return;

  const cause = input.trigger === 'manual' ? 'demandé' : 'automatique';
  const entree = `## ${memoire.horodatage()} | precompact | État sauvé avant compactage ${cause} | ${config.SIGNATURES[AGENT]}\n\n` +
    '- Écrit juste avant que le contexte soit résumé : l\'état du disque à cet instant.\n' + lignes.join('\n') + '\n';
  if (DRY) { process.stdout.write('[dry] ' + memoire.fichierHistorique(projet, AGENT) + ' <-\n' + entree); return; }
  memoire.ajouterAuJournal(projet, AGENT, entree);
});
