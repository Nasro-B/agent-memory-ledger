#!/usr/bin/env node
'use strict';
// context-ledger.js : adaptateur CLAUDE CODE du fichier contexte (liste de travail sur disque)
// + point d'entrée de la CLI. Noyau : ../lib/context-ledger-core.js (API documentée en tête).
//
// Hooks (Claude Code 2.1.284) : UserPromptSubmit, SessionStart, PostToolUse (fichiers, commits, lancement
// d'un sous-agent ou d'un workflow), PreToolUse (garde), Stop, SubagentStart (fiche du sous-agent),
// SubagentStop (fin d'un sous-agent), PostCompact (compactage d'un sous-agent).
// Sortie vers le modèle : UNIQUEMENT hookSpecificOutput.additionalContext (<= 9 000 caractères) ; le
// systemMessage d'un hook synchrone n'atteint jamais le modèle.
// Événement venu d'un sous-agent (agent_id, ou transcript rangé sous « subagents ») : jamais la liste ni
// les messages de l'orchestrateur. Il reçoit sa consigne et le chemin de sa fiche à son démarrage (redonnés à
// son premier outil si son transcript ne les contient pas), puis sa fiche après un compactage de son
// contexte. La garde PreToolUse lui laisse la lecture de la liste et lui
// refuse toute écriture, sauf une note dans sa propre fiche. SubagentStop porte l'agent_id du sous-agent fini.
// Toute erreur interne : silence et exit 0 (un hook qui plante ne doit jamais bloquer l'utilisateur),
// sauf la garde PreToolUse qui refuse si l'appel vise la racine contexte ou la CLI.
//
// CLI : node "<ce script>" <commande> --projet <projet> [args]
// L'agent est déduit de l'emplacement de CE script (__dirname), jamais du payload.
//
// Messages envoyés PENDANT un tour (mesuré avec Claude Code 2.1.284) : ils déclenchent
// UserPromptSubmit avec le prompt_id du tour EN COURS (la clé d'un message porte donc aussi l'empreinte de
// son texte), et le transcript les range en pièce jointe « queued_command » (origin.kind = human,
// commandMode = prompt). Filet : chaque événement (SessionStart, UserPromptSubmit, PostToolUse, Stop) lit
// la suite du transcript (transcript_path) depuis le dernier octet vu et enregistre mot pour mot ceux que
// UserPromptSubmit n'a pas déjà enregistrés.

const crypto = require('crypto');
const config = require('../lib/config.js');
const core = require('../lib/context-ledger-core.js');

function reconcilierContenu() {
  return core.reconcilierDansHook({ agent: AGENT, base: process.env.CONTEXT_LEDGER_PREUVES_DIR || config.maison() });
}

const AGENT = core.agentDepuisChemin(__dirname);
const SCRIPT = __filename;
const PLAFOND = core.PLAFOND;

// Règle des documents opérationnels. Texte identique à celui de l'adaptateur Codex : une seule
// formulation pour tous les agents.
const REGLE_6BIS = 'Règle : un problème trouvé en route et suivi nulle part s\'inscrit ici (ajouter sans --de) ; un travail qui suit un document opérationnel (plan à cases, audit, reste à faire) ne recopie pas ses problèmes ici, le document fait foi et un problème manquant s\'y ajoute en case ; une seule source par problème.';

// Ajoute une ligne en bas d'un texte du noyau sans dépasser le plafond : si ça déborde, les dernières
// lignes « - ... » partent et la mention « (N lignes de plus : lister) » est mise à jour (N cumule ce que
// le noyau avait déjà omis). Même logique que ajuster() de l'adaptateur Codex.
function ajuster(texte, bas, lister) {
  const joindre = ls => ls.filter(x => x !== '' && x != null).join('\n');
  const complet = joindre([texte, bas]);
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
    const t = joindre([essai.join('\n'), bas]);
    if (t.length <= PLAFOND) return t;
    let i = -1;
    for (let k = lignes.length - 1; k >= 0; k--) if (lignes[k].startsWith('- ')) { i = k; break; }
    if (i < 0) return t.slice(0, PLAFOND - 1) + '…';
    lignes.splice(i, 1);
    pos = i;
    omises++;
  }
}

function sortir(evenement, texte) {
  if (!texte) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: evenement, additionalContext: core.composerContexte(texte, [], '', '') },
  }));
}

function refuser(raison) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison },
  }));
}

