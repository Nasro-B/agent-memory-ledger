#!/usr/bin/env node
'use strict';
// Garde de sécurité des commandes : hook « avant un outil de shell » (Claude Code : Bash et PowerShell ; Codex :
// ses outils de commande). Il lit l'appel d'outil sur l'entrée standard et rend sa décision sur la sortie standard.
//
//   node securite.js --agent claude|codex|deepseek_H
//
// REFUSE (toutes les règles trouvées sont rapportées d'un coup, jamais « la première gagne ») :
//   - suppression récursive forcée, sous ses formes POSIX (flags combinés, séparés ou longs) et Windows
//     (Remove-Item -Recurse -Force, rmdir /s, del /s...) ;
//   - nettoyage forcé des fichiers non suivis (git clean avec -f) ;
//   - retour forcé de l'arbre (git reset --hard) ;
//   - poussée forcée (--force, --force-with-lease, -f, refspec « + »), y compris derrière des options globales de
//     git, un alias, un sous-shell ou un shell imbriqué ;
//   - contournement des hooks de git (option de saut des vérifications) ;
//   - suppression ou renommage d'une branche protégée (motifs de gardes.json, aucun par défaut) ;
//   - un commit dont le diff préparé touche une catégorie du rappel avant commit sans confirmation pour ce diff
//     exact (voir ../lib/checklist-commit.js) ;
//   - wrangler deploy sans --keep-vars (règle d'outil, désactivable).
// DEMANDE CONFIRMATION (poussée, déploiement de production, commandes ajoutées dans gardes.json) :
//   - Claude Code : « ask », l'utilisateur tranche ;
//   - Codex et autres : ces agents ne savent pas demander dans ce hook, la commande est donc REFUSÉE sauf si
//     l'utilisateur vient de l'ordonner dans son message du tour en cours (lu dans la liste de travail). Un
//     sous-agent ne pousse ni ne déploie jamais ; pas d'ordre, phrase négative, question ou récit au passé : refus.
// AVERTIT (règle d'outil, désactivable) : vercel env add sans printf.
// En cas d'erreur d'analyse (entrée illisible, guillemet jamais fermé...) : refus explicite.
//
// Le réglage vient de gardes.json (../lib/gardes-config.js). Un fichier illisible ne désarme pas la garde : les
// valeurs par défaut s'appliquent et la garde le dit.
//
// Sortie conforme aux schémas de hooks de Claude Code et de codex-cli : seul « hookSpecificOutput » avec
// permissionDecision allow/deny/ask et additionalContext, plus systemMessage pour l'affichage. Codex rejette
// continue:false, stopReason et « ask » en PreToolUse : ils ne sont jamais utilisés pour lui.

const config = require('../lib/config.js');
const gardesConfig = require('../lib/gardes-config.js');
const cs = require('../lib/commande-securite.js');
const checklist = require('../lib/checklist-commit.js');
const { resolveCommitTarget } = require('../lib/commande-git.js');

// Mots entiers, lettres accentuées comprises (\b ne connaît que l'ASCII : il ne voit pas de frontière devant
// « évite » ni derrière « déjà »).
const mots = liste => new RegExp('(?<![\\p{L}\\p{N}_])(?:' + liste + ')(?![\\p{L}\\p{N}_])', 'iu');
const RE_NEGATION = mots('ne|n|pas|jamais|aucun|aucune|sans|interdit|interdite|interdits|stop|arr[eê]te|arr[eê]tes|attends|[eé]vite|not|never|no|don|dont|wait|avoid|without');
const RE_PASSE = mots('hier|d[eé]j[aà]|dernier|derni[eè]re|pr[eé]c[eé]dent|as tu|tu as|j ai|a march[eé]|a [eé]t[eé]|ont [eé]t[eé]|avait|avais|[eé]tait|yesterday|already|previous|last|did|was|were|had');

