'use strict';
/**
 * Entrées-sorties des Consignes en vigueur : la liste des ordres permanents de l'utilisateur vit dans COCKPIT_DIR/consignes.json, lue
 * par les adaptateurs de Claude Code et de Codex et par le Cockpit. La logique (texte rappelé, refus d'une commande ou d'un agent,
 * commande /consignes) est dans consignes-logique.mjs.
 *
 * Fichier absent : aucune consigne. Fichier illisible (JSON abîmé) : aucune consigne appliquée, un fichier abîmé ne doit pas
 * bloquer le travail, mais la commande refuse d'écrire par-dessus, pour ne rien détruire.
 *
 * API : lireFichier, lireEtat, ecrireEtat, appliquerCommande, texteInjection, texteStatut, decisionCommande, decisionAgent.
 */

const path = require('node:path');
const cockpit = require('./cockpit-core.js');
const logique = require('./consignes-logique.mjs');
const reglages = require('./config-logique.mjs');

const fichier = () => path.join(cockpit.racine(), 'consignes.json');

// { etat, illisible } : illisible n'est vrai que si le fichier existe mais n'est pas du JSON (lecture commune avec le Cockpit).
const lireFichier = () => cockpit.lireConsignes();

const lireEtat = () => lireFichier().etat;

// Ce que les jetons {worktrees} et {plans} des consignes valent maintenant : les réglages du Cockpit (config.json, sinon les défauts).
const valeurs = () => reglages.valeursJetons(cockpit.lireConfig());

function ecrireEtat(etat) {
  cockpit.ecrireJson(fichier(), { ...logique.normaliserEtat(etat), maj: new Date().toISOString() });
}

// `/consignes <args>` : rend { message, etat } ou { erreur }. N'écrit que si la liste change.
function appliquerCommande(args) {
  const { etat, illisible } = lireFichier();
  if (illisible) return { erreur: `${fichier()} est illisible : corrige-le ou supprime-le, puis recommence (rien n'a été écrit).` };
  const r = logique.analyserCommande(args, etat, valeurs());
  if (r.erreur) return { erreur: r.erreur };
  if (JSON.stringify(r.etat) !== JSON.stringify(etat)) {
    try { ecrireEtat(r.etat); } catch (e) { return { erreur: `Écriture impossible dans ${fichier()} (${e && e.message ? e.message : String(e)}) : rien n'a changé.` }; }
  }
  return { message: r.message, etat: r.etat };
}

const texteInjection = () => logique.texteInjection(lireEtat(), valeurs());
const texteStatut = () => logique.texteStatut(lireEtat());
const decisionCommande = commande => logique.decisionCommande(lireEtat(), commande, valeurs());
const decisionAgent = () => logique.decisionAgent(lireEtat(), valeurs());

module.exports = { lireFichier, lireEtat, ecrireEtat, appliquerCommande, texteInjection, texteStatut, decisionCommande, decisionAgent };
