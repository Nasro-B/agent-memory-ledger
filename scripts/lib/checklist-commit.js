'use strict';
// Rappel avant commit : un commit dont le diff PRÉPARÉ touche une catégorie sensible (migrations de base,
// fonctions déployées à part, nouvelle variable d'environnement, tâche planifiée... les catégories se règlent dans
// gardes.json) est refusé tant que l'agent n'a pas confirmé, catégorie par catégorie, que l'action réelle
// correspondante est faite, pour CE diff exact.
//
// Trois réponses par catégorie : `oui` (fait, vérifié), `na` (non applicable, ou déjà prouvé plus tôt) et `non`
// (pas fait). Seuls `oui` et `na` débloquent ; `non` documente l'état sans rien débloquer.
//
// La confirmation est liée à l'empreinte du diff préparé (liste des fichiers et texte du diff) : toute
// modification de l'index la rend caduque. Elle est écrite dans le dossier git du dépôt concerné (un worktree a le
// sien), jamais dans l'arbre de travail.
//
// Ce module est partagé par la garde de commandes (scripts/gardes/securite.js, qui refuse le commit d'un agent),
// la commande de confirmation (scripts/gardes/checklist-confirmer.js) et le hook git natif
// (scripts/gardes/checklist-hook-git.js, qui refuse le commit quel que soit l'outil qui le lance). Tous
// calculent la même empreinte sur le même diff, sinon la confirmation ne correspondrait jamais.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const transaction = require('./transaction.js');

const NOM_MARQUEUR = 'agent-memory-ledger-checklist.json';
const REPONSES = ['oui', 'non', 'na'];
const DEBLOQUANTES = ['oui', 'na'];
const SCRIPT_CONFIRMER = path.join(__dirname, '..', 'gardes', 'checklist-confirmer.js').replace(/\\/g, '/');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Racine de l'arbre de travail du dépôt qui contient `cwd`, ou null (pas un dépôt, ou git absent : l'appelant
// laisse alors passer, il n'y a pas de commit à contrôler).
function racineGit(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).trim().replace(/\//g, path.sep);
  } catch (_) {
    return null;
  }
}

// Un worktree a un « .git » qui est un FICHIER pointeur : `git rev-parse --git-dir` donne le vrai dossier dans les
// deux cas, parfois en chemin relatif, d'où la résolution depuis la racine.
function dossierGit(racine) {
  try {
    return path.resolve(racine, git(['rev-parse', '--git-dir'], racine).trim());
  } catch (_) {
    return null;
  }
}

function cheminMarqueur(racine) {
  return path.join(dossierGit(racine) || path.join(racine, '.git'), NOM_MARQUEUR);
}

// Catégories touchées par le diff préparé, et empreinte de ce diff. `categories` : voir gardes-config.js
// ({ nom, fichiers, contenu, libelle, question }, motifs déjà compilés). Une catégorie est touchée quand un
// fichier préparé correspond à son motif de fichiers, ou quand une ligne AJOUTÉE correspond à son motif de contenu.
function detecter(racine, categories) {
  const fichiers = git(['-c', 'core.quotepath=off', 'diff', '--cached', '--name-only', '-z'], racine).split('\0').filter(Boolean);
  const diff = git(['-c', 'core.quotepath=off', 'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv'], racine);
  const ajoute = diff.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const touchees = {};
  for (const c of categories) {
    touchees[c.nom] = Boolean(
      (c.fichiers && fichiers.some(f => c.fichiers.test(f))) || // ancre-mutation:categorie-fichiers
      (c.contenu && c.contenu.test(ajoute)) // ancre-mutation:categorie-contenu
    );
  }
  const empreinte = crypto.createHash('sha256')
    .update(fichiers.slice().sort().join('\n'))
    .update('\u{0}')
    .update(diff) // ancre-mutation:empreinte-diff
    .digest('hex');
  return { touchees, empreinte };
}

function lireMarqueur(racine) {
  try {
    const m = JSON.parse(fs.readFileSync(cheminMarqueur(racine), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch (_) {
    return null;
  }
}

function ecrireMarqueur(racine, empreinte, reponses) {
  const marqueur = { empreinte, reponses, quand: new Date().toISOString() };
  transaction.ecrireAtomique(cheminMarqueur(racine), JSON.stringify(marqueur, null, 2) + '\n');
  return marqueur;
}

// Message de refus si le commit doit être refusé, sinon null. `categories` vide : rien à contrôler.
function evaluer(cwd, categories) {
  const racine = racineGit(cwd);
  if (!racine) return null;
  const { touchees, empreinte } = detecter(racine, categories);
  const detectees = categories.filter(c => touchees[c.nom]);
  if (!detectees.length) return null;
  const marqueur = lireMarqueur(racine);
  const reponses = marqueur && marqueur.empreinte === empreinte && marqueur.reponses && typeof marqueur.reponses === 'object' ? marqueur.reponses : {}; // ancre-mutation:marqueur-empreinte
  const attente = detectees.filter(c => !DEBLOQUANTES.includes(reponses[c.nom])); // ancre-mutation:non-debloque
  if (!attente.length) return null;
  const lignes = attente.map(c => '  - ' + c.nom.padEnd(12) + ': ' + c.libelle + ' -> ' + c.question);
  const options = attente.map(c => '--' + c.nom + '=oui').join(' ');
  return [
    'COMMIT REFUSE : rappel avant commit (dépôt ' + racine + ').',
    'Catégories sensibles dans le diff préparé, pas encore confirmées pour ce commit exact :',
  ].concat(lignes, [
    'Vérifie RÉELLEMENT chaque point (jamais par supposition), puis lance SEULE cette commande :',
    '  node "' + SCRIPT_CONFIRMER + '" --cwd="' + racine.replace(/\\/g, '/') + '" ' + options,
    '(=oui : fait et vérifié ; =na : non applicable, ou déjà prouvé plus tôt ; =non : pas fait, le commit reste refusé).',
    'Puis relance EXACTEMENT le même commit, dans une commande séparée. Toute modification de l\'index change l\'empreinte et exige une nouvelle confirmation.',
  ]).join('\n');
}

module.exports = { NOM_MARQUEUR, REPONSES, DEBLOQUANTES, SCRIPT_CONFIRMER, racineGit, dossierGit, cheminMarqueur, detecter, lireMarqueur, ecrireMarqueur, evaluer };
