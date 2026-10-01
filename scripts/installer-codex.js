#!/usr/bin/env node
'use strict';
// Branche les hooks de ce dépôt dans Codex (fichier hooks.json de son dossier de configuration).
//
//   node scripts/installer-codex.js              montre ce qui serait ajouté, n'écrit rien
//   node scripts/installer-codex.js --appliquer  écrit (après une copie de sauvegarde du fichier)
//   node scripts/installer-codex.js --retirer    retire les hooks de ce dépôt, n'écrit rien sans --appliquer
//   --home <dossier>                             dossier de configuration de Codex (défaut : %CODEX_HOME% ou ~/.codex)
//
// Règles : aucun hook existant n'est modifié ni déplacé. Les hooks de ce dépôt sont ajoutés dans des groupes
// NOUVEAUX, à la fin de chaque événement : Codex identifie un hook par « fichier:événement:groupe:rang » et
// garde une approbation par hook, les approbations déjà données restent donc valables. Relancer la commande
// n'ajoute rien deux fois. Après l'ajout, Codex demande d'approuver chaque nouveau hook : tant que ce n'est
// pas fait, il ne les exécute pas.

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const appliquer = args.includes('--appliquer');
const retirer = args.includes('--retirer');
const iHome = args.indexOf('--home');
const home = path.resolve(iHome >= 0 && args[iHome + 1] ? args[iHome + 1] : (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) || path.join(os.homedir(), '.codex'));
const cible = path.join(home, 'hooks.json');
const racine = path.resolve(__dirname, '..').replace(/\\/g, '/');
const modele = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex', 'hooks.modele.json'), 'utf8').split('{{RACINE}}').join(racine));

// Un hook est « de ce dépôt » quand sa commande appelle un script de ce dossier.
const estDeCeDepot = h => typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(racine + '/scripts/');

let brut = '';
let existant = { hooks: {} };
if (fs.existsSync(cible)) {
  brut = fs.readFileSync(cible, 'utf8');
  try { existant = JSON.parse(brut.replace(/^\uFEFF/, '')); } catch (e) {
    process.stderr.write(`hooks.json illisible (${e.message}) : rien n'est modifié. Corrige le fichier ${cible} puis relance.\n`);
    process.exit(2);
  }
  if (!existant || typeof existant !== 'object' || Array.isArray(existant)) { process.stderr.write(`contenu inattendu dans ${cible} : rien n'est modifié.\n`); process.exit(2); }
  if (!existant.hooks || typeof existant.hooks !== 'object') existant.hooks = {};
}

const journal = [];
if (retirer) {
  for (const [evt, groupes] of Object.entries(existant.hooks)) {
    if (!Array.isArray(groupes)) continue;
    const gardes = [];
    for (const g of groupes) {
      const hooks = Array.isArray(g.hooks) ? g.hooks : [];
      const reste = hooks.filter(h => !estDeCeDepot(h));
      for (const h of hooks) if (estDeCeDepot(h)) journal.push(`retiré  ${evt} : ${h.command}`);
      if (reste.length) gardes.push(Object.assign({}, g, { hooks: reste }));
      else if (!hooks.length) gardes.push(g);
    }
    if (gardes.length) existant.hooks[evt] = gardes; else delete existant.hooks[evt];
  }
} else {
  for (const [evt, groupes] of Object.entries(modele.hooks)) {
    const dejaLa = new Set();
    for (const g of (Array.isArray(existant.hooks[evt]) ? existant.hooks[evt] : [])) {
      for (const h of (Array.isArray(g.hooks) ? g.hooks : [])) dejaLa.add(`${g.matcher || ''}|${h.command}`);
    }
    for (const g of groupes) {
      const nouveaux = g.hooks.filter(h => !dejaLa.has(`${g.matcher || ''}|${h.command}`));
      if (!nouveaux.length) continue;
      existant.hooks[evt] = (Array.isArray(existant.hooks[evt]) ? existant.hooks[evt] : []).concat([Object.assign({}, g, { hooks: nouveaux })]);
      for (const h of nouveaux) journal.push(`ajouté  ${evt}${g.matcher ? ` (${g.matcher})` : ''} : ${h.command}`);
    }
  }
}

process.stdout.write(`Fichier : ${cible}\n`);
if (!journal.length) { process.stdout.write(retirer ? 'Aucun hook de ce dépôt à retirer.\n' : 'Tous les hooks de ce dépôt sont déjà en place : rien à faire.\n'); process.exit(0); }
process.stdout.write(journal.join('\n') + '\n');
if (!appliquer) { process.stdout.write(`\nRien n'a été écrit. Relance avec --appliquer pour ${retirer ? 'retirer' : 'ajouter'} ces ${journal.length} hook(s).\n`); process.exit(0); }

fs.mkdirSync(home, { recursive: true });
if (brut) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const sauvegarde = `${cible}.avant-agent-memory-ledger-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  fs.copyFileSync(cible, sauvegarde);
  process.stdout.write(`Sauvegarde : ${sauvegarde}\n`);
}
const tmp = cible + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(existant, null, 2) + '\n');
JSON.parse(fs.readFileSync(tmp, 'utf8'));
fs.renameSync(tmp, cible);
process.stdout.write(retirer
  ? `${journal.length} hook(s) retiré(s).\n`
  : `${journal.length} hook(s) ajouté(s). Ouvre Codex et approuve-les (écran des hooks) : tant qu'ils ne sont pas approuvés, Codex ne les exécute pas.\n`);