// Sous charge (plusieurs sessions, hooks parallèles), le verrou de 3 s du noyau peut expirer : mesuré,
// 1 `ajouter` sur 10 refusé « verrou occupé » sur une machine saturée. Cette erreur est levée AVANT
// toute écriture : on réessaie (même correction que l'adaptateur Codex).
const DELAI_MESSAGE_MS = 6000;
const DELAI_CLI_MS = 8000;
function patienter(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function verrouOccupe(e) { return /verrou occupé/.test(e && e.message ? e.message : String(e)); }

function enregistrerAvecReessai(input, prompt, cle = input.prompt_id) {
  const limite = Date.now() + DELAI_MESSAGE_MS;
  for (;;) {
    try {
      return core.enregistrerMessage({
        agent: AGENT, sessionId: input.session_id, promptId: cle, cwd: input.cwd, texte: prompt,
      });
    } catch (e) {
      if (!verrouOccupe(e) || Date.now() > limite) throw e; // ancre-mutation:message-reessai
      patienter(50 + Math.floor(Math.random() * 100));
    }
  }
}

// ---------------------------------------------------------------------------
// Messages de l'utilisateur envoyés pendant un tour (pièces jointes « queued_command » du transcript)

// Une ligne du transcript -> { cle, texte } si c'est un message humain mis en file, sinon null.
// Exclus : notifications de tâche, messages d'agents (origin.kind = peer), relances de l'application
// (origin absent), entrées de sous-agent (isSidechain).
function messageHumainEnFile(ligne) {
  let o;
  try { o = JSON.parse(ligne); } catch (_) { return null; }
  const a = o && o.attachment;
  if (!o || o.type !== 'attachment' || o.isSidechain || !a || a.type !== 'queued_command') return null;
  if (!a.origin || a.origin.kind !== 'human' || a.commandMode !== 'prompt') return null;
  let texte = '';
  if (typeof a.prompt === 'string') texte = a.prompt;
  else if (Array.isArray(a.prompt)) {
    texte = a.prompt.map(b => {
      if (b && b.type === 'text') return String(b.text || '');
      if (b && b.type === 'image') return '[image jointe]';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (!texte.trim()) return null;
  const id = a.source_uuid || o.uuid || crypto.createHash('sha1').update(String(a.timestamp || '') + texte).digest('hex').slice(0, 16);
  return { cle: 'file:' + id, texte, ts: Date.parse(a.timestamp || o.timestamp) || 0 };
}

function empreinte(t) { return crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 12); }

// Clé d'un message soumis par UserPromptSubmit. Mesuré (cause d'une perte de messages) : un message envoyé
// PENDANT un tour déclenche bien UserPromptSubmit, mais avec le prompt_id du tour en cours. Dédoublonner par
// prompt_id seul jetait donc tous ces messages : la clé porte aussi l'empreinte du texte.
function cleMessage(input, texte) {
  return input.prompt_id ? `${input.prompt_id}:${empreinte(texte)}` : undefined; // ancre-mutation:cle-message
}

// Vrai si ce texte est déjà enregistré pour cette session depuis `depuisMs` : l'autre voie (UserPromptSubmit
// ou lecture du transcript) est passée avant. Un message ne donne jamais deux M.
function dejaEnregistre(input, texte, depuisMs) {
  try {
    const projet = core.projetDeSession(AGENT, input.session_id, input.cwd);
    const e = core.lireLedger(projet, AGENT);
    return Object.keys(e.demandes).some(id => {
      const d = e.demandes[id];
      return d.session === input.session_id && d.texte === texte && (Date.parse(d.ts) || 0) >= depuisMs;
    });
  } catch (_) { return false; }
}

// Un message reçu pendant un tour s'ajoute au tour : le début et la clé du tour d'origine sont conservés
// (un seul rappel de fin de tour, qui cite tous les messages du tour encore à trier).
function rattacherAuTour(input, avant, id) {
  if (!avant || !avant.tourDebut) return;
  try {
    core.modifierSession(AGENT, input.session_id, s => {
      s.promptCourant = avant.promptCourant || null;
      s.tourDebut = avant.tourDebut;
      s.tourMessages = (Array.isArray(avant.tourMessages) ? avant.tourMessages : []).filter(x => x !== id).concat(id);
    });
  } catch (_) { /* le message est enregistré : seul le rattachement au tour manque */ }
}

// Suite du transcript depuis le dernier octet vu (noyau : suiteTranscript). Premier passage sur un transcript
// déjà existant : sert de base, rien n'est enregistré. Retourne null s'il n'y a rien de nouveau.
function suiteTranscript(input) {
  const messages = [];
  const fins = []; // notifications de fin de tâche de fond (sous-agents, workflows)
  const r = core.suiteTranscript({
    agent: AGENT, sessionId: input.session_id, fichier: input.transcript_path,
    surLigne: ligne => {
      if (ligne.includes('<task-notification>')) {
        const t = finDeTacheDansLigne(ligne.toString('utf8'));
        if (t) fins.push(t);
      }
      if (!ligne.includes('"queued_command"')) return;
      const m = messageHumainEnFile(ligne.toString('utf8'));
      if (m) messages.push(m);
    },
  });
  return r ? { messages, fins, vu: r.vu, base: r.base } : null;
}

// ---------------------------------------------------------------------------
// Livraisons des sous-agents et des workflows. Le suivi lui-même est dans le
// noyau (suivreTache, finirTache, texteLivraisons) ; ici, seulement les formes propres à Claude Code.

// Notification de fin de tâche contenue dans un texte -> { id, statut } ou null.
function finDeTache(texte) {
  const t = String(texte || '');
  if (!t.includes('<task-notification>')) return null;
  const id = (/<task-id>([^<\s]+)<\/task-id>/.exec(t) || [])[1];
  if (!id) return null;
  return { id, statut: (/<status>([^<]+)<\/status>/.exec(t) || [])[1] || 'terminé' };
}

// Une ligne du transcript : notification arrivée en cours de tour (pièce jointe) ou en tour séparé.
function finDeTacheDansLigne(ligne) {
  let o;
  try { o = JSON.parse(ligne); } catch (_) { return null; }
  if (!o || o.isSidechain) return null;
  const a = o.attachment;
  if (o.type === 'attachment' && a && a.type === 'queued_command' && a.commandMode === 'task-notification') return finDeTache(a.prompt);
  if (o.type === 'user' && o.message && typeof o.message.content === 'string' && o.message.content.trimStart().startsWith('<task-notification>')) return finDeTache(o.message.content);
  return null;
}

// Tâche de fond lancée par cet appel d'outil (forme relevée dans les transcripts de Claude Code 2.1.284) :
// Agent -> tool_response { isAsync, status: 'async_launched', agentId, outputFile } ;
// Workflow -> tool_response { status: 'async_launched', taskId, workflowName, transcriptDir }.
function tacheLancee(input) {
  const ti = input.tool_input || {};
  let tr = input.tool_response;
  if (typeof tr === 'string') { try { tr = JSON.parse(tr); } catch (_) { tr = {}; } }
  if (!tr || typeof tr !== 'object') return null;
  if (input.tool_name === 'Agent' && tr.agentId && (tr.isAsync || tr.status === 'async_launched')) {
    // mission : le brief mot pour mot (tool_input.prompt), copié dans la fiche du sous-agent.
    return { id: String(tr.agentId), genre: ti.subagent_type || 'agent', titre: String(ti.description || tr.description || 'sans titre'), resultat: String(tr.outputFile || ''), mission: typeof ti.prompt === 'string' ? ti.prompt : '' };
  }
  if (input.tool_name === 'Workflow' && tr.taskId && tr.status === 'async_launched') {
    return { id: String(tr.taskId), genre: 'workflow', titre: String(tr.workflowName || tr.summary || 'sans titre'), resultat: String(tr.transcriptDir || '') };
  }
  return null;
}

// Fin d'une tâche suivie. reprise = true seulement pour un événement reçu en direct (SubagentStop) : le
// transcript et les tours de notification peuvent revoir une fin déjà traitée.
function marquerFin(input, id, statut, reprise = false) {
  return core.finirTache({ agent: AGENT, sessionId: input.session_id, id, statut, reprise,
    resultat: input.agent_transcript_path, livraisonId: input.turn_id || input.tool_use_id,
    dernierMessage: input.last_assistant_message });
}

// Ce que l'orchestrateur doit lire avant la fin du tour : fins pas encore annoncées (SubagentStop marque
// une fin sans rien lui dire) et rappel des résultats qui attendent. Le rappel de fin de tour reste le filet.
function suiviEnCours(input) {
  try { return core.texteSuiviEnCours({ agent: AGENT, sessionId: input.session_id }); } catch (_) { return ''; } // ancre-mutation:suivi-en-cours
}

// Enregistre les messages en file trouvés. Un message en file appartient au tour en cours : le début et la
// clé du tour sont conservés, et le message s'ajoute aux messages du tour (rappel de fin de tour).
// En cas d'échec, l'octet vu n'avance pas : le message sera réessayé au prochain événement.
function rattraperMessagesEnFile(input) {
  const bilan = { ids: [], messages: [], echecs: [], projet: null };
  let suite = null;
  try { suite = suiteTranscript(input); } catch (_) { return bilan; }
  if (!suite) return bilan; // ancre-mutation:file-rattrapage
  for (const m of suite.messages) {
    // UserPromptSubmit a pu enregistrer ce message avant la lecture du transcript : pas de second M.
    if (dejaEnregistre(input, m.texte, m.ts ? m.ts - 5000 : Date.now() - 120000)) continue; // ancre-mutation:file-doublon
    let avant = null;
    try { avant = core.lireSession(AGENT, input.session_id); } catch (_) { avant = null; }
    let r;
    try { r = enregistrerAvecReessai(input, m.texte, m.cle); } catch (e) {
      bilan.echecs.push({ texte: m.texte, erreur: e && e.message ? e.message : String(e) });
      continue;
    }
    if (!r || !r.id || r.doublon) continue;
    bilan.ids.push(r.id);
    bilan.messages.push({ id: r.id, texte: m.texte });
    bilan.projet = r.projet;
    rattacherAuTour(input, avant, r.id);
  }
  // Fins de sous-agents et de workflows vues dans le transcript (filet de SubagentStop). L'annonce à
  // l'orchestrateur est faite par suiviEnCours, quel que soit l'événement qui a marqué la fin.
  for (const f of suite.fins || []) {
    try { marquerFin(input, f.id, f.statut); } catch (_) { /* réessayé par SubagentStop ou au rappel */ }
  }
  if (!bilan.echecs.length) {
    try { core.modifierSession(AGENT, input.session_id, s => { s.transcriptVu = suite.vu; }); } catch (_) { /* relu au prochain passage */ }
  }
  return bilan;
}

function texteMessagesEnFile(bilan) {
  const out = [];
  if (bilan.ids.length) out.push(`Message(s) de l'utilisateur reçu(s) pendant ce tour, enregistré(s) mot pour mot : ${bilan.ids.join(', ')}. À trier comme tout message.`);
  for (const e of bilan.echecs) {
    const t = e.texte.length > 1500 ? e.texte.slice(0, 1500) + '…' : e.texte;
    out.push(`Message de l'utilisateur reçu pendant ce tour et NON enregistré (${e.erreur}) : inscris-le toi-même avec la commande ajouter. Texte : « ${t} »`);
  }
  return out.join('\n');
}

function surUserPromptSubmit(input) {
  try { reconcilierContenu(); } catch (_) { /* prochain evenement */ }
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim()) return;
  // UserPromptSubmit se déclenche aussi pour les tours injectés : ce ne sont pas des messages de l'utilisateur.
  // Un tour ouvert par la fin d'un sous-agent marque sa livraison « à traiter » et le dit au modèle.
  if (prompt.trimStart().startsWith('<task-notification>')) {
    try { const f = finDeTache(prompt); if (f) marquerFin(input, f.id, f.statut); } catch (_) { /* rappelé en fin de tour */ }
    let file = { ids: [], messages: [], echecs: [], projet: null };
    try { file = rattraperMessagesEnFile(input); } catch (_) { /* rien */ }
    sortir('UserPromptSubmit', [texteMessagesEnFile(file), suiviEnCours(input)].filter(Boolean).join('\n'));
    return;
  }
  try { core.assurerVues(AGENT); } catch (_) { /* l'enregistrement du message passe avant tout */ }
  // Messages restés en file pendant le tour précédent : enregistrés d'abord (ordre chronologique des M).
  let file = { ids: [], messages: [], echecs: [], projet: null };
  try { file = rattraperMessagesEnFile(input); } catch (_) { /* le message courant passe avant tout */ }
  const cle = cleMessage(input, prompt);
  // Le message courant vient peut-être d'être rattrapé depuis le transcript (un message envoyé pendant un
  // tour y est écrit avant que ce hook tourne) : c'est le même message, pas un second.
  const jumeau = (file.messages || []).find(x => x.texte === prompt);
  let r;
  if (jumeau) {
    r = { id: jumeau.id, projet: file.projet, doublon: false };
    file = Object.assign({}, file, { ids: file.ids.filter(x => x !== jumeau.id) });
    if (cle) {
      try {
        core.modifierSession(AGENT, input.session_id, s => {
          s.promptsVus = (Array.isArray(s.promptsVus) ? s.promptsVus : []).concat(cle).slice(-200);
        });
      } catch (_) { /* la vérification par contenu (dejaEnregistre) couvre ce cas */ }
    }
  } else {
    let avant = null;
    try { avant = core.lireSession(AGENT, input.session_id); } catch (_) { avant = null; }
    try {
      r = enregistrerAvecReessai(input, prompt, cle);
    } catch (e) {
      // Jamais de perte silencieuse d'un message de l'utilisateur : copie de secours + consigne au modèle.
      const erreur = e && e.message ? e.message : String(e);
      let fichierSecours = null;
      try { fichierSecours = core.secours({ agent: AGENT, sessionId: input.session_id, promptId: input.prompt_id, texte: prompt, erreur }); } catch (_) { /* rien */ }
      let projet = '_general';
      try { projet = core.projetDeSession(AGENT, input.session_id, input.cwd); } catch (_) { /* repli */ }
      sortir('UserPromptSubmit', core.contexteEchecMessage({ agent: AGENT, projet, script: SCRIPT, erreur, fichierSecours, sessionId: input.session_id }));
      return;
    }
    // Même prompt_id que le tour en cours : message envoyé pendant ce tour, il s'y ajoute au lieu de le remplacer.
    const memeTour = avant && input.prompt_id && String(avant.promptCourant || '').split(':')[0] === input.prompt_id;
    if (memeTour && r && r.id && !r.doublon) rattacherAuTour(input, avant, r.id);
  }
  const enFile = [texteMessagesEnFile(file), suiviEnCours(input)].filter(Boolean).join('\n');
  if (r.doublon || !r.id) {
    if (enFile) sortir('UserPromptSubmit', enFile);
    return;
  }
  sortir('UserPromptSubmit', ajuster(
    [enFile, core.contexteMessage({ agent: AGENT, projet: r.projet, idMessage: r.id, script: SCRIPT, sessionId: input.session_id })].filter(Boolean).join('\n'),
    REGLE_6BIS, core.commandes(SCRIPT, r.projet, input.session_id).lister)); // ancre-mutation:regle-6bis-message
}

function surSessionStart(input) {
  try { reconcilierContenu(); } catch (_) { /* prochain evenement */ }
  const projet = core.lierSession(AGENT, input.session_id, input.cwd);
  let file = { ids: [], echecs: [], projet: null };
  try { file = rattraperMessagesEnFile(input); } catch (_) { /* la vue reste injectée */ }
  core.assurerVues(AGENT);
  sortir('SessionStart', ajuster(
    [texteMessagesEnFile(file), suiviEnCours(input), core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id })].filter(Boolean).join('\n'),
    REGLE_6BIS, core.commandes(SCRIPT, projet, input.session_id).lister)); // ancre-mutation:regle-6bis-session
}

