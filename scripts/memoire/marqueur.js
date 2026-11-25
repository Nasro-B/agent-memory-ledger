#!/usr/bin/env node
'use strict';
// Hook PostToolUse (écriture de fichier) : note qu'un fichier d'un projet vient d'être modifié.
//   node marqueur.js --agent claude|codex
//
// Le marqueur <maison>/etat/.session-pending-<projet> compte les éditions (count) et garde la liste des fichiers
// distincts (files) modifiés depuis le dernier commit journalisé. commit.js le retire ; demarrage.js et
// fin-session.js le lisent pour signaler un travail non documenté. Les fichiers générés (node_modules, .git, dist,
// caches, verrous) ne comptent pas, ni une écriture qui a échoué.

const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');

const AGENT = config.agentDepuisArgs(process.argv);
const IGNORES = /(^|[\\/])(node_modules|\.git|dist|build|\.next|\.cache|coverage)([\\/]|$)|\.lock$|-lock\.(json|yaml)$/i;

// Fichiers écrits par l'appel d'outil. Claude Code : tool_input.file_path. Codex : les chemins du patch.
function fichiers(input) {
  const ti = input.tool_input || {};
  if (AGENT === 'codex') {
    const codex = require('../codex/context-ledger.js');
    const out = [];
    for (const p of codex.analyser(String(input.tool_name || ''), ti).patchs) out.push(...codex.cheminsPatch(p));
    return out;
  }
  const f = ti.file_path || ti.notebook_path;
  return f ? [String(f)] : [];
}

memoire.avecEntree(input => {
  if (!AGENT) return;
  // Une écriture qui a échoué n'a rien modifié : pas de travail à documenter.
  const reponse = input.tool_response;
  if (reponse && typeof reponse === 'object' && (reponse.error || reponse.isError || (Number.isInteger(reponse.exit_code) && reponse.exit_code !== 0))) return; // ancre-mutation:marqueur-echec
  const path = require('path');
  for (const f of fichiers(input)) {
    const absolu = path.isAbsolute(f) ? f : path.resolve(input.cwd || process.cwd(), f);
    if (IGNORES.test(absolu)) continue;
    const projet = config.detecterProjet(absolu);
    if (projet) memoire.toucherMarqueur(projet, absolu);
  }
});
