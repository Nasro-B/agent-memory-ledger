'use strict';
/**
 * Noyau commun du Cockpit : un seul calcul pour tous les agents (commande, panneaux et hooks).
 * Mesure l'état réel du travail : fichier contexte (ledger), sous-agents, git des worktrees,
 * avancement des plans à cases, quota des agents. Ne modifie jamais un dépôt, un plan ni le ledger.
 *
 * Emplacements (lus à chaque appel, déplaçables pour les bancs) :
 *   COCKPIT_DIR          dossier d'état du Cockpit, défaut <maison>/cockpit (la maison : AGENT_MEMORY_LEDGER_HOME, sinon ~/.agent-memory-ledger, voir config.js)
 *   CONTEXT_LEDGER_DIR   dossier de la liste de travail, défaut <maison>/contexte (lecture seule ici ; même emplacement que context-ledger-core.js)
 *
 * Fichiers d'état (dans COCKPIT_DIR), écrits de façon atomique :
 *   config.json          réglages de l'utilisateur (worktrees, plans) ; absent ou mal formé = valeurs par défaut
 *   git-etat.json        dernière mesure git (rafraichirGit), relue par lireGitEtat avec son âge
 *   git-etat.verrou      verrou d'un rafraîchissement git en cours (pid + heure)
 *   quota-<agent>.json   dernière mesure de quota d'un agent (ecrireQuota)
 *   politique-agents.json, consignes.json, file-agents.json, nuit.json, nuit-boite.json, pause.json   alimentés par les autres modules ; chacun
 *                        est normalisé par sa logique commune (la nuit, sa boîte et la pause se lisent comme vides quand ils sont absents ou abîmés)
 *
 * API : racine, lireJson, ecrireJson, lireConfig, ecrireConfig, appliquerConfig, lireConsignes, resumeLedger, avancementPlans, analyserDepot,
 *       rafraichirGit, lireGitEtat, ecrireQuota, lireQuota, instantane, ligneCockpit, blocCockpit.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const regulateur = require('./regulateur-logique.mjs');
const logiqueConsignes = require('./consignes-logique.mjs');
const logiqueFile = require('./file-logique.mjs');
const logiqueConfig = require('./config-logique.mjs');
const logiqueNuit = require('./nuit-logique.mjs');
const logiquePause = require('./pause-logique.mjs');
const modelesAgents = require('./modeles-agents-core.js');
const emplacements = require('./config.js'); // la maison du plugin et l'emplacement de la liste de travail

const BRANCHE_PRINCIPALE = 'main';
const DELAI_GIT_MS = 60000; // marge large : un disque lent ou un grand dépôt peut mettre plusieurs secondes
const VERROU_PERIME_MS = 10 * 60 * 1000;
const TERMINAUX = new Set(['fait', 'abandon-utilisateur']); // context-ledger-core.js : TERMINAUX
const FINS_REUSSIES = new Set(['completed', 'terminé', 'termine']); // valeurs vues dans le ledger : completed, terminé, failed, killed
const LIMITE_BLOC = 700;
const ESSAIS_RENOMMAGE = 5;
const LARGEUR_NOM_AGENT = 40;
// Un agent « en cours » dont la ligne n'a pas bougé depuis plus de trois heures (ou sans date lisible) est un zombie : sa fin
// n'a jamais été reçue. Il ne tient aucun créneau (Régulateur) et ne compte pas comme « en cours » (Cockpit). Défini une seule fois.
const AGE_MAX_EN_COURS_MS = 3 * 60 * 60 * 1000;

// Les réglages par défaut (aucun worktree, aucun dossier de plans, profondeur de recherche 3) vivent dans config-logique.mjs,
// source unique partagée avec le module Consignes.
const DEFAUTS = logiqueConfig.DEFAUTS;

const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const chaineNonVide = v => typeof v === 'string' && v.trim() !== '';
const court = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };
const numero = id => { const m = /(\d+)$/.exec(id); return m ? Number(m[1]) : Infinity; };
const comparerIds = (a, b) => numero(a) - numero(b) || (a < b ? -1 : a > b ? 1 : 0);
const sur = (fn, repli) => { try { return fn(); } catch (e) { return repli(e); } };

function racine() {
  const e = process.env.COCKPIT_DIR;
  return chaineNonVide(e) ? path.resolve(e) : path.join(emplacements.maison(), 'cockpit');
}

// Même emplacement que la racine de la liste de travail (context-ledger-core.js : racine) : CONTEXT_LEDGER_DIR, sinon <maison>/contexte.
function dossierLedger() {
  const e = process.env.CONTEXT_LEDGER_DIR;
  return path.resolve(chaineNonVide(e) ? e.trim() : emplacements.chemins().contexte);
}

function lireJson(p, defaut) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return defaut; }
}

// Windows refuse parfois le renommage un instant (antivirus, lecteur concurrent) : cinq essais espacés, puis l'erreur.
function ecrireJson(p, valeur) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(valeur, null, 2));
    for (let essai = 1; ; essai++) {
      try { fs.renameSync(tmp, p); return; } catch (e) {
        if (essai >= ESSAIS_RENOMMAGE || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * essai);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* rien à nettoyer */ }
    throw e;
  }
}

