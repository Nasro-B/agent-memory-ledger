#!/usr/bin/env node
'use strict';
/*
 * lib/context-ledger-core.js : NOYAU du fichier contexte (liste de travail sur disque).
 *
 * Règle absolue : une ligne non faite ne disparaît JAMAIS du fichier contexte.
 * Seule une preuve [ctx C-NNNN] (historique, mémoire ou commit) la passe en « fait ».
 * Il n'existe AUCUNE fonction publique qui marque « fait » sans preuve.
 *
 * Adaptateurs qui réutilisent ce noyau :
 *   scripts/claude/context-ledger.js   (Claude Code)
 *   scripts/codex/context-ledger.js    (Codex)
 * Chaque adaptateur déduit SON agent de son emplacement : agentDepuisChemin(__dirname).
 * Jamais du payload du hook.
 *
 * ---------------------------------------------------------------------------
 * STOCKAGE : racine() = %CONTEXT_LEDGER_DIR%, sinon <maison>/contexte, où <maison> est
 * %AGENT_MEMORY_LEDGER_HOME% ou ~/.agent-memory-ledger (voir lib/config.js)
 *   .etat\<projet>.<agent>.json       état canonique (source de vérité)
 *   <projet>.<agent>.md               vue régénérée à chaque écriture ; restaurée si modifiée à la main
 *   <projet>.<agent>.journal.log      journal append-only (un objet JSON par ligne), jamais tronqué
 *   <projet>.<agent>\<ID>.txt         texte intégral des textes longs (au-delà de 240 caractères)
 *   .compteur                         compteur GLOBAL {"M": n, "C": n} (tous agents, tous projets)
 *   .sessions\<agent>-<session>.json  projet lié (fixé une fois), prompts vus, rappels faits, début du tour
 *   .reconciliation-<agent>.json      état du réconciliateur par contenu (hash des lignes [ctx] déjà vues)
 *   .etat\<projet>.<agent>.sig        empreinte sha256 du dernier JSON écrit par le noyau (détecte une
 *                                     modification hors commande : script, outil MCP, variable shell...)
 *   .etat\<projet>.<agent>.json.illisible-<ts>   JSON illisible mis de côté (jamais supprimé)
 *   .secours-<agent>.jsonl            messages de l'utilisateur qu'un incident a empêché d'enregistrer
 *   .secours-etat.json                présent seulement quand la copie de secours est en panne
 * COPIE DE SECOURS (hors racine, facultative) : racineSecours() = %CONTEXT_LEDGER_SECOURS_DIR% ; sans cette
 *   variable, pas de copie. Chaque journal y est recopié à chaque écriture ; un journal principal perdu ou
 *   amputé est reconstruit depuis cette copie (texteJournal), racine entièrement effacée comprise.
 * Intégrité : si le JSON manque, est illisible ou ne correspond plus à son empreinte, il est comparé au
 * journal rejoué ; toute ligne ou demande que le journal dit non faite et que le JSON a fait disparaître
 * (absente, statut « fait »/« abandon » sans événement, statut inconnu, texte modifié) est restaurée.
 * Écritures : verrou <fichier>.lock (fs.openSync 'wx'), réessais jusqu'à 3 s, verrou périmé après 10 s,
 * puis fichier .tmp + renameSync. Ordre des verrous (anti-interblocage) :
 *   session -> réconciliation -> ledger -> compteur.
 *
 * ---------------------------------------------------------------------------
 * API (fonctions synchrones ; elles lèvent une Error en cas de refus ou d'échec, sauf mention) :
 *
 * Constantes : AGENTS, PLAFOND (9000), STATUTS_MANUELS, TERMINAUX, OUTILS_FICHIER, OUTILS_SHELL,
 *              RAISON_FICHIER, RAISON_SHELL, RAISON_SOUS_AGENT.
 *
 * Emplacements
 *   racine() -> string                       racine absolue (lit CONTEXT_LEDGER_DIR à chaque appel)
 *   agentDepuisChemin(dir) -> agent|null     'claude'|'codex'
 *   projetDepuisCwd(cwd) -> string           detecterProjet(cwd) de lib/config.js, sinon '_general'
 *   chemins(projet, agent) -> {racine, json, md, journal, textes}
 *   listerProjets(agent) -> string[]         projets qui ont un état pour cet agent
 *
 * État
 *   lireLedger(projet, agent) -> etat        {projet, agent, demandes:{M-..}, lignes:{C-..}} (vide si absent)
 *   modifierLedger(projet, agent, fn(etat, {journal(evt), texteLong(id, texte)})) -> retour de fn
 *                                            sous verrou ; réécrit JSON + vue .md + textes longs + journal
 *   allouerId('M'|'C') -> 'M-0001'           compteur global sous verrou
 *   rendreVue(etat) -> string                texte exact du .md
 *   rejouerJournal(projet, agent) -> etat|null   état reconstruit depuis le journal (null sans journal)
 *   verifierEtat(projet, agent) -> {etat, restaures, raison, ecrire, quarantaine}   (à appeler sous verrou)
 *   assurerIntegrite(agent) -> projets réparés   JSON absent, illisible ou modifié hors commande
 *   assurerVues(agent) -> projets restaurés  intégrité puis régénération de toute vue absente ou modifiée
 *
 * Opérations (celles de la CLI)
 *   ajouterDemande({projet, agent, texte, session, promptId}) -> 'M-NNNN'   (statut a-trier)
 *   ajouterLigne({projet, agent, texte, de}) -> 'C-NNNN'                   (de = 'M-NNNN' ou null)
 *   classerSansTravail({projet, agent, id, raison}) -> {projet}
 *   changerEtat({projet, agent, id, statut, note}) -> {projet}             statut dans STATUTS_MANUELS
 *   abandonner({projet, agent, id, citation}) -> {projet}                  citation >= 8 car., mot pour mot
 *                                                                          dans une demande M du même projet,
 *                                                                          écrite APRÈS la création de la ligne
 *   trouverProjetDe(agent, id, prefere) -> projet|null
 *
 * Sessions
 *   lireSession(agent, sessionId) -> objet|null
 *   modifierSession(agent, sessionId, fn(session)) -> retour de fn (sous verrou)
 *   lierSession(agent, sessionId, cwd) -> projet      fixe le projet au premier appel, jamais recalculé
 *   projetDeSession(agent, sessionId, cwd) -> projet  lecture seule (repli : projetDepuisCwd)
 *   enregistrerMessage({agent, sessionId, promptId, cwd, texte})
 *        -> {id, projet, doublon}   M-NNNN mot pour mot, dédoublonné par promptId, marque le début du tour
 *   secours({agent, sessionId, promptId, texte, erreur}) -> chemin   garde un message non enregistré
 *   contexteEchecMessage({agent, projet, script, erreur}) -> string  texte injecté dans ce cas
 *   rappelStop({agent, sessionId, promptId, dernierMessage, script}) -> texte|null
 *        un seul rappel par message humain : M du tour encore à trier, lignes C du tour ni faites ni citées
 *   suiteTranscript({agent, sessionId, fichier, surLigne(Buffer)}) -> {vu, base}|null
 *        lignes complètes écrites dans le transcript depuis session.transcriptVu (premier passage : base)
 *
 * Livraisons des sous-agents (une ligne de travail par sous-agent lancé, gardée jusqu'à la preuve)
 *   suivreTache({agent, sessionId, cwd, tache:{id, genre, titre, resultat, alias}}) -> 'C-NNNN'|null
 *   finirTache({agent, sessionId, id, statut, resultat, reprise}) -> tâche à traiter|null
 *   livraisons({agent, sessionId}) -> {attente, enCours}
 *   tacheParAlias(agent, sessionId, alias) -> id|null
 *   texteLivraisons({agent, sessionId, dernierMessage}) -> rappel de fin de tour ('' si rien)
 *   texteFins(taches) -> annonce courte des fins qui viennent d'arriver
 *   texteSuiviEnCours({agent, sessionId}) -> en cours de tour : fins pas encore annoncées à l'orchestrateur,
 *        et rappel des résultats qui attendent (au plus une fois par délai) ; '' s'il n'y a rien à dire
 *
 * Preuves
 *   extraireMarqueurs(texte) -> [{id, partiel}]       [ctx C-0012], [ctx C-0012, C-0013], [ctx C-0012 partiel]
 *   marqueursAjoutes(toolName, toolInput, toolResponse) -> marqueurs du texte AJOUTÉ (Write/Edit/MultiEdit)
 *   estFichierPreuve(fichier, base?, cwd?) -> bool    <maison>\history\*.md, <maison>\Memory-Auto.md,
 *                                                     et la mémoire de projet de Claude Code
 *                                                     (~\.claude\projects\*\memory\*.md)
 *   preuveCommit({commande, cwd}) -> {sha, court, message, racineDepot}|null   HEAD frais (<= 90 s)
 *   preuvesDepuisOutil({toolName, toolInput, toolResponse, cwd, base}) -> {marqueurs, preuve}|null
 *   appliquerPreuves({agent, marqueurs, preuve}) -> {faits, partiels, ignores, projets}
 *        seul chemin vers « fait » ; un ID absent des fichiers de CET agent est ignoré
 *   reconcilier({agent, base}) -> {faits, partiels, ignores, projets}
 *        réconciliateur PAR CONTENU (agents dont l'outil d'édition est incertain) : relit les fichiers de
 *        preuve dont mtime/taille ont changé et n'applique que les lignes [ctx] apparues depuis le passage
 *        précédent (le tout premier passage sert de base, sans rien appliquer)
 *
 * Garde
 *   gardeOutil({input, generique}) -> raison|null     raison de refus PreToolUse, null = autorisé
 *   texteToucheRacine(texte) -> bool ; appelleCli(texte) -> bool ; commandeLectureOuCli(cmd) -> bool
 *   commandeViseRacine(cmd, cwd) -> bool     cwd dans la racine, ou chemin relatif (après cd / depuis cwd)
 *                                            qui y mène, jokers compris (cd <maison> && rm -rf contexte)
 *
 * Texte injecté au modèle (toujours <= PLAFOND caractères)
 *   commandes(script, projet) -> {ajouter(m?), sansTravail(m), etat, abandon, lister}
 *   contexteMessage({agent, projet, idMessage, script}) -> string
 *   contexteSession({agent, projet, script}) -> string
 *   contexteApresPreuve({agent, projet, script, resultat, preuve}) -> string
 *   composerContexte(entete, lignes, pied, commandeLister, max?) -> string
 *
 * CLI
 *   executerCli(argv, {agent, script}) -> {code, sortie, erreur}
 *     ajouter --projet P [--de M-NNNN] "texte" | sans-travail --projet P M-NNNN "raison"
 *     etat --projet P C-NNNN ouvert|en-cours|bloque-utilisateur ["note"] | abandon --projet P C-NNNN "citation"
 *     lister [--projet P]        (--fichier <chemin> remplace le texte libre, lu en UTF-8)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { maskQuotedSegments, resolveCommitTarget } = require('./commande-git.js');
const config = require('./config.js');

// ---------------------------------------------------------------------------
// Constantes

const AGENTS = config.AGENTS;
// Dossier de l'adaptateur (scripts/claude, scripts/codex) -> agent.
const DOSSIERS_AGENTS = { claude: 'claude', codex: 'codex' };
const PLAFOND = 9000;
const EXTRAIT_M = 300;
const EXTRAIT_C = 400;
const EXTRAIT_COMPACT = 240;
const STATUTS_MANUELS = ['ouvert', 'en-cours', 'bloque-utilisateur'];
const TERMINAUX = ['fait', 'abandon-utilisateur'];
const STATUTS_LIGNE = ['ouvert', 'en-cours', 'bloque-utilisateur', 'fait', 'abandon-utilisateur'];
const STATUTS_DEMANDE = ['a-trier', 'converti', 'sans-travail'];
const MAX_IDS_RAPPEL = 30;
const DELAI_VERROU_MS = 3000;
const VERROU_PERIME_MS = 10000;
const FRAICHEUR_COMMIT_S = 90;
const CITATION_MIN = 8;
const OUTILS_FICHIER = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const OUTILS_SHELL = ['Bash', 'PowerShell', 'mcp__Windows-MCP__PowerShell'];

const ENTETE_COMMENTAIRE = '<!-- Géré par les hooks context-ledger. Ne jamais supprimer une ligne à la main : seule une preuve [ctx C-NNNN] (historique, mémoire ou commit) la retire. Toute ligne effacée est restaurée. -->';
const SECTIONS = {
  aTrier: '## À trier (messages de l\'utilisateur pas encore transformés en travail)',
  ouvert: '## Ouvert',
  bloque: '## Bloqué : attend l\'utilisateur',
  abandon: '## Abandonné par l\'utilisateur (trace, sur ordre explicite)',
};

const RAISON_FICHIER = 'Le fichier contexte ne se modifie pas à la main : utilise la commande context-ledger (ajouter, etat, sans-travail, abandon). Une ligne ne disparaît que sur preuve [ctx].';
const RAISON_SHELL = 'Sur la racine contexte, le shell ne sert qu\'à lire (cat, type, Get-Content, head, tail, grep, ls, dir) ou à appeler la commande context-ledger. ' + RAISON_FICHIER;
const RAISON_SOUS_AGENT = 'Seul l\'orchestrateur écrit dans le fichier contexte : un sous-agent n\'appelle pas context-ledger et ne touche pas la racine contexte. Rends ton résultat à l\'orchestrateur, il mettra le fichier contexte à jour.';

// La racine telle qu'elle peut s'écrire dans une commande sans être résolue (~/, $HOME, %USERPROFILE%...) :
// le dossier parent (ou son nom court 8.3 sous Windows : six premiers caractères utiles puis ~N), puis le
// dossier de la racine. Recalculé à chaque appel : la racine dépend de variables d'environnement.
function echapper(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function motifsRacine() {
  const r = racine();
  const dossier = path.basename(r);
  const parent = path.basename(path.dirname(r));
  const court = parent.replace(/^\.+/, '').replace(/[ .]/g, '').slice(0, 6);
  const alt = `(?:${echapper(parent)}${court ? `|${echapper(court)}~\\d+` : ''})`;
  return {
    dossier,
    reelle: new RegExp(`${alt}[\\\\/]+${echapper(dossier)}(?![A-Za-z0-9_-])`, 'i'),
    segment: new RegExp(`${alt}/+([^/\\s"';|&<>()]+)`, 'gi'),
  };
}
const RE_MARQUEUR = /\[ctx\s+(C-\d{4,}(?:\s*,\s*C-\d{4,})*)(\s+partiel)?\s*\]/gi;
const LECTURE = new Set([
  'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'grep', 'ls', 'dir',
  'get-childitem', 'gci', 'rg', 'findstr', 'select-string', 'sls', 'wc', 'more',
  'test-path', 'get-item', 'gi', 'resolve-path', 'cd', 'set-location', 'sl', 'pushd', 'popd',
]);
const RE_CLI_SEGMENT = /^["']?(?:[^"'\s]*[\\/])?node(?:\.exe)?["']?\s+(?:"(?:[^"]*[\\/])?context-ledger\.js"|'(?:[^']*[\\/])?context-ledger\.js'|(?:[^"'\s]*[\\/])?context-ledger\.js)(?=\s|$)/i;

// ---------------------------------------------------------------------------
// Utilitaires bas niveau

const PAUSE = new Int32Array(new SharedArrayBuffer(4));
function dormir(ms) { Atomics.wait(PAUSE, 0, 0, ms); }

// Chemins longs Windows : préfixe \\?\ au-delà de la limite MAX_PATH.
function lp(p) {
  if (process.platform === 'win32' && p.length >= 248 && !p.startsWith('\\\\?\\') && !p.startsWith('\\\\')) {
    return '\\\\?\\' + path.resolve(p);
  }
  return p;
}

function maintenantIso() { return new Date().toISOString(); }
function dateLocale(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function chaine(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
function sansBom(t) { return chaine(t).replace(/^\uFEFF/, ''); }

const TRANSITOIRES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function lireTexte(f) {
  for (let i = 0; ; i++) {
    try { return fs.readFileSync(lp(f), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (i >= 40 || !TRANSITOIRES.has(e.code)) throw e;
      dormir(25);
    }
  }
}

function ecrireAtomique(f, contenu) {
  fs.mkdirSync(lp(path.dirname(f)), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(lp(tmp), contenu);
  for (let i = 0; ; i++) {
    try { fs.renameSync(lp(tmp), lp(f)); return; } catch (e) {
      if (i >= 40 || !TRANSITOIRES.has(e.code)) {
        try { fs.unlinkSync(lp(tmp)); } catch (_) { /* rien */ }
        throw e;
      }
      dormir(25);
    }
  }
}

