'use strict';
// Fonctions communes aux hooks de mémoire : historique par agent, résumé commun, marqueur de session,
// état git, texte injecté sous plafond. Emplacements : voir ./config.js.
//
//   <maison>/history/<projet>.<agent>.md   journal détaillé, entrées les plus récentes en haut (après « --- »)
//   <maison>/history/<projet>.rules.md     règles et réflexes du projet (écrit à la main, lu au démarrage)
//   <maison>/Memory-Auto.md                résumé commun : une ligne par événement, section « ### <projet> »
//   <maison>/etat/.session-pending-<projet>   marqueur « travail non documenté » (éditions, fichiers distincts, dernier fichier)
//   <maison>/.memoire.lock, .memoire-en-cours.json   verrou des écritures et transaction à rejouer (voir plus bas)
//
// Aucun de ces hooks ne doit bloquer l'agent : toute erreur interne se tait.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config.js');
const transaction = require('./transaction.js');

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

// ---------------------------------------------------------------------------
// Écritures du journal et du résumé : sous un verrou commun, par remplacement atomique du fichier, et, quand une
// entrée touche les deux fichiers, en une seule transaction. Deux agents qui journalisent en même temps sur un
// projet ne perdent plus une ligne, et une interruption entre l'écriture du journal et celle du résumé est
// rejouée au prochain accès (.memoire-en-cours.json) au lieu de laisser les deux fichiers en désaccord.

function fichierVerrou() { return path.join(config.chemins().maison, '.memoire'); }
function fichierReprise() { return path.join(config.chemins().maison, '.memoire-en-cours.json'); }

// Rejoue une transaction interrompue : [[chemin relatif à la maison, contenu complet], ...].
function reprendre() {
  const f = fichierReprise();
  let brut;
  try { brut = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  let ecritures = null;
  try { ecritures = JSON.parse(brut); } catch (_) { ecritures = null; }
  const maison = config.maison();
  let faites = 0;
  for (const [relatif, contenu] of Array.isArray(ecritures) ? ecritures : []) {
    const cible = path.resolve(maison, String(relatif));
    if (!cible.startsWith(maison + path.sep)) continue; // jamais hors de la maison
    transaction.ecrireAtomique(cible, String(contenu));
    // AML_PANNE_TEST ne sert qu'aux bancs : interruption après la première écriture, pour prouver la reprise.
    if (++faites === 1 && process.env.AML_PANNE_TEST === 'apres-premiere-ecriture') throw new Error('panne simulée');
  }
  try { fs.unlinkSync(f); } catch (_) { /* déjà repris */ }
}

function sousVerrou(fn) {
  return transaction.avecVerrou(fichierVerrou(), () => { reprendre(); return fn(); }); // ancre-mutation:verrou-memoire
}

function lireOuVide(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; }
}

// Contenu du journal de l'agent avec `entree` en tête (juste après le premier « --- »), ou null si
// `dejaLa(contenu)` dit que l'entrée y est déjà. Le fichier prend son en-tête s'il n'existe pas.
function journalAvec(projet, agent, entree, dejaLa) {
  let contenu = lireOuVide(fichierHistorique(projet, agent));
  if (!contenu) contenu = `# Historique ${projet} | ${config.SIGNATURES[agent]}\n\nEntrées les plus récentes en haut.\n\n---\n`;
  if (dejaLa && dejaLa(contenu)) return null; // ancre-mutation:journal-doublon
  const sep = contenu.indexOf('\n---\n');
  const bloc = '\n' + entree.replace(/^\n+|\n+$/g, '') + '\n';
  return sep !== -1
    ? contenu.slice(0, sep + 5) + bloc + contenu.slice(sep + 5)
    : contenu.replace(/\n*$/, '\n') + '\n---\n' + bloc;
}

// Contenu du résumé commun avec `ligne` ajoutée à la section « ### <projet> » (créée au besoin, comme le
// fichier), ou null si `dejaLa(ligneExistante)` est vrai pour une ligne de la section.
function resumeAvec(projet, ligne, dejaLa) {
  let contenu = lireOuVide(config.chemins().resume);
  if (!contenu) contenu = '# Memory-Auto : résumé commun à tous les agents\n\nUne ligne par événement, sous la section du projet. Chaque agent ajoute ses lignes, sans modifier celles des autres.\n';
  const lignes = contenu.split('\n');
  let debut = -1, fin = lignes.length;
  for (let i = 0; i < lignes.length; i++) {
    if (lignes[i].trim() === '### ' + projet) debut = i;
    else if (debut !== -1 && i > debut && lignes[i].startsWith('### ')) { fin = i; break; }
  }
  if (debut === -1) return contenu.replace(/\n*$/, '\n') + '\n### ' + projet + '\n' + ligne + '\n';
  let derniere = debut;
  for (let i = debut + 1; i < fin; i++) {
    if (lignes[i].startsWith('- ')) derniere = i;
    if (lignes[i].trim() === ligne.trim() || (dejaLa && dejaLa(lignes[i]))) return null;
  }
  lignes.splice(derniere + 1, 0, ligne);
  return lignes.join('\n');
}