const fichierConfig = () => path.join(racine(), 'config.json');

// Les réglages de l'utilisateur (worktrees mesurés, dossier des plans) : config.json par-dessus les défauts, champ par champ.
function lireConfig() {
  return logiqueConfig.normaliserConfig(lireJson(fichierConfig(), null));
}

function ecrireConfig(config) {
  ecrireJson(fichierConfig(), { ...logiqueConfig.normaliserConfig(config), maj: new Date().toISOString() });
}

// Les vérifications de la commande, qui touchent le disque : un dossier existe, un worktree est une racine Git utilisable.
const VERIFICATIONS = {
  dossierExiste: c => { try { return fs.statSync(c).isDirectory(); } catch (_) { return false; } },
  estDepot: c => {
    try {
      const sortie = execFileSync('git', ['--no-optional-locks', '-C', c, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const reel = x => fs.realpathSync.native(path.resolve(x));
      const attendu = reel(c);
      const obtenu = reel(sortie);
      return process.platform === 'win32' ? attendu.toLowerCase() === obtenu.toLowerCase() : attendu === obtenu;
    } catch (_) { return false; }
  },
};

// `cockpit config <args>` (et `/cockpit config <args>`) : rend { message, config } ou { erreur }. N'écrit que si les réglages changent.
function appliquerConfig(args) {
  const avant = lireConfig();
  const r = logiqueConfig.analyserCommande(args, avant, VERIFICATIONS);
  if (r.erreur) return { erreur: r.erreur };
  if (JSON.stringify(r.config) !== JSON.stringify(avant)) {
    try { ecrireConfig(r.config); } catch (e) { return { erreur: `Écriture impossible dans ${fichierConfig()} (${e && e.message ? e.message : String(e)}) : rien n'a changé.` }; }
  }
  return { message: r.message, config: r.config };
}

// ---------------------------------------------------------------- ledger

const ENTETE_AGENT = /^\[agent\]\s*«\s*([\s\S]*?)\s*»\s*\(([^,()]*),\s*([^()]*)\)/;

// Ligne [agent] : 'enCours' (note « agent en cours » ou « agent relancé », mise à jour depuis `limite`), 'obsoletes' (même note, mais plus ancienne
// ou sans date lisible), 'aTraiter' (fin TERMINÉ réussie), 'echoues' (toute autre fin : une fin inconnue doit alerter, pas
// passer pour un succès). null si ce n'est pas une ligne d'agent lisible.
// Le nom est celui qu'un agent s'est donné : il sera injecté dans le contexte d'un autre agent, donc borné et sur une ligne.
function lireLigneAgent(id, l, limite) {
  const m = ENTETE_AGENT.exec(String(l.texte || ''));
  if (!m) return null;
  const note = String(l.note || '');
  const base = {
    ligne: id, nom: court(m[1], LARGEUR_NOM_AGENT), genre: m[2].trim(), id: m[3].trim(), note: court(note, 300),
    session: typeof l.session === 'string' ? l.session : null, // le fil de l'orchestrateur qui l'a lancé
    maj: typeof l.maj === 'string' ? l.maj : null,
  };
  const fin = /^TERMINÉ \(([^)]*)\)/.exec(note);
  if (fin) {
    const st = fin[1].trim();
    return { ...base, classe: FINS_REUSSIES.has(st.toLowerCase()) ? 'aTraiter' : 'echoues', statutFin: st };
  }
  if (/^agent (?:en cours|relancé)/.test(note)) return { ...base, classe: Date.parse(base.maj) >= limite ? 'enCours' : 'obsoletes', statutFin: null };
  return { ...base, classe: 'inconnus', statutFin: null };
}

const totauxVides = () => ({ ouvertes: 0, bloquees: 0, aTrier: 0, agentsEnCours: 0, agentsObsoletes: 0, agentsATraiter: 0, agentsEchoues: 0, agentsInconnus: 0 });

// options : { agents: [noms] pour ne lire que ces agents, maintenant: instant de référence en ms (défaut : l'instant courant) }
function resumeLedger(options) {
  const filtre = options && Array.isArray(options.agents) ? options.agents : null;
  const maintenant = options && Number.isFinite(options.maintenant) ? options.maintenant : Date.now();
  const limite = maintenant - AGE_MAX_EN_COURS_MS;
  const out = { totaux: totauxVides(), agents: {}, erreurs: [] };
  const dir = path.join(dossierLedger(), '.etat');
  let noms;
  try { noms = fs.readdirSync(dir).sort(); } catch (_) { return out; }
  for (const nom of noms) {
    const m = /^(.+)\.([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(nom); // <projet>.<agent>.json : les noms d'agents du dépôt (config.js) ont des majuscules et des tirets bas
    if (!m || (filtre && !filtre.includes(m[2]))) continue;
    const [, projet, agent] = m;
    const etat = lireJson(path.join(dir, nom), undefined);
    if (!estObjet(etat)) { out.erreurs.push(`${nom} : illisible`); continue; }
    const p = { lignesOuvertes: [], lignesBloquees: [], demandesATrier: [], agents: { enCours: [], obsoletes: [], aTraiter: [], echoues: [], inconnus: [] } };
    const lignes = estObjet(etat.lignes) ? etat.lignes : {};
    for (const id of Object.keys(lignes).sort(comparerIds)) {
      const l = lignes[id];
      if (!estObjet(l) || TERMINAUX.has(l.statut)) continue;
      const a = lireLigneAgent(id, l, limite);
      if (a) { const { classe, ...fiche } = a; p.agents[classe].push(fiche); continue; }
      const resume = { id, texte: court(l.texte, 160), statut: l.statut, note: l.note ? court(l.note, 160) : null, session: typeof l.session === 'string' ? l.session : null };
      (l.statut === 'bloque-utilisateur' ? p.lignesBloquees : p.lignesOuvertes).push(resume);
    }
    const demandes = estObjet(etat.demandes) ? etat.demandes : {};
    for (const id of Object.keys(demandes).sort(comparerIds)) {
      if (estObjet(demandes[id]) && demandes[id].statut === 'a-trier') p.demandesATrier.push(id);
    }
    const t = out.totaux;
    t.ouvertes += p.lignesOuvertes.length;
    t.bloquees += p.lignesBloquees.length;
    t.aTrier += p.demandesATrier.length;
    t.agentsEnCours += p.agents.enCours.length;
    t.agentsObsoletes += p.agents.obsoletes.length;
    t.agentsATraiter += p.agents.aTraiter.length;
    t.agentsEchoues += p.agents.echoues.length;
    t.agentsInconnus += p.agents.inconnus.length;
    (out.agents[agent] = out.agents[agent] || {})[projet] = p;
  }
  return out;
}

function agregerAgents(ledger) {
  const out = { enCours: [], obsoletes: [], aTraiter: [], echoues: [], inconnus: [] };
  for (const [agent, projets] of Object.entries(ledger.agents || {})) {
    for (const [projet, p] of Object.entries(projets)) {
      for (const classe of Object.keys(out)) for (const a of p.agents[classe]) out[classe].push({ agent, projet, ...a });
    }
  }
  return out;
}

// ---------------------------------------------------------------- plans

function compterCases(contenu) {
  let total = 0;
  let cochees = 0;
  for (const m of contenu.matchAll(/^[ \t]*[-*+][ \t]+\[([ xX])\]/gm)) { total++; if (m[1] !== ' ') cochees++; }
  return { total, cochees };
}

function avancementPlans(cfg) {
  const c = estObjet(cfg) ? cfg : lireConfig().plans;
  const vide = { total: 0, cochees: 0, pct: null, fichiers: [] };
  if (!chaineNonVide(c.dossier)) return { ...vide, erreur: 'aucun dossier de plans réglé (cockpit config plans <dossier>)' };
  let stat = null;
  try { stat = fs.statSync(c.dossier); } catch (_) { /* absent */ }
  if (!stat || !stat.isDirectory()) return { ...vide, erreur: `dossier de plans introuvable : ${c.dossier}` };
  const exclure = new Set(c.exclure || []);
  const profondeur = c.profondeur || DEFAUTS.plans.profondeur;
  const trouves = [];
  const parcourir = (dir, niveau) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (exclure.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (niveau < profondeur) parcourir(p, niveau + 1); } // un lien symbolique n'est pas suivi
      else if (e.isFile() && /\.md$/i.test(e.name)) trouves.push(p);
    }
  };
  parcourir(c.dossier, 1);
  const fichiers = [];
  let total = 0;
  let cochees = 0;
  for (const p of trouves.sort()) {
    const n = compterCases(fs.readFileSync(p, 'utf8'));
    if (!n.total) continue;
    fichiers.push({ fichier: path.relative(c.dossier, p), total: n.total, cochees: n.cochees });
    total += n.total;
    cochees += n.cochees;
  }
  return { total, cochees, pct: total ? Math.round((100 * cochees) / total) : null, fichiers };
}

// ---------------------------------------------------------------- git

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args],
      { encoding: 'utf8', timeout: DELAI_GIT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim().split('\n')[0],
      }));
  });
}