// Réponses de l'utilisateur à un questionnaire (outil AskUserQuestion) : ce sont ses décisions, mais elles ne
// passent pas par UserPromptSubmit. Sans ce relevé, une décision donnée par questionnaire n'était enregistrée
// nulle part. Forme relevée dans les transcripts de Claude Code 2.1.284 :
// tool_response { questions, answers: { "<question>": "<réponse>" ou [réponses] } }.
function reponsesQuestionnaire(input) {
  if (input.tool_name !== 'AskUserQuestion') return null;
  let tr = input.tool_response;
  if (typeof tr === 'string') { try { tr = JSON.parse(tr); } catch (_) { return null; } }
  const a = tr && typeof tr === 'object' ? tr.answers : null;
  if (!a || typeof a !== 'object') return null;
  const lignes = Object.entries(a).map(([q, r]) => `« ${q} » : « ${Array.isArray(r) ? r.join(' ; ') : String(r)} »`);
  return lignes.length ? `Réponses de l'utilisateur à un questionnaire :\n${lignes.join('\n')}` : null;
}

function surPostToolUse(input) {
  core.assurerVues(AGENT);
  let file = { ids: [], echecs: [], projet: null };
  try { file = rattraperMessagesEnFile(input); } catch (_) { /* les preuves sont traitées quand même */ }
  // Réponses à un questionnaire : enregistrées comme un message de l'utilisateur reçu pendant le tour.
  const reponses = reponsesQuestionnaire(input);
  if (reponses) {
    let avant = null;
    try { avant = core.lireSession(AGENT, input.session_id); } catch (_) { avant = null; }
    try {
      const r = enregistrerAvecReessai(input, reponses, 'questionnaire:' + (input.tool_use_id || empreinte(reponses))); // ancre-mutation:questionnaire
      if (r && r.id && !r.doublon) {
        file.ids.push(r.id);
        file.messages = (file.messages || []).concat({ id: r.id, texte: reponses });
        file.projet = r.projet;
        rattacherAuTour(input, avant, r.id);
      }
    } catch (e) { file.echecs.push({ texte: reponses, erreur: e && e.message ? e.message : String(e) }); }
  }
  // Sous-agent ou workflow lancé en arrière-plan : une ligne de travail le suit jusqu'à la preuve.
  let suivi = '';
  const lancee = tacheLancee(input);
  if (lancee) {
    try {
      const l = core.suivreTache({ agent: AGENT, sessionId: input.session_id, cwd: input.cwd, tache: lancee });
      if (l) suivi = `Fichier contexte : ${lancee.genre === 'workflow' ? 'workflow' : 'sous-agent'} « ${lancee.titre.replace(/\s+/g, ' ').slice(0, 90)} » suivi par ${l}. À sa fin, son résultat devra être lu, vérifié et intégré ; la ligne ne se retire que sur preuve ([ctx ${l}] dans l'historique).`;
    } catch (e) {
      suivi = `Fichier contexte : le sous-agent « ${lancee.titre.slice(0, 90)} » (${lancee.id}) n'a PAS pu être inscrit (${e && e.message ? e.message : e}) : inscris-le toi-même avec la commande ajouter.`;
    }
  }
  const p = core.preuvesDepuisOutil({
    toolName: input.tool_name, toolInput: input.tool_input, toolResponse: input.tool_response, cwd: input.cwd,
  });
  let resultat = p ? core.appliquerPreuves({ agent: AGENT, marqueurs: p.marqueurs, preuve: p.preuve }) : null;
  try {
    const r = reconcilierContenu();
    if (!resultat) resultat = r;
    else for (const k of ['faits', 'partiels', 'ignores', 'projets']) resultat[k] = [...new Set([...resultat[k], ...r[k]])];
  } catch (_) { /* la file durable sera rejouee */ }
  const preuve = p ? p.preuve : 'fichier de preuve (historique ou memoire)';
  if (resultat && !resultat.faits.length && !resultat.partiels.length) resultat = null;
  // Après les preuves : un résultat que cet outil vient de prouver traité n'est plus annoncé.
  const courts = [suivi, suiviEnCours(input)].filter(Boolean).join('\n');
  const enFile = texteMessagesEnFile(file);
  // Liste renvoyée seulement si elle a changé (preuve) ou si un message est arrivé pendant le tour.
  if (!resultat && !enFile) {
    if (courts) sortir('PostToolUse', courts);
    return;
  }
  const projet = file.projet || core.projetDeSession(AGENT, input.session_id, input.cwd);
  if (!enFile) {
    sortir('PostToolUse', [courts, core.contexteApresPreuve({ agent: AGENT, projet, script: SCRIPT, resultat, preuve, sessionId: input.session_id })].filter(Boolean).join('\n'));
    return;
  }
  const haut = [
    courts,
    resultat && resultat.faits.length ? `Retiré sur preuve (${preuve}) : ${resultat.faits.join(', ')}.` : '',
    resultat && resultat.partiels.length ? `Passé en-cours (partiel, ${preuve}) : ${resultat.partiels.join(', ')}.` : '',
    enFile,
  ].filter(Boolean).join('\n');
  const dernier = file.ids[file.ids.length - 1];
  const corps = dernier
    ? core.contexteMessage({ agent: AGENT, projet, idMessage: dernier, script: SCRIPT, sessionId: input.session_id })
    : core.contexteSession({ agent: AGENT, projet, script: SCRIPT, sessionId: input.session_id });
  sortir('PostToolUse', ajuster(`${haut}\n${corps}`, REGLE_6BIS, core.commandes(SCRIPT, projet, input.session_id).lister));
}

