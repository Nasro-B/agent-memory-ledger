'use strict';
// Réglage des trois gardes (sécurité des commandes, rappel avant commit, caractères invisibles).
//
// Fichier facultatif : <maison>/gardes.json (la maison est décrite dans config.js). Sans fichier, les valeurs par
// défaut ci-dessous s'appliquent : les trois gardes sont actives, aucune branche n'est protégée par nom, la
// poussée et le déploiement de production demandent confirmation.
//
//   {
//     "securite": {
//       "actif": true,
//       "branchesProtegees": ["^sauvegarde-", { "motif": "\\bPROD\\b", "casse": true }],
//       "confirmer": ["poussee", "deploiement-production", { "nom": "deploiement-autre", "motif": "\\bmon-outil\\s+publier\\b" }],
//       "ordreUtilisateur": { "actif": true, "motsPoussee": ["push", "pousse"], "motsDeploiement": ["deploy", "déploie"] },
//       "reglesDesactivees": ["wrangler-keep-vars", "vercel-env-sans-printf"]
//     },
//     "checklist": {
//       "actif": true,
//       "categories": [
//         { "nom": "migrations", "actif": false },
//         { "nom": "secrets", "fichiers": "(^|/)secrets/", "contenu": "SECRET_[A-Z_]+", "libelle": "secrets", "question": "secret(s) créé(s) dans le coffre ?" }
//       ]
//     },
//     "caracteres": { "actif": true, "tiretLongFinDeTour": false }
//   }
//
// Règle de fond : un fichier illisible, ou une valeur mal formée, ne désarme JAMAIS une garde. Seul un booléen
// `false` écrit comme tel éteint une garde ou une catégorie ; tout le reste retombe sur la valeur par défaut, et
// chaque écart est rendu dans `avertissements` (les gardes le disent).

const fs = require('fs');
const config = require('./config.js');

// Règles liées à un outil du marché : nommées, donc désactivables une à une. Les règles générales (suppression
// récursive forcée, nettoyage forcé, retour forcé de l'arbre, poussée forcée, contournement des hooks de git)
// ne se désactivent pas une par une : seul `securite.actif: false` éteint toute la garde.
const REGLES_DESACTIVABLES = ['wrangler-keep-vars', 'vercel-env-sans-printf'];
const CONFIRMATIONS = ['poussee', 'deploiement-production'];

const MOTS_POUSSEE = ['push', 'pushe', 'pushes', 'pushez', 'pousse', 'pousses', 'poussez', 'pousser'];
const MOTS_DEPLOIEMENT = ['d[ée]ploie', 'd[ée]ploies', 'd[ée]ployez', 'd[ée]ployer', 'red[ée]ploie', 'deploy', 'redeploy', 'mets? en prod(?:uction)?'];

// Les motifs de contenu ci-dessous sont écrits en deux morceaux là où ils contiennent le nom d'une extension ou d'un
// appel de planification : un fichier qui les écrit en clair se prendrait lui-même pour une tâche planifiée.
const CATEGORIES_DEFAUT = [
  {
    nom: 'migrations',
    fichiers: '(^|/)migrations/.*\\.sql$',
    contenu: null,
    libelle: 'migrations de base de données (migrations/**/*.sql)',
    question: 'schéma appliqué en réel sur la bonne base ?',
  },
  {
    nom: 'fonctions',
    fichiers: '(^|/)supabase/functions/',
    contenu: null,
    libelle: 'fonctions déployées à part (supabase/functions/**)',
    question: 'fonction(s) déployée(s) en réel ?',
  },
  {
    nom: 'variables',
    fichiers: null,
    contenu: 'process\\.env\\.[A-Z0-9_]+|Deno\\.env\\.get\\(\\s*[\'"][A-Z0-9_]+[\'"]',
    libelle: 'nouvelle(s) variable(s) d\'environnement lue(s) par le code',
    question: 'variable(s) posée(s) en réel dans chaque environnement ?',
  },
  {
    nom: 'taches',
    fichiers: null,
    contenu: 'cron\\.schedule\\s*\\(|\\bpg_' + 'cron\\b',
    libelle: 'tâche planifiée de la base',
    question: 'tâche(s) planifiée(s) vérifiée(s) active(s) sur la bonne base ?',
  },
];

