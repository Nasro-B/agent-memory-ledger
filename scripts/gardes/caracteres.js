#!/usr/bin/env node
'use strict';
// Garde des caractères invisibles et des « filigranes » typographiques.
//
// Trois modes :
//
//  1. Hook « avant un outil » (par défaut) : REFUSE toute écriture (fichier, commande de shell, patch) dont le texte
//     ÉCRIT contient un caractère de la liste : espaces insécables, fines et larges, largeur nulle, marques de
//     direction, caractères de tag, sélecteurs de variation, remplisseurs, séparateurs de ligne exotiques,
//     contrôles C0 et C1. Le texte ancien (old_string) n'est jamais contrôlé : retirer un invisible d'un fichier
//     reste possible. Exceptions étroites (voir trouver) : marque d'ordre des octets en TÊTE de texte, marques de
//     direction dans un texte arabe, hébreu ou persan, sélecteur de variation ou liant de largeur nulle collé à un
//     pictogramme. Une commande `node ... context-ledger.js` est exemptée (elle cite mot pour mot les messages de
//     l'utilisateur). En cas d'entrée illisible ou d'erreur d'analyse, la garde LAISSE PASSER : elle ne doit jamais
//     bloquer les autres outils.
//
//  2. Ligne de commande : `node caracteres.js --scan <fichier>...` liste les occurrences (code 1 s'il y en a) ;
//     `node caracteres.js --fix <fichier>...` les remplace (espace normale, saut de ligne, ou suppression).
//
//  3. Fin de tour : `node caracteres.js --stop [--agent nom]` relit la DERNIÈRE RÉPONSE de l'agent et, si elle
//     contient un caractère de la liste (et, si gardes.json le demande, le tiret long U+2014), REFUSE une fois de
//     finir le tour : l'agent doit redonner sa réponse corrigée. Un hook de fin de tour ne peut pas empêcher
//     l'affichage, la réponse est déjà vue : il ne peut que forcer la correction. Une seule relance par message
//     (stop_hook_active). Les sous-agents ne sont pas contrôlés. Texte lu : last_assistant_message si le moteur le
//     fournit, sinon (format Claude Code) les blocs texte de la transcription depuis le dernier vrai message de
//     l'utilisateur.
//
// Réglage : gardes.json, section « caracteres » (actif, tiretLongFinDeTour). Essai à la main :
//   {"tool_name":"Write","tool_input":{"file_path":"x.txt","content":"a<U+202F>b"}} sur l'entrée standard.
// Module : exporte aussi nettoyer() pour les écritures de mémoire.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config.js');
const gardesConfig = require('../lib/gardes-config.js');

const CLASSE =
  '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00A0\\u00AD\\u034F\\u061C\\u115F\\u1160\\u1680\\u17B4\\u17B5\\u180E' +
  '\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u206F\\u2800\\u3000\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFC' + // ancre-mutation:classe-plage
  '\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}';