// Vrai si `texte` contient une phrase qui ORDONNE l'action : mot d'ordre présent, sans négation, sans question,
// sans marqueur de passé dans la même phrase.
function contientOrdre(texte, motsOrdre) {
  const phrases = String(texte || '').replace(/[\u{2019}'`]/gu, ' ').match(/[^.!?\n;]+[.!?\n;]*/g) || [];
  return phrases.some(p => motsOrdre.test(p) && !RE_NEGATION.test(p) && !RE_PASSE.test(p) && !/\?\s*$/.test(p));
}

// Cherche l'ordre de l'utilisateur dans ses messages du tour en cours (enregistrés mot pour mot par la liste de
// travail). Rend { ok, messages } ou { ok: false, raison }. Toute erreur ou tout doute vaut absence d'ordre.
function ordreDeLUtilisateur(input, types, agent, cfg) {
  const o = cfg.securite.ordreUtilisateur;
  if (!o.actif) return { ok: false, raison: 'l\'ordre de l\'utilisateur n\'est pas accepté comme autorisation (gardes.json, securite.ordreUtilisateur)' }; // ancre-mutation:ordre-desactive
  if (input.agent_id || input.agent_type) return { ok: false, raison: 'un sous-agent ne pousse ni ne déploie jamais' }; // ancre-mutation:sous-agent
  if (!input.session_id) return { ok: false, raison: 'session inconnue' };
  let core;
  try { core = require('../lib/context-ledger-core.js'); } catch (_) { return { ok: false, raison: 'liste de travail indisponible' }; }
  try {
    const s = agent ? core.lireSession(agent, input.session_id) : null;
    const ids = s && s.projet && Array.isArray(s.tourMessages) ? s.tourMessages : [];
    if (!ids.length) return { ok: false, raison: 'aucun message de l\'utilisateur enregistré pour ce tour dans la liste de travail' };
    const etat = core.lireLedger(s.projet, agent);
    const messages = ids.map(id => ({ id, d: etat.demandes[id] })).filter(x => x.d && x.d.session === input.session_id);
    const manquants = types.filter(t => !messages.some(x => contientOrdre(x.d.texte, o[t]))); // ancre-mutation:ordre-utilisateur
    if (manquants.length) {
      return { ok: false, raison: 'son message de ce tour (' + messages.map(x => x.id).join(', ') + ') ne contient pas l\'ordre attendu : ' + manquants.map(t => 'un mot d\'ordre de ' + (t === 'poussee' ? 'poussée' : 'déploiement') + ' (' + o.mots[t].slice(0, 3).join(', ') + '...)').join(' et ') };
    }
    return { ok: true, messages: messages.map(x => x.id) };
  } catch (e) { return { ok: false, raison: 'lecture de la liste de travail impossible (' + (e && e.message ? e.message : e) + ')' }; }
}

const NOM_ORDRE = { poussee: 'poussée', deploiement: 'déploiement' };

// Analyse un appel d'outil déjà décodé. Rend { verdict: 'allow'|'ask'|'deny', raison, avis }.
//   entree : l'objet reçu du moteur ; options : { agent, cfg }.
function analyser(entree, options) {
  const { agent, cfg } = options;
  const input = entree && typeof entree === 'object' ? entree : {};
  // apply_patch (outil d'édition de Codex) : tool_input.command porte le TEXTE du patch, rien n'y est exécuté.
  // L'analyser refuserait toute édition qui MENTIONNE git push ou une suppression récursive (docs, historiques, ce
  // script lui-même). Seul ce nom exact est exempté : un shell qui appelle apply_patch reste analysé.
  if (String(input.tool_name || '').toLowerCase() === 'apply_patch') return { verdict: 'allow' }; // ancre-mutation:apply-patch
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  // Champs de commande des outils de shell : command (Claude Code, Codex), cmd (exec_command de Codex), script et
  // input (outils de shell tiers). Une commande donnée en tableau est lue mot à mot.
  const champ = [ti.command, ti.cmd, ti.script, ti.input].find(v => (typeof v === 'string' && v) || (Array.isArray(v) && v.length));
  const original = Array.isArray(champ) ? champ.map(String).join(' ') : String(champ || '');
  if (!original) return { verdict: 'allow' };

  const blocs = [];
  const demandes = [];
  const avis = [];
  const ordres = [];

  // Normalisation pour la lecture seulement (les messages ne la montrent pas) : « git.exe » devient « git », et les
  // options globales et alias de git sont résolus. Les règles portent sur le texte normalisé ; la poussée et la
  // suppression de branche, sur les commandes git réellement exécutées (un exemple affiché n'est pas une commande).
  const cmd = cs.normalizeGitCommands(cs.sansExtension(original));
  const extraites = cs.commandesGitExecutees(original);
  const gitCommands = cs.enveloppeOpaque(original) ? extraites.concat(cmd.match(/git\s+(?:push|branch)\b[^|;&]*/gi) || []) : extraites;
  const gitPushes = gitCommands.filter(c => /^git\s+push\b/i.test(c));
  const segments = cmd.split(/[|;&]+/);

  if (cfg.securite.actif) {
    // wrangler deploy sans --keep-vars (règle d'outil, désactivable)
    if (!cfg.securite.reglesDesactivees.has('wrangler-keep-vars') && /\bwrangler\s+deploy\b/i.test(cmd) && !/--keep-vars\b/i.test(cmd)) { // ancre-mutation:wrangler
      blocs.push('wrangler deploy sans --keep-vars peut effacer les variables et secrets du Worker réglés hors de son fichier de configuration. Ajoute --keep-vars.');
    }

    // Poussée forcée : --force, --force-with-lease, -f, refspec « + » (git push origin +main)
    if (gitPushes.some(c => /--force\b|--force-with-lease\b|\s-f(?:\s|$)/i.test(c) || /\s\+\S/i.test(c))) { // ancre-mutation:poussee-forcee
      blocs.push('Poussée forcée détectée (--force, --force-with-lease, -f ou refspec « + ») : elle écrase l\'historique distant. Une branche protégée ne se force jamais.');
    }

    // Suppression ou renommage d'une branche protégée (motifs de gardes.json ; aucun par défaut)
    if (cfg.securite.branchesProtegees.length) {
      const localement = gitCommands.some(c => /^git\s+branch\b[^|;&]*(\s-[a-zA-Z]*[dDmM]\b|--delete\b|--move\b)/i.test(c));
      const distante = gitPushes.some(c => /--delete\b|\s+\S+\s+:\S+/i.test(c));
      // Les motifs sont cherchés dans le texte des commandes git et dans chacun de leurs arguments (un motif
      // « ^release/ » vise donc un nom de branche, pas le début de la commande).
      const candidats = [gitCommands.join('\n')].concat(gitCommands.flatMap(c => c.split(/\s+/).map(t => t.replace(/^[:'"]+|['"]+$/g, ''))));
      if ((localement || distante) && cfg.securite.branchesProtegees.some(re => candidats.some(t => re.test(t)))) { // ancre-mutation:branche-protegee
        blocs.push('Suppression ou renommage d\'une branche protégée détecté (motifs de gardes.json, securite.branchesProtegees) : ces branches ne se suppriment ni ne se renomment, ni en local ni sur le dépôt distant.');
      }
    }

    // Suppression récursive forcée : flags combinés (-rf, -fr), séparés (-r ... -f) ou longs (--recursive --force)
    for (const seg of segments) {
      if (!/(^|\s)rm\s/i.test(seg)) continue;
      const recursif = /\s-[a-z]*r[a-z]*(\s|$)/i.test(seg) || /--recursive\b/i.test(seg) || /\s-R\b/.test(seg);
      const force = /\s-[a-z]*f[a-z]*(\s|$)/i.test(seg) || /--force\b/i.test(seg);
      if (recursif && force) { // ancre-mutation:rm-recursif
        blocs.push('Suppression récursive forcée détectée (flags combinés ou séparés). Confirme explicitement le chemin et l\'intention avant.');
        break;
      }
    }

    // git clean avec -f (seul ou combiné -d/-x/-n) : supprime les fichiers non suivis (et ignorés avec -x), sans corbeille
    for (const seg of segments) {
      if (!/\bgit\s+clean\b/i.test(seg)) continue;
      const force = /\s-[a-z]*f[a-z]*(\s|$)/i.test(seg) || /--force\b/i.test(seg);
      if (force) { // ancre-mutation:git-clean
        blocs.push('git clean avec -f détecté (supprime tous les fichiers non suivis, -x inclut aussi les ignorés). Suppression IRRÉVERSIBLE, pas de corbeille. Confirme explicitement le chemin et l\'intention avant.');
        break;
      }
    }

    // Suppressions récursives Windows : Remove-Item/ri/rm/rd/del -Recurse -Force (PowerShell) ; rmdir|rd|del|erase /s (cmd)
    if (/\b(Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^|;&]*(-Recurse\b[^|;&]*-Force\b|-Force\b[^|;&]*-Recurse\b)/i.test(cmd) // ancre-mutation:windows-recursif
        || /\b(rmdir|rd|del|erase)\b[^|;&]*\/s\b/i.test(cmd)) { // ancre-mutation:windows-slash-s
      blocs.push('Suppression récursive Windows détectée (Remove-Item -Recurse -Force, rmdir /s, del /s). Confirme explicitement le chemin et l\'intention avant.');
    }

    // git reset --hard
    if (/git\s+reset\s+--hard\b/i.test(cmd)) { // ancre-mutation:reset-hard
      blocs.push('git reset --hard détecté : perte des modifications non commitées. Confirme explicitement.');
    }

    // Contournement des hooks de git
    if (/--no-verify\b/i.test(cmd)) { // ancre-mutation:contournement-hooks
      blocs.push('Option de saut des vérifications de git détectée (elle contourne les hooks, dont le rappel avant commit). Jamais sans demande explicite de l\'utilisateur.');
    }

    // Confirmations : poussée, déploiement de production, commandes ajoutées par gardes.json
    const veut = nom => cfg.securite.confirmer.some(c => c.nom === nom);
    if (veut('poussee') && gitPushes.length) { // ancre-mutation:poussee
      demandes.push('git push détecté : jamais automatique, uniquement sur ordre explicite de l\'utilisateur.');
      ordres.push('poussee');
    }
    // Couvre « vercel deploy --prod », « vercel --prod », « npx vercel --prod » et toute variante avec des options entre
    // le nom de l'outil et --prod.
    if (veut('deploiement-production') && /\bvercel\b[^|;&]*--prod\b/i.test(cmd)) { // ancre-mutation:deploiement
      demandes.push('Déploiement de production détecté (vercel --prod) : jamais automatique, uniquement sur ordre explicite de l\'utilisateur.');
      ordres.push('deploiement');
    }
    for (const c of cfg.securite.confirmer) {
      if (!c.re || !c.re.test(cmd)) continue; // ancre-mutation:confirmation-perso
      demandes.push(c.message || ('Commande « ' + c.nom + ' » détectée (gardes.json, securite.confirmer) : jamais automatique, uniquement sur ordre explicite de l\'utilisateur.'));
      ordres.push(c.ordre);
    }

    // Avertissement : vercel env add sans printf (règle d'outil, désactivable)
    if (!cfg.securite.reglesDesactivees.has('vercel-env-sans-printf') && /vercel\s+env\s+add\b/i.test(cmd) && !/\bprintf\b/i.test(cmd)) { // ancre-mutation:vercel-env
      avis.push('vercel env add sans printf détecté : une valeur collée peut contenir des sauts de ligne invisibles. Passe-la par printf valeur | vercel env add NOM environnement.');
    }
  }

  // Rappel avant commit : un commit dont le diff préparé touche une catégorie sensible. Une panne de la vérification
  // refuse le commit (jamais d'ouverture par défaut).
  if (cfg.checklist.actif) {
    try {
      const dossier = typeof ti.workdir === 'string' && ti.workdir ? ti.workdir : (input.cwd || process.cwd());
      const cible = resolveCommitTarget(cs.sansExtension(original), dossier);
      if (cible.isCommit) {
        const message = checklist.evaluer(cible.gitCwd, cfg.checklist.categories);
        if (message) blocs.push(message);
      }
    } catch (e) { blocs.push('Rappel avant commit NON VÉRIFIÉ : ' + e.message + '. Commit refusé : corrige la cause puis relance.'); } // ancre-mutation:checklist-panne
  }

  if (blocs.length) {
    return {
      verdict: 'deny',
      raison: 'DANGER (refusé par la garde de sécurité) : ' + blocs.concat(demandes).join(' | ') +
        (avis.length ? ' | RAPPEL : ' + avis.join(' | ') : '') +
        ' | Ne contourne pas ce refus : explique le risque à l\'utilisateur et attends son ordre explicite.',
    };
  }
  if (demandes.length) {
    if (agent === 'claude') return { verdict: 'ask', raison: demandes.concat(avis).join(' | ') }; // ancre-mutation:ask-claude
    const types = [...new Set(ordres)];
    const ordre = ordreDeLUtilisateur(input, types, agent, cfg);
    if (!ordre.ok) {
      return {
        verdict: 'deny',
        raison: 'REFUSÉ par la garde de sécurité : ' + demandes.join(' | ') + (avis.length ? ' | RAPPEL : ' + avis.join(' | ') : '') +
          ' | Pas d\'ordre de l\'utilisateur pour ce tour : ' + ordre.raison + '. Ne contourne pas ce refus. Soit l\'utilisateur l\'ordonne dans son prochain message (' +
          types.map(t => NOM_ORDRE[t]).join(', ') + ' ; son ordre vaut pour le tour en cours), soit tu lui présentes la commande exacte et il la lance lui-même.',
      };
    }
    avis.push('Commande autorisée sur ordre de l\'utilisateur (' + ordre.messages.join(', ') + ') : ' + types.map(t => NOM_ORDRE[t]).join(' + ') + '. Exécute exactement ce qu\'il a demandé, rien de plus.');
  }
  return avis.length ? { verdict: 'allow', avis: 'ATTENTION : ' + avis.join(' | ') } : { verdict: 'allow' };
}

// Décode l'entrée, analyse, et rend ce que le hook doit écrire : { stdout, stderr, code }.
function executer(brut, options) {
  const agent = options.agent;
  let cfg;
  try { cfg = gardesConfig.charger(); } catch (e) { return { stdout: refus('security : réglage des gardes inutilisable (' + (e && e.message ? e.message : String(e)) + '), commande refusée.'), stderr: '', code: agent === 'claude' ? 2 : 0 }; }
  const notice = gardesConfig.dire(cfg);
  let r;
  try {
    r = analyser(JSON.parse(brut), { agent, cfg });
  } catch (e) {
    // Erreur de traitement : refus explicite. Si la sortie échoue, le code 2 reste bloquant.
    r = { verdict: 'deny', raison: 'La garde de sécurité n\'a pas pu analyser la commande, elle est refusée (' + (e && e.message ? e.message : String(e)) + ').' }; // ancre-mutation:analyse-impossible
  }
  if (r.verdict === 'deny') {
    const raison = r.raison + (notice ? ' | ' + notice : '');
    return { stdout: refus(raison), stderr: agent === 'claude' ? raison + '\n' : '', code: agent === 'claude' ? 2 : 0 }; // ancre-mutation:sortie-refus
  }
  if (r.verdict === 'ask') {
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: r.raison + (notice ? ' | ' + notice : '') } }), stderr: '', code: 0 };
  }
  const message = [r.avis, notice].filter(Boolean).join(' | ');
  if (!message) return { stdout: '', stderr: '', code: 0 };
  return { stdout: JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }), stderr: '', code: 0 };
}

function refus(raison) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } });
}

function principal() {
  const agent = config.agentDepuisArgs(process.argv, '') || null;
  let brut = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => (brut += c));
  process.stdin.on('end', () => {
    let r;
    try { r = executer(brut, { agent }); } catch (_) { r = { stdout: '', stderr: 'La garde de sécurité a échoué : commande refusée.\n', code: 2 }; }
    ecrire(r, process);
  });
}

// Écrit le verdict sur la sortie du processus. Si la sortie échoue, le code 2 reste bloquant : la garde ne laisse
// jamais passer une commande faute d'avoir pu le dire.
function ecrire(r, proc) {
  try {
    if (r.stdout) proc.stdout.write(r.stdout);
    if (r.stderr) proc.stderr.write(r.stderr);
    proc.exitCode = r.code;
  } catch (_) { proc.exitCode = 2; } // ancre-mutation:sortie-en-panne
}

if (require.main === module) principal();

module.exports = { analyser, executer, ecrire, contientOrdre, ordreDeLUtilisateur };
