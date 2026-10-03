#!/usr/bin/env node
'use strict';
// Contrôle avant publication : le dépôt ne doit contenir ni donnée personnelle ni secret.
//
//   node scripts/verifier-public.js [--termes <fichier>] [--dossier <racine>]
//
// Contrôles toujours faits, sur chaque fichier du dépôt (hors .git et node_modules) :
//   - chemins de profil d'une vraie personne (dossier Users d'un disque Windows, /home/<nom>, /Users/<nom>) ;
//   - chemins Windows absolus hors des exemples admis (C:\travail, C:\outils, C:\tmp, C:\x, profil « demo ») ;
//   - adresses électroniques (hors domaines d'exemple et adresses « noreply ») ;
//   - clés et jetons aux formes connues, clés privées, affectations de mot de passe ou de secret en clair ;
//   - caractères invisibles écrits tels quels dans un fichier.
// Version du plugin, quand le dépôt a un manifeste (.claude-plugin/plugin.json) : la même dans le manifeste,
// dans l'entrée de marketplace et dans package.json ; et changée dès que le code a changé depuis la dernière
// publication connue (la branche amont). Claude Code garde chaque installation sur la copie de la version
// installée tant que cette chaîne ne change pas : un correctif poussé sans la changer n'atteint personne.
// Contrôle supplémentaire : --termes <fichier> (ou la variable AML_TERMES_PRIVES) désigne un fichier GARDÉ HORS
// DU DÉPÔT, une expression par ligne (sans tenir compte de la casse) : vos noms, vos projets, vos domaines.
// Chaque occurrence est une erreur. Les lignes vides et celles qui commencent par # sont ignorées.
//
// Sortie : une ligne par constat (fichier:ligne, règle, extrait court) ; code 0 si rien, 1 sinon.
// Un secret n'est jamais affiché en entier.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = nom => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
const racine = path.resolve(opt('--dossier') || path.join(__dirname, '..'));
const fichierTermes = opt('--termes') || process.env.AML_TERMES_PRIVES || null;

const PROFILS_ADMIS = /^(demo|x|vous|utilisateur|user|me|public|default)$/i;
// « C:\Program » seul : début de « C:\Program Files », où la détection s'arrête à l'espace.
const CHEMINS_ADMIS = /^[A-Za-z]:[\\/]+(?:(travail|outils|tmp|x|chemin|Users[\\/]+demo|Windows|Program Files)([\\/]|$)|Program$)/i;
const COURRIELS_ADMIS = /@(example\.(com|org|net|invalid)|[\w.-]*\.(invalid|local|test)|users\.noreply\.github\.com|context-ledger\.local)$/i;