function ajouterAuFichier(f, contenu) {
  fs.mkdirSync(lp(path.dirname(f)), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.appendFileSync(lp(f), contenu); return; } catch (e) {
      if (i >= 40 || !TRANSITOIRES.has(e.code)) throw e;
      dormir(25);
    }
  }
}

function lireDossier(d, options) {
  try { return fs.readdirSync(lp(d), options); } catch (_) { return []; }
}

// Verrou exclusif : fs.openSync(<fichier>.lock, 'wx'), réessais courts jusqu'à 3 s,
// verrou périmé (processus mort) au-delà de 10 s.
function avecVerrou(fichier, fn) {
  const verrou = fichier + '.lock';
  fs.mkdirSync(lp(path.dirname(verrou)), { recursive: true });
  const limite = Date.now() + DELAI_VERROU_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lp(verrou), 'wx');
      try { fs.writeSync(fd, `${process.pid} ${maintenantIso()}`); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && !TRANSITOIRES.has(e.code)) throw e;
      if (Date.now() > limite) throw new Error(`verrou occupé : ${verrou}`);
      try {
        const st = fs.statSync(lp(verrou));
        if (Date.now() - st.mtimeMs > VERROU_PERIME_MS) {
          try { fs.unlinkSync(lp(verrou)); } catch (_) { /* un autre l'a déjà retiré */ }
          continue;
        }
      } catch (_) { /* disparu entre-temps : réessayer */ }
      dormir(10 + Math.floor(Math.random() * 30));
    }
  }
  try { return fn(); } finally {
    try { fs.unlinkSync(lp(verrou)); } catch (_) { /* rien */ }
  }
}

// ---------------------------------------------------------------------------
// Emplacements

function racine() {
  const e = process.env.CONTEXT_LEDGER_DIR;
  return path.resolve(e && e.trim() ? e.trim() : config.chemins().contexte);
}

function agentDepuisChemin(dir) {
  const segments = path.resolve(chaine(dir)).split(/[\\/]+/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const a = DOSSIERS_AGENTS[segments[i].toLowerCase()];
    if (a) return a;
  }
  return null;
}

function projetDepuisCwd(cwd) {
  let p = null;
  try { p = config.detecterProjet(chaine(cwd)); } catch (_) { p = null; }
  return p || '_general';
}

function validerProjet(p) {
  if (typeof p !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(p) || p.includes('..')) {
    throw new Error(`nom de projet invalide : ${p}`);
  }
  return p;
}
function validerAgent(a) {
  if (!AGENTS.includes(a)) throw new Error(`agent inconnu : ${a}`);
  return a;
}

function chemins(projet, agent) {
  validerProjet(projet); validerAgent(agent);
  const r = racine();
  return {
    racine: r,
    json: path.join(r, '.etat', `${projet}.${agent}.json`),
    sig: path.join(r, '.etat', `${projet}.${agent}.sig`),
    md: path.join(r, `${projet}.${agent}.md`),
    journal: path.join(r, `${projet}.${agent}.journal.log`),
    textes: path.join(r, `${projet}.${agent}`),
  };
}

function listerProjets(agent) {
  validerAgent(agent);
  const suffixe = `.${agent}.json`;
  return lireDossier(path.join(racine(), '.etat'))
    .filter(n => n.endsWith(suffixe) && n.length > suffixe.length)
    .map(n => n.slice(0, -suffixe.length))
    .filter(p => { try { validerProjet(p); return true; } catch (_) { return false; } })
    .sort();
}

// Projets qui ont un état OU un journal (principal ou copie de secours) : un état supprimé par un script,
// ou la racine entière effacée, reste retrouvable.
function listerProjetsTous(agent) {
  validerAgent(agent);
  const suffixe = `.${agent}.journal.log`;
  const noms = d => lireDossier(d)
    .filter(n => n.endsWith(suffixe) && n.length > suffixe.length)
    .map(n => n.slice(0, -suffixe.length))
    .filter(p => { try { validerProjet(p); return true; } catch (_) { return false; } });
  const secours = racineSecours();
  return [...new Set(listerProjets(agent).concat(noms(racine()), secours ? noms(secours) : []))].sort();
}

// ---------------------------------------------------------------------------
// Copie de secours du journal (facultative)
//
// Chaque journal <projet>.<agent>.journal.log est recopié hors de la racine : si la racine est effacée
// (script, purge, disque), la liste est reconstruite depuis cette copie au premier événement suivant.
// Emplacement : %CONTEXT_LEDGER_SECOURS_DIR% (de préférence sur un autre disque). Sans cette variable, ou
// si elle est vide, il n'y a pas de copie.

function racineSecours() {
  const e = process.env.CONTEXT_LEDGER_SECOURS_DIR;
  return e && e.trim() ? path.resolve(e.trim()) : null;
}

function journalSecours(projet, agent) {
  const r = racineSecours();
  return r ? path.join(r, `${projet}.${agent}.journal.log`) : null;
}

function tailleDe(f) { try { return fs.statSync(lp(f)).size; } catch (_) { return -1; } }

// Trace d'une copie de secours en panne (disque absent, droits) : jamais de panne silencieuse, le texte
// injecté au démarrage la signale (avertissementSecours).
function noterSecours(ok, erreur) {
  const f = path.join(racine(), '.secours-etat.json');
  try {
    if (ok) { if (fs.existsSync(lp(f))) fs.unlinkSync(lp(f)); return; }
    let depuis = maintenantIso();
    try { const a = JSON.parse(sansBom(lireTexte(f) || '')); if (a && a.depuis) depuis = a.depuis; } catch (_) { /* première panne */ }
    ecrireAtomique(f, JSON.stringify({ ok: false, erreur: chaine(erreur), depuis, dossier: racineSecours() }) + '\n');
  } catch (_) { /* la trace elle-même ne doit rien bloquer */ }
}

function avertissementSecours() {
  try {
    const t = lireTexte(path.join(racine(), '.secours-etat.json'));
    if (!t) return '';
    const a = JSON.parse(sansBom(t));
    if (!a || a.ok !== false) return '';
    return `ATTENTION : la copie de secours du fichier contexte est en panne depuis ${a.depuis} (${a.erreur}) ; dossier : ${a.dossier}. Dis-le à l'utilisateur.`;
  } catch (_) { return ''; }
}

