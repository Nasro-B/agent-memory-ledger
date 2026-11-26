#!/usr/bin/env node
'use strict';
// Ligne de commande du Cockpit (noyau : lib/cockpit-core.js). Ne modifie ni dépôt, ni plan, ni liste de travail : les commandes qui écrivent
// (config, politique, quota, consignes, nuit, pause, reprendre) n'écrivent que les fichiers d'état du Cockpit (COCKPIT_DIR).
//   node scripts/cockpit.js ligne                  une ligne d'état
//   node scripts/cockpit.js instantane [--json]    l'état complet (ligne, ou JSON avec --json)
//   node scripts/cockpit.js rafraichir-git         mesure git des worktrees (peut être long), écrit git-etat.json
//   node scripts/cockpit.js politique [args]       Régulateur d'agents : comme /plafond (N, libre, pause, reprendre, relance on|off)
//   node scripts/cockpit.js quota [args]           Garde-quota : comme /quota (<attention> <critique>, bloquer|consigne|son on|off, defaut)
//   node scripts/cockpit.js config [args]          Réglages : worktrees mesurés et dossier des plans (afficher, worktree ajouter|retirer, plans <dossier>, defaut)
//   node scripts/cockpit.js config modeles [args]  Modèle imposé aux sous-agents (json, defaut <modele|heritage>, type <nom> <modele|heritage>, retirer <nom>)
//   node scripts/cockpit.js consignes [args]       Consignes en vigueur : comme /consignes (liste, ajouter <texte>, retirer|pause|reprendre <n>, verrou <n> <règle>)
//   node scripts/cockpit.js nuit [args]            Nuit : comme /nuit (on, off, statut, recap, boite, absence, tours, repondre, ecarter, defaut) ;
//                                                  --agent <agent> (claude par défaut) et --session <conversation> (pour compter ses lignes ouvertes)
//   node scripts/cockpit.js nuit-hook <opération>  Nuit, pour les hooks : lit un JSON sur l'entrée standard, rend un JSON sur une ligne
//                                                  (opérations : question, garde, continuer, activite ; une erreur est rendue en JSON, code 0)
//   node scripts/cockpit.js pause [--session <id ou titre>] [args]      Pause : comme /pause (tout, session [id], agent <nom>, agents, statut) ;
//                                                  la ligne de commande n'a pas de session courante : la désigner avec --session, ou dire « tout »
//   node scripts/cockpit.js reprendre [--session <id ou titre>] [args]  Pause : comme /reprendre
//   node scripts/cockpit.js pause-hook <opération> Pause, pour les hooks : lit un JSON sur l'entrée standard, rend un JSON sur une ligne
//                                                  (opérations : battre, commande, attendre ; une erreur est rendue en JSON, code 0)
const fs = require('node:fs');
const core = require('./lib/cockpit-core.js');
const regulateur = require('./lib/regulateur-core.js');
const quota = require('./lib/quota-core.js');
const consignes = require('./lib/consignes-core.js');
const nuit = require('./lib/nuit-core.js');
const pauseCore = require('./lib/pause-core.js');
const modelesAgents = require('./lib/modeles-agents-core.js');

const [, , commande, ...options] = process.argv;
const accord = (n, un, plusieurs) => `${n} ${n === 1 ? un : plusieurs}`;

// Retire `nom <valeur>` des mots, où qu'il soit : { present, valeur, mots }.
function extraireOption(mots, nom) {
  const i = mots.indexOf(nom);
  if (i < 0) return { present: false, valeur: undefined, mots };
  return { present: true, valeur: mots[i + 1], mots: [...mots.slice(0, i), ...mots.slice(i + 2)] };
}

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
    case 'politique': {
      const r = regulateur.appliquerCommande(options.join(' '));
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n`);
      break;
    }
    case 'quota': {
      const r = quota.appliquerCommande(options.join(' '));
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n`);
      break;
    }
    case 'config': {
      const r = options[0] === 'modeles' ? modelesAgents.appliquerCommande(options.slice(1)) : core.appliquerConfig(options.join(' '));
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n`);
      break;
    }
    case 'consignes': {
      const r = consignes.appliquerCommande(options.join(' '));
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n`);
      break;
    }
    case 'nuit': {
      const choixAgent = extraireOption(options, '--agent');
      const choixSession = extraireOption(choixAgent.mots, '--session');
      const agent = choixAgent.present ? choixAgent.valeur : 'claude';
      if (!nuit.agentValide(agent)) { process.stderr.write(`Agent invalide : ${agent === undefined ? '(aucun)' : agent}\n`); process.exitCode = 2; break; }
      const r = nuit.appliquerCommande(choixSession.mots.join(' '), { agent, session: choixSession.valeur });
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n${r.prompt === undefined ? '' : `Texte à donner à l'agent : ${r.prompt}\n`}`);
      break;
    }
    case 'nuit-hook': {
      let entree;
      try { entree = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { entree = undefined; }
      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : nuit.executerHook(options[0], entree))}\n`);
      break;
    }
    case 'pause':
    case 'reprendre': {
      const choix = extraireOption(options, '--session');
      const r = pauseCore.appliquerCommande(commande, choix.mots.join(' '), { sessionRef: choix.present ? (choix.valeur ?? '') : undefined });
      if (r.erreur) { process.stderr.write(`${r.erreur}\n`); process.exitCode = 2; } else process.stdout.write(`${r.message}\n`);
      break;
    }
    case 'pause-hook': {
      let entree;
      try { entree = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { entree = undefined; }
      process.stdout.write(`${JSON.stringify(entree === undefined ? { erreur: 'entrée illisible' } : await pauseCore.executerHook(options[0], entree))}\n`);
      break;
    }
    default:
      process.stderr.write(`commande inconnue : ${commande || '(aucune)'} (attendu : ligne, instantane [--json], rafraichir-git, politique, quota, config, consignes, nuit, nuit-hook, pause, reprendre, pause-hook)\n`);
      process.exitCode = 2;
  }
}

main().catch(e => { process.stderr.write(`${(e && e.message) || e}\n`); process.exitCode = 1; });