const REGLES = [
  { nom: 'profil personnel', re: /(?:[A-Za-z]:[\\/]+Users|\/home|\/Users)[\\/]+([A-Za-z0-9._-]+)/g, garde: m => !PROFILS_ADMIS.test(m[1]) },
  // (?<![\\\w]) : une lettre de lecteur n'est ni la fin d'un mot ni une classe d'expression régulière (\d:\d).
  { nom: 'chemin absolu Windows', re: /(?<![\\\w])[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.~-][^\s"'`<>|)*,;]*/g, garde: m => !CHEMINS_ADMIS.test(m[0].replace(/\\\\/g, '\\')) },
  { nom: 'adresse électronique', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, garde: m => !COURRIELS_ADMIS.test(m[0]) },
  { nom: 'clé ou jeton', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|hf_[A-Za-z0-9]{25,})/g },
  { nom: 'clé privée', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { nom: 'secret en clair', re: /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Za-z0-9_]*\s*[:=]\s*["'][^"'\s$<{]{8,}["']/g },
  // Caractères invisibles écrits tels quels (marque d'ordre des octets en milieu de fichier, espaces de largeur
  // nulle) : ils changent le sens d'un code sans se voir. Une marque en tout début de fichier est admise.
  { nom: 'caractère invisible', re: new RegExp('[' + [0xFEFF, 0x200B, 0x200C, 0x200D, 0x2060].map(c => String.fromCharCode(c)).join('') + ']', 'g'), garde: (m, ligne) => !(ligne === 0 && m.index === 0), montrer: m => 'U+' + m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') },
];

const termes = [];
if (fichierTermes) {
  const f = path.resolve(fichierTermes);
  const rel = path.relative(racine, f);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    process.stderr.write(`Le fichier de termes privés est DANS le dépôt (${rel}) : il serait publié. Mettez-le ailleurs.\n`);
    process.exit(2);
  }
  for (const l of fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    try { termes.push(new RegExp(t, 'gi')); } catch (e) { process.stderr.write(`terme privé invalide (${t.slice(0, 20)}...) : ${e.message}\n`); process.exit(2); }
  }
}

function fichiers(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) fichiers(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

const extrait = s => { const t = String(s); return t.length <= 12 ? t : t.slice(0, 8) + '…(' + t.length + ' car.)'; };
const constats = [];
const liste = fichiers(racine);
for (const f of liste) {
  const rel = path.relative(racine, f).replace(/\\/g, '/');
  let texte;
  try { texte = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  if (texte.includes('\u0000')) { constats.push(`${rel} : fichier binaire, non contrôlé`); continue; }
  const lignes = texte.split(/\r?\n/);
  lignes.forEach((ligne, i) => {
    for (const r of REGLES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(ligne))) if (!r.garde || r.garde(m, i)) constats.push(`${rel}:${i + 1} : ${r.nom} : ${r.montrer ? r.montrer(m) : extrait(m[0])}`);
    }
    for (const t of termes) {
      t.lastIndex = 0;
      let m;
      while ((m = t.exec(ligne))) { constats.push(`${rel}:${i + 1} : terme privé : ${extrait(m[0])}`); if (!m[0]) break; }
    }
  });
  for (const t of termes) { t.lastIndex = 0; if (t.test(rel)) constats.push(`${rel} : terme privé dans le nom du fichier`); }
}

// Dossiers dont un changement est un changement du plugin installé (la documentation n'en fait pas partie).
const DOSSIERS_PLUGIN = ['scripts', 'hooks', 'skills', 'codex', 'commands', 'agents'];

function controlerVersion() {
  const out = [];
  const lire = rel => { try { return JSON.parse(fs.readFileSync(path.join(racine, rel), 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } };
  const manifeste = lire('.claude-plugin/plugin.json');
  if (!manifeste || typeof manifeste.version !== 'string') return out;
  const v = manifeste.version;
  const paquet = lire('package.json');
  if (paquet && typeof paquet.version === 'string' && paquet.version !== v) out.push(`package.json : version ${paquet.version}, le manifeste du plugin dit ${v}`);
  const place = lire('.claude-plugin/marketplace.json');
  for (const p of (place && Array.isArray(place.plugins) ? place.plugins : [])) {
    if (p && p.name === manifeste.name && typeof p.version === 'string' && p.version !== v) out.push(`.claude-plugin/marketplace.json : version ${p.version}, le manifeste du plugin dit ${v}`);
  }
  // Code changé depuis la dernière publication connue sans changement de version. Sans git, hors d'un dépôt,
  // ou sans branche amont : rien à comparer.
  const git = a => { try { return execFileSync('git', a, { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }).trim(); } catch (_) { return null; } };
  const reel = p => { try { return fs.realpathSync.native(p).toLowerCase(); } catch (_) { return null; } };
  const sommet = git(['rev-parse', '--show-toplevel']);
  if (!sommet || !reel(sommet) || reel(sommet) !== reel(racine)) return out;
  const amont = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!amont) return out;
  let publiee = null;
  try { publiee = JSON.parse(git(['show', `${amont}:.claude-plugin/plugin.json`]) || 'null'); } catch (_) { publiee = null; }
  if (!publiee || publiee.version !== v) return out;
  const changes = (git(['diff', '--name-only', amont, '--', ...DOSSIERS_PLUGIN]) || '').split(/\r?\n/).filter(Boolean);
  if (changes.length) out.push(`version : ${changes.length} fichier(s) du plugin ont changé depuis la dernière publication (${amont}) mais la version est restée ${v} : les installations existantes garderaient l'ancienne copie. Changez la version.`);
  return out;
}
constats.push(...controlerVersion());

for (const c of constats) process.stdout.write(c + '\n');
process.stdout.write(`${liste.length} fichier(s) contrôlé(s), ${REGLES.length} règle(s)${fichierTermes ? `, ${termes.length} terme(s) privé(s)` : ', aucun fichier de termes privés'} : ${constats.length ? constats.length + ' constat(s)' : 'rien à signaler'}.\n`);
process.exit(constats.length ? 1 : 0);