const INTERDITS = new RegExp('[' + CLASSE + ']', 'gu');
const TEXTE_RTL = /[\u{0590}-\u{061B}\u{061D}-\u{08FF}\u{FB1D}-\u{FDFF}\u{FE70}-\u{FEFC}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const OUTILS_FICHIER = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CLES_CHEMIN = new Set(['old_string', 'file_path', 'path', 'notebook_path', 'filePath', 'destination', 'dest', 'target', 'file']);
const EXEMPTE_COMMANDE = /^\s*node\s+["']?[^\s"']*context-ledger\.js\b/i;
const TIRET_LONG = '\u{2014}';

const code = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

// Occurrences interdites de `texte` : [{ index, cp, ligne, colonne }] (exceptions déjà retirées).
function trouver(texte) {
  const s = String(texte ?? '');
  const rtl = TEXTE_RTL.test(s);
  const sortie = [];
  INTERDITS.lastIndex = 0;
  let m;
  while ((m = INTERDITS.exec(s))) {
    const index = m.index;
    const cp = m[0].codePointAt(0);
    if (cp === 0xFEFF && index === 0) continue; // ancre-mutation:bom-en-tete
    if ((cp === 0x200E || cp === 0x200F || cp === 0x061C) && rtl) continue; // ancre-mutation:direction-rtl
    if (cp === 0xFE0F || cp === 0xFE0E || cp === 0x200D) {
      const avant = [...s.slice(Math.max(0, index - 2), index)].pop() || '';
      const apres = [...s.slice(index + 1, index + 3)][0] || '';
      if (PICTO.test(avant) || /^[0-9#*]$/.test(avant) || (cp === 0x200D && PICTO.test(apres))) continue; // ancre-mutation:selecteur-pictogramme
    }
    const avantTexte = s.slice(0, index);
    const ligne = avantTexte.split('\n').length;
    const colonne = index - (avantTexte.lastIndexOf('\n') + 1) + 1;
    sortie.push({ index, cp, ligne, colonne });
  }
  return sortie;
}

// Remplace les occurrences interdites : espaces larges -> espace normale, séparateurs de ligne -> saut de ligne, le
// reste est supprimé.
function nettoyer(texte) {
  const s = String(texte ?? '');
  const trouves = trouver(s);
  if (!trouves.length) return s;
  const a = new Map(trouves.map(t => [t.index, t.cp]));
  let r = '';
  for (let i = 0; i < s.length; i++) {
    if (!a.has(i)) { r += s[i]; continue; }
    const cp = a.get(i);
    if (cp > 0xFFFF) i++;
    if (cp === 0x00A0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F || cp === 0x205F || cp === 0x3000) r += ' ';
    else if (cp === 0x2028 || cp === 0x2029 || cp === 0x0085) r += '\n';
  }
  return r;
}

function chaines(valeur, sortie) {
  if (typeof valeur === 'string') { sortie.push(valeur); return; }
  if (Array.isArray(valeur)) { for (const v of valeur) chaines(v, sortie); return; }
  if (valeur && typeof valeur === 'object') {
    for (const [cle, v] of Object.entries(valeur)) {
      if (CLES_CHEMIN.has(cle)) continue;
      chaines(v, sortie);
    }
  }
}

// Seules les lignes AJOUTÉES d'un patch comptent.
function lignesAjoutees(patch) {
  return String(patch).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
}

// Textes ÉCRITS par l'appel d'outil (jamais l'ancien texte ni les chemins).
function textesEcrits(entree) {
  const outil = String(entree.tool_name || '');
  const saisie = entree.tool_input || {};
  const textes = [];
  if (OUTILS_FICHIER.has(outil)) { chaines(saisie, textes); return textes; }
  const commande = typeof saisie.command === 'string' ? saisie.command : (typeof saisie.input === 'string' ? saisie.input : '');
  if (commande) {
    if (EXEMPTE_COMMANDE.test(commande)) return []; // ancre-mutation:exemption-liste
    textes.push(/\*\*\* Begin Patch/.test(commande) ? lignesAjoutees(commande) : commande);
    return textes;
  }
  if (outil === 'apply_patch' && typeof saisie.patch === 'string') { textes.push(lignesAjoutees(saisie.patch)); return textes; }
  // Outils d'écriture des autres agents (write_file, replace, edit, create...) et outils MCP : tout le texte sauf les chemins.
  if (/^mcp__|write|edit|patch|replace|create|append|insert|shell|exec|notebook/i.test(outil)) chaines(saisie, textes);
  return textes;
}

function resume(texte, t) {
  const debut = Math.max(0, t.index - 8);
  const extrait = texte.slice(debut, t.index + 8).replace(/[^\x20-\x7E\u{00C0}-\u{00FF}]/gu, c => '<' + code(c.codePointAt(0)) + '>');
  return code(t.cp) + ' ligne ' + t.ligne + ' colonne ' + t.colonne + ' (...' + extrait + '...)';
}

const SCRIPT = __filename.replace(/\\/g, '/');

function evaluer(entree) {
  const textes = textesEcrits(entree);
  const lignes = [];
  const comptes = new Map();
  for (const texte of textes) {
    for (const t of trouver(texte)) {
      comptes.set(t.cp, (comptes.get(t.cp) || 0) + 1);
      if (lignes.length < 5) lignes.push(resume(texte, t));
    }
  }
  if (!comptes.size) return null;
  const total = [...comptes.values()].reduce((a, b) => a + b, 0);
  const codes = [...comptes].map(([cp, n]) => code(cp) + ' x' + n).join(', ');
  return (
    'REFUSÉ par la garde des caractères invisibles : ' + total + ' caractère(s) invisible(s) ou filigrane(s) dans le texte à écrire (' + codes + '). ' +
    'Exemples : ' + lignes.join(' ; ') + '. ' +
    'Remplace-les par une espace normale U+0020 (ou supprime-les) et relance. Si le caractère doit vraiment figurer dans un test ou une expression régulière, écris-le par son échappement (\\u{202F}, \\x{202F}), jamais en clair. ' +
    'Nettoyage d\'un fichier existant : node "' + SCRIPT + '" --fix <fichier>.'
  );
}

// ---- Mode fin de tour (--stop) : filet sur la réponse de chat ------------------------------------------------------------------

function reponseDeLEntree(entree) {
  if (typeof entree.last_assistant_message === 'string' && entree.last_assistant_message) return { texte: entree.last_assistant_message, source: 'last_assistant_message' };
  const chemin = typeof entree.transcript_path === 'string' ? entree.transcript_path : '';
  if (!chemin) return { texte: '', source: 'aucune' };
  let lignes;
  try { lignes = fs.readFileSync(chemin, 'utf8').split('\n'); } catch (e) { return { texte: '', source: 'transcription illisible' }; }
  const morceaux = [];
  for (let i = lignes.length - 1; i >= 0; i--) {
    if (!lignes[i]) continue;
    let j; try { j = JSON.parse(lignes[i]); } catch (e) { continue; }
    const contenu = j && j.message && j.message.content;
    if (j.type === 'user') {
      const vrai = typeof contenu === 'string' || (Array.isArray(contenu) && contenu.some(b => b && b.type === 'text'));
      if (vrai) break;
    } else if (j.type === 'assistant' && Array.isArray(contenu)) {
      for (const b of contenu) if (b && b.type === 'text' && typeof b.text === 'string') morceaux.unshift(b.text);
    }
  }
  return { texte: morceaux.join('\n'), source: 'transcription' };
}

// options.tiretLong : compter aussi le tiret long U+2014 (gardes.json, caracteres.tiretLongFinDeTour).
function evaluerReponse(entree, options = {}) {
  if (entree.stop_hook_active === true || entree.agent_id || entree.agent_type) return { raison: null, source: 'ignore' }; // ancre-mutation:anti-boucle
  const { texte, source } = reponseDeLEntree(entree);
  const trouves = trouver(texte);
  if (options.tiretLong) { // ancre-mutation:tiret-long
    for (let i = texte.indexOf(TIRET_LONG); i >= 0; i = texte.indexOf(TIRET_LONG, i + 1)) {
      const avant = texte.slice(0, i);
      trouves.push({ index: i, cp: 0x2014, ligne: avant.split('\n').length, colonne: i - (avant.lastIndexOf('\n') + 1) + 1 });
    }
  }
  if (!trouves.length) return { raison: null, source, longueur: texte.length };
  const comptes = new Map();
  for (const x of trouves) comptes.set(x.cp, (comptes.get(x.cp) || 0) + 1);
  const codes = [...comptes].map(([cp, n]) => code(cp) + ' x' + n).join(', ');
  const exemples = trouves.slice(0, 5).map(x => resume(texte, x)).join(' ; ');
  return {
    source, longueur: texte.length,
    raison: 'RÉPONSE NON CONFORME : ta dernière réponse contient ' + trouves.length + ' caractère(s) interdit(s) (' + codes + '). Exemples : ' + exemples +
      '. Redonne maintenant ta réponse complète, identique sur le fond, sans aucun de ces caractères : espace normale U+0020 à la place des invisibles' +
      (options.tiretLong ? ', et deux-points, parenthèses, virgule ou tiret simple entouré d\'espaces à la place du tiret long' : '') + '. Ne commente pas cette vérification plus que nécessaire.',
  };
}

function journaliser(agent, resultat, entree) {
  try {
    const dossier = config.chemins().etat;
    fs.mkdirSync(dossier, { recursive: true });
    const f = path.join(dossier, 'garde-caracteres-fin-de-tour.jsonl');
    try { if (fs.statSync(f).size > 200000) fs.writeFileSync(f, ''); } catch (e) { /* premier appel */ }
    fs.appendFileSync(f, JSON.stringify({ quand: new Date().toISOString(), agent, source: resultat.source, longueur: resultat.longueur, refuse: Boolean(resultat.raison), relance: entree.stop_hook_active === true, champs: Object.keys(entree) }) + '\n');
  } catch (e) { /* le journal ne doit jamais gêner */ }
}

// Rend ce que le hook de fin de tour écrit sur la sortie standard ('' = laisser finir).
function executerFin(brut, agent, cfg) {
  if (!cfg.caracteres.actif || !brut.trim()) return ''; // ancre-mutation:actif-fin
  let entree; try { entree = JSON.parse(brut); } catch (e) { return ''; }
  if (!entree || typeof entree !== 'object') return '';
  let resultat; try { resultat = evaluerReponse(entree, { tiretLong: cfg.caracteres.tiretLongFinDeTour }); } catch (e) { return ''; }
  journaliser(agent, resultat, entree); // ancre-mutation:journal
  if (!resultat.raison) return '';
  return JSON.stringify({ decision: 'block', reason: resultat.raison }); // ancre-mutation:fin-bloque
}

// Rend { stdout, stderr, code } du hook avant un outil.
function executerAvant(brut, cfg) {
  if (!cfg.caracteres.actif || !brut.trim()) return { stdout: '', stderr: '', code: 0 }; // ancre-mutation:actif-avant
  let entree; try { entree = JSON.parse(brut); } catch (e) { return { stdout: '', stderr: '', code: 0 }; }
  if (!entree || typeof entree !== 'object') return { stdout: '', stderr: '', code: 0 };
  let raison = null; try { raison = evaluer(entree); } catch (e) { return { stdout: '', stderr: '', code: 0 }; }
  if (!raison) return { stdout: '', stderr: '', code: 0 };
  const notice = gardesConfig.dire(cfg);
  const complet = raison + (notice ? ' ' + notice : '');
  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: complet } }),
    stderr: complet + '\n',
    code: 2, // ancre-mutation:refus-code
  };
}

