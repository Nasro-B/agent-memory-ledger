#!/usr/bin/env node
'use strict';
// Hook git natif (pre-commit) du rappel avant commit. Il est AGNOSTIQUE : Claude Code, Codex, tout autre agent, ou
// un `git commit` tapé à la main passent tous dessous, puisque c'est git lui-même qui refuse le commit (code 1).
// Les hooks d'agents peuvent laisser passer une commande (délai dépassé, outil non couvert, autre shell) ; celui-ci
// non.
//
// Installation dans un dépôt (voir le README, section « Gardes ») : un fichier `.githooks/pre-commit` qui contient
//
//   #!/bin/sh
//   node "<dossier du plugin>/scripts/gardes/checklist-hook-git.js" || exit 1
//
// puis `git config core.hooksPath .githooks`. Avec husky : la même ligne dans `.husky/pre-commit`. Git lance ses
// hooks depuis la racine de l'arbre de travail.
//
// Sans fichier gardes.json, ou si la catégorie ne concerne pas ce diff, le commit passe. Un réglage illisible ne
// désarme pas le rappel : les valeurs par défaut s'appliquent, et le hook le dit.

const gardesConfig = require('../lib/gardes-config.js');
const checklist = require('../lib/checklist-commit.js');

try {
  const cfg = gardesConfig.charger();
  if (cfg.avertissements.length) console.error(gardesConfig.dire(cfg));
  if (!cfg.checklist.actif) process.exit(0);
  const message = checklist.evaluer(process.cwd(), cfg.checklist.categories);
  if (message) {
    console.error('');
    console.error(message);
    console.error('');
    process.exit(1); // ancre-mutation:hook-refus
  }
  process.exit(0);
} catch (e) {
  console.error('checklist-hook-git.js : le rappel avant commit n\'a pas pu être vérifié (' + (e && e.message ? e.message : String(e)) + '). Commit refusé : corrige la cause puis relance.');
  process.exit(1); // ancre-mutation:hook-panne
}
