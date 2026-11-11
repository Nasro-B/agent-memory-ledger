#!/usr/bin/env node
'use strict';
// context-ledger.js : adaptateur CODEX du fichier contexte (liste de travail sur disque)
// + point d'entrée de la CLI. Noyau partagé avec Claude Code : ../lib/context-ledger-core.js.
// L'agent est déduit du point d'entrée exécuté, jamais du payload ni de CODEX_HOME.
//
// Sorties : JSON STRICT conforme au schéma embarqué de codex-cli 0.155.0-alpha.16
// (additionalProperties:false, un champ en trop invalide toute la sortie) :
//   SessionStart, UserPromptSubmit, PostToolUse, SubagentStart :
//     {"hookSpecificOutput":{"hookEventName":"<Evt>","additionalContext":"..."}}
//   PreToolUse (garde) : {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                         "permissionDecision":"deny","permissionDecisionReason":"..."}}
//   Stop : {"decision":"block","reason":"..."} (reason non vide), une seule fois par message humain.
//   PostCompact : ne peut pas injecter ; pose le drapeau .sessions\reinject-<agent>-<session_id>,
//     le prochain UserPromptSubmit ou PostToolUse injecte la vue et efface le drapeau.
//   SubagentStop : sortie vide (la fin du sous-agent est notée dans la liste de l'orchestrateur).
//   Rien à dire : sortie vide.
// Sous-agent (agent_id ou agent_type présent) : jamais la liste ni les messages de l'orchestrateur.
// SubagentStart l'inscrit dans la liste de l'orchestrateur, crée sa fiche et lui donne sa consigne ;
// SubagentStop marque son résultat « à traiter » (voir « Livraisons ») ; ses autres événements lui rendent
// sa fiche quand son contexte vient d'être compacté (PostCompact le note, l'outil suivant l'injecte).
// La garde PreToolUse lui laisse la lecture de la liste et lui refuse toute écriture, sauf une note dans
// sa propre fiche.
// Toute erreur interne : silence et exit 0, sauf la garde PreToolUse qui refuse.
//
// Outils d'édition de Codex (apply_patch, exec_command, exec en code mode) : les preuves [ctx]
// écrites dans l'historique ou la mémoire sont trouvées par le réconciliateur PAR CONTENU du noyau
// (PostToolUse, Stop, UserPromptSubmit, SessionStart) ; les commits par git log -1 (<= 90 s).
//
// CLI : node "<ce script>" <commande> --projet <projet> [args]
// Variables réservées aux bancs : CONTEXT_LEDGER_DIR (racine), CONTEXT_LEDGER_PREUVES_DIR (base des
// fichiers de preuve, défaut : la maison, voir ../lib/config.js).

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const core = require('../lib/context-ledger-core.js');
const config = require('../lib/config.js');

const SCRIPT = require.main.filename;
const AGENT = core.agentDepuisChemin(path.dirname(SCRIPT));
const PLAFOND = core.PLAFOND;

const PREFIXES_NON_HUMAINS = ['<task-notification>', '<hook_prompt', 'Message Type:', '<subagent_notification', '<turn_aborted>'];
const RE_CLES_COMMANDE = /^(cmd|command|script)$/i;
const RE_CLES_DOSSIER = /^(workdir|cwd)$/i;
const RE_CLE_SHELL = /^shell$/i;
const RE_POWERSHELL = /^(?:pwsh|powershell)(?:\.exe)?$/i;

// Shell des commandes de Codex quand l'appel ne le nomme pas. Le hook ne le reçoit pas : mesuré le 2026-10-07
// sur 1 483 commandes réelles, l'entrée est chaque fois { command: "<texte>" }, sans shell. Sous Windows,
// Codex lance PowerShell (mesuré : 4 718 exécutions sur 4 718 dans 18 conversations, y compris celles des
// 704 appels qui ne nommaient aucun shell) ; ailleurs, un shell POSIX. CONTEXT_LEDGER_SHELL (powershell ou
// bash) le fixe quand une installation diffère. La garde s'en sert pour reconnaître l'écriture d'un texte
// littéral. Limite : un appel qui demanderait un autre shell que celui par défaut n'est pas visible d'ici.
function shellParDefautPowerShell() {
  const e = String(process.env.CONTEXT_LEDGER_SHELL || '').trim();
  return e ? RE_POWERSHELL.test(e) : process.platform === 'win32'; // ancre-mutation:shell-par-defaut
}

const REGLE_6BIS = 'Règle : un problème trouvé en route et suivi nulle part s\'inscrit ici (ajouter sans --de) ; un travail qui suit un document opérationnel (plan à cases, audit, reste à faire) ne recopie pas ses problèmes ici, le document fait foi et un problème manquant s\'y ajoute en case ; une seule source par problème.';
const APRES_COMPACTAGE = 'Réinjection après compactage : ce fichier fait foi pour ce qui reste, pas le résumé de compactage.';

// ---------------------------------------------------------------------------
// Sorties

function ecrire(obj) { process.stdout.write(JSON.stringify(obj)); }

function contexte(evenement, texte) {
  if (!texte) return;
  ecrire({ hookSpecificOutput: { hookEventName: evenement, additionalContext: plafonner(texte) } });
}

function refuser(raison) {
  ecrire({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });
}

function plafonner(t) {
  const s = String(t);
  return s.length <= PLAFOND ? s : s.slice(0, PLAFOND - 1) + '…';
}