// Après chaque écriture du journal principal : la copie reçoit le même bloc. Si elle a pris du retard
// (écriture manquée, disque absent un moment), elle est recopiée en entier. Si elle en sait PLUS que le
// principal (principal amputé), lireJournal fusionne les deux. Ne lève jamais : la copie de secours ne
// doit pas faire échouer l'écriture principale.
function synchroniserSecours(projet, agent, bloc) {
  const s = journalSecours(projet, agent);
  if (!s) return; // ancre-mutation:secours-copie
  try {
    const principal = chemins(projet, agent).journal;
    const tp = tailleDe(principal);
    const ts = tailleDe(s);
    fs.mkdirSync(lp(path.dirname(s)), { recursive: true });
    if (ts >= 0 && ts + Buffer.byteLength(bloc) === tp) fs.appendFileSync(lp(s), bloc);
    else if (ts > tp) lireJournal(projet, agent);
    else {
      const tmp = `${s}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.copyFileSync(lp(principal), lp(tmp));
      fs.renameSync(lp(tmp), lp(s));
    }
    noterSecours(true);
  } catch (e) { noterSecours(false, e && e.message ? e.message : String(e)); }
}

function lignesJournal(t) { return t === null ? [] : sansBom(t).split(/\r?\n/).filter(l => l.trim()); }
function horodatageLigne(l) { try { return chaine(JSON.parse(l).ts); } catch (_) { return ''; } }

// Texte du journal principal, réparé depuis la copie de secours quand il a perdu des lignes (journal
// supprimé ou amputé, racine effacée). Fusion par ordre d'horodatage ; les deux fichiers sont réécrits.
function texteJournal(projet, agent) {
  const c = chemins(projet, agent);
  const t = lireTexte(c.journal);
  const s = journalSecours(projet, agent);
  if (!s) return t;
  let ts = null;
  try { ts = lireTexte(s); } catch (_) { ts = null; }
  if (ts === null || ts === t) return t;
  const principales = lignesJournal(t);
  const copie = lignesJournal(ts);
  const vues = new Set(principales);
  const perdues = copie.filter(l => !vues.has(l)); // ancre-mutation:secours-restauration
  if (!perdues.length) return t;
  const dansCopie = new Set(copie);
  const fusion = copie.concat(principales.filter(l => !dansCopie.has(l)))
    .map((l, i) => ({ l, i, ts: horodatageLigne(l) }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.i - b.i))
    .map(x => x.l);
  fusion.push(JSON.stringify({ ts: maintenantIso(), evt: 'restauration-journal', lignes: perdues.length, raison: t === null ? 'journal principal absent' : 'journal principal amputé', source: s }));
  const texte = fusion.join('\n') + '\n';
  try { ecrireAtomique(c.journal, texte); } catch (_) { /* l'état est quand même reconstruit depuis le texte fusionné */ }
  try { ecrireAtomique(s, texte); } catch (_) { /* la copie sera resynchronisée à la prochaine écriture */ }
  return texte;
}

// ---------------------------------------------------------------------------
// État canonique

function ledgerVide(projet, agent) { return { projet, agent, demandes: {}, lignes: {} }; }

function estObjet(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function analyserLedger(t, projet, agent) {
  const e = JSON.parse(sansBom(t));
  if (!estObjet(e)) throw new Error('état JSON qui n\'est pas un objet');
  e.projet = projet; e.agent = agent;
  if (!estObjet(e.demandes)) e.demandes = {};
  if (!estObjet(e.lignes)) e.lignes = {};
  return e;
}

function lireLedger(projet, agent) {
  const c = chemins(projet, agent);
  const t = lireTexte(c.json);
  if (t === null) return ledgerVide(projet, agent);
  // Un état illisible lève : il ne doit JAMAIS être écrasé par un état vide (lignes perdues).
  // verifierEtat (sous verrou) le met de côté et le reconstruit depuis le journal.
  return analyserLedger(t, projet, agent);
}

function signature(texte) { return crypto.createHash('sha256').update(chaine(texte)).digest('hex'); }

function ecrireEtat(c, etat) {
  const texte = JSON.stringify(etat, null, 2) + '\n';
  ecrireAtomique(c.json, texte);
  ecrireAtomique(c.sig, signature(texte) + '\n');
}

function etatSigne(c) {
  const t = lireTexte(c.json);
  if (t === null) return false;
  const sig = chaine(lireTexte(c.sig)).trim();
  return !!sig && signature(t) === sig;
}

// Journal : un objet JSON par ligne ; une ligne abîmée est ignorée, jamais bloquante.
function lireJournal(projet, agent) {
  const t = texteJournal(projet, agent);
  if (t === null) return null;
  const evts = [];
  for (const l of sansBom(t).split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { const e = JSON.parse(l); if (estObjet(e)) evts.push(e); } catch (_) { /* ligne abîmée : ignorée */ }
  }
  return evts;
}

// État reconstruit depuis le journal seul (append-only) : même logique que les opérations.
function rejouerJournal(projet, agent) {
  const evts = lireJournal(projet, agent);
  if (!evts) return null;
  const e = ledgerVide(projet, agent);
  for (const v of evts) {
    const id = chaine(v.id).toUpperCase();
    const ts = chaine(v.ts);
    const d0 = new Date(ts);
    const date = Number.isNaN(d0.getTime()) ? '' : dateLocale(d0);
    const l = e.lignes[id];
    switch (v.evt) {
      case 'demande':
        e.demandes[id] = {
          texte: chaine(v.texte), date, ts, session: v.session || null, promptId: v.promptId || null,
          statut: 'a-trier', lignes: [], raison: null, maj: ts,
        };
        break;
      case 'sans-travail':
        if (e.demandes[id]) Object.assign(e.demandes[id], { statut: 'sans-travail', raison: chaine(v.raison), maj: ts });
        break;
      case 'ajout': {
        const de = v.de ? chaine(v.de).toUpperCase() : null;
        e.lignes[id] = {
          texte: chaine(v.texte), de, date, ts, statut: 'ouvert', note: null, preuve: null, citationUtilisateur: null, maj: ts,
        };
        const d = de && e.demandes[de];
        if (d) { d.statut = 'converti'; d.lignes = d.lignes.concat(id); d.maj = ts; }
        break;
      }
      case 'etat':
        if (l && STATUTS_MANUELS.includes(v.apres)) { l.statut = v.apres; if (v.note) l.note = v.note; l.maj = ts; }
        break;
      case 'fait':
        if (l) Object.assign(l, { statut: 'fait', preuve: v.preuve || null, maj: ts });
        break;
      case 'partiel':
        if (l) {
          const note = `partiel (preuve : ${v.preuve})`;
          l.statut = 'en-cours';
          l.note = l.note && !/^partiel \(preuve/.test(l.note) ? `${note} ; ${l.note}` : note;
          l.maj = ts;
        }
        break;
      case 'abandon':
        if (l) Object.assign(l, { statut: 'abandon-utilisateur', citationUtilisateur: chaine(v.citation), maj: ts });
        break;
      default: break; // abandon-refuse, restauration-* : sans effet sur l'état
    }
  }
  return e;
}

// Restaure dans `etat` tout ce que le journal dit présent et que le JSON a fait disparaître.
// Prudent : ne retire jamais rien du JSON, ne touche pas à un écart qui ne cache rien.
function reparerDepuisJournal(etat, rejoue) {
  const restaures = [];
  for (const id of Object.keys(rejoue.demandes)) {
    const r = rejoue.demandes[id];
    const j = etat.demandes[id];
    const cachee = !estObjet(j) || !STATUTS_DEMANDE.includes(j.statut) || j.texte !== r.texte
      || (r.statut === 'a-trier' && j.statut !== 'a-trier');
    if (cachee) {
      const avant = estObjet(j) && Array.isArray(j.lignes) ? j.lignes : [];
      etat.demandes[id] = Object.assign({}, estObjet(j) ? j : {}, r, { lignes: [...new Set(avant.concat(r.lignes))] });
      restaures.push(id);
    }
  }
  for (const id of Object.keys(rejoue.lignes)) {
    const r = rejoue.lignes[id];
    const j = etat.lignes[id];
    const cachee = !estObjet(j) || !STATUTS_LIGNE.includes(j.statut) || j.texte !== r.texte
      || (TERMINAUX.includes(j.statut) && j.statut !== r.statut);
    if (cachee) { etat.lignes[id] = Object.assign({}, estObjet(j) ? j : {}, r); restaures.push(id); }
  }
  return restaures;
}

// À appeler SOUS le verrou du JSON. Chemin rapide : JSON signé par le noyau -> lu tel quel.
function verifierEtat(projet, agent) {
  const c = chemins(projet, agent);
  const t = lireTexte(c.json);
  const sig = chaine(lireTexte(c.sig)).trim();
  if (t !== null && sig && signature(t) === sig) {
    return { etat: analyserLedger(t, projet, agent), restaures: [], raison: null, ecrire: false, quarantaine: false };
  }
  let etat = null;
  let raison = null;
  let quarantaine = false;
  const rejoue = rejouerJournal(projet, agent);
  if (t !== null) {
    try { etat = analyserLedger(t, projet, agent); } catch (e) {
      // Sans journal, rien ne permet de reconstruire : on lève (jamais d'état vide qui cacherait des lignes).
      if (!rejoue) throw new Error(`état illisible et journal absent, réparation manuelle requise : ${c.json} (${e.message})`);
      const cote = `${c.json}.illisible-${Date.now()}`;
      try { fs.renameSync(lp(c.json), lp(cote)); } catch (_) { ecrireAtomique(cote, t); }
      raison = `état illisible, mis de côté : ${cote}`;
      quarantaine = true;
    }
  }
  if (!etat) etat = ledgerVide(projet, agent);
  const restaures = rejoue ? reparerDepuisJournal(etat, rejoue) : []; // ancre-mutation:integrite
  if (!raison && restaures.length) raison = t === null ? 'état absent, reconstruit depuis le journal' : 'état modifié hors commande';
  return { etat, restaures, raison, ecrire: true, quarantaine };
}

function journaliser(projet, agent, evenements) {
  if (!evenements.length) return;
  const ts = maintenantIso();
  const bloc = evenements.map(e => JSON.stringify(Object.assign({ ts }, e))).join('\n') + '\n';
  ajouterAuFichier(chemins(projet, agent).journal, bloc);
  synchroniserSecours(projet, agent, bloc);
}

function modifierLedger(projet, agent, fn) {
  const c = chemins(projet, agent);
  return avecVerrou(c.json, () => {
    const v = verifierEtat(projet, agent);
    const etat = v.etat;
    const evenements = [];
    if (v.restaures.length || v.quarantaine) evenements.push({ evt: 'restauration-etat', ids: v.restaures, raison: v.raison });
    const longs = [];
    const outils = {
      journal: evt => evenements.push(evt),
      texteLong: (id, texte) => longs.push([id, texte]),
    };
    const resultat = fn(etat, outils);
    ecrireEtat(c, etat);
    for (const [id, texte] of longs) ecrireAtomique(path.join(c.textes, id + '.txt'), texte);
    ecrireAtomique(c.md, rendreVue(etat));
    journaliser(projet, agent, evenements);
    return resultat;
  });
}

function numero(id) { return parseInt(chaine(id).slice(2), 10) || 0; }
function trierIds(obj) { return Object.keys(obj).sort((a, b) => numero(a) - numero(b)); }

// Plus grands numéros M et C connus : états (.etat\*.json) ET journaux (un état supprimé y reste).
function reconstruireCompteur(partiel) {
  const max = { M: 0, C: 0 };
  if (partiel && Number.isInteger(partiel.M)) max.M = partiel.M;
  if (partiel && Number.isInteger(partiel.C)) max.C = partiel.C;
  const voir = t => {
    const re = /"([MC])-(\d{4,})"/g;
    let m;
    while ((m = re.exec(chaine(t)))) max[m[1]] = Math.max(max[m[1]], parseInt(m[2], 10));
  };
  const dossier = path.join(racine(), '.etat');
  for (const n of lireDossier(dossier)) {
    if (!/\.json$/.test(n)) continue;
    try { voir(lireTexte(path.join(dossier, n))); } catch (_) { /* illisible : ignoré ici */ }
  }
  // Journaux de la racine ET de la copie de secours (racine effacée : les numéros déjà pris y restent).
  for (const d of [racine(), racineSecours()].filter(Boolean)) {
    for (const n of lireDossier(d)) {
      if (!/\.journal\.log$/.test(n)) continue;
      try { voir(lireTexte(path.join(d, n))); } catch (_) { /* illisible : ignoré ici */ }
    }
  }
  return max;
}

// planchers {M, C} : numéros déjà pris (resynchronisation après un compteur remis en arrière).
function allouerId(type, planchers = null) {
  if (type !== 'M' && type !== 'C') throw new Error(`type d'ID inconnu : ${type}`);
  const f = path.join(racine(), '.compteur');
  return avecVerrou(f, () => {
    let cpt = null;
    try { const t = lireTexte(f); if (t) cpt = JSON.parse(sansBom(t)); } catch (_) { cpt = null; }
    if (!cpt || !Number.isInteger(cpt.M) || !Number.isInteger(cpt.C)) cpt = reconstruireCompteur(cpt);
    for (const k of ['M', 'C']) {
      if (planchers && Number.isInteger(planchers[k]) && planchers[k] > cpt[k]) cpt[k] = planchers[k];
    }
    cpt[type] += 1;
    ecrireAtomique(f, JSON.stringify({ M: cpt.M, C: cpt.C }) + '\n');
    return `${type}-${String(cpt[type]).padStart(4, '0')}`;
  });
}

// Jamais d'écrasement : si l'ID existe déjà dans cet état (compteur restauré en arrière),
// le compteur est resynchronisé sur le plus grand numéro connu (états + journaux).
function allouerIdLibre(type, etat) {
  const cle = type === 'M' ? 'demandes' : 'lignes';
  let id = allouerId(type);
  if (etat[cle][id]) id = allouerId(type, reconstruireCompteur(null));
  if (etat[cle][id]) throw new Error(`${id} existe déjà : compteur incohérent, aucune écriture`);
  return id;
}

// ---------------------------------------------------------------------------
// Vue .md

function aplatir(s) {
  return chaine(s).replace(/\s+$/, '').replace(/\r\n|\r|\n/g, ' / ');
}
function cheminTexte(projet, agent, id) { return path.join(chemins(projet, agent).textes, id + '.txt'); }
function extrait(texte, max, integral) {
  const t = chaine(texte);
  if (t.length <= max) return `« ${aplatir(t)} »`;
  return `« ${aplatir(t.slice(0, max))}… » (texte intégral : ${integral})`;
}

function ligneDemande(etat, id, max) {
  const d = etat.demandes[id];
  return `- ${id} | ${d.date} | ${extrait(d.texte, max, cheminTexte(etat.projet, etat.agent, id))}`;
}

function ligneTravail(etat, id, max) {
  const l = etat.lignes[id];
  const parts = [
    id, l.date, l.de ? `de ${l.de}` : 'découvert en route',
    extrait(l.texte, max, cheminTexte(etat.projet, etat.agent, id)),
    `état : ${l.statut}`,
  ];
  if (l.statut === 'abandon-utilisateur' && l.citationUtilisateur) parts.push(`citation de l'utilisateur : « ${aplatir(l.citationUtilisateur)} »`);
  else if (l.note) parts.push(aplatir(l.note));
  return '- ' + parts.join(' | ');
}

function rendreVue(etat) {
  const out = [`# Contexte - ${etat.projet} - ${etat.agent}`, ENTETE_COMMENTAIRE, SECTIONS.aTrier];
  for (const id of trierIds(etat.demandes)) {
    if (etat.demandes[id].statut === 'a-trier') out.push(ligneDemande(etat, id, EXTRAIT_M));
  }
  out.push(SECTIONS.ouvert);
  for (const id of trierIds(etat.lignes)) {
    const s = etat.lignes[id].statut;
    if (s === 'ouvert' || s === 'en-cours') out.push(ligneTravail(etat, id, EXTRAIT_C));
  }
  out.push(SECTIONS.bloque);
  for (const id of trierIds(etat.lignes)) {
    if (etat.lignes[id].statut === 'bloque-utilisateur') out.push(ligneTravail(etat, id, EXTRAIT_C));
  }
  out.push(SECTIONS.abandon);
  for (const id of trierIds(etat.lignes)) {
    if (etat.lignes[id].statut === 'abandon-utilisateur') out.push(ligneTravail(etat, id, EXTRAIT_C));
  }
  return out.join('\n') + '\n';
}

function normaliserVue(t) {
  return sansBom(t).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
}

// Intégrité : un JSON absent (journal présent), illisible ou dont l'empreinte ne correspond plus
// est vérifié contre le journal rejoué ; ce qu'il cachait est restauré et journalisé.
function assurerIntegrite(agent) {
  const repares = [];
  for (const projet of listerProjetsTous(agent)) {
    const c = chemins(projet, agent);
    try {
      if (etatSigne(c)) continue;
      avecVerrou(c.json, () => {
        const v = verifierEtat(projet, agent);
        if (!v.ecrire) return;
        if (!v.restaures.length && !v.quarantaine) {
          if (lireTexte(c.json) !== null) ecrireEtat(c, v.etat); // JSON sain non signé : simple signature
          return;
        }
        ecrireEtat(c, v.etat);
        ecrireAtomique(c.md, rendreVue(v.etat));
        journaliser(projet, agent, [{ evt: 'restauration-etat', ids: v.restaures, raison: v.raison }]);
        repares.push(projet);
      });
    } catch (_) { /* ce projet reste à réparer ; les autres sont vérifiés quand même */ }
  }
  return repares;
}

// Restauration : toute vue absente ou modifiée hors commande est régénérée depuis le JSON.
function assurerVues(agent) {
  const restaures = [];
  try { assurerIntegrite(agent).forEach(p => restaures.push(p)); } catch (_) { /* la vue reste vérifiée ci-dessous */ }
  for (const projet of listerProjets(agent)) {
    const c = chemins(projet, agent);
    let etat;
    try { etat = lireLedger(projet, agent); } catch (_) { continue; }
    const attendu = rendreVue(etat);
    const actuel = lireTexte(c.md);
    if (actuel !== null && normaliserVue(actuel) === normaliserVue(attendu)) continue; // ancre-mutation:restauration
    avecVerrou(c.json, () => {
      const vue = rendreVue(lireLedger(projet, agent));
      const act2 = lireTexte(c.md);
      if (act2 !== null && normaliserVue(act2) === normaliserVue(vue)) return;
      ecrireAtomique(c.md, vue);
      journaliser(projet, agent, [{ evt: 'restauration-vue', raison: act2 === null ? 'vue absente' : 'vue modifiée hors commande' }]);
      if (!restaures.includes(projet)) restaures.push(projet);
    });
  }
  return restaures;
}

// ---------------------------------------------------------------------------
// Opérations

function normaliserId(x, type) {
  const id = chaine(x).trim().toUpperCase();
  if (!new RegExp(`^${type}-\\d{4,}$`).test(id)) throw new Error(`ID ${type}-NNNN attendu, reçu : ${x === undefined ? '(rien)' : x}`);
  return id;
}

function trouverProjetDe(agent, id, prefere) {
  const cle = id.startsWith('M-') ? 'demandes' : 'lignes';
  const candidats = [];
  if (prefere) { try { validerProjet(prefere); candidats.push(prefere); } catch (_) { /* ignoré */ } }
  for (const p of listerProjets(agent)) if (p !== prefere) candidats.push(p);
  for (const p of candidats) {
    let e;
    try { e = lireLedger(p, agent); } catch (_) { continue; }
    if (e[cle][id]) return p;
  }
  return null;
}

function ajouterDemande({ projet, agent, texte, session, promptId }) {
  const t = chaine(texte);
  if (!t.trim()) throw new Error('message vide');
  return modifierLedger(projet, agent, (etat, o) => {
    const id = allouerIdLibre('M', etat);
    const iso = maintenantIso();
    etat.demandes[id] = {
      texte: t, date: dateLocale(), ts: iso, session: session || null, promptId: promptId || null,
      statut: 'a-trier', lignes: [], raison: null, maj: iso,
    };
    if (t.length > EXTRAIT_COMPACT) o.texteLong(id, t);
    o.journal({ evt: 'demande', id, session: session || null, promptId: promptId || null, texte: t });
    return id;
  });
}

function ajouterLigne({ projet, agent, texte, de }) {
  const t = chaine(texte);
  if (!t.trim()) throw new Error('texte de la ligne vide');
  const deId = de ? normaliserId(de, 'M') : null;
  return modifierLedger(projet, agent, (etat, o) => {
    if (deId && !etat.demandes[deId]) {
      const ailleurs = trouverProjetDe(agent, deId, null);
      throw new Error(`${deId} introuvable dans le projet ${projet}` + (ailleurs ? ` (il est dans le projet ${ailleurs} : utilise --projet ${ailleurs})` : ''));
    }
    const id = allouerIdLibre('C', etat);
    const iso = maintenantIso();
    etat.lignes[id] = {
      texte: t, de: deId, date: dateLocale(), ts: iso, statut: 'ouvert',
      note: null, preuve: null, citationUtilisateur: null, maj: iso,
    };
    if (deId) {
      const d = etat.demandes[deId];
      d.statut = 'converti';
      d.lignes = Array.isArray(d.lignes) ? d.lignes : [];
      d.lignes.push(id);
      d.maj = iso;
    }
    if (t.length > EXTRAIT_COMPACT) o.texteLong(id, t);
    o.journal({ evt: 'ajout', id, de: deId, texte: t });
    return id;
  });
}

function projetPour(agent, id, projet) {
  const p = trouverProjetDe(agent, id, projet || null);
  if (!p) throw new Error(`${id} introuvable dans les fichiers contexte de l'agent ${agent}`);
  // Projet indiqué explicitement : l'ID doit s'y trouver. La numérotation est commune à tous les projets :
  // sans ce contrôle, `etat --projet A C-0020` modifiait la ligne C-0020 d'un autre projet (cas réel).
  if (projet && p !== projet) throw new Error(`${id} n'est pas dans le projet ${projet} : il est dans le projet ${p} (--projet ${p} si c'est bien cette ligne)`); // ancre-mutation:projet-strict
  return p;
}

function classerSansTravail({ projet, agent, id, raison }) {
  const mid = normaliserId(id, 'M');
  const r = chaine(raison).trim();
  if (!r) throw new Error('raison requise pour sans-travail');
  const p = projetPour(agent, mid, projet);
  modifierLedger(p, agent, (etat, o) => {
    const d = etat.demandes[mid];
    if (d.statut === 'converti') throw new Error(`${mid} est déjà converti en ${(d.lignes || []).join(', ')} : rien à classer`);
    d.statut = 'sans-travail';
    d.raison = r;
    d.maj = maintenantIso();
    o.journal({ evt: 'sans-travail', id: mid, raison: r });
  });
  return { projet: p };
}

function changerEtat({ projet, agent, id, statut, note }) {
  const cid = normaliserId(id, 'C');
  const s = chaine(statut).trim();
  if (s === 'fait') throw new Error('aucune commande ne marque « fait » : cite [ctx ' + cid + '] dans l\'historique, la mémoire ou le commit, le hook le retire sur cette preuve');
  if (!STATUTS_MANUELS.includes(s)) throw new Error(`état inconnu : ${statut} (attendu : ${STATUTS_MANUELS.join(', ')})`);
  const n = chaine(note).trim();
  if (s === 'bloque-utilisateur' && !n) throw new Error('raison requise pour bloque-utilisateur');
  const p = projetPour(agent, cid, projet);
  modifierLedger(p, agent, (etat, o) => {
    const l = etat.lignes[cid];
    if (TERMINAUX.includes(l.statut)) throw new Error(`${cid} est déjà ${l.statut} : état non modifiable`);
    const avant = l.statut;
    l.statut = s;
    if (n) l.note = n;
    l.maj = maintenantIso();
    o.journal({ evt: 'etat', id: cid, avant, apres: s, note: n || null });
  });
  return { projet: p };
}

function normaliserFinsDeLigne(t) { return chaine(t).replace(/\r\n?/g, '\n'); }

function abandonner({ projet, agent, id, citation }) {
  const cid = normaliserId(id, 'C');
  const cit = chaine(citation).trim();
  const p = projetPour(agent, cid, projet);
  const refuser = raison => {
    journaliser(p, agent, [{ evt: 'abandon-refuse', id: cid, citation: cit, raison }]);
    throw new Error(raison);
  };
  if (cit.length < CITATION_MIN) refuser(`citation trop courte (${cit.length} caractères, minimum ${CITATION_MIN}) : abandon refusé`);
  // Messages de l'utilisateur : ceux du journal (append-only) quand il existe, pas une demande ajoutée au JSON
  // par un script pour fabriquer une citation.
  const rejoue = rejouerJournal(p, agent);
  const base = rejoue || lireLedger(p, agent);
  const sources = base.demandes;
  const aiguille = normaliserFinsDeLigne(cit);
  const citant = trierIds(sources).filter(m => normaliserFinsDeLigne(sources[m].texte).includes(aiguille));
  if (!citant.length) refuser(`citation introuvable mot pour mot dans les messages de l'utilisateur enregistrés pour le projet ${p} : abandon refusé`);
  // Règle : le message cité doit avoir été écrit APRÈS la création de la ligne
  // (un contre-ordre). La demande qui a créé la ligne ne peut pas servir à l'abandonner.
  const creee = Date.parse(chaine(base.lignes[cid] && base.lignes[cid].ts)) || 0;
  const trouvee = citant.find(m => (Date.parse(chaine(sources[m].ts)) || 0) > creee); // ancre-mutation:abandon-posterieur
  if (!trouvee) refuser(`citation trouvée seulement dans un message antérieur à la ligne (${citant.join(', ')}) : il faut un message de l'utilisateur écrit après la création de ${cid} (un contre-ordre) : abandon refusé`);
  modifierLedger(p, agent, (etat, o) => {
    const l = etat.lignes[cid];
    if (TERMINAUX.includes(l.statut)) throw new Error(`${cid} est déjà ${l.statut}`);
    const avant = l.statut;
    l.statut = 'abandon-utilisateur';
    l.citationUtilisateur = cit;
    l.maj = maintenantIso();
    o.journal({ evt: 'abandon', id: cid, avant, citation: cit, source: trouvee });
  });
  return { projet: p };
}

// ---------------------------------------------------------------------------
// Sessions

function cheminSession(agent, sessionId) {
  validerAgent(agent);
  const s = chaine(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(racine(), '.sessions', `${agent}-${s}.json`);
}

function lireSession(agent, sessionId) {
  if (!sessionId) return null;
  try {
    const t = lireTexte(cheminSession(agent, sessionId));
    return t ? JSON.parse(sansBom(t)) : null;
  } catch (_) { return null; }
}

function modifierSession(agent, sessionId, fn) {
  const f = cheminSession(agent, sessionId);
  return avecVerrou(f, () => {
    const s = lireSession(agent, sessionId) || {};
    const r = fn(s);
    ecrireAtomique(f, JSON.stringify(s, null, 2) + '\n');
    return r;
  });
}

function lierSessionObjet(s, cwd) {
  if (!s.projet) {
    s.projet = projetDepuisCwd(cwd);
    s.lieLe = maintenantIso();
    s.cwdInitial = cwd || null;
  }
  return s.projet;
}

function lierSession(agent, sessionId, cwd) {
  if (!sessionId) return projetDepuisCwd(cwd);
  return modifierSession(agent, sessionId, s => lierSessionObjet(s, cwd));
}

function projetDeSession(agent, sessionId, cwd) {
  const s = lireSession(agent, sessionId);
  return (s && s.projet) || projetDepuisCwd(cwd);
}

function enregistrerMessage({ agent, sessionId, promptId, cwd, texte }) {
  if (!sessionId) {
    const projet = projetDepuisCwd(cwd);
    return { id: ajouterDemande({ projet, agent, texte, session: null, promptId }), projet, doublon: false };
  }
  return modifierSession(agent, sessionId, s => {
    const projet = lierSessionObjet(s, cwd);
    s.promptsVus = Array.isArray(s.promptsVus) ? s.promptsVus : [];
    if (promptId && s.promptsVus.includes(promptId)) return { id: null, projet, doublon: true };
    const debut = maintenantIso();
    const id = ajouterDemande({ projet, agent, texte, session: sessionId, promptId });
    if (promptId) s.promptsVus = s.promptsVus.concat(promptId).slice(-200);
    s.promptCourant = promptId || null;
    s.tourDebut = debut;
    s.tourMessages = [id];
    return { id, projet, doublon: false };
  });
}

// Filet : un message de l'utilisateur qu'un incident (verrou, disque) empêche d'enregistrer est gardé ici,
// sans verrou, et le modèle est prévenu (contexteEchecMessage) : jamais de perte silencieuse.
function secours({ agent, sessionId, promptId, texte, erreur }) {
  validerAgent(agent);
  const f = path.join(racine(), `.secours-${agent}.jsonl`);
  ajouterAuFichier(f, JSON.stringify({
    ts: maintenantIso(), session: sessionId || null, promptId: promptId || null, texte: chaine(texte), erreur: chaine(erreur),
  }) + '\n');
  return f;
}

function contexteEchecMessage({ agent, projet, script, erreur, fichierSecours }) {
  const cmd = commandes(script, projet);
  return composerContexte([
    `Fichier contexte (projet ${projet}, agent ${agent}) : ce message de l'utilisateur n'a PAS pu être enregistré (${chaine(erreur) || 'erreur inconnue'}).`,
    fichierSecours ? `Il est gardé mot pour mot dans ${fichierSecours}.` : '',
    `Inscris-le toi-même avant d'agir : \`${cmd.ajouter()}\` (une ligne par travail demandé, texte mot pour mot).`,
  ].filter(Boolean).join('\n'), [], '', cmd.lister);
}

function rappelStop({ agent, sessionId, promptId, dernierMessage, script }) {
  const s = lireSession(agent, sessionId);
  if (!s || !s.projet) return null;
  const cle = s.promptCourant || promptId || s.tourDebut;
  if (!cle || (s.rappels || []).includes(cle)) return null;
  const etat = lireLedger(s.projet, agent);
  const msg = chaine(dernierMessage);
  const aTrier = (s.tourMessages || []).filter(id => etat.demandes[id] && etat.demandes[id].statut === 'a-trier');
  const lignesTour = s.tourDebut ? trierIds(etat.lignes).filter(id => {
    const l = etat.lignes[id];
    return l.maj && l.maj >= s.tourDebut && !TERMINAUX.includes(l.statut) && !msg.includes(id);
  }) : [];
  if (!aTrier.length && !lignesTour.length) return null;
  const deja = modifierSession(agent, sessionId, x => {
    x.rappels = Array.isArray(x.rappels) ? x.rappels : [];
    if (x.rappels.includes(cle)) return true;
    x.rappels = x.rappels.concat(cle).slice(-200);
    return false;
  });
  if (deja) return null;
  const cmd = commandes(script, s.projet);
  // Liste plafonnée : les consignes doivent rester lisibles sous le plafond de 9 000 caractères.
  const borner = items => (items.length > MAX_IDS_RAPPEL
    ? `${items.slice(0, MAX_IDS_RAPPEL).join(', ')} et ${items.length - MAX_IDS_RAPPEL} autre(s) (liste complète : \`${cmd.lister}\`)`
    : items.join(', '));
  const parts = [`Fichier contexte (projet ${s.projet}) : fin de tour.`];
  if (aTrier.length) {
    parts.push(`Message(s) de l'utilisateur encore à trier : ${borner(aTrier)}. Transforme-le(s) avec \`${cmd.ajouter(aTrier[0])}\` ou classe-le(s) avec \`${cmd.sansTravail(aTrier[0])}\`.`);
  }
  if (lignesTour.length) {
    const detail = borner(lignesTour.map(id => `${id} (${etat.lignes[id].statut})`));
    parts.push(`Lignes créées ou modifiées pendant ce tour, ni faites ni citées dans ta réponse : ${detail}. Si c'est fait : cite [ctx C-NNNN] dans l'historique ou le commit ; sinon mets l'état à jour avec \`${cmd.etat}\` et dis à l'utilisateur ce qui reste.`);
  }
  return composerContexte(parts.join('\n'), [], '', cmd.lister);
}

// Lit `fichier` de l'octet `depuis` à l'octet `jusqua`, par blocs de 4 Mo, et appelle surLigne(Buffer) pour
// chaque ligne COMPLÈTE. Retourne l'octet qui suit la dernière ligne complète : une ligne en cours
// d'écriture sera relue au passage suivant.
function lireLignesDepuis(fichier, depuis, jusqua, surLigne) {
  let fin = depuis;
  const fd = fs.openSync(lp(fichier), 'r');
  try {
    const bloc = Buffer.alloc(4 * 1024 * 1024);
    let reste = Buffer.alloc(0);
    let pos = depuis;
    while (pos < jusqua) {
      const n = fs.readSync(fd, bloc, 0, Math.min(bloc.length, jusqua - pos), pos);
      if (n <= 0) break;
      pos += n;
      const donnees = reste.length ? Buffer.concat([reste, bloc.subarray(0, n)]) : bloc.subarray(0, n);
      let debut = 0;
      let i;
      while ((i = donnees.indexOf(10, debut)) !== -1) {
        const ligne = donnees.subarray(debut, i);
        fin += ligne.length + 1;
        debut = i + 1;
        surLigne(ligne);
      }
      reste = Buffer.from(donnees.subarray(debut));
    }
  } finally { fs.closeSync(fd); }
  return fin;
}

// Suite du transcript de la session depuis le dernier octet vu (session.transcriptVu). Premier passage sur
// un transcript déjà existant : sert de base, rien n'est lu (l'historique d'avant l'activation n'est pas
// rejoué). Retourne null s'il n'y a rien de nouveau, sinon { vu, base } : l'appelant enregistre `vu` dans
// session.transcriptVu une fois ses lignes traitées (en cas d'échec il ne l'avance pas : relecture).
function suiteTranscript({ agent, sessionId, fichier, surLigne }) {
  if (!fichier || typeof fichier !== 'string' || !sessionId) return null;
  let taille;
  try { taille = fs.statSync(lp(fichier)).size; } catch (e) {
    if (e.code !== 'ENOENT') return null;
    taille = -1; // transcript pas encore créé : tout ce qui y sera écrit est nouveau
  }
  const s = lireSession(agent, sessionId);
  const vu = s && Number.isFinite(s.transcriptVu) ? s.transcriptVu : null;
  if (taille < 0) return vu === null ? { vu: 0, base: true } : null;
  if (vu === null || vu > taille) return { vu: taille, base: true };
  if (vu === taille) return null;
  return { vu: lireLignesDepuis(fichier, vu, taille, surLigne), base: false };
}

// ---------------------------------------------------------------------------
// Livraisons des sous-agents
//
// Mesuré dans une session réelle : 443 fins de sous-agents, dont 301 arrivées PENDANT que l'orchestrateur
// faisait autre chose ; pour 248, il n'a plus jamais reparlé de l'agent ensuite. Une notification passe une
// fois, rien ne la retient. Ici chaque sous-agent lancé devient une ligne de la liste de travail : créée au
// lancement, marquée « terminé, résultat à traiter » à la fin, rappelée à chaque fin de tour, et retirée
// seulement sur preuve [ctx C-NNNN] (résultat vérifié et intégré).
// Les tâches suivies sont gardées dans la session de l'orchestrateur :
//   session.taches[idTache] = { ligne, projet, titre, genre, resultat, alias, lance, fini, statut, clos }

const DELAI_REESSAI_MS = 6000;
const MAX_LIVRAISONS = 20;
const MAX_TACHES_CLOSES = 300;
const RAPPEL_LIVRAISONS_MIN = 20;

// « verrou occupé » est levé AVANT toute écriture : on réessaie (hooks parallèles, plusieurs sessions).
function reessayer(fn) {
  const limite = Date.now() + DELAI_REESSAI_MS;
  for (;;) {
    try { return fn(); } catch (e) {
      if (!/verrou occupé/.test(e && e.message ? e.message : String(e)) || Date.now() > limite) throw e;
      dormir(50 + Math.floor(Math.random() * 100));
    }
  }
}

// Au lancement : une ligne de travail par tâche de fond. tache = { id, genre, titre, resultat, alias }
// (alias : autre nom sous lequel la fin de la tâche peut être annoncée). Retourne l'ID de la ligne, ou null
// si la tâche est déjà suivie.
function suivreTache({ agent, sessionId, cwd, tache }) {
  validerAgent(agent);
  const id = chaine(tache && tache.id);
  if (!sessionId || !id) return null;
  const s = lireSession(agent, sessionId) || {};
  if (estObjet(s.taches) && s.taches[id]) return null;
  const projet = projetDeSession(agent, sessionId, cwd);
  const titre = (chaine(tache.titre) || 'sans titre').replace(/\s+/g, ' ').slice(0, 90);
  const genre = chaine(tache.genre) || 'agent';
  const texte = `[agent] « ${titre} » (${genre}, ${id}) : à sa fin, lire son résultat, le vérifier et l'intégrer.`;
  const ligne = reessayer(() => ajouterLigne({ projet, agent, texte, de: null })); // ancre-mutation:livraison-lancement
  try { reessayer(() => changerEtat({ projet, agent, id: ligne, statut: 'en-cours', note: `agent en cours depuis ${dateLocale()}` })); } catch (_) { /* la ligne existe : seul l'état manque */ }
  reessayer(() => modifierSession(agent, sessionId, x => {
    x.taches = estObjet(x.taches) ? x.taches : {};
    x.taches[id] = { ligne, projet, titre, genre, resultat: chaine(tache.resultat), alias: tache.alias ? chaine(tache.alias) : null, lance: maintenantIso() };
  }));
  return ligne;
}

// À la fin d'une tâche suivie. Retourne la tâche à traiter, ou null quand il n'y a rien de nouveau.
//  - première fin : la ligne passe de « agent en cours » à « terminé, résultat à traiter » ;
//  - fin de plus alors que la ligne attend encore : rien (une seule ligne ouverte par agent) ;
//  - fin de plus alors que la ligne est close sur preuve, signalée en direct (reprise = true : l'agent a
//    été relancé et a rendu un nouveau résultat) : une nouvelle ligne ; un filet qui relit une trace
//    (transcript) passe reprise = false, car il peut revoir la fin déjà traitée ;
//  - tâche inconnue (lancée avant l'activation, ou par un sous-agent) : ignorée.
function finirTache({ agent, sessionId, id, statut, resultat, reprise }) {
  validerAgent(agent);
  const cle = chaine(id);
  const s = lireSession(agent, sessionId);
  const t = s && estObjet(s.taches) && s.taches[cle];
  if (!t) return null;
  const st = chaine(statut) || 'terminé';
  const res = chaine(resultat) || chaine(t.resultat);
  const note = `TERMINÉ (${st}) le ${dateLocale()} : résultat à lire, vérifier et intégrer${res ? ' : ' + res : ''}`; // ancre-mutation:livraison-fin
  let close = false;
  try { const l = lireLedger(t.projet, agent).lignes[t.ligne]; close = !l || TERMINAUX.includes(l.statut); } catch (_) { return null; }
  const marquer = ligne => reessayer(() => modifierSession(agent, sessionId, x => {
    const y = estObjet(x.taches) && x.taches[cle];
    if (y) Object.assign(y, { ligne, fini: maintenantIso(), statut: st, resultat: res, clos: null, annonce: null });
  }));
  if (!close) {
    if (t.fini) return null;
    try { reessayer(() => changerEtat({ projet: t.projet, agent, id: t.ligne, statut: 'ouvert', note })); } catch (_) { /* close entre-temps : rien à rappeler */ }
    marquer(t.ligne);
    return Object.assign({}, t, { id: cle, statut: st, resultat: res });
  }
  if (!reprise) {
    if (!t.fini) marquer(t.ligne);
    return null;
  }
  const texte = `[agent] « ${t.titre} » (${t.genre}, ${cle}) : nouveau résultat rendu après la clôture de ${t.ligne}, à lire, vérifier et intégrer.`;
  const ligne = reessayer(() => ajouterLigne({ projet: t.projet, agent, texte, de: null })); // ancre-mutation:livraison-reprise
  try { reessayer(() => changerEtat({ projet: t.projet, agent, id: ligne, statut: 'ouvert', note })); } catch (_) { /* la ligne existe : seule la note manque */ }
  marquer(ligne);
  return Object.assign({}, t, { id: cle, ligne, statut: st, resultat: res });
}

// Tâches terminées dont la ligne n'est pas close, et tâches encore en cours. Une tâche dont la ligne est
// close reste connue (une reprise créera une nouvelle ligne), les plus anciennes sont purgées.
function livraisons({ agent, sessionId }) {
  const s = lireSession(agent, sessionId);
  const taches = s && estObjet(s.taches) ? s.taches : {};
  const attente = []; const enCours = []; const closes = [];
  const etats = {};
  for (const [id, t] of Object.entries(taches)) {
    if (!estObjet(t) || t.clos) continue;
    let e = etats[t.projet];
    if (!e) { try { e = etats[t.projet] = lireLedger(t.projet, agent); } catch (_) { continue; } }
    const l = e.lignes[t.ligne];
    if (!l || TERMINAUX.includes(l.statut)) { closes.push(id); continue; }
    (t.fini ? attente : enCours).push(Object.assign({ id }, t));
  }
  if (closes.length) {
    try {
      modifierSession(agent, sessionId, x => {
        if (!estObjet(x.taches)) return;
        const iso = maintenantIso();
        for (const id of closes) if (estObjet(x.taches[id])) x.taches[id].clos = iso;
        const anciennes = Object.keys(x.taches).filter(k => x.taches[k].clos)
          .sort((a, b) => (x.taches[a].clos < x.taches[b].clos ? -1 : 1));
        for (const k of anciennes.slice(0, Math.max(0, anciennes.length - MAX_TACHES_CLOSES))) delete x.taches[k];
      });
    } catch (_) { /* marquage reporté au prochain passage */ }
  }
  return { attente, enCours };
}

// Tâche en cours (pas encore finie) connue sous cet alias, ou null.
function tacheParAlias(agent, sessionId, alias) {
  const a = chaine(alias);
  if (!a) return null;
  const s = lireSession(agent, sessionId);
  const taches = s && estObjet(s.taches) ? s.taches : {};
  const id = Object.keys(taches).find(k => estObjet(taches[k]) && taches[k].alias === a && !taches[k].fini);
  return id || null;
}

function decrireTache(t) { return `${t.ligne} « ${t.titre} »${t.resultat ? ` (résultat : ${t.resultat})` : ''}`; }

// Rappel de fin de tour : livraisons non traitées et non citées dans la réponse de l'orchestrateur.
// Revient à CHAQUE fin de tour tant que le résultat n'est pas prouvé traité.
function texteLivraisons({ agent, sessionId, dernierMessage }) {
  let etat;
  try { etat = livraisons({ agent, sessionId }); } catch (_) { return ''; }
  const msg = chaine(dernierMessage);
  const attente = etat.attente.filter(t => !msg.includes(t.ligne)); // ancre-mutation:livraison-rappel
  const nonDites = etat.attente.filter(t => !t.annonce);
  if (!attente.length) { noterAnnonce(agent, sessionId, nonDites, false); return ''; } // citées : déjà connues
  noterAnnonce(agent, sessionId, nonDites, true);
  const liste = attente.slice(0, MAX_LIVRAISONS).map(decrireTache).join(' ; ');
  const plus = attente.length > MAX_LIVRAISONS ? ` ; et ${attente.length - MAX_LIVRAISONS} autre(s)` : '';
  return `Sous-agents TERMINÉS dont le résultat n'est pas traité (${attente.length}) : ${liste}${plus}. Avant de t'arrêter : lis chaque résultat, vérifie-le, intègre-le, puis cite [ctx C-NNNN] dans l'historique ; sinon dis à l'utilisateur lesquels restent et pourquoi.${texteEnCours(etat)}`;
}

function texteEnCours(etat) {
  return etat.enCours.length ? ` Encore en cours : ${etat.enCours.length} (${etat.enCours.slice(0, MAX_LIVRAISONS).map(t => t.ligne).join(', ')}).` : '';
}

// Texte court pour des sous-agents qui viennent de finir (fins = tâches rendues par finirTache).
function texteFins(fins) {
  const vus = new Set();
  const uniques = (fins || []).filter(t => t && !vus.has(t.ligne) && vus.add(t.ligne));
  if (!uniques.length) return '';
  const plus = uniques.length > MAX_LIVRAISONS ? ` ; et ${uniques.length - MAX_LIVRAISONS} autre(s)` : '';
  return `Sous-agent(s) terminé(s), résultat à traiter : ${uniques.slice(0, MAX_LIVRAISONS).map(decrireTache).join(' ; ')}${plus}. Ne les oublie pas : lis, vérifie et intègre chaque résultat avant de t'arrêter, puis cite [ctx C-NNNN] dans l'historique.`;
}

// Délai du rappel en cours de tour, en millisecondes (CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN, en minutes).
function delaiRappelMs() {
  const brut = process.env.CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN;
  const v = brut === undefined || String(brut).trim() === '' ? NaN : Number(brut);
  return (Number.isFinite(v) && v >= 0 ? v : RAPPEL_LIVRAISONS_MIN) * 60000;
}

// Retient que ces fins ont été dites à l'orchestrateur (et, si rappel, l'heure du dernier rappel complet).
// Un échec d'écriture ne retient rien : la fin sera redite, ce qui vaut mieux qu'une fin jamais dite.
function noterAnnonce(agent, sessionId, taches, rappel) {
  if (!taches.length && !rappel) return;
  try {
    reessayer(() => modifierSession(agent, sessionId, x => {
      const iso = maintenantIso();
      if (estObjet(x.taches)) for (const t of taches) if (estObjet(x.taches[t.id])) x.taches[t.id].annonce = iso;
      if (rappel) x.rappelLivraisons = iso;
    }));
  } catch (_) { /* redit au prochain événement */ }
}

// En cours de tour, sur un événement que l'orchestrateur lit avant de s'arrêter (outil, message, reprise).
// Trouvé dans une session réelle : l'événement de fin du sous-agent marque la fin sans rien dire à
// l'orchestrateur, et le rappel n'existait qu'en fin de tour ; un tour de plus de 4 heures a laissé
// 7 résultats sans rappel.
//  - fin pas encore dite à l'orchestrateur : annonce courte, une fois ;
//  - résultat déjà annoncé qui attend depuis plus du délai : rappel de tout ce qui attend, au plus une
//    fois par délai (20 minutes).
function texteSuiviEnCours({ agent, sessionId }) {
  validerAgent(agent);
  const s = lireSession(agent, sessionId);
  const taches = s && estObjet(s.taches) ? s.taches : {};
  if (!Object.values(taches).some(t => estObjet(t) && t.fini && !t.clos)) return '';
  let etat;
  try { etat = livraisons({ agent, sessionId }); } catch (_) { return ''; }
  if (!etat.attente.length) return '';
  const nouvelles = etat.attente.filter(t => !t.annonce); // ancre-mutation:livraison-annonce
  const delai = delaiRappelMs();
  const age = iso => Date.now() - (Date.parse(iso || '') || 0);
  // Délai compté depuis l'annonce, pas depuis la fin : une fin ancienne annoncée à l'instant n'est pas
  // rappelée dans la foulée (constaté en réel : annonce puis rappel à une demi-seconde d'écart).
  const rappeler = age(s.rappelLivraisons) >= delai && etat.attente.some(t => t.annonce && age(t.annonce) >= delai); // ancre-mutation:livraison-rappel-en-cours
  if (!nouvelles.length && !rappeler) return '';
  noterAnnonce(agent, sessionId, nouvelles, rappeler);
  if (!rappeler) return texteFins(nouvelles);
  const liste = etat.attente.slice(0, MAX_LIVRAISONS).map(t => `${t.ligne} « ${t.titre} »`).join(' ; ');
  const plus = etat.attente.length > MAX_LIVRAISONS ? ` ; et ${etat.attente.length - MAX_LIVRAISONS} autre(s)` : '';
  return `Rappel : ${etat.attente.length} sous-agent(s) TERMINÉ(S) dont le résultat n'est toujours pas traité : ${liste}${plus}. N'attends pas la fin du tour : dès que l'étape en cours est finie, lis chaque résultat (son chemin est dans la note de sa ligne), vérifie-le, intègre-le, puis cite [ctx C-NNNN] dans l'historique.${texteEnCours(etat)}`;
}

// ---------------------------------------------------------------------------
// Preuves

function extraireMarqueurs(texte) {
  const out = [];
  const t = chaine(texte);
  RE_MARQUEUR.lastIndex = 0;
  let m;
  while ((m = RE_MARQUEUR.exec(t))) {
    const partiel = !!m[2];
    for (const id of m[1].match(/C-\d{4,}/gi)) out.push({ id: id.toUpperCase(), partiel });
  }
  return out;
}

function soustraireMarqueurs(nouveaux, anciens) {
  const reste = new Map();
  for (const a of anciens) { const k = `${a.id}|${a.partiel}`; reste.set(k, (reste.get(k) || 0) + 1); }
  return nouveaux.filter(n => {
    const k = `${n.id}|${n.partiel}`;
    const c = reste.get(k) || 0;
    if (c > 0) { reste.set(k, c - 1); return false; }
    return true;
  });
}

// Marqueurs du texte AJOUTÉ uniquement : un marqueur déjà présent dans l'ancien texte ne compte pas.
function marqueursAjoutes(toolName, toolInput, toolResponse) {
  const ti = toolInput || {};
  const tr = toolResponse && typeof toolResponse === 'object' ? toolResponse : {};
  let nouveau = '';
  let ancien = '';
  if (toolName === 'Write') {
    nouveau = chaine(ti.content);
    ancien = typeof tr.originalFile === 'string' ? tr.originalFile : '';
  } else if (toolName === 'Edit') {
    nouveau = chaine(ti.new_string);
    ancien = chaine(ti.old_string);
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    nouveau = edits.map(e => chaine(e && e.new_string)).join('\n');
    ancien = edits.map(e => chaine(e && e.old_string)).join('\n');
  } else if (toolName === 'NotebookEdit') {
    nouveau = chaine(ti.new_source);
  } else {
    return [];
  }
  return soustraireMarqueurs(extraireMarqueurs(nouveau), extraireMarqueurs(ancien));
}

function normChemin(p, cwd) {
  let s = chaine(p).replace(/^\\\\\?\\/, '');
  try { s = cwd ? path.resolve(chaine(cwd), s) : path.resolve(s); } catch (_) { /* garder tel quel */ }
  return s.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

// Fichiers où une preuve [ctx] compte : l'historique et le résumé commun de la maison (ou de `base`), et la
// mémoire de projet que Claude Code tient lui-même (~/.claude/projects/<projet>/memory/*.md).
function estFichierPreuve(fichier, base, cwd) {
  if (!fichier) return false;
  const n = normChemin(fichier, cwd);
  const sous = (racineBase, motif) => {
    const b = normChemin(racineBase);
    return n.startsWith(b + '/') && motif.test(n.slice(b.length + 1));
  };
  if (sous(base || config.maison(), /^(?:history\/[^/]+\.md|memory-auto\.md|projects\/[^/]+\/memory\/[^/]+\.md)$/)) return true;
  return sous(path.join(os.homedir(), '.claude'), /^projects\/[^/]+\/memory\/[^/]+\.md$/);
}

function preuveCommit({ commande, cwd }) {
  const cmd = chaine(commande);
  if (!cmd) return null;
  const rc = resolveCommitTarget(cmd, chaine(cwd) || process.cwd());
  if (!rc.isCommit) return null;
  const opts = { cwd: rc.gitCwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  let sortie;
  try { sortie = execFileSync('git', ['log', '-1', '--format=%ct%x00%H%x00%B'], opts); } catch (_) { return null; }
  const parts = sortie.split('\0');
  const ct = Number(parts[0]);
  const sha = chaine(parts[1]).trim();
  const message = sansBom(parts.slice(2).join('\0'));
  const age = Date.now() / 1000 - ct;
  if (!Number.isFinite(ct) || age > FRAICHEUR_COMMIT_S || age < -5 || !sha) return null;
  let racineDepot = rc.gitCwd;
  try { racineDepot = execFileSync('git', ['rev-parse', '--show-toplevel'], opts).trim() || rc.gitCwd; } catch (_) { /* garder gitCwd */ }
  return { sha, court: sha.slice(0, 7), message, racineDepot };
}

function preuvesDepuisOutil({ toolName, toolInput, toolResponse, cwd, base }) {
  const ti = toolInput || {};
  if (OUTILS_FICHIER.includes(toolName)) {
    const f = ti.file_path || ti.notebook_path || ti.path;
    if (!f || !estFichierPreuve(f, base, cwd)) return null;
    const marqueurs = marqueursAjoutes(toolName, ti, toolResponse);
    return marqueurs.length ? { marqueurs, preuve: `fichier ${f}` } : null;
  }
  if (OUTILS_SHELL.includes(toolName)) {
    const cmd = chaine(ti.command || ti.script || ti.input || ti.cmd);
    const c = preuveCommit({ commande: cmd, cwd: ti.workdir || ti.cwd || cwd });
    if (!c) return null;
    const marqueurs = extraireMarqueurs(c.message);
    return marqueurs.length ? { marqueurs, preuve: `commit ${c.sha} (${c.racineDepot})` } : null;
  }
  return null;
}

// Seul chemin vers « fait ». Un marqueur non partiel l'emporte sur un partiel du même ID.
function appliquerPreuves({ agent, marqueurs, preuve }) {
  validerAgent(agent);
  const res = { faits: [], partiels: [], ignores: [], projets: [] };
  const parId = new Map();
  for (const m of marqueurs || []) {
    const id = chaine(m.id).toUpperCase();
    if (!/^C-\d{4,}$/.test(id)) continue;
    parId.set(id, parId.get(id) === 'fait' || !m.partiel ? 'fait' : 'partiel');
  }
  if (!parId.size) return res;
  const trouves = new Set();
  for (const projet of listerProjets(agent)) {
    let etat;
    try { etat = lireLedger(projet, agent); } catch (_) { continue; }
    const ids = [...parId.keys()].filter(id => etat.lignes[id]);
    if (!ids.length) continue;
    ids.forEach(id => trouves.add(id));
    let change = false;
    modifierLedger(projet, agent, (e, o) => {
      for (const id of ids) {
        const l = e.lignes[id];
        if (!l || TERMINAUX.includes(l.statut)) { res.ignores.push(id); continue; }
        const iso = maintenantIso();
        if (parId.get(id) === 'fait') {
          const avant = l.statut;
          l.statut = 'fait';
          l.preuve = preuve;
          l.maj = iso;
          o.journal({ evt: 'fait', id, avant, preuve });
          res.faits.push(id);
        } else {
          const avant = l.statut;
          const note = `partiel (preuve : ${preuve})`;
          l.statut = 'en-cours';
          l.note = l.note && !/^partiel \(preuve/.test(l.note) ? `${note} ; ${l.note}` : note;
          l.maj = iso;
          o.journal({ evt: 'partiel', id, avant, preuve });
          res.partiels.push(id);
        }
        change = true;
      }
    });
    if (change) res.projets.push(projet);
  }
  for (const id of parId.keys()) if (!trouves.has(id)) res.ignores.push(id);
  return res;
}

function listerFichiersPreuve(base) {
  const out = [];
  const hist = path.join(base, 'history');
  for (const n of lireDossier(hist)) if (/\.md$/i.test(n)) out.push(path.join(hist, n));
  out.push(path.join(base, 'Memory-Auto.md'));
  const proj = path.join(base, 'projects');
  for (const d of lireDossier(proj, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mem = path.join(proj, d.name, 'memory');
    for (const n of lireDossier(mem)) if (/\.md$/i.test(n)) out.push(path.join(mem, n));
  }
  return out;
}

function hashCourt(t) { return crypto.createHash('sha1').update(t).digest('hex').slice(0, 16); }

function reconcilier({ agent, base }) {
  validerAgent(agent);
  const b = base || config.maison();
  const fEtat = path.join(racine(), `.reconciliation-${agent}.json`);
  const parFichier = avecVerrou(fEtat, () => {
    let st = null;
    try { const t = lireTexte(fEtat); st = t ? JSON.parse(sansBom(t)) : null; } catch (_) { st = null; }
    const premierPassage = !st;
    const s = st || { fichiers: {} };
    s.fichiers = s.fichiers || {};
    const trouves = [];
    for (const f of listerFichiersPreuve(b)) {
      let stat;
      try { stat = fs.statSync(lp(f)); } catch (_) { continue; }
      const cle = normChemin(f);
      const prec = s.fichiers[cle];
      if (prec && prec.mtimeMs === stat.mtimeMs && prec.taille === stat.size) continue;
      const texte = lireTexte(f);
      if (texte === null) continue;
      const lignes = texte.split(/\r?\n/).filter(l => /\[ctx\s/i.test(l));
      const hashes = lignes.map(hashCourt);
      if (!premierPassage) {
        const anciens = new Set(prec ? prec.hashes : []);
        const marqueurs = [];
        lignes.forEach((l, i) => { if (!anciens.has(hashes[i])) marqueurs.push(...extraireMarqueurs(l)); });
        if (marqueurs.length) trouves.push({ fichier: f, marqueurs });
      }
      s.fichiers[cle] = { mtimeMs: stat.mtimeMs, taille: stat.size, hashes: [...new Set(hashes)] };
    }
    s.maj = maintenantIso();
    ecrireAtomique(fEtat, JSON.stringify(s) + '\n');
    return trouves;
  });
  const total = { faits: [], partiels: [], ignores: [], projets: [] };
  for (const { fichier, marqueurs } of parFichier) {
    const r = appliquerPreuves({ agent, marqueurs, preuve: `fichier ${fichier}` });
    for (const k of Object.keys(total)) total[k].push(...r[k].filter(x => !total[k].includes(x)));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Garde PreToolUse

// Texte de commande normalisé pour la recherche de chemins : séparateurs '/', minuscules,
// segments './' retirés et 'x/../' résolus (<maison>/./contexte, <maison>/history/../contexte).
function normaliserTexteChemins(t) {
  let n = chaine(t).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  let avant;
  do { avant = n; n = n.replace(/\/\.(?=\/)/g, ''); } while (n !== avant);
  do { avant = n; n = n.replace(/\/(?!\.\.(?:\/|$))[^/\s"';|&<>()]+\/\.\.(?=\/|$|[\s"';|&<>()])/g, ''); } while (n !== avant);
  return n;
}

// Joker shell (*, ?, [..]) qui peut désigner `nom`.
// Motif impossible à compiler (crochet non fermé, intervalle inversé) : ce n'est pas un joker valide,
// ni en bash (le crochet reste littéral) ni en PowerShell (erreur) : il ne désigne donc pas `nom`.
// Cas réel : renvoyer vrai ici refusait tout `node -e "...([a, b])..."` lancé depuis le dossier parent.
function jokerVise(motif, nom) {
  if (!/[*?[]/.test(motif)) return false;
  try {
    const src = motif.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${src}$`, 'i').test(nom);
  } catch (_) { return false; } // ancre-mutation:joker-invalide
}

function toucheNormalise(n) {
  const motifs = motifsRacine();
  if (motifs.reelle.test(n)) return true;
  const r = normChemin(racine());
  if (n.includes(r)) return true;
  const posix = r.replace(/^([a-z]):/, '/$1');
  if (posix !== r && n.includes(posix)) return true;
  let m;
  while ((m = motifs.segment.exec(n))) if (jokerVise(m[1], motifs.dossier)) return true; // <maison>/cont*, <maison>/*
  return false;
}

function texteToucheRacine(texte) {
  const t = chaine(texte);
  if (motifsRacine().reelle.test(t)) return true;
  return toucheNormalise(normaliserTexteChemins(t));
}

function cheminDansRacine(f, cwd) {
  const n = normChemin(f, cwd);
  const r = normChemin(racine());
  return n === r || n.startsWith(r + '/') || motifsRacine().reelle.test(chaine(f)) || toucheNormalise(n);
}

// Chemins RELATIFS d'une commande shell résolus depuis le cwd du hook et depuis chaque `cd` :
// `cd <maison> && rm -rf contexte`, cwd = <maison> + `rm -rf contexte`, cwd dans la racine.
function commandeViseRacine(cmd, cwd) {
  const c = chaine(cmd);
  if (cwd && cheminDansRacine(cwd)) return true; // shell déjà placé dans la racine
  const bases = [];
  const cwdN = cwd ? normChemin(cwd) : null;
  if (cwdN) bases.push(cwdN);
  const reCd = /(?:^|&&|\|\||[;|&\r\n(])\s*(?:cd|chdir|pushd|set-location|sl|push-location)\s+(?:-(?:literal)?path\s+)?("[^"]*"|'[^']*'|[^\s;|&()]+)/gi;
  let m;
  while ((m = reCd.exec(c))) {
    const cible = normaliserTexteChemins(m[1].replace(/^["']|["']$/g, ''));
    bases.push(/^([a-z]:|\/|~|\$)/i.test(cible) || !cwdN ? cible : path.posix.join(cwdN, cible));
  }
  if (!bases.length) return false;
  const jetons = c.split(/[\s;|&<>(),]+/)
    .map(t => t.replace(/^["'=]+|["']+$/g, ''))
    .filter(t => t && !/^([a-z]:|[\\/~$%@-])/i.test(t));
  for (const b of bases) {
    for (const j of jetons) {
      if (toucheNormalise(normaliserTexteChemins(path.posix.join(b, j.replace(/\\/g, '/'))))) return true;
    }
  }
  return false;
}

// Appel de la CLI ou du noyau context-ledger (avec ou sans .js, require compris).
function appelleCli(texte) {
  return /\b(?:node|nodejs|bun|deno|npx|tsx)(?:\.exe)?["']?\s+[^|;&\r\n]*context-ledger(?:-core)?(?:\.js)?(?![\w.-])/i.test(chaine(texte));
}

function segmentAutorise(seg) {
  const s = seg.replace(/^[&\s]+/, '');
  if (!s) return true;
  if (RE_CLI_SEGMENT.test(s)) return true;
  const m = s.match(/^["']?([^\s"']+)["']?/);
  if (!m) return false;
  let tok = m[1].replace(/\\/g, '/');
  tok = tok.slice(tok.lastIndexOf('/') + 1).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (tok === 'rg' && /(?:^|\s)--pre(?:=|\s|$)/i.test(s)) return false; // rg --pre exécute une commande par fichier
  return LECTURE.has(tok);
}

// Vrai si la commande ne fait que lire (ou appeler la CLI context-ledger).
function commandeLectureOuCli(cmd) {
  const c = chaine(cmd);
  if (/\$\(|`/.test(c)) return false; // substitution de commande : pas analysable, refus
  const masque = maskQuotedSegments(c);
  // Parenthèses et accolades hors guillemets : substitution de processus <( ), sous-expression
  // PowerShell (Get-Item x).Delete() ou Test-Path ([IO.File]::Delete(..)), bloc { } : refus.
  if (/[(){}]/.test(masque)) return false;
  const reRedir = /(?:\d|&)?>{1,2}\s*(&\d|[^\s;|&<>]*)/g;
  let m;
  while ((m = reRedir.exec(masque))) {
    if (!/^(\/dev\/null|\$null|nul|&\d)$/i.test(m[1])) return false;
  }
  // Séparateurs : && || ; | fin de ligne, et & seul (arrière-plan bash, opérateur d'appel PowerShell),
  // sauf dans une redirection (2>&1, &>).
  const reSep = /&&|\|\||[;|\r\n]|(?<![<>])&(?![&>])/g;
  let debut = 0;
  const bornes = [];
  while ((m = reSep.exec(masque))) { bornes.push([debut, m.index]); debut = m.index + m[0].length; }
  bornes.push([debut, c.length]);
  for (const [a, b] of bornes) {
    const seg = c.slice(a, b).trim();
    if (seg && !segmentAutorise(seg)) return false;
  }
  return true;
}

function gardeOutil({ input, generique }) {
  const inp = input || {};
  const tn = chaine(inp.tool_name);
  const ti = inp.tool_input || {};
  const sousAgent = !!inp.agent_id;
  if (OUTILS_FICHIER.includes(tn)) {
    const f = ti.file_path || ti.notebook_path || ti.path;
    if (f && cheminDansRacine(f, inp.cwd)) return sousAgent ? RAISON_SOUS_AGENT : RAISON_FICHIER;
    return null;
  }
  if (OUTILS_SHELL.includes(tn)) {
    const cmd = chaine(ti.command || ti.script || ti.input || ti.cmd);
    if (!cmd) return null;
    const touche = texteToucheRacine(cmd) || commandeViseRacine(cmd, ti.workdir || ti.cwd || inp.cwd);
    if (sousAgent && (touche || appelleCli(cmd))) return RAISON_SOUS_AGENT;
    if (!touche) return null;
    return commandeLectureOuCli(cmd) ? null : RAISON_SHELL;
  }
  if (generique) {
    const brut = JSON.stringify(ti);
    const touche = texteToucheRacine(brut);
    if (sousAgent && (touche || appelleCli(brut))) return RAISON_SOUS_AGENT;
    if (touche) return RAISON_FICHIER;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Texte injecté au modèle

function commandes(script, projet) {
  const s = `node "${chaine(script).replace(/\\/g, '/')}"`;
  return {
    ajouter: m => `${s} ajouter --projet ${projet}${m ? ` --de ${m}` : ''} "texte mot pour mot"`,
    sansTravail: m => `${s} sans-travail --projet ${projet} ${m} "raison courte"`,
    etat: `${s} etat --projet ${projet} C-NNNN en-cours|bloque-utilisateur|ouvert "note"`,
    abandon: `${s} abandon --projet ${projet} C-NNNN "citation EXACTE de l'utilisateur"`,
    lister: `${s} lister --projet ${projet}`,
  };
}

function lignesCompactes(etat) {
  const aTrier = trierIds(etat.demandes).filter(id => etat.demandes[id].statut === 'a-trier');
  const ouverts = trierIds(etat.lignes).filter(id => ['ouvert', 'en-cours'].includes(etat.lignes[id].statut));
  const bloques = trierIds(etat.lignes).filter(id => etat.lignes[id].statut === 'bloque-utilisateur');
  const out = [];
  if (aTrier.length) { out.push('À trier :'); for (const id of aTrier) out.push(ligneDemande(etat, id, EXTRAIT_COMPACT)); }
  if (ouverts.length) { out.push('Ouvert :'); for (const id of ouverts) out.push(ligneTravail(etat, id, EXTRAIT_COMPACT)); }
  if (bloques.length) { out.push('Bloqué : attend l\'utilisateur :'); for (const id of bloques) out.push(ligneTravail(etat, id, EXTRAIT_COMPACT)); }
  if (!out.length) out.push('Aucune ligne ouverte ni message à trier.');
  return out;
}

function composerContexte(entete, lignes, pied, commandeLister, max = PLAFOND) {
  const e = chaine(entete);
  const p = chaine(pied);
  const reserve = 80 + chaine(commandeLister).length;
  let taille = e.length + p.length + 2;
  const retenues = [];
  let i = 0;
  for (; i < lignes.length; i++) {
    if (taille + lignes[i].length + 1 + reserve > max) break;
    retenues.push(lignes[i]);
    taille += lignes[i].length + 1;
  }
  const restantes = lignes.slice(i).filter(l => l.startsWith('- ')).length;
  if (restantes) retenues.push(`(${restantes} lignes de plus : ${commandeLister})`);
  let texte = [e, ...retenues, p].filter(Boolean).join('\n');
  if (texte.length > max) texte = texte.slice(0, max - 1) + '…';
  return texte;
}

function contexteMessage({ agent, projet, idMessage, script }) {
  const cmd = commandes(script, projet);
  const etat = lireLedger(projet, agent);
  const entete = `Fichier contexte (projet ${projet}, agent ${agent}) : ${chemins(projet, agent).md}`;
  const pied = `Nouveau message ${idMessage}. Avant d'agir : transforme-le en ligne(s) de travail avec \`${cmd.ajouter(idMessage)}\` ou classe-le avec \`${cmd.sansTravail(idMessage)}\`. Citer \`[ctx C-NNNN]\` dans l'historique ou le commit quand c'est fait ; \`[ctx C-NNNN partiel]\` si ce n'est pas fini.`;
  return composerContexte(entete, lignesCompactes(etat), pied, cmd.lister);
}

function contexteSession({ agent, projet, script }) {
  const cmd = commandes(script, projet);
  const etat = lireLedger(projet, agent);
  const alerte = avertissementSecours();
  const entete = `Fichier contexte (projet ${projet}, agent ${agent}) : ${chemins(projet, agent).md}\nCe fichier fait foi pour ce qui reste, pas le résumé de compactage.${alerte ? '\n' + alerte : ''}`;
  const pied = `Commandes : \`${cmd.ajouter()}\` ; \`${cmd.etat}\` ; \`${cmd.lister}\`. Une ligne ne disparaît que sur preuve [ctx C-NNNN] (historique, mémoire ou commit).`;
  return composerContexte(entete, lignesCompactes(etat), pied, cmd.lister);
}

function contexteApresPreuve({ agent, projet, script, resultat, preuve }) {
  const cmd = commandes(script, projet);
  const etat = lireLedger(projet, agent);
  const faits = resultat.faits.length ? `Retiré sur preuve (${preuve}) : ${resultat.faits.join(', ')}.` : '';
  const partiels = resultat.partiels.length ? `Passé en-cours (partiel, ${preuve}) : ${resultat.partiels.join(', ')}.` : '';
  const entete = [`Fichier contexte (projet ${projet}, agent ${agent}) mis à jour.`, faits, partiels, 'Reste :'].filter(Boolean).join('\n');
  return composerContexte(entete, lignesCompactes(etat), '', cmd.lister);
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = [
  'Usage : node context-ledger.js <commande> --projet <projet> [args]',
  '  ajouter --projet P [--de M-NNNN] "texte mot pour mot"',
  '  sans-travail --projet P M-NNNN "raison courte"',
  '  etat --projet P C-NNNN en-cours|bloque-utilisateur|ouvert ["note"]',
  '  abandon --projet P C-NNNN "citation EXACTE de l\'utilisateur"   (message écrit APRÈS la création de la ligne)',
  '  lister [--projet P]',
  '  (--fichier <chemin> : lit le texte libre dans un fichier UTF-8)',
  'Aucune commande ne marque « fait » : seule une preuve [ctx C-NNNN] le fait.',
].join('\n');

function analyserArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(projet|de|fichier)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    else pos.push(a);
  }
  return { opts, pos };
}

function executerCli(argv, { agent, script }) {
  const ok = sortie => ({ code: 0, sortie, erreur: '' });
  try {
    if (!agent) throw new Error('agent introuvable depuis l\'emplacement du script');
    try { assurerIntegrite(agent); } catch (_) { /* chaque écriture revérifie sous verrou */ }
    const [commande, ...reste] = argv;
    const { opts, pos } = analyserArgs(reste);
    const texteLibre = debut => (opts.fichier ? sansBom(lireTexte(path.resolve(opts.fichier)) || '') : pos.slice(debut).join(' '));
    if (opts.projet !== undefined) validerProjet(opts.projet);
    switch (commande) {
      case 'ajouter': {
        if (!opts.projet) throw new Error('--projet requis');
        const id = ajouterLigne({ projet: opts.projet, agent, texte: texteLibre(0), de: opts.de || null });
        return ok(`${id} ajouté (projet ${opts.projet}${opts.de ? `, de ${opts.de.toUpperCase()}` : ''}). Quand c'est fait : cite [ctx ${id}] dans l'historique ou le commit ; [ctx ${id} partiel] si ce n'est pas fini.`);
      }
      case 'sans-travail': {
        const id = normaliserId(pos[0], 'M');
        const { projet } = classerSansTravail({ projet: opts.projet, agent, id, raison: texteLibre(1) });
        return ok(`${id} classé sans travail (projet ${projet}).`);
      }
      case 'etat': {
        const id = normaliserId(pos[0], 'C');
        const { projet } = changerEtat({ projet: opts.projet, agent, id, statut: pos[1], note: texteLibre(2) });
        return ok(`${id} : état ${pos[1]} (projet ${projet}).`);
      }
      case 'abandon': {
        const id = normaliserId(pos[0], 'C');
        const { projet } = abandonner({ projet: opts.projet, agent, id, citation: texteLibre(1) });
        return ok(`${id} abandonné sur ordre de l'utilisateur (projet ${projet}), trace gardée dans la section Abandonné.`);
      }
      case 'lister': {
        assurerVues(agent);
        const projets = opts.projet ? [opts.projet] : listerProjets(agent);
        if (!projets.length) return ok(`Aucun fichier contexte pour l'agent ${agent}.`);
        return ok(projets.map(p => rendreVue(lireLedger(p, agent))).join('\n'));
      }
      default:
        return { code: 1, sortie: '', erreur: (commande ? `commande inconnue : ${commande}\n` : '') + USAGE };
    }
  } catch (e) {
    return { code: 1, sortie: '', erreur: `context-ledger : ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = {
  AGENTS, PLAFOND, STATUTS_MANUELS, TERMINAUX, OUTILS_FICHIER, OUTILS_SHELL,
  RAISON_FICHIER, RAISON_SHELL, RAISON_SOUS_AGENT,
  racine, agentDepuisChemin, projetDepuisCwd, chemins, listerProjets, listerProjetsTous,
  lireLedger, modifierLedger, allouerId, rendreVue, assurerVues,
  rejouerJournal, verifierEtat, assurerIntegrite,
  racineSecours, journalSecours, avertissementSecours,
  ajouterDemande, ajouterLigne, classerSansTravail, changerEtat, abandonner, trouverProjetDe,
  lireSession, modifierSession, lierSession, projetDeSession, enregistrerMessage, rappelStop,
  secours, contexteEchecMessage, lireLignesDepuis, suiteTranscript,
  suivreTache, finirTache, livraisons, tacheParAlias, texteLivraisons, texteFins, texteSuiviEnCours,
  extraireMarqueurs, marqueursAjoutes, estFichierPreuve, preuveCommit, preuvesDepuisOutil,
  appliquerPreuves, reconcilier,
  gardeOutil, texteToucheRacine, commandeViseRacine, appelleCli, commandeLectureOuCli,
  commandes, contexteMessage, contexteSession, contexteApresPreuve, composerContexte,
  executerCli,
};
