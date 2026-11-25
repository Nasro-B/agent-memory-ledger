'use strict';
// Moteur commun des preuves par mutation d'UN fichier source testé par `node --test`.
// Une copie temporaire du fichier reçoit UNE ancre exacte altérée ; le banc est relancé avec `variable` pointant la copie
// et DOIT rougir. Une mutation survivante désigne un comportement que rien ne protège.
// Chaque mutation : { nom, suite, de, vers } ; `suite` est le motif de la suite du banc qui doit la tuer (essai rapide,
// sinon le banc entier est rejoué avant de déclarer la mutation survivante) ; `de` doit exister exactement une fois.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function compterOccurrences(texte, ancre) {
  if (!ancre) return 0;
  let n = 0;
  for (let i = texte.indexOf(ancre); i !== -1; i = texte.indexOf(ancre, i + ancre.length)) n++;
  return n;
}

function lancerBanc({ banc, variable, copie, suite, delaiMs }) {
  return new Promise(resolve => {
    const args = ['--test', '--test-concurrency=1', ...(suite ? [`--test-name-pattern=${suite}`] : []), banc];
    const enfant = spawn(process.execPath, args, { env: { ...process.env, [variable]: copie }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let sortie = '';
    let delaiDepasse = false;
    enfant.stdout.on('data', d => { sortie += d; });
    enfant.stderr.on('data', d => { sortie += d; });
    const minuteur = setTimeout(() => { delaiDepasse = true; enfant.kill(); }, delaiMs);
    enfant.on('close', code => { clearTimeout(minuteur); resolve({ code, sortie, delaiDepasse }); });
  });
}

// Le premier test en échec du banc : on voit ainsi qu'une mutation est tuée pour la bonne raison.
function raisonEchec(sortie) {
  const lignes = sortie.split('\n').map(l => l.trim());
  const premier = lignes.find(l => /^not ok \d+ - /.test(l)) || lignes.filter(Boolean).pop() || 'sortie vide';
  return premier.length > 140 ? `${premier.slice(0, 137)}...` : premier;
}

// null si la mutation s'applique à ce texte, sinon la raison pour laquelle elle ne s'applique pas.
function problemeAncre(texte, m) {
  const n = compterOccurrences(texte, m.de);
  if (n !== 1) return `ancre trouvée ${n} fois (attendu : 1)`;
  if (m.vers === m.de) return 'mutation identique à l ancre';
  return null;
}

// --ancres : vérifie, sans lancer le banc, que chaque ancre est présente une seule fois dans le fichier source (code 0 si toutes le sont).
// À lancer après toute modification du fichier : une ancre périmée n'est détectée sinon qu'au milieu d'une longue exécution.
function verifierAncres(texte, mutations) {
  let invalides = 0;
  for (const m of mutations) {
    const probleme = problemeAncre(texte, m);
    if (probleme) { invalides++; process.stdout.write(`ANCRE      ${m.nom} (${probleme})\n`); }
  }
  process.stdout.write(`${mutations.length - invalides} ancres valides sur ${mutations.length}\n`);
  return invalides === 0 ? 0 : 1;
}

async function essayer(cfg, m, dossier) {
  const probleme = problemeAncre(cfg.texte, m);
  if (probleme) return { nom: m.nom, etat: 'ANCRE', detail: probleme };
  const copie = path.join(dossier, `${m.nom}.js`);
  // La mutation s'applique au texte d'origine ; les réécritures d'environnement (chemins absolus à la place des chemins
  // relatifs au fichier) viennent ensuite : la copie vit dans un dossier temporaire.
  let muté = cfg.texte.replace(m.de, () => m.vers);
  for (const [de, vers] of cfg.reecritures) muté = muté.split(de).join(vers);
  fs.writeFileSync(copie, muté);
  const debut = Date.now();
  const base = { banc: cfg.banc, variable: cfg.variable, copie, delaiMs: cfg.delaiMs };
  let r = await lancerBanc({ ...base, suite: m.suite });
  let portee = `suite ${m.suite}`;
  if (r.code === 0) { r = await lancerBanc({ ...base, suite: null }); portee = 'banc entier'; }
  const duree = ((Date.now() - debut) / 1000).toFixed(1);
  // Un banc interrompu par le délai n'a rien prouvé : sous charge, il ne compte jamais comme une mutation tuée.
  if (r.delaiDepasse) return { nom: m.nom, etat: 'DELAI', detail: `${portee}, ${duree} s : délai dépassé, verdict inconnu` };
  if (r.code === 0) return { nom: m.nom, etat: 'SURVIVANTE', detail: `${portee}, ${duree} s` };
  return { nom: m.nom, etat: 'TUEE', detail: `${portee}, ${duree} s : ${raisonEchec(r.sortie)}` };
}

// Retourne le code de sortie : 0 si le témoin est vert et toutes les mutations sont tuées, 1 sinon, 2 si l'appel est faux.
// Variables : MUTATIONS_CONCURRENCE (bancs lancés en parallèle ; défaut : celui du script), MUTATIONS_DELAI_MS (délai d'un banc ; défaut : 5 minutes).
// États : TUEE (le banc a rougi, avec sa cause), SURVIVANTE (il est resté vert), ANCRE (l'ancre ne s'applique pas), DELAI (délai dépassé : aucun verdict).
async function executer({ source, banc, variable, mutations, argv, reecritures = [], concurrence = 3, delaiMs = 5 * 60 * 1000 }) {
  if (argv.includes('--liste')) { for (const m of mutations) process.stdout.write(`${m.nom}\n`); return 0; }
  const seulementAncres = argv.includes('--ancres');
  const noms = argv.filter(a => a !== '--ancres');
  const inconnues = noms.filter(a => !mutations.some(m => m.nom === a));
  if (inconnues.length) { process.stderr.write(`mutation inconnue : ${inconnues.join(', ')}\n`); return 2; }
  const choisies = noms.length ? mutations.filter(m => noms.includes(m.nom)) : mutations;
  const texte = fs.readFileSync(source, 'utf8');
  for (const [de] of reecritures) {
    if (compterOccurrences(texte, de) < 1) { process.stderr.write(`réécriture d environnement sans effet : ${de}\n`); return 2; }
  }
  // La copie mutée vit dans un dossier temporaire : un require relatif qui n'a pas été réécrit en chemin absolu y échoue, et le banc
  // rougit pour une raison sans rapport avec la mutation (toutes les mutations seraient « tuées » à tort).
  let reecrit = texte;
  for (const [de, vers] of reecritures) reecrit = reecrit.split(de).join(vers);
  const relatifs = [...new Set([...reecrit.matchAll(/require\(\s*(['"`])\.{1,2}[\\/][^'"`]*\1\s*\)/g)].map(m => m[0].replace(/\s+/g, ' ').replace('( ', '(').replace(' )', ')')))];
  if (relatifs.length) {
    process.stderr.write(`require relatif non réécrit (la copie mutée vit dans un dossier temporaire) : ${relatifs.join(', ')}\n`);
    return 2;
  }
  if (seulementAncres) return verifierAncres(texte, choisies);
  const parallele = Math.max(1, Number(process.env.MUTATIONS_CONCURRENCE) || concurrence);
  delaiMs = Number(process.env.MUTATIONS_DELAI_MS) || delaiMs;
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'mutations-'));
  const cfg = { texte, banc, variable, delaiMs, reecritures };
  try {
    const temoin = await lancerBanc({ banc, variable, copie: source, suite: null, delaiMs });
    process.stdout.write(`TEMOIN non mute : ${temoin.code === 0 ? 'vert' : temoin.delaiDepasse ? 'DELAI DEPASSE' : 'ROUGE'}\n`);
    if (temoin.code !== 0) { process.stdout.write(`${temoin.sortie.split('\n').slice(-40).join('\n')}\n`); return 1; }
    const file = choisies.slice();
    const resultats = [];
    await Promise.all(Array.from({ length: parallele }, async () => {
      for (let m = file.shift(); m; m = file.shift()) {
        const r = await essayer(cfg, m, dossier);
        resultats.push(r);
        process.stdout.write(`${r.etat.padEnd(10)} ${r.nom} (${r.detail})\n`);
      }
    }));
    const tuees = resultats.filter(r => r.etat === 'TUEE').length;
    process.stdout.write(`\n${tuees} mutations tuées sur ${resultats.length}\n`);
    for (const r of resultats.filter(x => x.etat !== 'TUEE')) process.stdout.write(`A TRAITER : ${r.etat} ${r.nom} : ${r.detail}\n`);
    return tuees === resultats.length ? 0 : 1;
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

module.exports = { executer };