// Ajoute des lignes en haut et en bas d'un texte du noyau sans dépasser le plafond :
// si ça déborde, les dernières lignes « - ... » partent et la mention « (N lignes de plus : lister) »
// est mise à jour (N cumule ce que le noyau avait déjà omis).
function ajuster(haut, texte, bas, lister) {
  const joindre = ls => ls.filter(x => x !== '' && x != null).join('\n');
  const complet = joindre([haut, texte, bas]);
  if (complet.length <= PLAFOND) return complet;
  const lignes = String(texte || '').split('\n');
  let dejaOmises = 0;
  const iPlus = lignes.findIndex(l => /^\(\d+ lignes de plus : /.test(l));
  let pos = -1;
  if (iPlus >= 0) { dejaOmises = parseInt(lignes[iPlus].slice(1), 10) || 0; lignes.splice(iPlus, 1); pos = iPlus; }
  let omises = 0;
  for (;;) {
    const total = omises + dejaOmises;
    const essai = lignes.slice();
    if (total) essai.splice(pos >= 0 ? Math.min(pos, essai.length) : essai.length, 0, `(${total} lignes de plus : ${lister})`);
    const t = joindre([haut, essai.join('\n'), bas]);
    if (t.length <= PLAFOND) return t;
    let i = -1;
    for (let k = lignes.length - 1; k >= 0; k--) if (lignes[k].startsWith('- ')) { i = k; break; }
    if (i < 0) return plafonner(t);
    lignes.splice(i, 1);
    pos = i;
    omises++;
  }
}

// ---------------------------------------------------------------------------
// Lecture tolérante du tool_input de Codex (sa forme varie selon l'outil et le mode d'exécution)

function enChaine(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const a = v.map(x => String(x));
    const i = a.findIndex(x => /^(-lc|-c|\/c|-command)$/i.test(x));
    return i >= 0 ? a.slice(i + 1).join(' ') : a.join(' ');
  }
  return '';
}

function estPatch(t) { return /^\s*\*\*\* Begin Patch/.test(String(t || '')); }

function textePatch(toolName, ti) {
  if (typeof ti === 'string') return (toolName === 'apply_patch' || estPatch(ti)) ? ti : null;
  if (!ti || typeof ti !== 'object') return null;
  for (const k of ['command', 'input', 'patch', 'cmd']) {
    const v = enChaine(ti[k]);
    if (v && (estPatch(v) || (toolName === 'apply_patch' && /\*\*\* (Update|Add|Delete) File:/.test(v)))) return v;
  }
  return null;
}

function cheminsPatch(patch) {
  const out = [];
  const re = /^\*\*\* (?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(String(patch)))) out.push(m[1]);
  return out;
}