function compter(sortie) {
  const m = /^(\d+)\s+(\d+)$/.exec(sortie);
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

const nul = v => v.behind === 0 && v.ahead === 0;

// Les refs de branche sont communes à tous les worktrees d'un dépôt : tout se lit depuis le worktree.
// « Distant » = les refs de suivi locales (aucun fetch ici : lecture seule).
async function analyserDepot(depot) {
  const cwd = depot.chemin;
  const r = {
    nom: depot.nom, chemin: cwd, branche: null, upstream: null, sale: null, vsMain: null, vsDistant: null,
    constats: { propre: null, egalMain: null, egalDistant: null, mainEgalDistant: null, distantEgalMainDistant: null },
    erreurs: [],
  };
  const br = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!br.ok) { r.erreurs.push(`git : ${br.err || 'dépôt illisible'}`); return r; }
  r.branche = br.out;
  const st = await git(cwd, ['status', '--porcelain=v1', '-unormal']);
  if (st.ok) { r.sale = st.out ? st.out.split('\n').length : 0; r.constats.propre = r.sale === 0; }
  else r.erreurs.push(`status : ${st.err}`);
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']);
  if (up.ok) r.upstream = up.out;
  const vm = await git(cwd, ['rev-list', '--left-right', '--count', `${BRANCHE_PRINCIPALE}...HEAD`]);
  if (vm.ok) { r.vsMain = compter(vm.out); if (r.vsMain) r.constats.egalMain = nul(r.vsMain); }
  else r.erreurs.push(`rev-list main : ${vm.err}`);
  if (r.upstream) {
    const vd = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    if (vd.ok) { r.vsDistant = compter(vd.out); if (r.vsDistant) r.constats.egalDistant = nul(r.vsDistant); }
    else r.erreurs.push(`rev-list distant : ${vd.err}`);
  }
  // SHA : main local, branche locale, puis leurs suivis (upstream de chacune).
  const locales = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(upstream)',
    `refs/heads/${BRANCHE_PRINCIPALE}`, ...(r.branche !== 'HEAD' ? [`refs/heads/${r.branche}`] : [])]);
  if (locales.ok) {
    const l = {};
    for (const ligne of locales.out.split('\n').filter(Boolean)) { const [ref, sha, upstream] = ligne.split('\t'); l[ref] = { sha, upstream }; }
    const main = l[`refs/heads/${BRANCHE_PRINCIPALE}`];
    const courante = l[`refs/heads/${r.branche}`];
    const suivis = [main && main.upstream, courante && courante.upstream].filter(Boolean);
    const distants = suivis.length ? await git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)', ...suivis]) : { ok: true, out: '' };
    if (distants.ok) {
      const d = {};
      for (const ligne of distants.out.split('\n').filter(Boolean)) { const [ref, sha] = ligne.split('\t'); d[ref] = sha; }
      const shaMainDistant = main && main.upstream ? d[main.upstream] : undefined;
      const shaBrancheDistante = courante && courante.upstream ? d[courante.upstream] : undefined;
      if (main && shaMainDistant) r.constats.mainEgalDistant = main.sha === shaMainDistant;
      if (shaBrancheDistante && shaMainDistant) r.constats.distantEgalMainDistant = shaBrancheDistante === shaMainDistant;
    } else r.erreurs.push(`refs distantes : ${distants.err}`);
  } else r.erreurs.push(`refs locales : ${locales.err}`);
  return r;
}