// Insère une entrée en tête du journal de l'agent. `dejaLa(contenu)` vrai : rien n'est écrit (dédoublonnage).
// Retourne vrai si écrit.
function ajouterAuJournal(projet, agent, entree, dejaLa) {
  return sousVerrou(() => {
    const sortie = journalAvec(projet, agent, entree, dejaLa);
    if (sortie === null) return false;
    transaction.ecrireAtomique(fichierHistorique(projet, agent), sortie);
    return true;
  });
}

// Ajoute une ligne à la section du projet dans le résumé commun. Retourne vrai si écrit.
function ajouterAuResume(projet, ligne, dejaLa) {
  return sousVerrou(() => {
    const sortie = resumeAvec(projet, ligne, dejaLa);
    if (sortie === null) return false;
    transaction.ecrireAtomique(config.chemins().resume, sortie);
    return true;
  });
}

// Journal et résumé d'un même événement en une transaction : les deux écritures sont décidées d'abord, notées dans
// le fichier de reprise, puis appliquées. dejaJournal(contenu) et dejaResume(ligne) dédoublonnent chacun leur
// fichier. Retourne { journal, resume } (vrai quand le fichier a été écrit).
function ajouterEntree(projet, agent, entree, ligne, { dejaJournal, dejaResume } = {}) {
  return sousVerrou(() => {
    const maison = config.maison();
    const journal = journalAvec(projet, agent, entree, dejaJournal);
    const resume = resumeAvec(projet, ligne, dejaResume);
    const ecritures = [];
    if (journal !== null) ecritures.push([path.relative(maison, fichierHistorique(projet, agent)), journal]);
    if (resume !== null) ecritures.push([path.relative(maison, config.chemins().resume), resume]);
    if (ecritures.length) {
      transaction.ecrireAtomique(fichierReprise(), JSON.stringify(ecritures)); // ancre-mutation:transaction-reprise
      reprendre();
    }
    return { journal: journal !== null, resume: resume !== null };
  });
}

// Les `limite` entrées les plus récentes d'un journal (« ## AAAA-MM-JJ HH:MM | ... »), par horodatage et non par
// position : une entrée ajoutée à la main en bas, ou un journal dont l'ordre s'est brouillé, ne cache plus les
// plus récentes. Les blocs de code (``` ou ~~~) ne comptent pas comme des titres. Rend le texte des entrées,
// sans l'en-tête du fichier.
function entreesRecentes(brut, limite = 25) {
  const departs = [];
  let cloture = null;
  for (const ligne of String(brut).matchAll(/[^\n]*(?:\n|$)/g)) {
    const delimiteur = /^ {0,3}(`{3,}|~{3,})/.exec(ligne[0]);
    if (delimiteur) {
      if (!cloture) cloture = delimiteur[1];
      else if (delimiteur[1][0] === cloture[0] && delimiteur[1].length >= cloture.length && /^ {0,3}(?:`+|~+)\s*$/.test(ligne[0])) cloture = null;
      continue;
    }
    if (!cloture && /^##[ \t]+\d{4}-\d{2}-\d{2}(?:[ \t]|$)/.test(ligne[0])) departs.push(ligne.index);
  }
  const blocs = departs.map((debut, i) => String(brut).slice(debut, departs[i + 1] === undefined ? String(brut).length : departs[i + 1]));
  return blocs.map((texte, index) => {
    const d = /^##[ \t]+(\d{4})-(\d{2})-(\d{2})(?:[ \t]+(\d{2}):(\d{2}))?/.exec(texte);
    const ts = new Date(+d[1], +d[2] - 1, +d[3], +(d[4] || 0), +(d[5] || 0)).getTime();
    return { texte, index, ts: Number.isFinite(ts) ? ts : -Infinity };
  }).sort((a, b) => b.ts - a.ts || a.index - b.index).slice(0, limite).map(e => e.texte).join('');
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

// Note qu'un fichier du projet vient d'être modifié sans commit : count = nombre d'éditions, files = les fichiers
// distincts (un fichier édité dix fois compte pour dix éditions et un fichier). Sous verrou, écriture atomique :
// deux éditions simultanées ne s'écrasent pas.
function toucherMarqueur(projet, fichier) {
  const f = fichierMarqueur(projet);
  transaction.avecVerrou(f, () => {
    const avant = lireMarqueur(projet);
    const connus = avant && Array.isArray(avant.files) ? avant.files : (avant && avant.lastFile ? [avant.lastFile] : []);
    const files = [...new Set([...connus, fichier])];
    transaction.ecrireAtomique(f, JSON.stringify({ ts: new Date().toISOString(), lastFile: fichier, count: ((avant && avant.count) || 0) + 1, files }));
  });
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
    try { input = JSON.parse(data.replace(/^\uFEFF/, '')); } catch (_) { input = {}; }
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
  fichierHistorique, ajouterAuJournal, ajouterAuResume, ajouterEntree, entreesRecentes, resumeDuProjet,
  fichierMarqueur, lireMarqueur, toucherMarqueur, retirerMarqueur,
  git, etatGit, avecEntree, injecter,
};
