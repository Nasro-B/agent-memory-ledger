'use strict';
// Preuve par mutation du banc pause-core.test.js (entrées-sorties de la Pause : lib/pause-core.js).
//   node tests/mutations/mutations-pause-core.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-pause-core.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-pause-core.js --liste         affiche les noms
//   node tests/mutations/mutations-pause-core.js --ancres        vérifie seulement que chaque ancre existe une fois
// Les commandes de cockpit.js (pause, reprendre, pause-hook) sont mutées par mutations-pause-cli.js.
// Mutations jugées équivalentes (non écrites) :
//   - `typeof session === 'string' &&` de battre : Object.hasOwn(sessions, <autre chose qu'un texte>) est faux de lui-même, inscrire refuse déjà ces fiches ;
//   - `reste <= 0` devenu `reste < 0` dans attendre : l'instant exact où il reste zéro milliseconde ne s'observe pas ;
//   - `return await attendre(` devenu `return attendre(` dans executerHook : aucune exception ne peut sortir de attendre (la lecture de l'état
//     rend toujours une valeur et dormir ne rejette pas), donc le try/catch n'a rien à rattraper à cet endroit ;
//   - `|| String(e)` de message devenu `|| ''` : toutes les exceptions rencontrées sont des Error qui portent un message.
// Écriture des ancres : T`...` garde les barres obliques inverses telles quelles ; § { remplace dollar-accolade ; ¤ remplace l'accent grave.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib');
const T = strings => String.raw(strings).replaceAll('§{', '${').replaceAll('¤', '`').replaceAll('\\n', '\n');
const mut = (nom, suite, de, vers) => ({ nom, suite, de, vers });