function pidVivant(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Création exclusive : deux rafraîchissements simultanés ne passent jamais ensemble.
function prendreVerrou(chemin) {
  const contenu = JSON.stringify({ pid: process.pid, ts: Date.now() });
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  for (let essai = 0; essai < 2; essai++) {
    try { fs.writeFileSync(chemin, contenu, { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const v = lireJson(chemin, null);
      if (v && Number.isFinite(v.ts) && Date.now() - v.ts < VERROU_PERIME_MS && pidVivant(v.pid)) return false;
      try { fs.unlinkSync(chemin); } catch (_) { /* repris entre-temps par un autre */ }
    }
  }
  return false;
}

async function rafraichirGit(cfg) {
  const c = estObjet(cfg) ? cfg : lireConfig();
  const verrou = path.join(racine(), 'git-etat.verrou');
  if (!prendreVerrou(verrou)) return { ignore: 'verrou' };
  try {
    const depots = await Promise.all((c.worktrees || []).map(analyserDepot));
    ecrireJson(path.join(racine(), 'git-etat.json'), { mesureA: new Date().toISOString(), depots });
    return { ok: true, depots };
  } finally {
    try { fs.unlinkSync(verrou); } catch (_) { /* déjà retiré */ }
  }
}

function lireGitEtat() {
  const e = lireJson(path.join(racine(), 'git-etat.json'), null);
  if (!estObjet(e) || !Array.isArray(e.depots)) return null;
  const t = Date.parse(e.mesureA);
  return { ...e, ageS: Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null };
}

// ---------------------------------------------------------------- quota

function validerAgent(agent) {
  if (typeof agent !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(agent)) throw new Error(`agent invalide : ${JSON.stringify(agent)}`);
  return agent;
}

function ecrireQuota(agent, quota) {
  validerAgent(agent);
  const maintenant = new Date().toISOString();
  const mesureA = Object.hasOwn(quota, 'sourceAt') ? quota.sourceAt || null : maintenant;
  ecrireJson(path.join(racine(), `quota-${agent}.json`), { ...quota, mesureA, rafraichiA: maintenant });
}

function lireQuota(agent) {
  validerAgent(agent);
  return lireJson(path.join(racine(), `quota-${agent}.json`), null);
}

function lireTousQuotas() {
  const q = { claude: null, codex: null }; // les agents dont une mesure est attendue ; tout autre fichier quota-<agent>.json qui est une mesure s'ajoute
  let noms = [];
  try { noms = fs.readdirSync(racine()); } catch (_) { /* aucune mesure encore */ }
  for (const n of noms) {
    const m = /^quota-([a-z][a-z0-9-]{0,31})\.json$/.exec(n);
    if (!m) continue;
    const mesure = lireJson(path.join(racine(), n), null);
    if (estObjet(mesure) && Array.isArray(mesure.fenetres)) q[m[1]] = mesure; // un fichier qui n'est pas une mesure n'est pas un agent
  }
  return q;
}

// ---------------------------------------------------------------- instantané et rendu

// La politique du Régulateur d'agents, normalisée ; null tant que personne n'a rien décidé.
function politiqueAgents() {
  const brut = lireJson(path.join(racine(), 'politique-agents.json'), null);
  return brut === null ? null : regulateur.normaliserPolitique(brut);
}

// Les consignes en vigueur (module Consignes) : { etat, illisible }. Fichier absent : aucune consigne. Fichier abîmé (pas du JSON) :
// aucune consigne appliquée, mais le fichier est dit illisible, car ses ordres permanents ne sont plus rappelés ni vérifiés.
function lireConsignes() {
  let brut;
  try { brut = fs.readFileSync(path.join(racine(), 'consignes.json'), 'utf8'); } catch (_) { return { etat: logiqueConsignes.etatParDefaut(), illisible: false }; }
  try { return { etat: logiqueConsignes.normaliserEtat(JSON.parse(brut.replace(/^\uFEFF/, ''))), illisible: false }; } catch (_) { return { etat: logiqueConsignes.etatParDefaut(), illisible: true }; }
}

// Le résumé des consignes pour l'instantané ; null tant qu'aucune n'est active (et que le fichier n'est pas abîmé).
function resumeConsignes() {
  const { etat, illisible } = lireConsignes();
  const actives = etat.consignes.filter(c => c.actif);
  if (!illisible && actives.length === 0) return null;
  return { illisible, actives: actives.length, verrouillees: actives.filter(c => c.verrou).length, consignes: etat.consignes };
}

// Le résumé de la nuit pour l'instantané (l'état et la boîte écrits par le noyau de la nuit, partagés avec la commande et les hooks) ;
// null quand il n'y a rien à dire : la nuit n'est pas active et rien n'attend en boîte. Un fichier absent ou abîmé se lit comme vide.
function resumeNuit() {
  const etat = logiqueNuit.normaliserEtat(lireJson(path.join(racine(), 'nuit.json'), null));
  const aDecider = logiqueNuit.enAttente(lireJson(path.join(racine(), 'nuit-boite.json'), null)).length;
  if (!etat.actif && aDecider === 0) return null;
  return { actif: etat.actif, mode: etat.mode, depuis: etat.depuis, tours: etat.tours, maxTours: etat.maxTours, arret: etat.arret, aDecider };
}

// Le résumé de la pause pour l'instantané (l'état écrit par le noyau de la pause, partagé avec les hooks et les panneaux des sessions) ; null tant qu'aucune
// session n'est ouverte. Les sessions sans battement depuis cinq minutes sont mortes : elles n'y figurent pas. Un fichier absent ou abîmé se
// lit comme vide. Rien n'est écrit.
function resumePause() {
  const etat = logiquePause.purger(lireJson(path.join(racine(), 'pause.json'), null), Date.now()).etat;
  if (Object.keys(etat.sessions).length === 0) return null;
  const r = logiquePause.resume(etat, null);
  return { sessions: r.sessions, sessionsEnPause: r.sessionsEnPause, agentsArretes: r.agentsArretes, liste: logiquePause.listeSessions(etat) };
}

// Le résumé de la file d'attente des agents (tous agents et sessions) ; null tant qu'elle est vide, absente ou illisible.
function resumeFile() {
  const resume = logiqueFile.resume(lireJson(path.join(racine(), 'file-agents.json'), null));
  return resume.enAttente + resume.ordonnees === 0 ? null : resume;
}

function instantane(cfg) {
  const c = estObjet(cfg) ? cfg : lireConfig();
  const ledger = sur(() => resumeLedger(), e => ({ totaux: totauxVides(), agents: {}, erreurs: [String(e && e.message)] }));
  const modeles = modelesAgents.lireRegles();
  return {
    mesureA: new Date().toISOString(),
    ledger,
    agents: agregerAgents(ledger),
    git: lireGitEtat(),
    plans: sur(() => avancementPlans(c.plans), e => ({ total: 0, cochees: 0, pct: null, fichiers: [], erreur: String(e && e.message) })),
    quota: lireTousQuotas(),
    politiqueAgents: politiqueAgents(),
    consignes: resumeConsignes(),
    file: resumeFile(),
    nuit: resumeNuit(),
    pause: resumePause(),
    config: sur(() => logiqueConfig.normaliserConfig(c), () => null),
    modelesAgents: modeles.regles,
    erreurModeles: modeles.erreur || null,
  };
}

const accord = (n, un, plusieurs) => `${n} ${n === 1 ? un : plusieurs}`;

function ecart(v, nom) {
  if (!v) return `? ${nom}`;
  if (!v.ahead && !v.behind) return `= ${nom}`;
  const a = v.ahead ? `+${v.ahead}` : '';
  const b = v.behind ? `-${v.behind}` : '';
  return `${a && b ? `${a}/${b}` : a || b} ${nom}`;
}

function segmentDepot(d) {
  if (d.constats.propre === null && d.erreurs && d.erreurs.length) return `${d.nom} illisible`;
  const distant = d.vsDistant ? ecart(d.vsDistant, 'distant') : d.upstream ? '? distant' : 'sans distant';
  const p = [d.sale === null ? 'modif ?' : d.sale ? `${d.sale} modif` : 'propre', ecart(d.vsMain, 'main'), distant];
  if (d.constats.mainEgalDistant === false) p.push('main non poussé');
  return `${d.nom} ${p.join(', ')}`;
}

function segmentQuota(quota) {
  const parts = [];
  for (const [agent, v] of Object.entries(quota)) {
    if (v?.source === 'app-server-indisponible' && !v.fenetres?.length) { parts.push(`${agent} mesure indisponible`); continue; }
    if (!estObjet(v) || !Array.isArray(v.fenetres) || !v.fenetres.length) continue;
    const actives = v.fenetres.filter(f => !f.resetsAt || !Number.isFinite(Date.parse(f.resetsAt)) || Date.parse(f.resetsAt) > Date.now());
    if (!actives.length) { parts.push(`${agent} mesure perimee`); continue; }
    const ts = Date.parse(v.mesureA);
    const heure = Number.isFinite(ts) ? new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'date inconnue';
    const ancienne = !Number.isFinite(ts) || Date.now() - ts > 2 * 60 * 1000;
    const source = court(v.source || 'source inconnue', 24);
    const fenetres = actives.map(f => {
      if (!Number.isFinite(f.pct) || f.pct < 0 || f.pct > 100) return `${f.nom} ? %`;
      const utilise = Math.round(f.pct);
      return `${f.nom} ${utilise} % consommes, ${100 - utilise} % restants`;
    });
    parts.push(`${agent} ${fenetres.join(', ')} (${source}, ${ancienne ? 'ancienne ' : ''}${heure})`);
  }
  return parts.length ? `quota ${parts.join(' ; ')}` : null;
}

function enumerer(liste, f) {
  const vues = liste.slice(0, 3).map(f).join(', ');
  return liste.length > 3 ? `${vues} +${liste.length - 3}` : vues;
}

function segments(s, detail) {
  const t = s.ledger.totaux;
  const seg = [];
  const bloquees = [];
  for (const [, projets] of Object.entries(s.ledger.agents)) {
    for (const [projet, p] of Object.entries(projets)) for (const l of p.lignesBloquees) bloquees.push({ projet, id: l.id });
  }
  let l = `ledger ${accord(t.ouvertes, 'ouverte', 'ouvertes')}`;
  if (t.bloquees) l += `, ${accord(t.bloquees, 'bloquée', 'bloquées')}${detail && bloquees.length ? ` (${enumerer(bloquees, b => `${b.projet}/${b.id}`)})` : ''}`;
  if (t.aTrier) l += `, ${t.aTrier} à trier`;
  seg.push(l);
  const ag = [];
  if (t.agentsEnCours) ag.push(`${t.agentsEnCours} en cours`);
  if (t.agentsObsoletes) ag.push(accord(t.agentsObsoletes, 'obsolète', 'obsolètes'));
  if (t.agentsATraiter) ag.push(`${t.agentsATraiter} à traiter`);
  if (t.agentsEchoues) ag.push(`${accord(t.agentsEchoues, 'échoué', 'échoués')}${detail ? ` (${enumerer(s.agents.echoues, a => a.nom)})` : ''}`);
  if (t.agentsInconnus) ag.push(`${t.agentsInconnus} etat inconnu`);
  const pol = s.politiqueAgents; // politique du Régulateur : rien à dire tant qu'elle est inerte (libre, sans pause)
  if (pol && pol.pause) ag.push(pol.max !== null ? `en pause (max ${pol.max})` : 'en pause');
  else if (pol && pol.max !== null) ag.push(`max ${pol.max}`);
  const fi = s.file; // file d'attente des agents : rien à dire quand elle est vide
  if (fi) ag.push(`file ${fi.enAttente}${fi.ordonnees ? ` + ${fi.ordonnees} ${fi.ordonnees === 1 ? 'ordonné' : 'ordonnés'}` : ''}`);
  if (ag.length) seg.push(`agents ${ag.join(', ')}`);
  const cs = s.consignes; // consignes en vigueur : rien à dire sans consigne active
  if (cs) seg.push(cs.illisible ? 'consignes illisibles' : `consignes ${cs.actives} (${accord(cs.verrouillees, 'verrouillée', 'verrouillées')})`);
  const nu = s.nuit; // la nuit : rien à dire quand elle est inactive sans question en boîte
  if (nu) seg.push(nu.actif ? `nuit active ${nu.tours}/${nu.maxTours}${nu.arret ? ' (arrêtée)' : ''}${nu.aDecider ? `, ${nu.aDecider} à décider` : ''}` : `nuit inactive, ${nu.aDecider} à décider`);
  const pa = s.pause; // la pause : rien à dire tant qu'aucune session ni aucun agent n'est à l'arrêt
  if (pa && pa.sessionsEnPause + pa.agentsArretes > 0) seg.push(`pause ${[pa.sessionsEnPause && accord(pa.sessionsEnPause, 'session', 'sessions'), pa.agentsArretes && accord(pa.agentsArretes, 'agent', 'agents')].filter(Boolean).join(', ')}`);
  if (s.git) for (const d of s.git.depots) seg.push(segmentDepot(d)); else seg.push('git ?');
  seg.push(s.plans && s.plans.pct !== null ? `plans ${s.plans.pct} % (${s.plans.cochees}/${s.plans.total})` : 'plans ?');
  const q = segmentQuota(s.quota);
  if (q) seg.push(q);
  return seg;
}

function ligneCockpit(s) {
  return ['Cockpit', ...segments(s, false)].join(' | ');
}

function blocCockpit(s) {
  const quand = new Date().toLocaleString('sv-SE').slice(0, 16);
  const parties = segments(s, true);
  const prefixe = `COCKPIT ${quand} : `;
  const texte = `${prefixe}${parties.join(' ; ')}.`;
  if (texte.length <= LIMITE_BLOC) return texte;
  const quota = parties.find(part => part.startsWith('quota '));
  if (!quota) return `${texte.slice(0, LIMITE_BLOC - 3)}...`;
  const reste = parties.filter(part => part !== quota).join(' ; ');
  const place = LIMITE_BLOC - prefixe.length - quota.length - 8;
  return `${prefixe}${reste.slice(0, Math.max(0, place))}... ; ${quota}.`.slice(0, LIMITE_BLOC);
}

module.exports = {
  AGE_MAX_EN_COURS_MS, racine, lireJson, ecrireJson, lireConfig, ecrireConfig, appliquerConfig, lireConsignes, resumeLedger, avancementPlans, analyserDepot,
  rafraichirGit, lireGitEtat, ecrireQuota, lireQuota, instantane, ligneCockpit, blocCockpit,
};