function lireEntree() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--stop')) {
    const i = args.indexOf('--agent');
    const sortie = executerFin(lireEntree(), i >= 0 ? args[i + 1] : 'claude', gardesConfig.charger());
    if (sortie) process.stdout.write(sortie);
    return;
  }
  if (args[0] === '--scan' || args[0] === '--fix') {
    let trouve = 0;
    for (const f of args.slice(1)) {
      let brut;
      try { brut = fs.readFileSync(f, 'utf8'); } catch (e) { process.stderr.write(f + ' : lecture impossible (' + e.code + ')\n'); process.exitCode = 2; continue; }
      const t = trouver(brut);
      if (!t.length) continue;
      trouve += t.length;
      if (args[0] === '--fix') { fs.writeFileSync(f, nettoyer(brut)); console.log(f + ' : ' + t.length + ' remplacé(s)'); }
      else for (const x of t.slice(0, 20)) console.log(f + ':' + x.ligne + ':' + x.colonne + ' ' + code(x.cp));
    }
    if (!process.exitCode) process.exitCode = args[0] === '--scan' && trouve ? 1 : 0;
    return;
  }
  const r = executerAvant(lireEntree(), gardesConfig.charger());
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

if (require.main === module) main();
module.exports = { trouver, nettoyer, evaluer, textesEcrits, INTERDITS, evaluerReponse, reponseDeLEntree, executerAvant, executerFin };