// Expression régulière depuis un texte ; null si elle est invalide.
function compiler(source, drapeaux) {
  try { return new RegExp(String(source), drapeaux); } catch (_) { return null; }
}

function echapper(texte) { return String(texte).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function estObjet(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function booleen(valeur, defaut, chemin, avert) {
  if (valeur === undefined) return defaut;
  if (typeof valeur === 'boolean') return valeur; // ancre-mutation:booleen-strict
  avert.push(`${chemin} : un booléen (true ou false) était attendu, la valeur par défaut (${defaut}) est gardée`);
  return defaut;
}

// Liste de textes non vides ; undefined si la clé est absente, ou mal formée (avec avertissement).
function listeDeTextes(valeur, chemin, avert) {
  if (valeur === undefined) return undefined;
  if (!Array.isArray(valeur)) { avert.push(`${chemin} : une liste était attendue, la valeur par défaut est gardée`); return undefined; }
  const sortie = [];
  for (const v of valeur) {
    if (typeof v === 'string' && v.trim()) sortie.push(v.trim());
    else avert.push(`${chemin} : une entrée qui n'est pas un texte est ignorée`);
  }
  return sortie;
}

function lireFichier() {
  const f = config.chemins().gardes;
  let brut;
  try { brut = fs.readFileSync(f, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { fichier: f, present: false, valeur: {} };
    return { fichier: f, present: true, valeur: null, erreur: `lecture impossible (${e && e.code ? e.code : 'erreur'})` };
  }
  try {
    const v = JSON.parse(brut.replace(/^\u{FEFF}/u, ''));
    if (!estObjet(v)) return { fichier: f, present: true, valeur: null, erreur: 'le contenu doit être un objet JSON' };
    return { fichier: f, present: true, valeur: v };
  } catch (e) {
    return { fichier: f, present: true, valeur: null, erreur: `JSON invalide (${e.message})` };
  }
}

function sectionSecurite(src, avert) {
  const s = estObjet(src) ? src : {};
  if (src !== undefined && !estObjet(src)) avert.push('securite : un objet était attendu, les valeurs par défaut sont gardées');
  const sortie = {
    actif: booleen(s.actif, true, 'securite.actif', avert),
    branchesProtegees: [],
    confirmer: [],
    ordreUtilisateur: { actif: true, poussee: null, deploiement: null, mots: { poussee: MOTS_POUSSEE, deploiement: MOTS_DEPLOIEMENT } },
    reglesDesactivees: new Set(),
  };

  // Branches protégées : motifs d'expressions régulières, sans casse par défaut. Un motif invalide est gardé comme
  // texte littéral : il protège encore, il ne disparaît pas.
  const branches = s.branchesProtegees;
  if (branches !== undefined && !Array.isArray(branches)) avert.push('securite.branchesProtegees : une liste était attendue, aucune branche protégée par nom');
  for (const b of Array.isArray(branches) ? branches : []) {
    const motif = typeof b === 'string' ? b : (estObjet(b) ? b.motif : null);
    if (typeof motif !== 'string' || !motif.trim()) { avert.push('securite.branchesProtegees : une entrée sans motif est ignorée'); continue; }
    const drapeaux = estObjet(b) && b.casse === true ? '' : 'i';
    let re = compiler(motif.trim(), drapeaux);
    if (!re) { avert.push(`securite.branchesProtegees : le motif « ${motif} » est invalide, il est cherché comme texte littéral`); re = compiler(echapper(motif.trim()), drapeaux); } // ancre-mutation:motif-litteral
    sortie.branchesProtegees.push(re);
  }

  // Commandes soumises à confirmation. Les noms connus : poussee, deploiement-production. Une entrée objet ajoute
  // un motif de commande ; `ordre` dit quel ordre de l'utilisateur la débloque (poussee ou deploiement, défaut :
  // deploiement).
  const confirmer = s.confirmer === undefined ? CONFIRMATIONS.slice() : s.confirmer;
  if (!Array.isArray(confirmer)) avert.push('securite.confirmer : une liste était attendue, les valeurs par défaut sont gardées');
  for (const c of Array.isArray(confirmer) ? confirmer : CONFIRMATIONS) {
    if (typeof c === 'string') {
      if (CONFIRMATIONS.includes(c)) sortie.confirmer.push({ nom: c, re: null });
      else avert.push(`securite.confirmer : « ${c} » n'est pas un nom connu (${CONFIRMATIONS.join(', ')}), ignoré`);
    } else if (estObjet(c) && typeof c.nom === 'string' && c.nom.trim() && typeof c.motif === 'string' && c.motif.trim()) {
      const re = compiler(c.motif, 'i');
      if (!re) { avert.push(`securite.confirmer : le motif de « ${c.nom} » est invalide, entrée ignorée`); continue; }
      sortie.confirmer.push({ nom: c.nom.trim(), re, message: typeof c.message === 'string' && c.message.trim() ? c.message.trim() : null, ordre: c.ordre === 'poussee' ? 'poussee' : 'deploiement' });
    } else avert.push('securite.confirmer : une entrée doit être un nom connu ou un objet { nom, motif }, ignorée');
  }

  // Mots qui valent ordre de l'utilisateur (agents qui ne savent pas demander confirmation).
  const o = s.ordreUtilisateur;
  if (o !== undefined && o !== false && !estObjet(o)) avert.push('securite.ordreUtilisateur : false ou un objet était attendu, les valeurs par défaut sont gardées');
  const oo = estObjet(o) ? o : {};
  sortie.ordreUtilisateur.actif = o === false ? false : booleen(oo.actif, true, 'securite.ordreUtilisateur.actif', avert);
  for (const [cle, defaut, nom] of [['motsPoussee', MOTS_POUSSEE, 'poussee'], ['motsDeploiement', MOTS_DEPLOIEMENT, 'deploiement']]) {
    const liste = listeDeTextes(oo[cle], `securite.ordreUtilisateur.${cle}`, avert);
    const fragments = liste && liste.length ? liste : defaut;
    const valides = fragments.filter(f => compiler(f));
    if (valides.length !== fragments.length) avert.push(`securite.ordreUtilisateur.${cle} : un fragment invalide est ignoré`);
    const alternative = (valides.length ? valides : defaut).join('|');
    sortie.ordreUtilisateur.mots[nom] = valides.length ? valides : defaut;
    sortie.ordreUtilisateur[nom] =new RegExp('(?<![\\p{L}\\p{N}_])(?:' + alternative + ')(?![\\p{L}\\p{N}_])', 'iu');
  }

  const desactivees = listeDeTextes(s.reglesDesactivees, 'securite.reglesDesactivees', avert) || [];
  for (const r of desactivees) {
    if (REGLES_DESACTIVABLES.includes(r)) sortie.reglesDesactivees.add(r);
    else avert.push(`securite.reglesDesactivees : « ${r} » n'est pas une règle désactivable (${REGLES_DESACTIVABLES.join(', ')}), la règle reste active`); // ancre-mutation:regle-inconnue
  }
  return sortie;
}

// Catégorie de la checklist : `defaut` est la catégorie intégrée du même nom (ou null). Un motif invalide ou mal
// typé garde le motif par défaut quand il existe, sinon il est ignoré.
function compilerCategorie(c, defaut, avert) {
  const sortie = { nom: c.nom, fichiers: null, contenu: null, libelle: c.nom, question: `${c.nom} : fait en réel ?` };
  if (defaut) { sortie.libelle = defaut.libelle; sortie.question = defaut.question; }
  for (const cle of ['fichiers', 'contenu']) {
    let source = defaut ? defaut[cle] : null;
    if (c[cle] !== undefined) {
      if (c[cle] === null) source = null;
      else if (typeof c[cle] === 'string' && c[cle].trim()) {
        if (compiler(c[cle], 'i')) source = c[cle];
        else avert.push(`checklist.categories : le motif « ${cle} » de « ${c.nom} » est invalide, ${defaut ? 'le motif par défaut est gardé' : 'il est ignoré'}`);
      } else avert.push(`checklist.categories : le motif « ${cle} » de « ${c.nom} » doit être un texte, ${defaut ? 'le motif par défaut est gardé' : 'il est ignoré'}`);
    }
    sortie[cle] = source ? compiler(source, cle === 'contenu' ? '' : 'i') : null;
  }
  if (typeof c.libelle === 'string' && c.libelle.trim()) sortie.libelle = c.libelle.trim();
  if (typeof c.question === 'string' && c.question.trim()) sortie.question = c.question.trim();
  return sortie;
}

function sectionChecklist(src, avert) {
  const s = estObjet(src) ? src : {};
  if (src !== undefined && !estObjet(src)) avert.push('checklist : un objet était attendu, les valeurs par défaut sont gardées');
  const sortie = { actif: booleen(s.actif, true, 'checklist.actif', avert), categories: [] };
  const parNom = new Map();
  for (const d of CATEGORIES_DEFAUT) parNom.set(d.nom, compilerCategorie(d, null, []));
  const liste = s.categories;
  if (liste !== undefined && !Array.isArray(liste)) avert.push('checklist.categories : une liste était attendue, les catégories par défaut sont gardées');
  for (const c of Array.isArray(liste) ? liste : []) {
    if (!estObjet(c) || typeof c.nom !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(c.nom)) {
      avert.push('checklist.categories : une catégorie doit avoir un « nom » en minuscules, chiffres et tirets (31 caractères au plus), ignorée');
      continue;
    }
    const defaut = CATEGORIES_DEFAUT.find(d => d.nom === c.nom) || null;
    if (c.actif === false) { parNom.delete(c.nom); continue; } // ancre-mutation:categorie-desactivee
    if (c.actif !== undefined && c.actif !== true) avert.push(`checklist.categories : « actif » de « ${c.nom} » doit être un booléen, la catégorie reste active`);
    const cat = compilerCategorie(c, defaut, avert);
    if (!cat.fichiers && !cat.contenu) {
      avert.push(`checklist.categories : « ${c.nom} » n'a ni motif de fichiers ni motif de contenu, ignorée`);
      if (defaut) parNom.set(c.nom, compilerCategorie(defaut, null, []));
      continue;
    }
    parNom.set(c.nom, cat); // ancre-mutation:categorie-ajoutee
  }
  sortie.categories = [...parNom.values()];
  return sortie;
}

function sectionCaracteres(src, avert) {
  const s = estObjet(src) ? src : {};
  if (src !== undefined && !estObjet(src)) avert.push('caracteres : un objet était attendu, les valeurs par défaut sont gardées');
  return {
    actif: booleen(s.actif, true, 'caracteres.actif', avert),
    tiretLongFinDeTour: booleen(s.tiretLongFinDeTour, false, 'caracteres.tiretLongFinDeTour', avert),
  };
}

// Lit gardes.json et rend le réglage complet. Ne lève jamais : toute difficulté devient un avertissement.
function charger() {
  const lu = lireFichier();
  const avertissements = [];
  let valeur = lu.valeur;
  if (valeur === null) {
    avertissements.push(`le fichier est illisible (${lu.erreur}) : les valeurs par défaut s'appliquent, les trois gardes restent actives. Corrige ou supprime ce fichier`);
    valeur = {}; // ancre-mutation:defaut-illisible
  }
  for (const cle of Object.keys(valeur)) {
    if (!['securite', 'checklist', 'caracteres'].includes(cle)) avertissements.push(`clé inconnue « ${cle} » ignorée (clés connues : securite, checklist, caracteres)`);
  }
  return {
    fichier: lu.fichier,
    present: lu.present,
    illisible: lu.valeur === null,
    securite: sectionSecurite(valeur.securite, avertissements),
    checklist: sectionChecklist(valeur.checklist, avertissements),
    caracteres: sectionCaracteres(valeur.caracteres, avertissements),
    avertissements,
  };
}

// Phrase unique pour dire les écarts de configuration, ou chaîne vide s'il n'y en a pas.
function dire(cfg) {
  if (!cfg.avertissements.length) return '';
  return `Réglage des gardes (${cfg.fichier}) : ` + cfg.avertissements.join(' ; ') + '.';
}

module.exports = { charger, dire, CATEGORIES_DEFAUT, REGLES_DESACTIVABLES, CONFIRMATIONS, MOTS_POUSSEE, MOTS_DEPLOIEMENT };
