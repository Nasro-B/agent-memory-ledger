#!/usr/bin/env node
'use strict';
// Hook SessionStart : remet au modèle la mémoire du projet en cours.
//   node demarrage.js --agent claude|codex
//
// Injecte, par ordre d'importance et sous un plafond de 9 000 caractères :
//   0. l'alerte « session précédente non documentée » (marqueur de travail non commité) ;
//   1. les règles et réflexes du projet (history/<projet>.rules.md, écrit à la main) ;
//   2. les 12 dernières lignes du projet dans le résumé commun (Memory-Auto.md) ;
//   3. le rappel du protocole mémoire ;
//   4. le journal de CET agent, puis ceux des autres agents (25 lignes par fichier).
// Une section trop longue est coupée avec son chemin, une section sans place est nommée : rien ne disparaît
// en silence. Hors projet reconnu (voir ../lib/config.js) : aucune sortie.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');

const AGENT = config.agentDepuisArgs(process.argv);
const PROTOCOLE = path.join(__dirname, '..', '..', 'docs', 'PROTOCOLE-MEMOIRE.md');

memoire.avecEntree(input => {
  if (!AGENT || input.agent_id || input.agent_type) return; // un sous-agent reçoit son contexte de l'orchestrateur
  const cwd = input.cwd || process.cwd();
  const projet = config.detecterProjet(cwd);
  if (!projet) return;
  const c = config.chemins();
  const items = [];

  try {
    const f = path.join(c.history, projet + '.rules.md');
    const corps = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(0, 40).join('\n');
    if (corps) items.push({ prio: 1, path: f, text: '## Règles et réflexes : ' + projet + ' (à appliquer en priorité)\n' + corps });
  } catch (_) { /* pas de fichier de règles */ }

  try {
    const mien = `${projet}.${AGENT}.md`;
    const fichiers = fs.readdirSync(c.history)
      .filter(f => f.endsWith('.md') && f !== projet + '.rules.md' && f.startsWith(projet + '.') && f.slice(projet.length + 1, -3).indexOf('.') === -1)
      .sort((a, b) => (a === mien ? 0 : 1) - (b === mien ? 0 : 1) || a.localeCompare(b));
    for (const f of fichiers) {
      const lignes = fs.readFileSync(path.join(c.history, f), 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(0, 25).join('\n');
      if (lignes) items.push({ prio: f === mien ? 4 : 5, path: path.join(c.history, f), text: '## Historique | ' + f + ' (récent)\n' + lignes });
    }
  } catch (_) { /* pas encore d'historique */ }

  const recentes = memoire.resumeDuProjet(projet, 12);
  if (recentes.length) items.push({ prio: 2, path: c.resume + ' (section ### ' + projet + ')', text: '## Memory-Auto | ' + projet + ' (12 dernières)\n' + recentes.join('\n') });

  items.push({ prio: 3, path: PROTOCOLE,
    text: `## Mémoire partagée entre agents\nProtocole : ${PROTOCOLE}. Journal : ${memoire.fichierHistorique(projet, AGENT)} (une entrée par travail, la plus récente en haut) ; résumé commun : ${c.resume} (une ligne signée par événement). Écrire avant de finir.` });

  const marqueur = memoire.lireMarqueur(projet);
  if (marqueur) {
    const ageMin = Math.round((Date.now() - new Date(marqueur.ts).getTime()) / 60000);
    const age = Number.isFinite(ageMin) ? (ageMin < 60 ? ageMin + ' min' : Math.round(ageMin / 60) + ' h') : '?';
    items.push({ prio: 0, path: memoire.fichierMarqueur(projet), text:
      '## Attention : session précédente non documentée\n' +
      '- ' + (marqueur.count || 0) + ' fichier(s) modifié(s) sans commit (il y a ' + age + ')\n' +
      '- Dernier fichier touché : ' + (marqueur.lastFile || '?') + '\n' +
      '- Si cette session continue ce travail : écris une entrée dans ' + memoire.fichierHistorique(projet, AGENT) + ' avant de clôturer.' });
  }

  items.sort((a, b) => a.prio - b.prio); // affichage dans l'ordre d'importance (tri stable)
  const texte = memoire.assembler(items);
  memoire.injecter(AGENT, 'SessionStart', texte, 'Mémoire ' + projet + ' chargée pour le modèle (' + items.length + ' section(s), ' + texte.length + ' car.)');
});
