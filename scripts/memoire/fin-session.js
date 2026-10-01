#!/usr/bin/env node
'use strict';
// Filet de fin de session : si des fichiers ont été modifiés sans commit journalisé (marqueur présent), écrit
// une entrée « wip » signée dans le journal de l'agent et dans le résumé commun, pour que ce travail ne se
// perde pas.
//   node fin-session.js --agent claude|codex [--dry]
//
// À brancher sur SessionEnd. Il peut aussi tourner sur Stop (fin de tour) : une entrée n'est écrite qu'une
// fois par état (même nombre de fichiers, même dernier fichier). Le marqueur reste en place : la session
// suivante affichera l'alerte tant qu'aucun commit n'a documenté le travail. Si le dépôt du dernier fichier
// est propre, le marqueur est périmé : il est retiré et rien n'est écrit.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');

const AGENT = config.agentDepuisArgs(process.argv);
const DRY = process.argv.includes('--dry');

memoire.avecEntree(input => {
  if (!AGENT || input.agent_id || input.agent_type) return;
  const cwd = input.cwd || process.cwd();
  const projet = config.detecterProjet(cwd);
  if (!projet) return;
  const marqueur = memoire.lireMarqueur(projet);
  if (!marqueur) return;
  const nombre = marqueur.count || 0;
  if (!nombre) { if (!DRY) memoire.retirerMarqueur(projet); return; }

  const sonder = d => { try { return memoire.git(['status', '--porcelain'], d).trim(); } catch (_) { return null; } };
  const dossierDernier = marqueur.lastFile ? path.dirname(marqueur.lastFile) : null;
  const premier = dossierDernier && fs.existsSync(dossierDernier) ? sonder(dossierDernier) : null;
  if (premier === '') { if (!DRY) memoire.retirerMarqueur(projet); return; }
  let source = null, statut = premier;
  if (statut) source = dossierDernier;
  else if (fs.existsSync(cwd)) { statut = sonder(cwd); if (statut) source = cwd; }
  const details = ['- Filet de fin de session : travail non commité, à compléter au prochain commit'];
  if (statut && source) {
    let branche = '';
    try { branche = memoire.git(['rev-parse', '--abbrev-ref', 'HEAD'], source).trim(); } catch (_) { branche = ''; }
    if (branche) details.push('- Branche : ' + branche);
    const lignes = statut.split('\n');
    details.push('- Fichiers modifiés (git status) : ' + lignes.slice(0, 8).map(l => l.trim()).join(' ; ') + (lignes.length > 8 ? ' ... +' + (lignes.length - 8) + ' autres' : ''));
  }

  const dernier = marqueur.lastFile ? path.basename(marqueur.lastFile) : '?';
  const titre = `session terminée : ${nombre} fichier(s) modifié(s) NON commité(s) (dernier : ${dernier}), à documenter`;
  const horo = memoire.horodatage();
  const signature = config.SIGNATURES[AGENT];
  const entree = `## ${horo} | wip | ${titre} | ${signature}\n\n${details.join('\n')}\n`;
  const ligne = `- ${horo} | wip | ${titre} | ${signature}`;
  if (DRY) { process.stdout.write('[dry] ' + memoire.fichierHistorique(projet, AGENT) + ' <-\n' + entree + '[dry] résumé <- ' + ligne + '\n'); return; }
  memoire.ajouterAuJournal(projet, AGENT, entree, contenu => contenu.includes(`| wip | ${titre}`));
  memoire.ajouterAuResume(projet, ligne, l => l.includes(`| wip | ${titre}`));
});
