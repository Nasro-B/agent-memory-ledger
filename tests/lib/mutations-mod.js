'use strict';
// Moteur commun des preuves par mutation d'un MODULE d'interface de Claude Code (dossier avec hooks/ et tests/, voir mods/).
// Chaque mutation altère UNE ancre exacte dans une copie temporaire du module ; `claude plugin test` lancé sur la copie doit alors ROUGIR.
// Une mutation survivante désigne un comportement que rien ne protège.
// Mutation : { nom, f (fichier relatif au module), de (ancre, présente une seule fois), vers }.
// Variables : AML_MOTEUR_CLAUDE (le programme `claude` à lancer ; défaut : la commande `claude` du chemin d'exécution),
//   MUTATIONS_CONCURRENCE (bancs lancés en parallèle ; défaut : celui du script), MUTATIONS_DELAI_MS (délai d'un banc ; défaut : 3 minutes).
// États : TUEE (le banc a rougi, avec sa cause), SURVIVANTE (il est resté vert), ANCRE (l'ancre ne s'applique pas), DELAI (délai dépassé : aucun verdict).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { trouverMoteur } = require('../../scripts/lib/moteur-claude.js'); // le programme `claude` et la preuve qu'il lance les bancs d'un module

function compterOccurrences(texte, ancre) {
  if (!ancre) return 0;
  let n = 0;
  for (let i = texte.indexOf(ancre); i !== -1; i = texte.indexOf(ancre, i + ancre.length)) n++;
  return n;
}

