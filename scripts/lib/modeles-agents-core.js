'use strict';

// Entrées-sorties des règles de modèle des sous-agents : le fichier modeles-agents.json du dossier d'état du Cockpit (COCKPIT_DIR,
// défaut <maison>/cockpit) et la commande `cockpit config modeles`. La logique pure est dans modeles-agents-logique.mjs.
const fs = require('node:fs');
const path = require('node:path');
const { ecrireAtomique, avecVerrou } = require('./transaction.js');
const emplacements = require('./config.js');
const { normaliserRegles, validerModele, validerType } = require('./modeles-agents-logique.mjs');

const USAGE = 'Usage : cockpit config modeles [json | defaut <modele|heritage> | type <nom> <modele|heritage> | retirer <nom>]';

function fichierModeles() {
  const racine = process.env.COCKPIT_DIR?.trim() || path.join(emplacements.maison(), 'cockpit');
  return path.join(path.resolve(racine), 'modeles-agents.json');
}

function lireRegles(fichier = fichierModeles()) {
  let texte;
  try { texte = fs.readFileSync(fichier, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { regles: normaliserRegles(null), erreur: null } : { regles: null, erreur: 'Configuration des modèles illisible.' };
  }
  try {
    const brut = JSON.parse(texte.replace(/^\uFEFF/, ''));
    const regles = brut === null ? null : normaliserRegles(brut);
    return regles === null ? { regles: null, erreur: 'Configuration des modèles invalide.' } : { regles, erreur: null };
  } catch (_) { return { regles: null, erreur: 'Configuration des modèles illisible.' }; }
}

function appliquerCommande(mots, fichier = fichierModeles()) {
  if (!Array.isArray(mots)) return { erreur: USAGE };
  const [action, nom, valeur] = mots;
  if (action === 'json' && mots.length === 1) {
    const lu = lireRegles(fichier);
    return lu.erreur ? { erreur: lu.erreur } : { message: JSON.stringify(lu.regles), regles: lu.regles };
  }
  if (action === 'defaut' && (mots.length !== 2 || (nom !== 'heritage' && !validerModele(nom)))) return { erreur: 'Modèle invalide. ' + USAGE };
  if (action === 'type' && (mots.length !== 3 || !validerType(nom) || (valeur !== 'heritage' && !validerModele(valeur)))) return { erreur: 'Type ou modèle invalide. ' + USAGE };
  if (action === 'retirer' && (mots.length !== 2 || !validerType(nom))) return { erreur: USAGE };
  if (!['defaut', 'type', 'retirer'].includes(action)) return { erreur: USAGE };

  try {
    return avecVerrou(fichier, () => {
      const lu = lireRegles(fichier);
      if (lu.erreur) return { erreur: lu.erreur };
      const regles = lu.regles;
      if (action === 'retirer' && !Object.hasOwn(regles.parType, nom)) return { erreur: `Type ${nom} introuvable.` };
      const suivant = {
        defaut: action === 'defaut' ? (nom === 'heritage' ? null : nom) : regles.defaut,
        parType: { ...regles.parType },
      };
      if (action === 'type') suivant.parType[nom] = valeur === 'heritage' ? null : valeur;
      if (action === 'retirer') delete suivant.parType[nom];
      if (JSON.stringify(suivant) !== JSON.stringify(regles)) ecrireAtomique(fichier, JSON.stringify(suivant, null, 2) + '\n');
      const message = action === 'defaut' ? `Modèle par défaut : ${nom}.` : action === 'type' ? `Modèle pour ${nom} : ${valeur}.` : `Type ${nom} retiré.`;
      return { message, regles: suivant };
    });
  } catch (e) { return { erreur: `Écriture de la politique des modèles impossible : ${e.message}` }; }
}

module.exports = { fichierModeles, lireRegles, appliquerCommande };
