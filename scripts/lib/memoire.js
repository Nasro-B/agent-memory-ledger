'use strict';
// Fonctions communes aux hooks de mémoire : historique par agent, résumé commun, marqueur de session,
// état git, texte injecté sous plafond. Emplacements : voir ./config.js.
//
//   <maison>/history/<projet>.<agent>.md   journal détaillé, entrées les plus récentes en haut (après « --- »)
//   <maison>/history/<projet>.rules.md     règles et réflexes du projet (écrit à la main, lu au démarrage)
//   <maison>/Memory-Auto.md                résumé commun : une ligne par événement, section « ### <projet> »
//   <maison>/etat/.session-pending-<projet>   marqueur « travail non documenté » (compteur, dernier fichier)
//
// Aucun de ces hooks ne doit bloquer l'agent : toute erreur interne se tait.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config.js');

const PLAFOND = 9000; // au-delà de 10 000 caractères, Claude Code ne transmet qu'un aperçu au modèle

function horodatage(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "YYYY-MM-DD HH:MM" en heure locale -> millisecondes, ou null.
function lireHorodatage(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
}

// Assemble des sections { text, prio, path } sous un plafond strict. prio 0 = la plus importante ; l'ordre
// d'affichage reste celui du tableau. Une section trop longue est coupée à une fin de ligne avec son chemin,
// une section sans place est nommée en fin de texte : rien ne disparaît en silence.
function assembler(items, cap = PLAFOND) {
  const MIN_PARTIE = 300, RESERVE_PIED = 600, SEP = '\n\n';
  let reste = cap - RESERVE_PIED;
  const retenues = new Map();
  const omises = [];
  const parPrio = items.map((it, i) => Object.assign({ i }, it)).sort((a, b) => a.prio - b.prio || a.i - b.i);
  for (const it of parPrio) {
    const besoin = it.text.length + SEP.length;
    if (besoin <= reste) { retenues.set(it.i, it.text); reste -= besoin; continue; }
    const marque = '\n[... tronqué : texte complet dans ' + (it.path || 'la source') + ']';
    const place = reste - SEP.length - marque.length;
    if (place >= MIN_PARTIE) {
      let coupe = it.text.slice(0, place);
      const nl = coupe.lastIndexOf('\n');
      if (nl > place / 2) coupe = coupe.slice(0, nl);
      retenues.set(it.i, coupe + marque);
      reste -= coupe.length + marque.length + SEP.length;
    } else {
      omises.push(it.path || '?');
    }
  }
  const parties = items.map((_, i) => retenues.get(i)).filter(Boolean);
  if (omises.length) {
    let pied = omises.length + ' section(s) non injectée(s) faute de place (à lire au besoin) : ' + omises.join(' ; ');
    const max = RESERVE_PIED - SEP.length;
    if (pied.length > max) pied = pied.slice(0, max - 4) + ' ...';
    parties.push(pied);
  }
  let out = parties.join(SEP);
  if (out.length > cap) out = out.slice(0, cap - 30) + '\n[... coupé au plafond]';
  return out;
}

function fichierHistorique(projet, agent) {
  return path.join(config.chemins().history, `${projet}.${agent}.md`);
}

// Insère une entrée en tête du journal de l'agent (juste après le premier « --- »). Le fichier est créé avec
// son en-tête s'il n'existe pas. `dejaLa(contenu)` vrai : rien n'est écrit (dédoublonnage). Retourne vrai si écrit.
function ajouterAuJournal(projet, agent, entree, dejaLa) {
  const f = fichierHistorique(projet, agent);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let contenu = '';
  try { contenu = fs.readFileSync(f, 'utf8'); } catch (_) { contenu = ''; }
  if (!contenu) contenu = `# Historique ${projet} | ${config.SIGNATURES[agent]}\n\nEntrées les plus récentes en haut.\n\n---\n`;
  if (dejaLa && dejaLa(contenu)) return false; // ancre-mutation:journal-doublon
  const sep = contenu.indexOf('\n---\n');
  const bloc = '\n' + entree.replace(/^\n+|\n+$/g, '') + '\n';
  const sortie = sep !== -1
    ? contenu.slice(0, sep + 5) + bloc + contenu.slice(sep + 5)
    : contenu.replace(/\n*$/, '\n') + '\n---\n' + bloc;
  fs.writeFileSync(f, sortie);
  return true;
}

// Ajoute une ligne à la section « ### <projet> » du résumé commun (créée au besoin, comme le fichier).
// `dejaLa(ligneExistante)` vrai pour une ligne de la section : rien n'est écrit. Retourne vrai si écrit.
function ajouterAuResume(projet, ligne, dejaLa) {
  const f = config.chemins().resume;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let contenu = '';
  try { contenu = fs.readFileSync(f, 'utf8'); } catch (_) { contenu = ''; }
  if (!contenu) contenu = '# Memory-Auto : résumé commun à tous les agents\n\nUne ligne par événement, sous la section du projet. Chaque agent ajoute ses lignes, sans modifier celles des autres.\n';
  const lignes = contenu.split('\n');
  let debut = -1, fin = lignes.length;
  for (let i = 0; i < lignes.length; i++) {
    if (lignes[i].trim() === '### ' + projet) debut = i;
    else if (debut !== -1 && i > debut && lignes[i].startsWith('### ')) { fin = i; break; }
  }
  if (debut === -1) {
    fs.writeFileSync(f, contenu.replace(/\n*$/, '\n') + '\n### ' + projet + '\n' + ligne + '\n');
    return true;
  }
  let derniere = debut;
  for (let i = debut + 1; i < fin; i++) {
    if (lignes[i].startsWith('- ')) derniere = i;
    if (lignes[i].trim() === ligne.trim() || (dejaLa && dejaLa(lignes[i]))) return false;
  }
  lignes.splice(derniere + 1, 0, ligne);
  fs.writeFileSync(f, lignes.join('\n'));
  return true;
}

// Dernières lignes de la section du projet dans le résumé commun.
function resumeDuProjet(projet, max = 12) {
  let brut;
  try { brut = fs.readFileSync(config.chemins().resume, 'utf8').split(/\r?\n/); } catch (_) { return []; }
  let debut = -1, fin = brut.length;
  for (let i = 0; i < brut.length; i++) {
    if (brut[i].trim() === '### ' + projet) debut = i;
    else if (debut !== -1 && i > debut && brut[i].startsWith('### ')) { fin = i; break; }
  }
  return debut === -1 ? [] : brut.slice(debut + 1, fin).filter(l => l.trim().startsWith('- ')).slice(-max);
}

function fichierMarqueur(projet) { return path.join(config.chemins().etat, '.session-pending-' + projet); }

function lireMarqueur(projet) {
  try { return JSON.parse(fs.readFileSync(fichierMarqueur(projet), 'utf8')); } catch (_) { return null; }
}

// Note qu'un fichier du projet vient d'être modifié sans commit.
function toucherMarqueur(projet, fichier) {
  const f = fichierMarqueur(projet);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const avant = lireMarqueur(projet);
  fs.writeFileSync(f, JSON.stringify({ ts: new Date().toISOString(), lastFile: fichier, count: ((avant && avant.count) || 0) + 1 }));
}

function retirerMarqueur(projet) { try { fs.unlinkSync(fichierMarqueur(projet)); } catch (_) { /* déjà retiré */ } }

function git(args, cwd, delai = 3000) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: delai, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

// État d'un dépôt en quelques champs, ou null si ce n'en est pas un.
function etatGit(cwd) {
  try {
    const branche = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
    const dernier = git(['log', '-1', '--format=%h %s'], cwd).trim().slice(0, 72);
    const statut = git(['status', '--porcelain'], cwd).split('\n').filter(l => l.trim());
    const sale = statut.filter(l => !l.startsWith('??')).length;
    const nonSuivis = statut.filter(l => l.startsWith('??')).length;
    let avance = '';
    try {
      const n = git(['rev-list', '--count', '@{u}..HEAD'], cwd).trim();
      if (n && n !== '0') avance = `, ${n} commit(s) NON POUSSÉ(S)`;
    } catch (_) { /* pas de branche amont */ }
    return { branche, dernier, sale, nonSuivis, avance, nom: path.basename(cwd) };
  } catch (_) { return null; }
}

// Lit le payload JSON du hook sur l'entrée standard, puis appelle fn(input). Ne lève jamais.
function avecEntree(fn) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(data.replace(/^﻿/, '')); } catch (_) { input = {}; }
    try { fn(input && typeof input === 'object' ? input : {}); } catch (e) {
      if (process.argv.includes('--dry')) { process.stderr.write('[dry] ERREUR : ' + (e && e.message) + '\n'); process.exitCode = 1; }
    }
  });
}

// Texte vu par le modèle (additionalContext). Claude Code accepte en plus un message court pour l'utilisateur ;
// Codex valide sa sortie contre un schéma strict : on n'y met que le champ prévu.
function injecter(agent, evenement, texte, messageUtilisateur) {
  if (!texte) return;
  const sortie = { hookSpecificOutput: { hookEventName: evenement, additionalContext: texte.length > PLAFOND ? texte.slice(0, PLAFOND - 30) + '\n[... coupé au plafond]' : texte } };
  if (agent === 'claude' && messageUtilisateur) sortie.systemMessage = messageUtilisateur;
  process.stdout.write(JSON.stringify(sortie));
}

module.exports = {
  PLAFOND, horodatage, lireHorodatage, assembler,
  fichierHistorique, ajouterAuJournal, ajouterAuResume, resumeDuProjet,
  fichierMarqueur, lireMarqueur, toucherMarqueur, retirerMarqueur,
  git, etatGit, avecEntree, injecter,
};