const MUTATIONS = [
  // constantes
  mut('pausecore-duree-defaut', 'attendre', T`const DUREE_ATTENTE_DEFAUT_MS = 20_000;`, T`const DUREE_ATTENTE_DEFAUT_MS = 21_000;`),
  mut('pausecore-duree-max', 'attendre', T`const DUREE_ATTENTE_MAX_MS = 9 * 60 * 1000;`, T`const DUREE_ATTENTE_MAX_MS = 10 * 60 * 1000;`),
  mut('pausecore-periode', 'attendre', T`const PERIODE_ATTENTE_MS = 500;`, T`const PERIODE_ATTENTE_MS = 5000;`),
  mut('pausecore-sens-sans-pause', 'appliquerCommande', T`const SENS = new Set(['pause', 'reprendre']);`, T`const SENS = new Set(['reprendre']);`),
  mut('pausecore-sens-sans-reprendre', 'appliquerCommande', T`const SENS = new Set(['pause', 'reprendre']);`, T`const SENS = new Set(['pause']);`),
  mut('pausecore-sens-accepte-tout', 'appliquerCommande', T`const SENS = new Set(['pause', 'reprendre']);`, T`const SENS = new Set(['pause', 'reprendre', 'arreter', '', undefined, 'PAUSE']);`),
  mut('pausecore-fichier', 'lire et écrire', T`path.join(cockpit.racine(), 'pause.json')`, T`path.join(cockpit.racine(), 'pauses.json')`),
  // lecture et écriture
  mut('pausecore-lecture-brute', 'lire et écrire', T`return logique.normaliserEtat(cockpit.lireJson(fichier(), null));`, T`return cockpit.lireJson(fichier(), null) ?? { sessions: {} };`),
  mut('pausecore-ecriture-brute', 'lire et écrire', T`cockpit.ecrireJson(fichier(), { ...logique.normaliserEtat(etat), maj: new Date().toISOString() });`, T`cockpit.ecrireJson(fichier(), { ...etat, maj: new Date().toISOString() });`),
  mut('pausecore-ecriture-sans-heure', 'lire et écrire', T`{ ...logique.normaliserEtat(etat), maj: new Date().toISOString() }`, T`{ ...logique.normaliserEtat(etat) }`),
  mut('pausecore-enregistre-toujours', 'appliquerCommande', T`if (JSON.stringify(avant) !== JSON.stringify(apres)) ecrireEtat(apres);`, T`ecrireEtat(apres);`),
  mut('pausecore-enregistre-jamais', 'appliquerCommande', T`if (JSON.stringify(avant) !== JSON.stringify(apres)) ecrireEtat(apres);`, T`if (false) ecrireEtat(apres);`),
  // battre
  mut('pausecore-battre-ok-toujours', 'battre', T`return { ok: typeof session === 'string' && Object.hasOwn(apres.sessions, session) };`, T`return { ok: true };`),
  mut('pausecore-battre-instant-zero', 'battre', T`function battre({ session, titre, agents, maintenant = Date.now() }) {`, T`function battre({ session, titre, agents, maintenant = 0 }) {`),
  mut('pausecore-battre-sans-titre', 'battre', T`logique.inscrire(avant, { session, titre, agents }, maintenant)`, T`logique.inscrire(avant, { session, agents }, maintenant)`),
  mut('pausecore-battre-sans-agents', 'battre', T`logique.inscrire(avant, { session, titre, agents }, maintenant)`, T`logique.inscrire(avant, { session, titre }, maintenant)`),
  mut('pausecore-battre-sans-ecriture', 'battre', T`    const apres = logique.inscrire(avant, { session, titre, agents }, maintenant);
    enregistrer(avant, apres);`, T`    const apres = logique.inscrire(avant, { session, titre, agents }, maintenant);`),
  // appliquerCommande
  mut('pausecore-cmd-sens-inconnu', 'appliquerCommande', T`if (!SENS.has(sens)) return { erreur:`, T`if (false) return { erreur:`),
  mut('pausecore-cmd-sens-texte', 'appliquerCommande', T`§{String(sens)} (pause ou reprendre).`, T`§{String(sens)}.`),
  mut('pausecore-cmd-cible-ignoree', 'appliquerCommande', T`  let cible = contexte.cible;`, T`  let cible;`),
  mut('pausecore-cmd-ref-vide', 'appliquerCommande', T`if (contexte.sessionRef !== undefined) {`, T`if (contexte.sessionRef) {`),
  mut('pausecore-cmd-ref-ignoree', 'appliquerCommande', T`if (contexte.sessionRef !== undefined) {`, T`if (false) {`),
  mut('pausecore-cmd-ref-erreur', 'appliquerCommande', T`      if (r.erreur) return { erreur: r.erreur };
      cible = r.id;`, T`      cible = r.id;`),
  mut('pausecore-cmd-ref-cible', 'appliquerCommande', T`    cible = r.id;`, T`    cible = contexte.cible;`),
  mut('pausecore-cmd-sans-instant', 'appliquerCommande', T`{ maintenant: Date.now(), ...contexte, cible }`, T`{ ...contexte, cible }`),
  mut('pausecore-cmd-sans-contexte', 'appliquerCommande', T`{ maintenant: Date.now(), ...contexte, cible }`, T`{ maintenant: Date.now(), cible }`),
  mut('pausecore-cmd-sans-cible', 'appliquerCommande', T`{ maintenant: Date.now(), ...contexte, cible }`, T`{ maintenant: Date.now(), ...contexte }`),
  mut('pausecore-cmd-instant-ecrase', 'appliquerCommande', T`{ maintenant: Date.now(), ...contexte, cible }`, T`{ ...contexte, maintenant: Date.now(), cible }`),
  mut('pausecore-cmd-erreur-ignoree', 'appliquerCommande', T`    if (r.erreur) return { erreur: r.erreur };
    try {`, T`    try {`),
  mut('pausecore-cmd-sans-try', 'appliquerCommande', T`    try {
      enregistrer(avant, r.etat);
    } catch (e) {
      return { erreur: ¤Écriture impossible dans §{fichier()} (§{message(e)}) : rien n'a changé.¤ };
    }`, T`    enregistrer(avant, r.etat);`),
  mut('pausecore-cmd-ecriture-texte', 'appliquerCommande', T`(§{message(e)}) : rien n'a changé.`, T`: rien n'a changé.`),
  mut('pausecore-cmd-message', 'appliquerCommande', T`    return { message: r.message };
  });`, T`    return { message: 'ok' };
  });`),
  // attente
  mut('pausecore-attendre-agent', 'attendre', T`const doitAttendre = (session, agentId) => logique.doitAttendre(lireEtat(), session, agentId);`, T`const doitAttendre = (session, agentId) => logique.doitAttendre(lireEtat(), session);`),
  mut('pausecore-attendre-etat', 'attendre', T`logique.doitAttendre(lireEtat(), session, agentId)`, T`logique.doitAttendre(etatCache, session, agentId)`),
  mut('pausecore-duree-negative', 'attendre', T`Number.isFinite(ms) && ms >= 0 ? Math.min(ms, DUREE_ATTENTE_MAX_MS) : DUREE_ATTENTE_DEFAUT_MS`, T`Number.isFinite(ms) && ms > 0 ? Math.min(ms, DUREE_ATTENTE_MAX_MS) : DUREE_ATTENTE_DEFAUT_MS`),
  mut('pausecore-duree-non-bornee', 'attendre', T`Number.isFinite(ms) && ms >= 0 ? Math.min(ms, DUREE_ATTENTE_MAX_MS) : DUREE_ATTENTE_DEFAUT_MS`, T`Number.isFinite(ms) && ms >= 0 ? ms : DUREE_ATTENTE_DEFAUT_MS`),
  mut('pausecore-duree-nan', 'attendre', T`Number.isFinite(ms) && ms >= 0 ?`, T`ms >= 0 ?`),
  mut('pausecore-duree-sans-borne-basse', 'attendre', T`Number.isFinite(ms) && ms >= 0 ?`, T`Number.isFinite(ms) ?`),
  mut('pausecore-attendre-fin', 'attendre', T`const fin = Date.now() + dureeBornee(dureeMaxMs);`, T`const fin = Date.now() + DUREE_ATTENTE_DEFAUT_MS;`),
  mut('pausecore-attendre-libre', 'attendre', T`if (!d.attendre) return { enPause: false };`, T`if (!d.attendre) return { enPause: true };`),
  mut('pausecore-attendre-jamais-libre', 'attendre', T`    if (!d.attendre) return { enPause: false };\n`, T``),
  mut('pausecore-attendre-sans-cible', 'attendre', T`return { enPause: true, cible: d.cible, depuis: d.depuis };`, T`return { enPause: true, depuis: d.depuis };`),
  mut('pausecore-attendre-sans-depuis', 'attendre', T`return { enPause: true, cible: d.cible, depuis: d.depuis };`, T`return { enPause: true, cible: d.cible };`),
  mut('pausecore-attendre-sans-borne-du-sommeil', 'attendre', T`await dormir(Math.min(periodeMs, reste));`, T`await dormir(periodeMs);`),
  mut('pausecore-attendre-periode-fixe', 'attendre', T`await dormir(Math.min(periodeMs, reste));`, T`await dormir(Math.min(PERIODE_ATTENTE_MS, reste));`),
  mut('pausecore-attendre-periode-defaut', 'attendre', T`async function attendre({ session, agentId, dureeMaxMs, periodeMs = PERIODE_ATTENTE_MS }) {`, T`async function attendre({ session, agentId, dureeMaxMs, periodeMs = 60000 }) {`),
  // opérations des hooks
  mut('pausecore-hook-entree', 'opérations', T`if (!estObjet(entree)) return { erreur: 'entrée invalide' };`, T`if (false) return { erreur: 'entrée invalide' };`),
  mut('pausecore-hook-battre-instant', 'opérations', T`maintenant: Number.isFinite(entree.maintenant) ? entree.maintenant : Date.now() });`, T`maintenant: Date.now() });`),
  mut('pausecore-hook-battre-instant-brut', 'opérations', T`maintenant: Number.isFinite(entree.maintenant) ? entree.maintenant : Date.now() });`, T`maintenant: entree.maintenant });`),
  mut('pausecore-hook-battre-titre', 'opérations', T`titre: entree.titre, agents: entree.agents,`, T`agents: entree.agents,`),
  mut('pausecore-hook-battre-agents', 'opérations', T`titre: entree.titre, agents: entree.agents,`, T`titre: entree.titre,`),
  mut('pausecore-hook-cmd-args', 'opérations', T`typeof entree.args === 'string' ? entree.args : ''`, T`entree.args`),
  mut('pausecore-hook-cmd-args-ignores', 'opérations', T`typeof entree.args === 'string' ? entree.args : ''`, T`''`),
  mut('pausecore-hook-cmd-ref', 'opérations', T`sessionRef: typeof entree.sessionRef === 'string' ? entree.sessionRef : undefined,`, T`sessionRef: entree.sessionRef,`),
  mut('pausecore-hook-cmd-ref-perdue', 'opérations', T`sessionRef: typeof entree.sessionRef === 'string' ? entree.sessionRef : undefined,`, T`sessionRef: undefined,`),
  mut('pausecore-hook-cmd-fiche', 'opérations', T`fiche: estObjet(entree.fiche) ? entree.fiche : undefined,`, T`fiche: entree.fiche,`),
  mut('pausecore-hook-cmd-fiche-perdue', 'opérations', T`fiche: estObjet(entree.fiche) ? entree.fiche : undefined,`, T`fiche: undefined,`),
  mut('pausecore-hook-cmd-session', 'opérations', T`          session: entree.session,\n          sessionRef`, T`          sessionRef`),
  mut('pausecore-hook-cmd-sens', 'opérations', T`appliquerCommande(entree.sens, typeof entree.args`, T`appliquerCommande('pause', typeof entree.args`),
  mut('pausecore-hook-attendre-session', 'opérations', T`if (typeof entree.session !== 'string' || entree.session === '') return { erreur: 'entrée invalide' };`, T`if (entree.session === '') return { erreur: 'entrée invalide' };`),
  mut('pausecore-hook-attendre-session-vide', 'opérations', T`if (typeof entree.session !== 'string' || entree.session === '') return { erreur: 'entrée invalide' };`, T`if (typeof entree.session !== 'string') return { erreur: 'entrée invalide' };`),
  mut('pausecore-hook-attendre-agent', 'opérations', T`agentId: typeof entree.agentId === 'string' ? entree.agentId : undefined,`, T`agentId: undefined,`),
  mut('pausecore-hook-attendre-agent-brut', 'opérations', T`agentId: typeof entree.agentId === 'string' ? entree.agentId : undefined,`, T`agentId: entree.agentId,`),
  mut('pausecore-hook-attendre-duree', 'opérations', T`dureeMaxMs: entree.dureeMs });`, T`dureeMaxMs: undefined });`),
  mut('pausecore-hook-inconnue', 'opérations', T`return { erreur: ¤opération inconnue : §{operation}¤ };`, T`return { erreur: 'opération inconnue' };`),
  mut('pausecore-hook-panne', 'opérations', T`    return { erreur: message(e) };\n  }\n}`, T`    return {};\n  }\n}`),
  mut('pausecore-message-sans-message', 'opérations', T`const message = e => (e && e.message) || String(e);`, T`const message = e => String(e);`),
  // verrou d'écriture
  mut('pausecore-verrou-peremption-courte', 'verrou', T`const VERROU_PERIME_MS = 5000;`, T`const VERROU_PERIME_MS = 3000;`),
  mut('pausecore-verrou-peremption-longue', 'verrou', T`const VERROU_PERIME_MS = 5000;`, T`const VERROU_PERIME_MS = 8000;`),
  mut('pausecore-verrou-attente-courte', 'verrou', T`const ATTENTE_VERROU_MS = 2000;`, T`const ATTENTE_VERROU_MS = 1000;`),
  mut('pausecore-verrou-attente-longue', 'verrou', T`const ATTENTE_VERROU_MS = 2000;`, T`const ATTENTE_VERROU_MS = 6000;`),
  mut('pausecore-verrou-pas-long', 'verrou', T`const PAS_VERROU_MS = 10;`, T`const PAS_VERROU_MS = 1500;`),
  mut('pausecore-verrou-jamais-perime', 'verrou', T`return Date.now() - fs.statSync(verrou).mtimeMs > VERROU_PERIME_MS;`, T`return false;`),
  mut('pausecore-verrou-perime-inverse', 'verrou', T`mtimeMs > VERROU_PERIME_MS;`, T`mtimeMs < VERROU_PERIME_MS;`),
  mut('pausecore-verrou-retrait-sans-effet', 'verrou', T`try { fs.unlinkSync(verrou); return true; }`, T`try { return true; }`),
  mut('pausecore-verrou-non-exclusif', 'verrou', T`fs.openSync(verrou, 'wx')`, T`fs.openSync(verrou, 'w')`),
  mut('pausecore-verrou-occupe-sans-eexist', 'verrou', T`new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])`, T`new Set(['EPERM', 'EACCES', 'EBUSY'])`),
  mut('pausecore-verrou-occupe-sans-eperm', 'verrou', T`new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])`, T`new Set(['EEXIST', 'EACCES', 'EBUSY'])`),
  mut('pausecore-verrou-occupe-sans-eacces', 'verrou', T`new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])`, T`new Set(['EEXIST', 'EPERM', 'EBUSY'])`),
  mut('pausecore-verrou-occupe-sans-ebusy', 'verrou', T`new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])`, T`new Set(['EEXIST', 'EPERM', 'EACCES'])`),
  mut('pausecore-verrou-toute-erreur-attend', 'verrou', T`      if (!VERROU_OCCUPE.has(e.code)) return false;\n`, T``),
  mut('pausecore-verrou-toute-erreur-sans-verrou', 'verrou', T`if (!VERROU_OCCUPE.has(e.code)) return false;`, T`return false;`),
  mut('pausecore-verrou-peri-jamais-repris', 'verrou', T`    if (verrouPerime(verrou) && retirer(verrou)) continue;\n`, T``),
  mut('pausecore-verrou-attente-sans-fin', 'verrou', T`    if (Date.now() >= fin) return false;\n`, T``),
  mut('pausecore-verrou-liberation-omise', 'verrou', T`    if (pris) retirer(verrou);\n`, T``),
  mut('pausecore-verrou-liberation-sans-condition', 'verrou', T`if (pris) retirer(verrou);`, T`retirer(verrou);`),
  mut('pausecore-verrou-pris-force', 'verrou', T`pris = prendreVerrou(verrou);`, T`prendreVerrou(verrou); pris = true;`),
  mut('pausecore-verrou-sans-finally', 'verrou', T`  try {\n    return section();\n  } finally {\n    if (pris) retirer(verrou);\n  }`, T`  const resultat = section();\n  if (pris) retirer(verrou);\n  return resultat;`),
  mut('pausecore-verrou-resultat-perdu', 'verrou', T`    return section();`, T`    section();\n    return undefined;`),
  mut('pausecore-verrou-dossier-omis', 'verrou', T`    fs.mkdirSync(path.dirname(verrou), { recursive: true });\n`, T``),
  mut('pausecore-verrou-nom', 'verrou', T`¤§{fichier()}.verrou¤`, T`¤§{fichier()}.lock¤`),
  mut('pausecore-verrou-battre-sans', 'verrou', T`  return avecVerrou(() => {\n    const avant = lireEtat();\n    const apres = logique.inscrire(`, T`  return (() => {\n    const avant = lireEtat();\n    const apres = logique.inscrire(`),
  mut('pausecore-verrou-commande-sans', 'verrou', T`  return avecVerrou(() => {\n    const avant = lireEtat();\n    let cible = contexte.cible;`, T`  return (() => {\n    const avant = lireEtat();\n    let cible = contexte.cible;`),
  mut('pausecore-verrou-non-exporte', 'verrou', T`module.exports = { avecVerrou, lireEtat,`, T`module.exports = { lireEtat,`),
];

executer({
  source: path.join(LIB, 'pause-core.js'),
  banc: path.join(__dirname, '..', 'pause-core.test.js'),
  variable: 'PAUSE_CORE_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('./cockpit-core.js')", `require(${JSON.stringify(path.join(LIB, 'cockpit-core.js'))})`],
    ["require('./pause-logique.mjs')", `require(${JSON.stringify(path.join(LIB, 'pause-logique.mjs'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