function surStop(input) {
  // Les messages en file sont enregistrés même quand le rappel est déjà passé (stop_hook_active).
  let file = { ids: [], echecs: [], projet: null };
  try { file = rattraperMessagesEnFile(input); } catch (_) { /* rien */ }
  if (input.stop_hook_active) return;
  try { reconcilierContenu(); } catch (_) { /* prochain evenement */ }
  core.assurerVues(AGENT);
  const texte = core.rappelStop({ agent: AGENT, sessionId: input.session_id, promptId: input.prompt_id, script: SCRIPT });
  // Le rappel du noyau cite déjà les messages du tour encore à trier ; sans rappel (déjà fait pour ce
  // tour), un message tout juste rattrapé est quand même signalé.
  const complement = texteMessagesEnFile(texte ? { ids: [], echecs: file.echecs } : file);
  // Livraisons de sous-agents non traitées : rappelées à CHAQUE fin de tour, pas seulement une fois.
  sortir('Stop', [texte, complement, core.texteLivraisons({ agent: AGENT, sessionId: input.session_id, dernierMessage: input.last_assistant_message })].filter(Boolean).join('\n'));
}

// Fin d'un sous-agent (événement de la session parente, qui porte l'agent_id du sous-agent).
function surSubagentStop(input) {
  if (!input.agent_id) return;
  marquerFin(input, String(input.agent_id), 'terminé', true);
}

