#!/usr/bin/env node
'use strict';
// synchroniser-mods.js : recopie une logique commune (source unique : scripts/lib/<nom>-logique.mjs) dans chaque module d'interface qui
// en embarque une copie (un module ne peut importer que des fichiers de son propre dossier). Par défaut : la logique du Régulateur.
//   node scripts/synchroniser-mods.js [--nom <nom>-logique.mjs] <dossier-module>...              recopie, octet pour octet
//   node scripts/synchroniser-mods.js --verifier [--nom <nom>-logique.mjs] <dossier-module>...   compare sans rien écrire ; code 1 si une copie diffère ou manque
// <dossier-module> contient un dossier hooks/ ; la copie est hooks/<nom>-logique.mjs.
// --nom : une autre logique commune qui existe dans scripts/lib (par exemple quota-logique.mjs, celle du Garde-quota).
const fs = require('node:fs');
const path = require('node:path');

const NOM_DEFAUT = 'regulateur-logique.mjs';

const argv = process.argv.slice(2);
const verifier = argv.includes('--verifier');
const iNom = argv.indexOf('--nom');
const NOM = iNom >= 0 ? argv[iNom + 1] : NOM_DEFAUT;
const SOURCE = path.join(__dirname, 'lib', String(NOM));
const dossiers = argv.filter((a, i) => a !== '--verifier' && !(iNom >= 0 && (i === iNom || i === iNom + 1)));

function erreur(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function principal() {
  if (!/^[a-z][a-z0-9-]*-logique\.mjs$/.test(NOM) || !fs.existsSync(SOURCE)) return erreur(`nom de logique invalide : ${JSON.stringify(NOM)}`);
  if (!dossiers.length) return erreur('au moins un dossier de module est requis');
  for (const d of dossiers) {
    let ok = false;
    try { ok = fs.statSync(path.join(d, 'hooks')).isDirectory(); } catch (_) { /* absent */ }
    if (!ok) return erreur(`${d} : pas un module (pas de dossier hooks)`);
  }
  const source = fs.readFileSync(SOURCE);
  let probleme = false;
  for (const d of dossiers) {
    const cible = path.join(d, 'hooks', NOM);
    if (verifier) {
      if (!fs.existsSync(cible)) { process.stdout.write(`${d} : copie absente\n`); probleme = true; continue; }
      const identique = fs.readFileSync(cible).equals(source);
      process.stdout.write(`${d} : copie ${identique ? 'identique' : 'différente'}\n`);
      if (!identique) probleme = true;
    } else {
      fs.writeFileSync(cible, source);
      process.stdout.write(`${d} : copie mise à jour\n`);
    }
  }
  if (probleme) process.exitCode = 1;
}

principal();
