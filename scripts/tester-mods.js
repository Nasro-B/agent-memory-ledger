#!/usr/bin/env node
'use strict';
// tester-mods.js : lance les bancs des modules d'interface de Claude Code (mods/<nom>), l'un après l'autre.
//   node scripts/tester-mods.js [<nom>...]    tous les modules, ou seulement ceux nommés
// Deux sortes de bancs :
//   - les bancs de Node seul (mods/<nom>/tests/*.test.mjs) : aucun moteur nécessaire ;
//   - les bancs du moteur (mods/<nom>/tests/*.test.ts), lancés par `claude plugin test mods/<nom>` : le moteur de Claude Code les exécute dans un
//     environnement qui ressemble à celui des hooks du module. Le programme `claude` est celui de la variable AML_MOTEUR_CLAUDE, sinon la
//     commande `claude` du chemin d'exécution (scripts/lib/moteur-claude.js). Il n'entre PAS dans `npm test`, qui reste jouable avec Node seul.
// Code de sortie : 0 si tout est vert, 1 si un banc échoue, 2 si le moteur est introuvable (dit clairement, avec quoi faire) ou si un nom est inconnu.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { trouverMoteur } = require('./lib/moteur-claude.js');

const RACINE = path.join(__dirname, '..');
const MODS = path.join(RACINE, 'mods');
const ORDRE = ['consignes', 'garde-quota', 'regulateur', 'pause', 'nuit', 'cockpit'];

const demandes = process.argv.slice(2);
const existants = fs.existsSync(MODS) ? fs.readdirSync(MODS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
const connus = [...ORDRE.filter(n => existants.includes(n)), ...existants.filter(n => !ORDRE.includes(n)).sort()];
const inconnus = demandes.filter(n => !connus.includes(n));
if (inconnus.length) {
  process.stderr.write(`module inconnu : ${inconnus.join(', ')} (modules : ${connus.join(', ') || 'aucun'})\n`);
  process.exit(2);
}
const modules = demandes.length ? connus.filter(n => demandes.includes(n)) : connus;
if (!modules.length) {
  process.stderr.write('aucun module dans mods/\n');
  process.exit(2);
}

let code = 0;
const resume = [];

// 1. Node seul.
const bancsNode = modules.flatMap(nom => {
  const dossier = path.join(MODS, nom, 'tests');
  return fs.existsSync(dossier) ? fs.readdirSync(dossier).filter(f => /\.test\.mjs$/.test(f)).map(f => path.join(dossier, f)) : [];
});
if (bancsNode.length) {
  process.stdout.write(`== bancs de Node : ${bancsNode.length} fichier(s)\n`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...bancsNode], { stdio: 'inherit', windowsHide: true });
  resume.push(`${r.status === 0 ? 'vert' : 'ROUGE'}  bancs de Node`);
  if (r.status !== 0) code = 1;
}

// 2. Le moteur de Claude Code, un module après l'autre.
const trouve = trouverMoteur();
if (trouve.erreur) {
  process.stderr.write(`${trouve.erreur}\n`);
  process.stderr.write('Les bancs des modules passent par `claude plugin test` : ils n\'ont pas été lancés.\n');
  process.exit(2);
}
for (const nom of modules) {
  process.stdout.write(`== ${nom} : ${trouve.moteur} plugin test mods/${nom}\n`);
  const r = spawnSync(trouve.moteur, ['plugin', 'test', path.join(MODS, nom)], { stdio: 'inherit', windowsHide: true });
  resume.push(`${r.status === 0 ? 'vert' : 'ROUGE'}  ${nom}`);
  if (r.status !== 0) code = 1;
}
process.stdout.write(`\n${resume.join('\n')}\n`);
process.exit(code);