// ---------------------------------------------------------------------------
// Sous-agents : leur fiche. Le noyau tient les fiches ; ici, seulement les
// formes propres à Claude Code. Mesuré dans 372 transcripts de sous-agents : les événements d'outils d'un
// sous-agent portent agent_id ; SessionStart après SON compactage ne le porte pas toujours, d'où la
// reconnaissance par le chemin du transcript (dossier « subagents »).

// ID du sous-agent qui a déclenché l'événement, ou '' pour l'orchestrateur.
function idSousAgent(input) {
  if (input.agent_id) return String(input.agent_id);
  if (core.transcriptDUnSousAgent(input.transcript_path, input.session_id, AGENT)) return core.idDepuisTranscript(input.transcript_path) || 'inconnu'; // ancre-mutation:sous-agent-par-transcript
  return '';
}

// Transcript du sous-agent : donné par l'événement, ou déduit de celui de la session
// (<dossier>/<session>/subagents/agent-<id>.jsonl, forme relevée dans Claude Code 2.1.284).
function transcriptSousAgent(input, id) {
  if (typeof input.agent_transcript_path === 'string' && input.agent_transcript_path) return input.agent_transcript_path;
  const tp = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!tp) return '';
  if (core.transcriptDUnSousAgent(tp, input.session_id, AGENT)) return tp;
  return require('path').join(tp.replace(/\.jsonl$/i, ''), 'subagents', `agent-${id}.jsonl`);
}

