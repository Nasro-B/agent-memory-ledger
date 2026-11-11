#!/usr/bin/env node
'use strict';
// Hooks Stop et PostToolUse : point de contrôle automatique. Toutes les deux heures de travail sur un projet,
// écrit dans le journal de l'agent l'état factuel du dépôt (branche, dernier commit, fichiers modifiés).
//   node checkpoint.js --agent claude|codex|deepseek_H
// Après un outil aussi (au seul Stop, un tour de dix heures n'avait aucun point de contrôle) : jamais pour un
// sous-agent, jamais de sortie. Le compteur est par projet et par agent, stable entre les sessions : avec
// plusieurs sessions sur un projet, le test de session relançait la fenêtre sans fin. Hors dépôt git, rien
// n'est écrit (une entrée « état git indisponible » n'apprend rien) et la fenêtre repart.
//
// Ne bloque jamais le tour et ne demande aucune rédaction : seuls les faits lisibles dans git sont écrits.
// Pour Claude Code, un message court invite à noter une décision ou un piège qui ne se voit pas dans git.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');

const AGENT = config.agentDepuisArgs(process.argv);
const INTERVALLE_MS = 2 * 60 * 60 * 1000;

memoire.avecEntree(input => {
  if (!AGENT || input.agent_id || input.agent_type) return;
  const cwd = input.cwd || process.cwd();
  const projet = config.detecterProjet(cwd);
  if (!projet) return;
  const session = String(input.session_id || '');
  const f = path.join(config.chemins().etat, `.checkpoint-${projet}-${AGENT}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const noter = () => fs.writeFileSync(f, JSON.stringify({ ts: new Date().toISOString(), sessionId: session }));

  let dernier = null;
  try { dernier = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { dernier = null; }
  const avant = dernier && dernier.ts ? new Date(dernier.ts).getTime() : NaN;
  // Première fois ou date illisible : la fenêtre de deux heures démarre, en silence.
  if (!dernier || Number.isNaN(avant)) { noter(); return; }
  const age = Date.now() - avant;
  if (age < INTERVALLE_MS) return;

  const etat = memoire.etatGit(cwd);
  if (!etat) { noter(); return; } // ancre-mutation:checkpoint-sans-git
  const p2 = n => String(n).padStart(2, '0');
  const duree = `${Math.floor(age / 3600000)}h${p2(Math.round((age % 3600000) / 60000))}`;
  const ligne = `[${etat.branche}] ${etat.dernier} : ${etat.sale} modifié(s), ${etat.nonSuivis} non suivi(s)`;
  const entree = `## ${memoire.horodatage()} | checkpoint | Point de contrôle automatique (${duree}) | ${config.SIGNATURES[AGENT]}\n\n- ${ligne}\n`;
  memoire.ajouterAuJournal(projet, AGENT, entree);
  noter();
  if (AGENT === 'claude' && String(input.hook_event_name || '') !== 'PostToolUse') {
    process.stdout.write(JSON.stringify({
      systemMessage: 'Point de contrôle écrit (' + projet + ' : ' + memoire.fichierHistorique(projet, AGENT) + '). Si une décision, un piège ou un fait durable est né depuis et ne se voit pas dans git, ajoute une ligne courte ; sinon continue.',
    }));
  }
});