function lancer(moteur, dossier, delaiMs) {
  return new Promise(resolve => {
    const enfant = spawn(moteur, ['plugin', 'test', dossier], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let sortie = '';
    let delaiDepasse = false;
    enfant.stdout.on('data', d => { sortie += d; });
    enfant.stderr.on('data', d => { sortie += d; });
    enfant.on('error', e => { sortie += String(e && e.message); });
    const minuteur = setTimeout(() => { delaiDepasse = true; enfant.kill(); }, delaiMs);
    enfant.on('close', code => { clearTimeout(minuteur); resolve({ code, sortie, delaiDepasse }); });
  });
}

// Les premières lignes qui disent pourquoi le banc a rougi : on voit ainsi qu'une mutation est tuée pour la bonne raison.
function raisonEchec(sortie) {
  const lignes = sortie.split('\n').map(l => l.trim()).filter(l => /^\(fail\)|unhandled|rejection|error/i.test(l));
  return lignes.slice(0, 2).map(l => (l.length > 140 ? `${l.slice(0, 137)}...` : l)).join(' | ') || 'sortie sans cause lisible';
}

const copier = (de, vers) => fs.cpSync(de, vers, { recursive: true, filter: s => !s.includes(`${path.sep}node_modules`) });

// null si la mutation s'applique à ce texte, sinon la raison pour laquelle elle ne s'applique pas.
function problemeAncre(source, m) {
  const n = compterOccurrences(source, m.de);
  if (n !== 1) return `ancre trouvée ${n} fois dans ${m.f} (attendu : 1)`;
  if (m.vers === m.de) return 'mutation identique à l ancre';
  return null;
}

async function essayer({ mod, moteur, racine, delaiMs }, m) {
  const copie = path.join(racine, m.nom);
  copier(mod, copie);
  const cible = path.join(copie, m.f);
  const source = fs.readFileSync(cible, 'utf8');
  const probleme = problemeAncre(source, m);
  if (probleme) return { nom: m.nom, etat: 'ANCRE', detail: probleme };
  fs.writeFileSync(cible, source.replace(m.de, () => m.vers));
  const debut = Date.now();
  const r = await lancer(moteur, copie, delaiMs);
  const duree = `${m.f}, ${((Date.now() - debut) / 1000).toFixed(1)} s`;
  // Un banc interrompu par le délai n'a rien prouvé : sous charge, il ne compte jamais comme une mutation tuée.
  if (r.delaiDepasse) return { nom: m.nom, etat: 'DELAI', detail: `${duree} : délai dépassé, verdict inconnu` };
  if (r.code === 0) return { nom: m.nom, etat: 'SURVIVANTE', detail: duree };
  return { nom: m.nom, etat: 'TUEE', detail: `${duree} : ${raisonEchec(r.sortie)}` };
}

// --ancres : vérifie, sans lancer le moteur, que chaque ancre est présente une seule fois dans son fichier (code de sortie 0 si toutes le sont).
// À lancer après toute modification du code du module : une ancre périmée n'est détectée sinon qu'au milieu d'une longue exécution.
function verifierAncres(mod, mutations) {
  let invalides = 0;
  for (const m of mutations) {
    let probleme;
    try {
      probleme = problemeAncre(fs.readFileSync(path.join(mod, m.f), 'utf8'), m);
    } catch {
      probleme = `fichier illisible : ${m.f}`;
    }
    if (probleme) { invalides++; process.stdout.write(`ANCRE      ${m.nom} (${probleme})\n`); }
  }
  process.stdout.write(`${mutations.length - invalides} ancres valides sur ${mutations.length}\n`);
  return invalides === 0 ? 0 : 1;
}

// Retourne le code de sortie : 0 si le témoin est vert et toutes les mutations sont tuées, 1 sinon, 2 si l'appel est faux ou le moteur introuvable.
async function executer({ mod, mutations, argv, concurrence = 4, delaiMs = 3 * 60 * 1000 }) {
  if (argv.includes('--liste')) { for (const m of mutations) process.stdout.write(`${m.nom}\n`); return 0; }
  const seulementAncres = argv.includes('--ancres');
  const noms = argv.filter(a => a !== '--ancres');
  const inconnues = noms.filter(a => !mutations.some(m => m.nom === a));
  if (inconnues.length) { process.stderr.write(`mutation inconnue : ${inconnues.join(', ')}\n`); return 2; }
  const choisies = noms.length ? mutations.filter(m => noms.includes(m.nom)) : mutations;
  if (seulementAncres) return verifierAncres(mod, choisies);
  const parallele = Math.max(1, Number(process.env.MUTATIONS_CONCURRENCE) || concurrence);
  delaiMs = Number(process.env.MUTATIONS_DELAI_MS) || delaiMs;
  const trouve = trouverMoteur();
  if (trouve.erreur) { process.stderr.write(`${trouve.erreur}\n`); return 2; }
  const { moteur } = trouve;
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'mutations-mod-'));
  try {
    process.stdout.write(`moteur : ${moteur}\nmodule : ${mod}\n`);
    const temoinDossier = path.join(racine, '_temoin');
    copier(mod, temoinDossier);
    const temoin = await lancer(moteur, temoinDossier, delaiMs);
    process.stdout.write(`TEMOIN non mute : ${temoin.code === 0 ? 'vert' : temoin.delaiDepasse ? 'DELAI DEPASSE' : 'ROUGE'}\n`);
    if (temoin.code !== 0) { process.stdout.write(`${temoin.sortie.split('\n').slice(-40).join('\n')}\n`); return 1; }
    const file = choisies.slice();
    const resultats = [];
    await Promise.all(Array.from({ length: parallele }, async () => {
      for (let m = file.shift(); m; m = file.shift()) {
        const r = await essayer({ mod, moteur, racine, delaiMs }, m);
        resultats.push(r);
        process.stdout.write(`${r.etat.padEnd(10)} ${r.nom} (${r.detail})\n`);
      }
    }));
    const tuees = resultats.filter(r => r.etat === 'TUEE').length;
    process.stdout.write(`\n${tuees} mutations tuées sur ${resultats.length}\n`);
    for (const r of resultats.filter(x => x.etat !== 'TUEE')) process.stdout.write(`A TRAITER : ${r.etat} ${r.nom} : ${r.detail}\n`);
    return tuees === resultats.length ? 0 : 1;
  } finally {
    fs.rmSync(racine, { recursive: true, force: true });
  }
}

module.exports = { executer };