// Chaînes littérales JS ("...", '...', `...`) précédées de leur clé éventuelle (cmd:, workdir:, ...).
function litteraux(code) {
  const out = [];
  const re = /(?:([A-Za-z_$][\w$]*)\s*:\s*)?("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let m;
  while ((m = re.exec(String(code)))) {
    const brut = m[2];
    let val;
    if (brut[0] === '"') { try { val = JSON.parse(brut); } catch (_) { val = brut.slice(1, -1); } }
    else {
      val = brut.slice(1, -1).replace(/\\(u\{?[0-9a-fA-F]+\}?|.)/g, (x, c) => {
        if (c === 'n') return '\n'; if (c === 't') return '\t'; if (c === 'r') return '\r';
        if (c[0] === 'u' && c.length > 1) { const h = c.replace(/[u{}]/g, ''); return String.fromCodePoint(parseInt(h, 16)); }
        return c;
      });
    }
    out.push({ cle: m[1] || null, val, brut });
  }
  return out;
}

// Toutes les chaînes d'un objet (code mode : le JS peut être rangé sous n'importe quelle clé).
function chainesDe(v, cle, out) {
  if (typeof v === 'string') out.push({ cle, val: v });
  else if (Array.isArray(v)) v.forEach(x => chainesDe(x, cle, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) chainesDe(x, k, out);
  return out;
}

// Analyse d'un appel d'outil : commandes shell, dossiers de travail, shells nommés, patchs, et texte restant.
function analyser(toolName, ti) {
  const r = { commandes: [], dossiers: [], shells: [], patchs: [], reste: '' };
  const patch = textePatch(toolName, ti);
  if (patch !== null) { r.patchs.push(patch); return r; }
  if (ti && typeof ti === 'object' && !Array.isArray(ti)) {
    const brut = ti.command !== undefined ? ti.command : (ti.cmd !== undefined ? ti.cmd : ti.script);
    const c = enChaine(brut);
    if (c) {
      r.commandes.push(c);
      const d = ti.workdir || ti.cwd;
      if (typeof d === 'string' && d) r.dossiers.push(d);
      // Shell nommé par l'appel : champ shell, ou programme en tête d'une commande donnée en tableau.
      if (typeof ti.shell === 'string' && ti.shell) r.shells.push(ti.shell);
      else if (Array.isArray(brut) && brut.length > 1) r.shells.push(String(brut[0]).split(/[\\/]/).pop());
      return r;
    }
  }
  // Code mode (outil 'exec' ou inconnu) : chercher les appels imbriqués dans les littéraux.
  const restes = [];
  for (const { cle, val } of chainesDe(ti, null, [])) {
    if (estPatch(val)) { r.patchs.push(val); continue; }
    let texte = val;
    for (const l of litteraux(val)) {
      if (l.cle && RE_CLES_COMMANDE.test(l.cle)) r.commandes.push(l.val);
      else if (l.cle && RE_CLES_DOSSIER.test(l.cle)) r.dossiers.push(l.val);
      else if (estPatch(l.val)) r.patchs.push(l.val);
      else { if (l.cle && RE_CLE_SHELL.test(l.cle)) r.shells.push(l.val); continue; }
      texte = texte.split(l.brut).join(' ');
    }
    if (cle && RE_CLES_COMMANDE.test(cle)) { r.commandes.push(val); continue; }
    restes.push(texte);
  }
  r.reste = restes.join('\n');
  return r;
}

// ---------------------------------------------------------------------------
// Garde PreToolUse (forme supportée par Codex 0.155 : permissionDecision deny + raison non vide)

function gardeCodex(input) {
  const sousAgent = !!(input.agent_id || input.agent_type);
  const base = Object.assign({}, input);
  if (sousAgent) base.agent_id = input.agent_id || input.agent_type; else delete base.agent_id;
  const tn = String(input.tool_name || '');
  const ti = input.tool_input;
  const via = (toolName, toolInput, powershell) => core.gardeOutil({ input: Object.assign({}, base, { tool_name: toolName, tool_input: toolInput }), powershell });

  if (core.OUTILS_FICHIER.includes(tn)) return via(tn, ti || {});
  const a = analyser(tn, ti);
  // PowerShell prouvé : chaque shell nommé par l'appel en est un, et les commandes sans shell nommé partent
  // dans le shell par défaut. Un seul shell nommé qui n'en est pas un : aucune commande n'est jugée ainsi.
  const powershell = a.shells.every(s => RE_POWERSHELL.test(s)) && (a.shells.length >= a.commandes.length || shellParDefautPowerShell()); // ancre-mutation:shell-nomme
  for (const p of a.patchs) {
    for (const f of cheminsPatch(p)) {
      const r = via('Write', { file_path: f });
      if (r) return r;
    }
  }
  const dossierRacine = a.dossiers.some(d => core.texteToucheRacine(d));
  for (const c of a.commandes) {
    const r = via('Bash', { command: c }, powershell);
    if (r) return r;
    if (dossierRacine) {
      // Dossier de travail placé dans la racine : lecture seulement (CLI restreinte pour un sous-agent).
      if (sousAgent) { if (!core.commandeLectureOuCli(c, { agentId: String(base.agent_id) })) return core.RAISON_SOUS_AGENT; }
      else if (!core.commandeLectureOuCli(c)) return core.RAISON_SHELL;
    }
  }
  if (a.reste) {
    const touche = core.texteToucheRacine(a.reste);
    if (sousAgent && (touche || core.appelleCli(a.reste))) return core.RAISON_SOUS_AGENT;
    if (touche) return core.RAISON_FICHIER;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preuves

function basePreuves() {
  const e = process.env.CONTEXT_LEDGER_PREUVES_DIR;
  return e && e.trim() ? path.resolve(e.trim()) : config.maison();
}

function vide() { return { faits: [], partiels: [], ignores: [], projets: [], preuves: [] }; }

function fusionner(total, r, preuve) {
  if (!r) return total;
  for (const k of ['faits', 'partiels', 'ignores', 'projets']) {
    for (const x of r[k] || []) if (!total[k].includes(x)) total[k].push(x);
  }
  if (preuve && ((r.faits || []).length || (r.partiels || []).length) && !total.preuves.includes(preuve)) total.preuves.push(preuve);
  return total;
}

// Le TOUT PREMIER passage du réconciliateur lit tous les fichiers de preuve : sur une mémoire ancienne
// (mesuré : 1 260 fichiers, 13 Mo, 23 s à froid) il dépasse le délai d'un hook. Il est donc lancé dans
// un processus détaché (base-en-cours) ; les hooks sautent la réconciliation tant que la base n'existe pas.
// Les passages suivants ne relisent que les fichiers modifiés (~0,2 à 0,4 s mesurés).
const BASE_EN_COURS_MS = 120000;

function fichierEtatReconciliation() { return path.join(core.racine(), `.reconciliation-${AGENT}.json`); }
function marqueurBase() { return path.join(core.racine(), `.reconciliation-${AGENT}.base-en-cours`); }

function lancerBaseDetachee() {
  const m = marqueurBase();
  fs.mkdirSync(path.dirname(m), { recursive: true });
  try { fs.closeSync(fs.openSync(m, 'wx')); } catch (e) {
    if (e.code !== 'EEXIST') return;
    try { if (Date.now() - fs.statSync(m).mtimeMs < BASE_EN_COURS_MS) return; fs.unlinkSync(m); } catch (_) { return; }
    try { fs.closeSync(fs.openSync(m, 'wx')); } catch (_) { return; }
  }
  const { spawn } = require('child_process');
  const c = spawn(process.execPath, [SCRIPT, '--reconcilier-base'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  c.on('error', () => { try { fs.unlinkSync(m); } catch (_) { /* rien */ } }); // sinon exception non rattrapée : exit 1
  c.unref();
}

function etablirBase() {
  try { core.reconcilier({ agent: AGENT, base: basePreuves() }); } finally {
    try { fs.unlinkSync(marqueurBase()); } catch (_) { /* rien */ }
  }
}

function reconcilier() {
  if (!fs.existsSync(fichierEtatReconciliation())) { lancerBaseDetachee(); return vide(); }
  const r = core.reconcilier({ agent: AGENT, base: basePreuves() });
  return fusionner(vide(), r, 'fichier de preuve (historique ou mémoire)');
}

function preuvesCommit(input) {
  const total = vide();
  const a = analyser(String(input.tool_name || ''), input.tool_input);
  if (!a.commandes.length) return total;
  const cwd = a.dossiers[0] || input.cwd;
  const vus = new Set();
  for (const cmd of a.commandes) {
    if (!/\bcommit\b/.test(cmd)) continue;
    const c = core.preuveCommit({ commande: cmd, cwd });
    if (!c || vus.has(c.sha)) continue;
    vus.add(c.sha);
    const marqueurs = core.extraireMarqueurs(c.message);
    if (!marqueurs.length) continue;
    const preuve = `commit ${c.sha} (${c.racineDepot})`;
    fusionner(total, core.appliquerPreuves({ agent: AGENT, marqueurs, preuve }), preuve);
  }
  return total;
}

function a_change(r) { return r.faits.length > 0 || r.partiels.length > 0; }

function ligneResultat(r) {
  const out = [];
  if (r.faits.length) out.push(`Retiré sur preuve (${r.preuves.join(' ; ')}) : ${r.faits.join(', ')}.`);
  if (r.partiels.length) out.push(`Passé en-cours (partiel) : ${r.partiels.join(', ')}.`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Drapeau de réinjection après compactage

function cheminDrapeau(sessionId) {
  const s = String(sessionId || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(core.racine(), '.sessions', `reinject-${AGENT}-${s}`);
}
function poserDrapeau(sessionId) {
  if (!sessionId) return;
  const f = cheminDrapeau(sessionId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, new Date().toISOString() + '\n');
}
// Vrai si le drapeau existait (il est effacé).
function prendreDrapeau(sessionId) {
  if (!sessionId) return false;
  try { fs.unlinkSync(cheminDrapeau(sessionId)); return true; } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Livraisons des sous-agents (suivi dans le noyau : suivreTache, finirTache, texteLivraisons)
//
// Formes vérifiées dans le code source de codex (étiquette rust-v0.155.0-alpha.16,
// codex-rs/core/src/hook_runtime.rs) et dans des rollouts réels :
//  - SubagentStart et SubagentStop tournent DANS le sous-agent ; leur session_id est celui de la session de
//    l'orchestrateur, leur agent_id est le fil (thread) du sous-agent ; SubagentStop revient à la fin de
//    CHAQUE tour du sous-agent, avec agent_transcript_path (son rollout) ;
//  - première ligne du rollout d'un sous-agent : session_meta dont source.subagent.thread_spawn porte
//    parent_thread_id, depth, agent_path (/root/<tâche>), agent_nickname, agent_role ;
//  - la réponse finale d'un sous-agent arrive dans le rollout de l'orchestrateur en response_item
//    { type: 'agent_message', author: '/root/<tâche>', recipient: '/root',
//      content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\n...' }] }.
// Observé dans des sessions réelles (2026-10-02, 2 579 événements) : les événements d'outils d'un sous-agent
// portent agent_id, agent_type et, dans transcript_path, SON rollout ; SubagentStop porte le rollout de
// l'orchestrateur dans transcript_path et celui du sous-agent dans agent_transcript_path ; PostCompact d'un
// sous-agent porte son agent_id. Entrée de SubagentStart capturée le 2026-10-02 : agent_id, agent_type, cwd,
// model, permission_mode, session_id, turn_id, et dans transcript_path le rollout du sous-agent ; sa consigne
// s'écrit dans ce rollout en message « developer » (11 sous-agents sur 12 l'ont reçue ce soir-là, dont 2 par
// le filet du premier outil ; le douzième, hook tué après sa marque, est le cas que le filet vérifie depuis).
// La lecture du rollout de l'orchestrateur sert de filet pour les fins.

// En-tête du rollout d'un sous-agent : chemin de tâche, surnom, profondeur.
function enteteSousAgent(fichier) {
  if (!fichier || typeof fichier !== 'string') return {};
  let t = '';
  try {
    const fd = fs.openSync(fichier, 'r');
    try { const b = Buffer.alloc(8192); t = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
  } catch (_) { return {}; }
  const m = /"thread_spawn":\{([^{}]*)\}/.exec(t);
  if (!m) return {};
  const champ = c => {
    const x = new RegExp(`"${c}":("(?:[^"\\\\]|\\\\.)*"|\\d+)`).exec(m[1]);
    if (!x) return null;
    try { return JSON.parse(x[1]); } catch (_) { return null; }
  };
  return { chemin: champ('agent_path'), surnom: champ('agent_nickname'), profondeur: champ('depth') };
}

// Inscrit le sous-agent dans la liste de l'orchestrateur. Un sous-agent lancé par un autre sous-agent
// (profondeur > 1) n'est pas suivi : seul l'orchestrateur tient la liste, celui qui l'a lancé rend compte.
function suivreSousAgent(input, rollout) {
  if (!input.session_id || !input.agent_id) return null;
  const e = enteteSousAgent(rollout);
  if (Number(e.profondeur) > 1) return null;
  const nom = e.chemin ? String(e.chemin).replace(/^\/root\//, '') : '';
  const titre = nom ? `${nom}${e.surnom ? ` (${e.surnom})` : ''}` : `sous-agent ${input.agent_type || ''}`.trim();
  return core.suivreTache({ // ancre-mutation:suivi-lancement
    agent: AGENT, sessionId: input.session_id, cwd: input.cwd,
    tache: { id: String(input.agent_id), genre: String(input.agent_type || 'agent'), titre, resultat: rollout || '', alias: e.chemin || null },
  });
}

// Fiche du sous-agent (noyau : creerFiche). Dans Codex 0.155 le message de lancement est chiffré, dans le
// rollout comme dans l'entrée des hooks (mesuré le 2026-10-02 : tool_input.message commence par « gAAAA ») :
// la mission ne peut pas être copiée par le hook, le sous-agent la recopie lui-même dans sa fiche.
// Sous-agent d'un sous-agent (profondeur > 1) : pas de ligne dans la liste, mais une fiche quand même.
function assurerFiche(input, rollout) {
  const id = String(input.agent_id);
  let index = core.lireIndexFiche(AGENT, id);
  if (index) return index;
  const e = enteteSousAgent(rollout);
  const nom = e.chemin ? String(e.chemin).replace(/^\/root\//, '') : '';
  let suivi = null;
  try { const s = core.lireSession(AGENT, input.session_id); suivi = s && s.taches ? s.taches[id] : null; } catch (_) { suivi = null; }
  // Titre de repli quand ni le suivi ni le rollout n'en donnent : remplacé dès que le vrai titre arrive.
  const titre = (suivi && suivi.titre) || (nom ? `${nom}${e.surnom ? ` (${e.surnom})` : ''}` : '');
  core.creerFiche({
    agent: AGENT, sessionId: input.session_id, id, cwd: input.cwd, ligne: suivi ? suivi.ligne : null,
    projet: (suivi && suivi.projet) || core.projetDeSession(AGENT, input.session_id, input.cwd),
    titre: titre || `sous-agent ${input.agent_type || ''}`.trim(), titreRepli: !titre,
    genre: String(input.agent_type || 'agent'),
  });
  return core.lireIndexFiche(AGENT, id);
}

function surSubagentStart(input) {
  try { suivreSousAgent(input, input.transcript_path); } catch (_) { /* le sous-agent démarre quand même */ }
  if (input.agent_id) { try { assurerFiche(input, input.transcript_path); } catch (_) { /* consigne sans fiche */ } }
  contexte('SubagentStart', core.texteConsigneSousAgent({ agent: AGENT, id: input.agent_id, script: SCRIPT }));
  if (input.agent_id) { try { core.consigneADonner({ agent: AGENT, id: String(input.agent_id) }); } catch (_) { /* au pire, redite à son premier outil */ } }
}

// Événement venu d'un sous-agent (agent_id présent ; transcript_path = SON rollout, mesuré le 2026-10-02).
// Jamais la liste de l'orchestrateur : sa fiche, rendue quand son contexte vient d'être compacté.
function surEvenementSousAgent(input) {
  const evenement = input.hook_event_name;
  if (!input.agent_id || !['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'PostCompact'].includes(evenement)) return;
  const id = String(input.agent_id);
  let index = null;
  try { index = assurerFiche(input, input.transcript_path); } catch (_) { index = null; }
  if (!index) return;
  // PostCompact porte l'identité du sous-agent (mesuré : 7 événements réels le 2026-10-02) mais ne peut rien
  // injecter : le compactage est noté, la fiche sera rendue à son prochain outil.
  if (evenement === 'PostCompact') { core.noterCompactage({ agent: AGENT, id }); return; }
  let compacte = false;
  try {
    compacte = core.compactageDuSousAgent({
      agent: AGENT, id, fichier: input.transcript_path, motifs: ['"type":"compacted"'],
      annonce: evenement === 'SessionStart' && input.source === 'compact',
    });
  } catch (_) { compacte = false; }
  if (compacte) { contexte(evenement, plafonner(core.texteRepriseSousAgent({ agent: AGENT, id, script: SCRIPT }))); return; } // ancre-mutation:reprise-sous-agent
  // Consigne jamais donnée (mesuré le 2026-10-02 : celle du démarrage n'est arrivée qu'à 2 sous-agents sur 22,
  // hook de démarrage tué par son délai ou jamais déclenché), ou marquée mais absente de son rollout (hook de
  // démarrage tué après sa marque, constaté le 2026-10-02) : donnée ici, une fois. La consigne injectée
  // s'écrit dans le rollout en message « developer ».
  if (!index.reprises && !index.consigneVerifieeLe && core.consigneADonner({ agent: AGENT, id, fichier: input.transcript_path, formes: ['"role":"developer"'] })) contexte(evenement, core.texteConsigneSousAgent({ agent: AGENT, id, script: SCRIPT })); // ancre-mutation:consigne-filet
}

// Fin d'un tour du sous-agent : son résultat devient « à traiter » dans la liste de l'orchestrateur.
// Sous-agent jamais inscrit (lancé avant le branchement) : inscrit maintenant, pour que sa fin compte.
function surSubagentStop(input) {
  if (!input.session_id || !input.agent_id) return;
  const rollout = input.agent_transcript_path || '';
  const s = core.lireSession(AGENT, input.session_id);
  if (!(s && s.taches && s.taches[String(input.agent_id)])) suivreSousAgent(input, rollout);
  core.finirTache({ agent: AGENT, sessionId: input.session_id, id: String(input.agent_id), statut: 'terminé', resultat: rollout, reprise: true, livraisonId: input.turn_id || input.tool_use_id, dernierMessage: input.last_assistant_message }); // ancre-mutation:suivi-fin
}

// Une ligne du rollout de l'orchestrateur -> chemin du sous-agent qui rend sa réponse finale, sinon null.
function finDansLigne(ligne) {
  let o;
  try { o = JSON.parse(ligne); } catch (_) { return null; }
  const p = o && o.payload;
  if (!p || o.type !== 'response_item' || p.type !== 'agent_message' || !p.author) return null;
  const t = (Array.isArray(p.content) ? p.content : []).map(c => (c && typeof c.text === 'string' ? c.text : '')).join('');
  return /^\s*Message Type:\s*FINAL_ANSWER\b/.test(t) ? String(p.author) : null;
}

// Ce que l'orchestrateur doit lire avant la fin du tour : fins pas encore annoncées (SubagentStop marque une
// fin sans rien lui dire) et rappel des résultats qui attendent. Le Stop bloquant reste le filet de fin de tour.
function suiviEnCours(input) {
  try { return core.texteSuiviEnCours({ agent: AGENT, sessionId: input.session_id }); } catch (_) { return ''; } // ancre-mutation:suivi-en-cours
}

// Filet de SubagentStop : réponses finales de sous-agents écrites dans le rollout de l'orchestrateur depuis
// le dernier passage. Ne crée jamais de ligne (reprise = false) : il ne fait que marquer une première fin.
// L'annonce à l'orchestrateur est faite par suiviEnCours, quel que soit l'événement qui a marqué la fin.
function rattraperFins(input) {
  const fins = [];
  if (!input.transcript_path || !input.session_id) return fins;
  const auteurs = [];
  const r = core.suiteTranscript({
    agent: AGENT, sessionId: input.session_id, fichier: input.transcript_path,
    surLigne: ligne => {
      if (!ligne.includes('"agent_message"') || !ligne.includes('FINAL_ANSWER')) return;
      const a = finDansLigne(ligne.toString('utf8'));
      if (a) auteurs.push(a);
    },
  });
  if (!r) return fins; // ancre-mutation:filet-rollout
  for (const auteur of auteurs) {
    const id = core.tacheParAlias(AGENT, input.session_id, auteur);
    if (!id) continue;
    const t = core.finirTache({ agent: AGENT, sessionId: input.session_id, id, statut: 'terminé', reprise: false });
    if (t) fins.push(t);
  }
  core.modifierSession(AGENT, input.session_id, s => { s.transcriptVu = r.vu; });
  return fins;
}

// ---------------------------------------------------------------------------
// Événements

function surSessionStart(input) {
  const projet = core.lierSession(AGENT, input.session_id, input.cwd);
  try { reprendreEnAttente(); } catch (_) { /* rien */ }
  try { rattraperFins(input); } catch (_) { /* rien */ }
  try { reconcilier(); } catch (_) { /* la vue reste injectée */ }
  core.assurerVues(AGENT);
  prendreDrapeau(input.session_id);
  const cmd = core.commandes(SCRIPT, projet, input.session_id);
  contexte('SessionStart', ajuster(suiviEnCours(input), core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id }), REGLE_6BIS, cmd.lister));
}

// ---------------------------------------------------------------------------
// Garantie mécanique : un message de l'utilisateur n'est jamais perdu, même si les verrous restent occupés
// (plusieurs hooks et sessions en parallèle). Réessais jusqu'à ~6 s (délai du hook : 15 s), puis
// dépôt dans .sessions\en-attente-<agent>.jsonl, repris au prochain événement.

const DELAI_MESSAGE_MS = 6000;

function cheminAttente() { return path.join(core.racine(), '.sessions', `en-attente-${AGENT}.jsonl`); }

function dejaEnregistre(sessionId, cle, cwd) {
  try {
    const projet = core.projetDeSession(AGENT, sessionId, cwd);
    const e = core.lireLedger(projet, AGENT);
    const id = Object.keys(e.demandes).find(k => e.demandes[k].promptId === cle && e.demandes[k].session === (sessionId || null));
    return id ? { id, projet, doublon: false } : null;
  } catch (_) { return null; }
}

function enregistrerSur(m, limite) {
  for (let essai = 0; ; essai++) {
    try {
      if (essai > 0) { const d = dejaEnregistre(m.sessionId, m.cle, m.cwd); if (d) return d; }
      return core.enregistrerMessage({ agent: AGENT, sessionId: m.sessionId, promptId: m.cle, cwd: m.cwd, texte: m.texte });
    } catch (e) {
      if (Date.now() > limite) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.floor(Math.random() * 100));
    }
  }
}

function mettreEnAttente(m) {
  const f = cheminAttente();
  const ligne = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, m)) + '\n';
  for (let i = 0; ; i++) { // réessais courts sur les erreurs transitoires de Windows (antivirus, indexation)
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, ligne); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// Reprise : la file est renommée (un seul hook la prend), traitée, puis supprimée. Un lot abandonné par un
// hook interrompu (timeout) est repris après 30 s. Le dédoublonnage du noyau (promptsVus de la session)
// empêche un double enregistrement si un lot est traité deux fois.
const LOT_ABANDONNE_MS = 30000;

function reprendreEnAttente() {
  const f = cheminAttente();
  const dir = path.dirname(f);
  const nom = path.basename(f);
  const maintenant = Date.now();
  const pris = `${f}.${process.pid}.${maintenant}`;
  const lots = [];
  try { fs.renameSync(f, pris); lots.push(pris); } catch (_) { /* rien en attente, ou un autre hook l'a pris */ }
  let noms = [];
  try { noms = fs.readdirSync(dir); } catch (_) { noms = []; }
  noms.forEach((n, i) => {
    const m = n.startsWith(nom + '.') ? /\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(n) : null;
    if (!m || maintenant - Number(m[2]) < LOT_ABANDONNE_MS) return;
    const p2 = `${pris}.${i}`;
    try { fs.renameSync(path.join(dir, n), p2); lots.push(p2); } catch (_) { /* pris par un autre */ }
  });
  const limite = Date.now() + 2000;
  for (const lot of lots) {
    let texte = '';
    try { texte = fs.readFileSync(lot, 'utf8'); } catch (_) { continue; }
    for (const ligne of texte.split('\n')) {
      if (!ligne.trim()) continue;
      let m;
      try { m = JSON.parse(ligne); } catch (_) { continue; }
      try {
        if (Date.now() > limite) throw new Error('délai');
        enregistrerSur(m, limite);
      } catch (_) { try { mettreEnAttente(m); } catch (_) { /* rien */ } }
    }
    try { fs.unlinkSync(lot); } catch (_) { /* rien */ }
  }
}

// Dernier filet quand ni l'enregistrement ni la file d'attente n'ont pu écrire (disque, droits, .sessions
// inutilisable) : copie de secours du noyau (hors .sessions) et consigne au modèle, jamais de perte silencieuse.
function signalerEchec(input, m, erreur) {
  let fichierSecours = null;
  try { fichierSecours = core.secours({ agent: AGENT, sessionId: m.sessionId, promptId: m.cle, texte: m.texte, erreur }); } catch (_) { /* rien */ }
  let projet = '_general';
  try { projet = core.projetDeSession(AGENT, input.session_id, input.cwd); } catch (_) { /* repli */ }
  let texte = core.contexteEchecMessage({ agent: AGENT, projet, script: SCRIPT, erreur, fichierSecours, sessionId: input.session_id });
  if (!fichierSecours) texte = plafonner(`${texte}\nTexte du message (mot pour mot) : ${m.texte}`);
  contexte('UserPromptSubmit', texte);
}

function surUserPromptSubmit(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const debut = prompt.trimStart();
  const humain = !!prompt.trim() && !PREFIXES_NON_HUMAINS.some(p => debut.startsWith(p));
  let enr = null;
  let enAttente = false;
  if (humain) {
    // Dédoublonnage : turn_id + empreinte du texte (un message envoyé en cours de tour garde le même turn_id).
    const m = {
      sessionId: input.session_id, cwd: input.cwd, texte: prompt,
      cle: `${input.turn_id || ''}:${crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12)}`,
    };
    try { enr = enregistrerSur(m, Date.now() + DELAI_MESSAGE_MS); } catch (e1) {
      try { mettreEnAttente(m); enAttente = true; } catch (e2) { // ancre-mutation:attente
        signalerEchec(input, m, `${e1 && e1.message ? e1.message : e1} ; file d'attente : ${e2 && e2.message ? e2.message : e2}`); // ancre-mutation:secours
        return;
      }
    }
  }
  if (!enAttente) { try { reprendreEnAttente(); } catch (_) { /* rien */ } } // verrou occupé : reprise plus tard
  try { rattraperFins(input); } catch (_) { /* rappelé en fin de tour */ }
  let r = vide();
  try { r = reconcilier(); } catch (_) { /* rien */ }
  const fins = suiviEnCours(input); // après les preuves : un résultat prouvé traité n'est plus annoncé
  core.assurerVues(AGENT);
  const drapeau = prendreDrapeau(input.session_id);
  const projet = enr ? enr.projet : core.projetDeSession(AGENT, input.session_id, input.cwd);
  const cmd = core.commandes(SCRIPT, projet, input.session_id);
  const haut = [drapeau ? APRES_COMPACTAGE : '', ligneResultat(r), fins,
    enAttente ? 'Message de l\'utilisateur reçu mais fichier contexte occupé : il est gardé en attente et sera enregistré (M-NNNN) au prochain événement. Traite-le comme un message à trier.' : '',
  ].filter(Boolean).join('\n');
  if (enr && enr.id && !enr.doublon) {
    contexte('UserPromptSubmit', ajuster(haut, core.contexteMessage({ agent: AGENT, projet, idMessage: enr.id, script: SCRIPT, sessionId: input.session_id }), REGLE_6BIS, cmd.lister));
  } else if (drapeau || enAttente || a_change(r) || fins) {
    contexte('UserPromptSubmit', ajuster(haut, core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id }), drapeau || enAttente ? REGLE_6BIS : '', cmd.lister));
  }
}

function ajouterResultat(total, r) {
  fusionner(total, r, null);
  for (const p of r.preuves) if (!total.preuves.includes(p)) total.preuves.push(p);
}

function surPostToolUse(input) {
  try { reprendreEnAttente(); } catch (_) { /* rien */ }
  try { rattraperFins(input); } catch (_) { /* rappelé en fin de tour */ }
  const total = vide();
  try { ajouterResultat(total, reconcilier()); } catch (_) { /* rien */ }
  try { ajouterResultat(total, preuvesCommit(input)); } catch (_) { /* rien */ }
  const fins = suiviEnCours(input); // après les preuves : un résultat prouvé traité n'est plus annoncé
  core.assurerVues(AGENT);
  const drapeau = prendreDrapeau(input.session_id);
  if (!drapeau && !a_change(total)) { // liste renvoyée seulement si elle a changé
    contexte('PostToolUse', fins);
    return;
  }
  const projet = core.projetDeSession(AGENT, input.session_id, input.cwd);
  const cmd = core.commandes(SCRIPT, projet, input.session_id);
  if (drapeau) {
    const haut = [APRES_COMPACTAGE, ligneResultat(total), fins].filter(Boolean).join('\n');
    contexte('PostToolUse', ajuster(haut, core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id }), REGLE_6BIS, cmd.lister));
  } else {
    contexte('PostToolUse', ajuster(fins, core.contexteApresPreuve({
      agent: AGENT, projet, script: SCRIPT, resultat: total, preuve: total.preuves.join(' ; '), sessionId: input.session_id,
    }), '', cmd.lister));
  }
}

function surPostCompact(input) {
  poserDrapeau(input.session_id); // PostCompact ne peut pas injecter (schéma) : sortie vide
}

// Codex : le Stop {decision:block} fait continuer le tour, ce qu'un texte ajouté après un outil ne fait pas
// (l'additionalContext d'un PostToolUse arrive bien au modèle, en message « developer » : observé dans des
// rollouts réels le 2026-10-02). Il porte donc, une fois par message humain :
//  - le rappel du noyau (M du tour à trier ; les lignes du tour non citées ne sont plus rappelées) ;
//  - sinon, les M de CETTE session encore à trier (ex. un premier message suivi d'un second dans le même
//    tour : le noyau ne suit que le dernier) ;
//  - une fois par état des livraisons, les résultats encore non traités ;
//  - et, dès qu'il rappelle quelque chose, la vue compacte (à trier, ouvert, bloqué), plafonnée.

// M de CETTE session encore à trier, rappelés une fois par message humain ('' s'il n'y a rien à rappeler).
function rappelSession(input, s, projet, cmd) {
  const cle = s.promptCourant || input.turn_id || s.tourDebut;
  const etat = core.lireLedger(projet, AGENT);
  const aTrier = Object.keys(etat.demandes)
    .filter(id => etat.demandes[id].statut === 'a-trier' && etat.demandes[id].session === (input.session_id || null))
    .sort();
  if (!cle || !aTrier.length || (s.rappels || []).includes(cle)) return ''; // ancre-mutation:stop-session
  const deja = core.modifierSession(AGENT, input.session_id, x => {
    x.rappels = Array.isArray(x.rappels) ? x.rappels : [];
    if (x.rappels.includes(cle)) return true;
    x.rappels = x.rappels.concat(cle).slice(-200);
    return false;
  });
  if (deja) return '';
  const liste = aTrier.length > 30 ? `${aTrier.slice(0, 30).join(', ')} et ${aTrier.length - 30} autre(s)` : aTrier.join(', ');
  return `Fichier contexte (projet ${projet}) : fin de tour.\nMessage(s) de l'utilisateur de cette session encore à trier : ${liste}. Transforme-le(s) avec \`${cmd.ajouter(aTrier[0])}\` ou classe-le(s) avec \`${cmd.sansTravail(aTrier[0])}\`.`;
}

function surStop(input) {
  if (input.stop_hook_active) return;
  // Le rappel passe avant tout : les mises à jour qui le précèdent ne tournent que s'il reste du temps
  // (ce qu'elles auraient vu le sera au prochain événement). Un hook tué pour délai dépassé ne rappelle rien.
  const sIlResteDuTemps = fn => { if (core.tempsRestant() > 2500) { try { fn(); } catch (_) { /* au prochain événement */ } } }; // ancre-mutation:stop-budget
  sIlResteDuTemps(reprendreEnAttente);
  sIlResteDuTemps(() => rattraperFins(input));
  sIlResteDuTemps(reconcilier);
  try { core.assurerVues(AGENT); } catch (_) { /* la vue sera refaite au prochain événement */ }
  let texte = '';
  try {
    texte = core.rappelStop({ agent: AGENT, sessionId: input.session_id, promptId: input.turn_id, script: SCRIPT });
  } catch (_) { texte = ''; } // verrou occupé jusqu'à l'échéance : les livraisons sont rappelées quand même
  const s = core.lireSession(AGENT, input.session_id);
  if (!s || !s.projet) return;
  const projet = s.projet;
  const cmd = core.commandes(SCRIPT, projet, input.session_id);
  if (!texte || !texte.trim()) texte = rappelSession(input, s, projet, cmd);
  const livraisons = core.texteLivraisons({ agent: AGENT, sessionId: input.session_id, dernierMessage: input.last_assistant_message }); // ancre-mutation:stop-livraisons
  const motif = [texte, livraisons].filter(x => x && x.trim()).join('\n');
  if (!motif) return;
  let vue = '';
  try { vue = core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id }); } catch (_) { vue = ''; } // ancre-mutation:stop-vue
  ecrire({ decision: 'block', reason: ajuster(motif, vue, '', cmd.lister) });
}

function executerHook(brut) {
  let input;
  try { input = JSON.parse(String(brut).replace(/^\uFEFF/, '')); } catch (_) {
    if (/PreToolUse/.test(brut) && (core.texteToucheRacine(brut) || /context-ledger/i.test(brut))) refuser(core.RAISON_FICHIER);
    return;
  }
  if (!input || typeof input !== 'object') return;
  try { core.capturerEvenement({ agent: AGENT, input, octets: String(brut).length }); } catch (_) { /* diagnostic seulement */ }
  const evenement = input.hook_event_name;
  // Budget de temps, démarrage de node compris : sous le délai du modèle de hooks (20 s pour la garde, la fin
  // de tour, le démarrage et la fin d'un sous-agent et l'après-compactage ; 15 s sinon).
  // Un hook tué pour délai dépassé ne rend rien : constaté dans une session réelle sur le rappel de fin de tour.
  core.fixerBudget({ PreToolUse: 16000, Stop: 16000, SubagentStop: 16000, PostCompact: 16000, SubagentStart: 16000 }[evenement] || 12000);
  if (evenement === 'PreToolUse') {
    try {
      const raison = gardeCodex(input); // ancre-mutation:garde-codex
      if (raison) refuser(raison);
    } catch (_) {
      if (core.texteToucheRacine(brut) || /context-ledger/i.test(brut)) refuser(core.RAISON_FICHIER);
    }
    return;
  }
  if (!AGENT) return;
  if (evenement === 'SubagentStart') { try { surSubagentStart(input); } catch (_) { /* silence */ } return; }
  if (evenement === 'SubagentStop') { try { surSubagentStop(input); } catch (_) { /* le rollout de l'orchestrateur sert de filet */ } return; }
  // Sous-agent : jamais la liste ni les messages de l'orchestrateur, seulement sa propre fiche.
  if (input.agent_id || input.agent_type) { try { surEvenementSousAgent(input); } catch (_) { /* silence */ } return; }
  try {
    if (evenement === 'UserPromptSubmit') surUserPromptSubmit(input);
    else if (evenement === 'SessionStart') surSessionStart(input);
    else if (evenement === 'PostToolUse') surPostToolUse(input);
    else if (evenement === 'PostCompact') surPostCompact(input);
    else if (evenement === 'Stop') surStop(input);
  } catch (_) { /* silence : ne jamais bloquer l'utilisateur */ }
}

function main() {
  if (process.argv[2] === '--reconcilier-base') {
    // Base du réconciliateur (processus détaché, ou lancé une fois à la main avant l'activation).
    try { etablirBase(); process.stdout.write(`base du réconciliateur établie (${AGENT})\n`); } catch (e) {
      process.stderr.write(`context-ledger : ${e && e.message ? e.message : e}\n`);
      process.exitCode = 1;
    }
  } else if (process.argv.length > 2) {
    // Sous charge (hooks parallèles, plusieurs sessions), le verrou de 3 s du noyau peut expirer : mesuré
    // 2 échecs sur 10 `ajouter` concurrents. « verrou occupé » est levé AVANT toute écriture : on réessaie.
    const limite = Date.now() + 8000;
    let r = core.executerCli(process.argv.slice(2), { agent: AGENT, script: SCRIPT });
    while (r.code !== 0 && /verrou occupé/.test(r.erreur || '') && Date.now() < limite) { // ancre-mutation:cli-reessai
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + Math.floor(Math.random() * 200));
      r = core.executerCli(process.argv.slice(2), { agent: AGENT, script: SCRIPT });
    }
    if (r.sortie) process.stdout.write(r.sortie.endsWith('\n') ? r.sortie : r.sortie + '\n');
    if (r.erreur) process.stderr.write(r.erreur.endsWith('\n') ? r.erreur : r.erreur + '\n');
    process.exitCode = r.code;
  } else {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => {
      try { executerHook(data); } catch (_) { /* silence */ }
      process.exitCode = 0;
    });
  }
}

module.exports = { analyser, gardeCodex, ajuster, litteraux, cheminsPatch, AGENT, main };

if (require.main === module) main();