// Mission d'un sous-agent : le premier message de son transcript (son brief, mot pour mot), sinon ''.
function missionDepuisTranscript(fichier) {
  if (!fichier) return '';
  const fs = require('fs');
  let debut = '';
  try {
    const fd = fs.openSync(fichier, 'r');
    try { const b = Buffer.alloc(262144); debut = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
  const fin = debut.indexOf('\n');
  if (fin < 0) return ''; // première ligne plus longue que le tampon, ou pas encore écrite en entier
  let o;
  try { o = JSON.parse(debut.slice(0, fin)); } catch (_) { return ''; }
  const c = o && o.type === 'user' && o.message ? o.message.content : null;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).join('\n').trim();
  return '';
}

// Fiche du sous-agent : créée si elle manque, complétée si sa mission manque. Retourne son index ou null.
function assurerFiche(input, id) {
  let index = core.lireIndexFiche(AGENT, id);
  if (index && index.mission) return index;
  const mission = missionDepuisTranscript(transcriptSousAgent(input, id));
  if (!index || mission) {
    // Sous-agent déjà suivi par l'orchestrateur (ligne [agent]) : la fiche reprend sa ligne et son titre.
    let suivi = null;
    try { const s = core.lireSession(AGENT, input.session_id); suivi = s && s.taches ? s.taches[id] : null; } catch (_) { suivi = null; }
    const projet = index ? index.projet : (suivi && suivi.projet) || core.projetDeSession(AGENT, input.session_id, input.cwd);
    // Titre de repli quand ni l'orchestrateur ni la fiche n'en ont : remplacé dès que le vrai titre arrive.
    const titre = (suivi && suivi.titre) || (index && !index.titreRepli ? index.titre : '');
    core.creerFiche({
      agent: AGENT, sessionId: input.session_id, id, projet, mission, cwd: input.cwd, ligne: suivi ? suivi.ligne : null,
      titre: titre || (index ? index.titre : `sous-agent ${input.agent_type || ''}`.trim()), titreRepli: !titre,
      genre: (suivi && suivi.genre) || input.agent_type || 'agent',
    });
    index = core.lireIndexFiche(AGENT, id);
  }
  return index;
}

// Démarrage d'un sous-agent : sa fiche existe avant son premier outil, et il sait où elle est.
function surSubagentStart(input) {
  const id = idSousAgent(input);
  if (!id || id === 'inconnu') return;
  try { assurerFiche(input, id); } catch (_) { /* la consigne part quand même, sans fiche */ }
  sortir('SubagentStart', core.texteConsigneSousAgent({ agent: AGENT, id, script: SCRIPT }));
  try { core.consigneADonner({ agent: AGENT, id }); } catch (_) { /* au pire, redite à son premier outil */ }
}

// Événement venu d'un sous-agent. Jamais la liste de l'orchestrateur (défaut mesuré le 2026-10-02 : elle
// lui était injectée après son compactage) : sa fiche, rendue quand son contexte vient d'être compacté.
function surEvenementSousAgent(input, id) {
  const evenement = input.hook_event_name;
  if (id === 'inconnu' || !['SessionStart', 'PostToolUse', 'UserPromptSubmit', 'PostCompact'].includes(evenement)) return;
  let index = null;
  try { index = assurerFiche(input, id); } catch (_) { index = null; }
  if (!index) return;
  // PostCompact ne peut rien injecter : le compactage est noté, la fiche sera rendue au prochain outil.
  if (evenement === 'PostCompact') { core.noterCompactage({ agent: AGENT, id }); return; }
  let compacte = false;
  try {
    compacte = core.compactageDuSousAgent({
      agent: AGENT, id, fichier: transcriptSousAgent(input, id), motifs: ['"subtype":"compact_boundary"'],
      annonce: evenement === 'SessionStart' && input.source === 'compact',
    });
  } catch (_) { compacte = false; }
  if (compacte) { sortir(evenement, core.texteRepriseSousAgent({ agent: AGENT, id, script: SCRIPT })); return; } // ancre-mutation:reprise-sous-agent
  // Consigne jamais donnée (démarrage du sous-agent non vu), ou marquée mais absente de son transcript (hook de
  // démarrage tué après sa marque) : donnée ici, une fois. La consigne injectée s'y écrit en hook_additional_context.
  if (!index.reprises && !index.consigneVerifieeLe && core.consigneADonner({ agent: AGENT, id, fichier: transcriptSousAgent(input, id), formes: ['"type":"hook_additional_context"'] })) sortir(evenement, core.texteConsigneSousAgent({ agent: AGENT, id, script: SCRIPT })); // ancre-mutation:consigne-filet
}

// generique : les outils hors Write/Edit/Bash/PowerShell (MCP Windows-MCP FileSystem ou MultiEdit,
// desktop-commander...) sont refusés dès que leur tool_input vise la racine contexte.
function surPreToolUse(input) {
  const raison = core.gardeOutil({ input, generique: true }); // ancre-mutation:garde
  if (raison) refuser(raison);
}

function executerHook(brut) {
  let input;
  try { input = JSON.parse(String(brut).replace(/^\uFEFF/, '')); } catch (_) {
    if (/PreToolUse/.test(brut) && (core.texteToucheRacine(brut) || /context-ledger/i.test(brut))) {
      refuser(core.RAISON_FICHIER);
    }
    return;
  }
  if (!input || typeof input !== 'object') return;
  try { core.capturerEvenement({ agent: AGENT, input, octets: String(brut).length }); } catch (_) { /* diagnostic seulement */ }
  const evenement = input.hook_event_name;
  // Budget de temps, démarrage de node compris : sous le délai de hooks/hooks.json (30 s ; SessionStart 20 s).
  core.fixerBudget(evenement === 'SessionStart' ? 16000 : 25000);
  if (evenement === 'PreToolUse') {
    try { surPreToolUse(input); } catch (_) {
      if (core.texteToucheRacine(brut) || /context-ledger/i.test(brut)) refuser(core.RAISON_FICHIER);
    }
    return;
  }
  if (evenement === 'SubagentStop') {
    if (AGENT) { try { surSubagentStop(input); } catch (_) { /* la notification du transcript sert de filet */ } }
    return;
  }
  if (!AGENT) return;
  if (evenement === 'SubagentStart') { try { surSubagentStart(input); } catch (_) { /* silence */ } return; }
  // Sous-agent : jamais la liste ni les messages de l'orchestrateur, seulement sa propre fiche.
  const sousAgent = idSousAgent(input);
  if (sousAgent) { try { surEvenementSousAgent(input, sousAgent); } catch (_) { /* silence */ } return; }
  try {
    if (evenement === 'UserPromptSubmit') surUserPromptSubmit(input);
    else if (evenement === 'SessionStart') surSessionStart(input);
    else if (evenement === 'PostToolUse') surPostToolUse(input);
    else if (evenement === 'Stop') surStop(input);
  } catch (_) { /* silence : ne jamais bloquer l'utilisateur */ }
}

if (process.argv.length > 2) {
  const limite = Date.now() + DELAI_CLI_MS;
  let r = core.executerCli(process.argv.slice(2), { agent: AGENT, script: SCRIPT });
  while (r.code !== 0 && /verrou occupé/.test(r.erreur || '') && Date.now() < limite) { // ancre-mutation:cli-reessai
    patienter(100 + Math.floor(Math.random() * 200));
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
