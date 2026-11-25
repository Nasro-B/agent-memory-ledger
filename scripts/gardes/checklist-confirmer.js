#!/usr/bin/env node
'use strict';
// Confirmation du rappel avant commit. À lancer APRÈS avoir réellement fait ou vérifié l'action de chaque
// catégorie sensible détectée dans le diff préparé (migration appliquée, fonction déployée, variable posée, tâche
// planifiée vérifiée...) : jamais avant, jamais par habitude.
//
//   node checklist-confirmer.js --migrations=oui --variables=na [--cwd=<chemin du dépôt>]
//
// Valeurs : oui (fait, vérifié) | na (non applicable, ou déjà prouvé plus tôt) | non (pas fait : le commit reste
// refusé, la réponse documente seulement l'état). Une réponse par catégorie détectée. Sans --cwd, le dépôt est
// celui du dossier courant.
//
// La confirmation vaut pour le diff préparé tel qu'il est maintenant : si l'index change, elle est caduque.
// Lance cette commande SEULE, puis le commit dans une commande séparée.

const gardesConfig = require('../lib/gardes-config.js');
const checklist = require('../lib/checklist-commit.js');

// Rend { code, sortie, erreur } sans rien écrire sur la console (les bancs l'appellent aussi en direct).
function confirmer(argv, cwdDefaut) {
  const sortie = [];
  const erreur = [];
  const cfg = gardesConfig.charger();
  if (cfg.avertissements.length) erreur.push(gardesConfig.dire(cfg));
  const reponses = {};
  let cwd = cwdDefaut;
  const inconnus = [];
  for (const a of argv) {
    const mCwd = /^--cwd=(.+)$/.exec(a);
    if (mCwd) { cwd = mCwd[1]; continue; }
    const m = /^--([a-z][a-z0-9-]*)=(oui|non|na)$/i.exec(a);
    if (m) reponses[m[1].toLowerCase()] = m[2].toLowerCase();
    else inconnus.push(a);
  }
  if (inconnus.length) {
    erreur.push('Argument(s) non reconnu(s) : ' + inconnus.join(' ') + '. Forme attendue : --<categorie>=oui|non|na, et --cwd=<chemin>.');
    return { code: 1, sortie, erreur };
  }
  if (!cfg.checklist.actif) {
    sortie.push('Le rappel avant commit est désactivé (gardes.json, checklist.actif) : rien à confirmer.');
    return { code: 0, sortie, erreur };
  }
  const racine = checklist.racineGit(cwd);
  if (!racine) {
    erreur.push('Pas un dépôt git depuis ' + cwd + ' : rien à confirmer.');
    return { code: 1, sortie, erreur };
  }
  const { touchees, empreinte } = checklist.detecter(racine, cfg.checklist.categories);
  const detectees = cfg.checklist.categories.filter(c => touchees[c.nom]);
  if (!detectees.length) {
    sortie.push('Aucune catégorie sensible dans le diff préparé de ' + racine + ' : rien à confirmer, le rappel ne bloque pas ce commit.');
    return { code: 0, sortie, erreur };
  }
  const connus = new Set(cfg.checklist.categories.map(c => c.nom));
  const inconnues = Object.keys(reponses).filter(n => !connus.has(n));
  if (inconnues.length) { // ancre-mutation:confirmer-inconnues
    erreur.push('Catégorie(s) inconnue(s) : ' + inconnues.join(', ') + '. Catégories connues : ' + [...connus].join(', ') + '.');
    return { code: 1, sortie, erreur };
  }
  const manquantes = detectees.filter(c => !reponses[c.nom]);
  if (manquantes.length) { // ancre-mutation:confirmer-manquantes
    erreur.push('Catégories détectées SANS réponse : ' + manquantes.map(c => c.nom).join(', ') + '. Repasse avec ' + manquantes.map(c => '--' + c.nom + '=oui|non|na').join(' ') + '.');
    return { code: 1, sortie, erreur };
  }
  const donnees = {};
  for (const c of detectees) donnees[c.nom] = reponses[c.nom];
  checklist.ecrireMarqueur(racine, empreinte, donnees);
  sortie.push('Confirmation enregistrée pour ' + racine + ' (empreinte ' + empreinte.slice(0, 12) + '...) :');
  for (const c of detectees) sortie.push('  - ' + c.nom.padEnd(12) + ': ' + donnees[c.nom] + '  (' + c.libelle + ')');
  const restent = detectees.filter(c => donnees[c.nom] === 'non');
  if (restent.length) sortie.push('ATTENTION : ' + restent.map(c => c.nom).join(', ') + ' reste en NON : le commit restera refusé tant que ce n\'est pas oui ou na.');
  else sortie.push('Tout est oui ou na : relance le même commit, dans une commande séparée. Il passera tant que l\'index ne change pas.');
  return { code: 0, sortie, erreur };
}

if (require.main === module) {
  const r = confirmer(process.argv.slice(2), process.cwd());
  for (const l of r.sortie) process.stdout.write(l + '\n');
  for (const l of r.erreur) process.stderr.write(l + '\n');
  process.exitCode = r.code;
}

module.exports = { confirmer };
