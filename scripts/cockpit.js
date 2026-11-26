#!/usr/bin/env node
'use strict';
// Ligne de commande du Cockpit (noyau : lib/cockpit-core.js). Ne modifie ni dépôt, ni plan, ni liste de travail.
// Cette version porte les commandes que servent le noyau du Cockpit et celui des modèles par agent ; les autres commandes
// (politique, quota, consignes, nuit, nuit-hook, pause, reprendre, pause-hook) viennent avec leurs noyaux.
//   node scripts/cockpit.js ligne                  une ligne d'état
//   node scripts/cockpit.js instantane [--json]    l'état complet (ligne, ou JSON avec --json)
//   node scripts/cockpit.js rafraichir-git         mesure git des worktrees (peut être long), écrit git-etat.json
//   node scripts/cockpit.js config [args]          Réglages : worktrees mesurés et dossier des plans (afficher, worktree ajouter|retirer, plans <dossier>, defaut)
//   node scripts/cockpit.js config modeles [args]  Modèle imposé aux sous-agents (json, defaut <modele|heritage>, type <nom> <modele|heritage>, retirer <nom>)
const core = require('./lib/cockpit-core.js');
const modelesAgents = require('./lib/modeles-agents-core.js');

const [, , commande, ...options] = process.argv;
const accord = (n, un, plusieurs) => `${n} ${n === 1 ? un : plusieurs}`;

async function main() {
  switch (commande) {
    case 'ligne':
      process.stdout.write(`${core.ligneCockpit(core.instantane())}\n`);
      break;
    case 'instantane': {
      const s = core.instantane();
      const ligne = core.ligneCockpit(s);
      process.stdout.write(`${options.includes('--json') ? JSON.stringify({ ...s, ligne }, null, 2) : ligne}\n`);
      break;
    }
    case 'rafraichir-git': {
      const r = await core.rafraichirGit();
      process.stdout.write(r.ignore ? 'git : verrou actif, rien fait\n' : `git : ${accord(r.depots.length, 'dépôt mesuré', 'dépôts mesurés')}\n`);
      break;
    }
    case 'config': {
      const r = options[0] === 'modeles' ? modelesAgents.appliquerCommande(options.slice(1)) : core.appliquerConfig(options.join(' '));
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n`);
      break;
    }
    default:
      process.stderr.write(`commande inconnue : ${commande || '(aucune)'} (attendu : ligne, instantane [--json], rafraichir-git, config)\n`);
      process.exitCode = 2;
  }
}

main().catch(e => { process.stderr.write(`${(e && e.message) || e}\n`); process.exitCode = 1; });
