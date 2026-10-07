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
 *   amputé est reconstruit depuis cette copie (texteJournal), racine entièrement effacée comprise. La liste
 *   de ses projets est gardée dans la racine (.secours-projets.<agent>.json) : son dossier, qui peut être
 *   sur un disque lent, n'est relu que si cette liste manque ou a plus de dix minutes.
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
 *   rappelStop({agent, sessionId, promptId, script}) -> texte|null
 *        un seul rappel par message humain : les M du tour encore à trier, rien d'autre
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
 *   texteSuiviEnCours({agent, sessionId}) -> en cours de tour : signalements des sous-agents, fins pas encore
 *        annoncées à l'orchestrateur, rappel des résultats qui attendent (au plus une fois par délai) ; '' sinon
 *
 * Signalements entre agents principaux (boîte par agent : <racine>\.signalements\<agent>.jsonl, jamais réécrite)
 *   signalerAgent({de, vers, projet, ligne, genre, texte}) -> signalement   sur une ligne encore ouverte de `vers`
 *   texteSignalementsAgents({agent, sessionId, session}) -> nouveaux signalements du projet de la session, dits
 *        une fois (appelé par texteSuiviEnCours) ; texteSignalementsEnAttente({agent, projet}) -> ceux dont la
 *        ligne est encore ouverte (repris par contexteSession) ; lireBoite(agent, depuis) -> {fin, signalements}
 *
 * Fiches des sous-agents (un fichier par sous-agent : identité, mission mot pour mot, notes qu'il ajoute)
 *   <racine>\<projet>.<agent>\fiches\<genre>-<12 derniers caractères de l'ID>.md ; index : <racine>\.fiches\<agent>-<ID>.json
 *   creerFiche({agent, sessionId, id, projet, ligne, titre, titreRepli, genre, mission, cwd}) -> chemin
 *        crée ou complète ; un titre de repli (titreRepli : fabriqué faute de mieux) est remplacé par le vrai
 *   lireFiche(agent, id) -> {index, texte}|null ; lireIndexFiche(agent, id) -> index|null
 *   noterFiche({agent, id, genre, texte}) -> {fiche, notes, mission, signale}   note ajoutée, jamais réécrite ;
 *        genre mission : remplit la mission absente ; deja-fait, bloque, question : signalé à l'orchestrateur
 *   texteConsigneSousAgent({agent, id, script}) -> consigne donnée au sous-agent à son démarrage
 *   consigneADonner({agent, id, fichier, formes}) -> bool   vrai si la consigne est à donner à cet appel :
 *        jamais marquée (filet du démarrage : premier événement du sous-agent quand SubagentStart ne l'a pas
 *        donnée), ou marquée mais absente de son transcript `fichier` (hook de démarrage tué après sa marque) :
 *        cherchée une seule fois, redonnée une seule fois ; formes : motifs d'une ligne injectée (par agent)
 *   texteRepriseSousAgent({agent, id, script}) -> sa fiche, rendue après un compactage de SON contexte
 *   compactageDuSousAgent({agent, id, fichier, motifs, annonce}) -> bool   vrai si la fiche doit être rendue
 *   noterCompactage({agent, id}) -> bool     compactage annoncé par son événement (fiche rendue au prochain outil)
 *   transcriptDUnSousAgent(fichier, sessionId, agent) -> bool ; idDepuisTranscript(fichier) -> id|''
 *   chercher({projet, agent, motifs}) -> texte   recherche en lecture seule dans les lignes C et les messages M ;
 *        un motif C-NNNN ou M-NNNN rend la ligne ou le message entier
 *
 * Temps et diagnostic
 *   fixerBudget(ms) ; tempsRestant() -> ms   échéance du processus, démarrage de node compris : les attentes
 *        (verrou, réessais) s'y arrêtent. %CONTEXT_LEDGER_BUDGET_MS% remplace la valeur (bancs).
 *   capturerEvenement({agent, input, octets})   forme et durée des événements reçus, sans aucun contenu ;
 *        actif seulement si le fichier « actif » existe dans le dossier de capture (voir DOSSIER_CAPTURE) ;
 *        une ligne courte au début (<agent>.debuts.jsonl) : un début sans fin = hook tué par son délai ;
 *        la ligne de fin porte dur_ms et, pour chaque étape qui a pris du temps, sa durée : verrou_ms
 *        (attente d'un verrou), secours_ms (disque de la copie de secours), transcript_ms, preuves_ms
 *        (recherche des preuves, attente de son verrou comprise : ces durées ne s'additionnent pas) ;
 *        pour un outil, la forme de son entrée : outil_cles, outil_commande (type, ou programme et options
 *        d'une commande en tableau), outil_shell
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
 *   gardeOutil({input, generique, powershell}) -> raison|null     raison de refus PreToolUse, null = autorisé
 *        sous-agent (input.agent_id) : lecture de la racine permise, écriture refusée, CLI limitée à lister,
 *        chercher, fiche, help, et note sur sa propre fiche
 *        powershell : la commande part à coup sûr dans PowerShell (sinon seuls les outils PowerShell le
 *        prouvent) ; alors un texte littéral (here-string @' '@) écrit dans un fichier de texte hors de la
 *        racine passe, même s'il cite la racine : le rapport d'un sous-agent
 *   texteToucheRacine(texte) -> bool ; appelleCli(texte) -> bool ; commandeLectureOuCli(cmd, sousAgent?) -> bool
 *   lectureAmbigue(cmd) -> bool     guillemet typographique ou commentaire : PowerShell les lit autrement
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
 *     chercher [--projet P] [--agent A] "mot"... | fiche <ID> | note --fiche <ID> [--genre g] "texte" | help
 *     signaler --agent A --projet P C-NNNN [--genre g] "texte"   (agent principal : prévient l'agent A)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { resolveCommitTarget } = require('./commande-git.js');
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
// Ajouté aux refus d'une commande : comment écrire un fichier à soi dont le texte cite la racine (constat du
// 2026-10-07 : le refus ne parlait que de lecture, trois sous-agents sur cinq ont écrit à l'orchestrateur).
const AIDE_TEXTE = ' Si tu écrivais un fichier à toi (rapport, notes) dont le texte cite ce dossier ou cette commande : passe par l\'outil de fichier (apply_patch, Write), ou en PowerShell par un here-string littéral donné tel quel à l\'écriture, vers un chemin complet, le reste de la commande ne faisant que lire (@\'…\'@ | Set-Content -LiteralPath \'C:\\…\\rapport.md\').';
const RAISON_SHELL = 'Sur la racine contexte, le shell ne sert qu\'à lire (cat, type, Get-Content, head, tail, grep, ls, dir) ou à appeler la commande context-ledger. ' + RAISON_FICHIER + AIDE_TEXTE;
// Sous-agents (règle : « un sous-agent n'y écrit jamais »). Jusqu'au 2026-10-02 la garde leur
// refusait aussi la LECTURE : mesuré cette nuit-là, 19 refus dans 7 sous-agents Codex et le même refus dans
// 23 sous-agents Claude, tous pour lire le registre ou une fiche C (recouper un reste avec la liste).
// Depuis : lecture permise, écriture toujours refusée, et une fiche par sous-agent pour ses propres notes.
// Le 2026-10-02, 48 des 91 lectures encore refusées étaient des boucles sur des C-NNNN.txt : d'où « chercher »
// par identifiant, et le rappel qu'une lecture se fait sans boucle ni script.
const RAISON_SOUS_AGENT = 'Seul l\'orchestrateur écrit dans le fichier contexte. Toi, sous-agent, tu peux le LIRE, jamais le modifier : lis avec une commande simple, une par lecture, sans boucle ni script (Get-Content, cat, Select-String ou rg sur un fichier nommé ; Get-Content x | Select-Object -Index 10,20 pour des lignes précises) ou avec la commande context-ledger « chercher » (chercher C-0151 C-0152 rend ces lignes entières ; --agent claude ou --agent codex pour la liste d\'un autre agent) ; ajouter, etat, sans-travail et abandon sont réservés à l\'orchestrateur. Ce que tu trouves se note dans ta fiche (commande « note ») ou dans ton rapport : rends ton résultat à l\'orchestrateur, il mettra le fichier contexte à jour.' + AIDE_TEXTE;
// Sous-commandes de la CLI qu'un sous-agent peut appeler (lecture) ; « note » en plus, sur sa propre fiche.
const CLI_SOUS_AGENT = new Set(['lister', 'chercher', 'fiche', 'help', '--help', '-h', 'aide']);

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
  'test-path', 'get-item', 'gi', 'resolve-path', 'join-path', 'cd', 'set-location', 'sl', 'pushd', 'popd',
  'get-location', 'pwd', 'format-hex',
  // Fin de pipeline qui ne fait qu'afficher ou compter (formes relevées dans les lectures refusées).
  'measure-object', 'select-object', 'sort-object', 'out-string', 'format-table', 'format-list',
  'write-output', 'write-host', 'echo',
]);
// Affectation PowerShell d'une chaîne littérale ($p='...'), sans interpolation : n'exécute rien.
const RE_AFFECTATION_LITTERALE = /^\$[A-Za-z_]\w*\s*=\s*(?:'[^']*'|"[^"$`]*")\s*$/;
// Blocs { } sans effet, formes relevées dans les lectures refusées du 2026-10-02 : projection de l'objet
// courant ({ $_ }, { $_.Line }), format ({ '{0}: {1}' -f $_.LineNumber, $_.Line }) et filtre
// ({ $_.Name -like 'C-*' }). Ils s'appliquent au texte comme au masque (chaînes vidées) : une chaîne s'y
// réduit à '...' ou "..." (« $( » et l'accent grave sont refusés avant). Le segment qui les porte ne peut
// être que ForEach-Object ou Where-Object (et leurs alias), suivi du seul bloc.
const TERME_OBJET = '\\$_(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';
const LITTERAL = '(?:\'[^\']*\'|"[^"]*"|-?\\d+(?:\\.\\d+)?)';
const COMPARAISON = '-[ci]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin)';
const BLOCS_SURS = [
  `\\{\\s*${TERME_OBJET}\\s*\\}`,
  `\\{\\s*(?:'[^']*'|"[^"]*")\\s+-f\\s+${TERME_OBJET}(?:\\s*,\\s*${TERME_OBJET})*\\s*\\}`,
  `\\{\\s*${TERME_OBJET}\\s+${COMPARAISON}\\s+${LITTERAL}\\s*\\}`,
].join('|');
const RE_BLOC_SUR = new RegExp(BLOCS_SURS, 'gi');
const RE_SEGMENT_BLOC = new RegExp(`^(?:foreach-object|foreach|%|where-object|where)\\s*(?:${BLOCS_SURS})\\s*$`, 'i');
// Where-Object sans bloc, sur une propriété et une valeur littérale (Where-Object Name -like '*projet*').
const RE_SEGMENT_FILTRE = new RegExp(`^(?:where-object|where)\\s+(?:-property\\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*\\s+${COMPARAISON}\\s+(?:-value\\s+)?${LITTERAL}\\s*$`, 'i');
// Sous-expression ( ) dont le contenu est lui-même une lecture ((Get-Content x).Count, Get-Item -LiteralPath
// (Join-Path $d 'x')) : remplacée, pour l'analyse seulement, par une marque de même longueur (caractère 1,
// refusé dans une commande). L'accès qui la suit (.Count, [0]) reste à sa place ; une parenthèse collée à un
// nom (méthode : .Delete(), fonction) n'est jamais remplacée, elle fait donc refuser la commande.
const MARQUE_SOUS_EXPRESSION = String.fromCharCode(1);
const RE_SEGMENT_SOUS_EXPRESSION = new RegExp(`^${MARQUE_SOUS_EXPRESSION}+(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[-?\\d+(?:\\.\\.-?\\d+)?\\])*$`);
const MAX_SOUS_EXPRESSIONS = 8;
// Fins de pipeline dont un argument peut être un bloc exécuté pour chaque objet (Select-Object -Property
// @{ e = { ... } }, Sort-Object { ... }) : une variable y est refusée, elle pourrait porter un tel bloc
// préparé par une commande précédente qui, elle, ne visait pas la racine.
const PIPELINE_A_BLOC = new Set(['select-object', 'sort-object', 'format-table', 'format-list', 'measure-object']);
const RE_CLI_SEGMENT = /^["']?(?:[^"'\s]*[\\/])?node(?:\.exe)?["']?\s+(?:"(?:[^"]*[\\/])?context-ledger\.js"|'(?:[^']*[\\/])?context-ledger\.js'|(?:[^"'\s]*[\\/])?context-ledger\.js)(?=\s|$)/i;
// Écriture d'un texte littéral hors de la racine (voir ecritureDeTexteLitteral). Outils dont la commande part
// à coup sûr dans PowerShell ; marque qui remplace le here-string pendant l'analyse (caractère 2, refusé dans
// une commande) ; cmdlets d'écriture reconnues ; extensions d'un fichier de texte (un rapport, pas un script) ;
// garde-fou courant avant d'écrire, qui ne fait qu'arrêter la commande.
const OUTILS_POWERSHELL = ['PowerShell', 'mcp__Windows-MCP__PowerShell'];
const MARQUE_TEXTE = String.fromCharCode(2);
const RE_CMDLET_ECRITURE = /^(?:set-content|add-content|out-file)(?=\s|$)/i;
const RE_EXTENSION_TEXTE = /\.(?:md|markdown|txt|json|jsonl|csv|tsv|log|ya?ml)$/i;
const RE_GUILLEMET_TYPOGRAPHIQUE = /[‘’‚‛“”„]/;
const RE_APOSTROPHE_TYPOGRAPHIQUE = /[‘’‚‛]/;
const RE_GUILLEMET_DOUBLE_TYPOGRAPHIQUE = /[“”„]/;
const TEST_CHEMIN = 'test-path\\s+(?:-(?:literal)?path\\s+)?(?:\\$[A-Za-z_]\\w*|\'[^\']*\')(?:\\s+-pathtype\\s+(?:leaf|container|any))?';
const RE_GARDE_FOU = new RegExp(`^if\\s*\\(\\s*(?:(?:-not|!)\\s*\\(\\s*${TEST_CHEMIN}\\s*\\)|${TEST_CHEMIN})\\s*\\)\\s*\\{\\s*throw\\s+(?:'[^']*'|"[^"$\`]*")\\s*\\}$`, 'i');

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

// Échéance commune à tout le processus. Un hook tué pour délai dépassé ne rend RIEN (ni rappel ni refus) :
// les attentes (verrou occupé, réessais) s'arrêtent donc à l'échéance et le hook rend ce qu'il a. Le temps
// de démarrage de node compte dans le budget : mesuré sous forte charge (2026-10-01), un hook a mis de 12,9
// à 21,6 s, presque tout avant sa première ligne. Sans budget fixé (CLI, bancs) : pas d'échéance.
let echeance = Infinity;
function fixerBudget(ms) {
  const impose = Number(process.env.CONTEXT_LEDGER_BUDGET_MS); // bancs : machine saturée par les tests eux-mêmes
  const budget = Number.isFinite(impose) && impose > 0 ? impose : ms;
  if (Number.isFinite(budget) && budget > 0) echeance = Date.now() - Math.round(process.uptime() * 1000) + budget;
}
function tempsRestant() { return echeance - Date.now(); }

// Où passe le temps d'un hook : attente d'un verrou, disque de la copie de secours, lecture du transcript,
// recherche des preuves. Ces durées vont dans la ligne de fin de la capture de diagnostic (des durées, aucun
// contenu). Constaté le 2026-10-07 : un hook de 21 s et un autre coupé à 30 s, node démarré en 41 ms dans les
// deux cas, et rien pour dire quelle étape avait attendu.
const jalons = { verrou_ms: 0, secours_ms: 0, transcript_ms: 0, preuves_ms: 0 };
function chronometrer(cle, fn) {
  const t = Date.now();
  try { return fn(); } finally { jalons[cle] += Date.now() - t; } // ancre-mutation:jalons
}

// Verrou exclusif : fs.openSync(<fichier>.lock, 'wx'), réessais courts jusqu'à 3 s,
// verrou périmé (processus mort) au-delà de 10 s.
function avecVerrou(fichier, fn) {
  const verrou = fichier + '.lock';
  fs.mkdirSync(lp(path.dirname(verrou)), { recursive: true });
  const limite = Math.min(Date.now() + DELAI_VERROU_MS, echeance); // ancre-mutation:echeance-verrou
  chronometrer('verrou_ms', () => {
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
  });
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
  return [...new Set(listerProjets(agent).concat(noms(racine()), projetsDuSecours(agent, noms)))].sort();
}

// Projets présents dans la copie de secours. Ce dossier peut être sur un disque lent ou en veille : relu à
// chaque événement (c'était le cas jusqu'au 2026-10-07), il fait attendre le hook le temps que ce disque
// réponde. Sa liste est donc gardée dans la racine et relue au plus toutes les FRAICHEUR_SECOURS_MS ; une
// écriture de la copie y ajoute son projet. Racine effacée : la liste gardée disparaît avec elle, le dossier
// de secours est relu aussitôt et tout est reconstruit au premier événement, comme avant.
const FRAICHEUR_SECOURS_MS = 10 * 60 * 1000;
function fichierProjetsSecours(agent) { return path.join(racine(), `.secours-projets.${agent}.json`); }

function projetsSecoursGardes(agent, secours) {
  try {
    const c = JSON.parse(sansBom(lireTexte(fichierProjetsSecours(agent)) || ''));
    const age = Date.now() - Date.parse(c.le);
    if (c.dossier === secours && Array.isArray(c.projets) && age >= 0 && age < FRAICHEUR_SECOURS_MS) return c.projets;
  } catch (_) { /* absente ou illisible : le dossier de secours sera relu */ }
  return null;
}

function projetsDuSecours(agent, noms) {
  const secours = racineSecours();
  if (!secours) return [];
  const gardes = projetsSecoursGardes(agent, secours);
  if (gardes) return gardes; // ancre-mutation:secours-liste-gardee
  const projets = chronometrer('secours_ms', () => noms(secours));
  try { ecrireAtomique(fichierProjetsSecours(agent), JSON.stringify({ le: maintenantIso(), dossier: secours, projets }) + '\n'); } catch (_) { /* relue au prochain événement */ }
  return projets;
}

// Une écriture de la copie y fait entrer son projet : la liste gardée le reçoit sans relire le dossier.
function ajouterProjetSecours(agent, projet) {
  const secours = racineSecours();
  const gardes = secours ? projetsSecoursGardes(agent, secours) : null;
  if (!gardes || gardes.includes(projet)) return;
  try {
    const c = JSON.parse(sansBom(lireTexte(fichierProjetsSecours(agent))));
    c.projets = gardes.concat(projet).sort();
    ecrireAtomique(fichierProjetsSecours(agent), JSON.stringify(c) + '\n'); // ancre-mutation:secours-liste-ajout
  } catch (_) { /* la liste sera relue du dossier à son échéance */ }
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
    chronometrer('secours_ms', () => {
      const ts = tailleDe(s);
      fs.mkdirSync(lp(path.dirname(s)), { recursive: true });
      if (ts >= 0 && ts + Buffer.byteLength(bloc) === tp) fs.appendFileSync(lp(s), bloc);
      else if (ts > tp) lireJournal(projet, agent);
      else {
        const tmp = `${s}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.copyFileSync(lp(principal), lp(tmp));
        fs.renameSync(lp(tmp), lp(s));
      }
    });
    ajouterProjetSecours(agent, projet);
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
  try { ts = chronometrer('secours_ms', () => lireTexte(s)); } catch (_) { ts = null; }
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
          texte: chaine(v.texte), de, date, ts, statut: 'ouvert', note: null, preuve: null, citationUtilisateur: null, maj: ts, session: v.session || null,
        };
        const d = de && e.demandes[de];
        if (d) { d.statut = 'converti'; d.lignes = d.lignes.concat(id); d.maj = ts; }
        break;
      }
      case 'etat':
        if (l && STATUTS_MANUELS.includes(v.apres)) { l.statut = v.apres; if (v.note) l.note = v.note; l.maj = ts; }
        break;
      case 'fait':
        if (l) Object.assign(l, { statut: 'fait', preuve: v.preuve || null, maj: ts, ...(v.cloture ? { cloture: v.cloture } : {}) });
        break;
      case 'partiel':
        if (l) {
          if (v.cloture) l.cloture = v.cloture;
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

function ajouterLigne({ projet, agent, texte, de, sessionId }) {
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
      note: null, preuve: null, citationUtilisateur: null, maj: iso, session: sessionId || (deId && etat.demandes[deId].session) || null,
    };
    if (deId) {
      const d = etat.demandes[deId];
      d.statut = 'converti';
      d.lignes = Array.isArray(d.lignes) ? d.lignes : [];
      d.lignes.push(id);
      d.maj = iso;
    }
    if (t.length > EXTRAIT_COMPACT) o.texteLong(id, t);
    o.journal({ evt: 'ajout', id, de: deId, texte: t, session: etat.lignes[id].session });
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

function contexteEchecMessage({ agent, projet, script, erreur, fichierSecours, sessionId }) {
  const cmd = commandes(script, projet, sessionId);
  return composerContexte([
    `Fichier contexte (projet ${projet}, agent ${agent}) : ce message de l'utilisateur n'a PAS pu être enregistré (${chaine(erreur) || 'erreur inconnue'}).`,
    fichierSecours ? `Il est gardé mot pour mot dans ${fichierSecours}.` : '',
    `Inscris-le toi-même avant d'agir : \`${cmd.ajouter()}\` (une ligne par travail demandé, texte mot pour mot).`,
  ].filter(Boolean).join('\n'), [], '', cmd.lister);
}

// Fin de tour : un seul rappel par message humain, pour les messages de CE tour encore à trier.
// Jusqu'au 2026-10-07, les lignes créées ou modifiées pendant le tour et absentes de la réponse étaient
// rappelées aussi. Constaté dans des sessions réelles : ce rappel revenait à presque chaque tour (5 tours
// sur 7 dans une conversation de dépannage), l'agent donnait une seconde réponse sans rien changer, et le
// critère (l'identifiant écrit dans la réponse) ne disait rien du travail. Retiré : la ligne reste dans la
// liste, qui fait foi et qui est réinjectée.
function rappelStop({ agent, sessionId, promptId, script }) {
  const s = lireSession(agent, sessionId);
  if (!s || !s.projet) return null;
  const cle = s.promptCourant || promptId || s.tourDebut;
  if (!cle || (s.rappels || []).includes(cle)) return null;
  const etat = etatDeSession(lireLedger(s.projet, agent), agent, sessionId);
  const aTrier = (s.tourMessages || []).filter(id => etat.demandes[id] && etat.demandes[id].statut === 'a-trier');
  if (!aTrier.length) return null; // ancre-mutation:stop-lignes-du-tour
  const deja = modifierSession(agent, sessionId, x => {
    x.rappels = Array.isArray(x.rappels) ? x.rappels : [];
    if (x.rappels.includes(cle)) return true;
    x.rappels = x.rappels.concat(cle).slice(-200);
    return false;
  });
  if (deja) return null;
  const cmd = commandes(script, s.projet, sessionId);
  // Liste plafonnée : les consignes doivent rester lisibles sous le plafond de 9 000 caractères.
  const borner = items => (items.length > MAX_IDS_RAPPEL
    ? `${items.slice(0, MAX_IDS_RAPPEL).join(', ')} et ${items.length - MAX_IDS_RAPPEL} autre(s) (liste complète : \`${cmd.lister}\`)`
    : items.join(', '));
  const parts = [
    `Fichier contexte (projet ${s.projet}) : fin de tour.`,
    `Message(s) de l'utilisateur encore à trier : ${borner(aTrier)}. Transforme-le(s) avec \`${cmd.ajouter(aTrier[0])}\` ou classe-le(s) avec \`${cmd.sansTravail(aTrier[0])}\`.`,
  ];
  return composerContexte(parts.join('\n'), [], '', cmd.lister);
}

// Lit `fichier` de l'octet `depuis` à l'octet `jusqua`, par blocs de 4 Mo, et appelle surLigne(Buffer) pour
// chaque ligne COMPLÈTE. Retourne l'octet qui suit la dernière ligne complète : une ligne en cours
// d'écriture sera relue au passage suivant.
function lireLignesDepuis(fichier, depuis, jusqua, surLigne) {
  return chronometrer('transcript_ms', () => lireLignesChronometrees(fichier, depuis, jusqua, surLigne));
}

function lireLignesChronometrees(fichier, depuis, jusqua, surLigne) {
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
// Transcript d'un autre fil que celui de la session, donc d'un sous-agent : Claude Code le range dans un
// dossier « subagents » ; chez Codex le nom du rollout porte l'identifiant du fil enfant, pas celui de la
// session. Sert à reconnaître un sous-agent quand l'événement ne porte pas agent_id (mesuré le 2026-10-02 :
// SessionStart après le compactage d'un sous-agent Claude), et à ne jamais appliquer à un autre fichier
// l'octet « déjà vu » du transcript de l'orchestrateur.
function transcriptDUnSousAgent(fichier, sessionId, agent) {
  const f = chaine(fichier).replace(/\\/g, '/');
  if (!f) return false;
  if (/\/subagents\/[^/]+$/i.test(f)) return true;
  // Règle par le nom : seulement pour Codex, où elle est vérifiée (le rollout de la session porte son
  // identifiant). Ailleurs, un transcript au nom inattendu ne doit jamais faire taire l'orchestrateur.
  if (!/^codex/.test(chaine(agent))) return false;
  const ids = f.slice(f.lastIndexOf('/') + 1).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  const session = chaine(sessionId).toLowerCase();
  return ids.length > 0 && !!session && !ids.some(u => u.toLowerCase() === session);
}

// Identifiant du sous-agent tiré du nom de son transcript (agent-<id>.jsonl chez Claude Code), sinon ''.
function idDepuisTranscript(fichier) {
  const m = /[\\/]subagents[\\/]agent-([A-Za-z0-9_-]+)\.jsonl$/i.exec(chaine(fichier));
  return m ? m[1] : '';
}

function suiteTranscript({ agent, sessionId, fichier, surLigne }) {
  if (!fichier || typeof fichier !== 'string' || !sessionId) return null;
  if (transcriptDUnSousAgent(fichier, sessionId, agent)) return null; // ancre-mutation:transcript-sous-agent
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
// lancement, marquée « terminé, résultat à traiter » à la fin, rappelée une fois par état au Stop, et retirée
// seulement sur preuve [ctx C-NNNN] (résultat vérifié et intégré).
// Les tâches suivies sont gardées dans la session de l'orchestrateur :
//   session.taches[idTache] = { ligne, projet, titre, genre, resultat, alias, lance, fini, statut, clos }

const DELAI_REESSAI_MS = 6000;
const MAX_LIVRAISONS = 20;
const MAX_TACHES_CLOSES = 300;
const RAPPEL_LIVRAISONS_MIN = 20;

// « verrou occupé » est levé AVANT toute écriture : on réessaie (hooks parallèles, plusieurs sessions).
function reessayer(fn) {
  const limite = Math.min(Date.now() + DELAI_REESSAI_MS, echeance);
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
function suivreTache(args) {
  if (!args.sessionId || !chaine(args.tache && args.tache.id)) return null;
  return avecVerrou(cheminSession(args.agent, args.sessionId) + '.tache-' + hashCourt(chaine(args.tache.id)), () => suivreTacheSousVerrou(args));
}

function suivreTacheSousVerrou({ agent, sessionId, cwd, tache }) {
  validerAgent(agent);
  const id = chaine(tache && tache.id);
  if (!sessionId || !id) return null;
  const s = lireSession(agent, sessionId) || {};
  if (estObjet(s.taches) && s.taches[id]) {
    // Déjà suivie : la mission peut arriver après coup (retour de l'outil de lancement après le démarrage).
    const t = s.taches[id];
    if (chaine(tache.mission).trim()) {
      try { creerFiche({ agent, sessionId, id, projet: t.projet, ligne: t.ligne, titre: t.titre, genre: t.genre, mission: tache.mission, cwd }); } catch (_) { /* complétée plus tard */ }
    }
    return null;
  }
  const projet = projetDeSession(agent, sessionId, cwd);
  const titre = (chaine(tache.titre) || 'sans titre').replace(/\s+/g, ' ').slice(0, 90);
  const genre = chaine(tache.genre) || 'agent';
  const texte = `[agent] « ${titre} » (${genre}, ${id}) : à sa fin, lire son résultat, le vérifier et l'intégrer.`;
  const ligne = reessayer(() => ajouterLigne({ projet, agent, texte, de: null, sessionId })); // ancre-mutation:livraison-lancement
  try { reessayer(() => changerEtat({ projet, agent, id: ligne, statut: 'en-cours', note: `agent en cours depuis ${dateLocale()}` })); } catch (_) { /* la ligne existe : seul l'état manque */ }
  // Fiche du sous-agent (mission mot pour mot quand elle est connue). Un échec ne retire rien au suivi :
  // la fiche sera créée au premier événement du sous-agent.
  let fiche = null;
  try { fiche = creerFiche({ agent, sessionId, id, projet, ligne, titre, genre, mission: tache.mission, cwd }); } catch (_) { fiche = null; }
  reessayer(() => modifierSession(agent, sessionId, x => {
    x.taches = estObjet(x.taches) ? x.taches : {};
    x.taches[id] = { ligne, projet, titre, genre, resultat: chaine(tache.resultat), alias: tache.alias ? chaine(tache.alias) : null, lance: maintenantIso(), fiche };
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
function identiteLivraison({ livraisonId, resultat, dernierMessage }) {
  // Un rapport different peut etre remis dans le meme tour du parent.
  // Sans ID ni texte final, le chemin seul est conservateur : sa date ne prouve pas une nouvelle fin.
  return hashCourt(JSON.stringify([chaine(livraisonId), chaine(resultat), chaine(dernierMessage)]));
}

function finirTache(args) {
  if (!args.sessionId || !chaine(args.id)) return null;
  return avecVerrou(cheminSession(args.agent, args.sessionId) + '.tache-' + hashCourt(chaine(args.id)), () => finirTacheSousVerrou(args));
}

function finirTacheSousVerrou({ agent, sessionId, id, statut, resultat, reprise, livraisonId, dernierMessage }) {
  validerAgent(agent);
  const cle = chaine(id);
  const s = lireSession(agent, sessionId);
  const t = s && estObjet(s.taches) && s.taches[cle];
  if (!t) return null;
  if (t.fini && !reprise) return null; // relecture d'une trace, jamais une nouvelle livraison
  const st = chaine(statut) || 'terminé';
  const res = chaine(resultat) || chaine(t.resultat);
  const identite = identiteLivraison({ livraisonId, resultat: res, dernierMessage });
  if ((t.livraisonsVues || []).includes(identite)) return null;
  // Migration prudente : une fin deja connue sans identite ne rouvre pas sa ligne.
  if (t.fini && !t.livraisonId) {
    modifierSession(agent, sessionId, x => {
      const y = x.taches && x.taches[cle];
      if (y) { y.livraisonId = identite; y.livraisonsVues = [identite]; }
    });
    return null;
  }
  const note = `TERMINÉ (${st}) le ${dateLocale()} : résultat à lire, vérifier et intégrer${res ? ' : ' + res : ''}`; // ancre-mutation:livraison-fin
  let close = false;
  try { const l = lireLedger(t.projet, agent).lignes[t.ligne]; close = !l || TERMINAUX.includes(l.statut); } catch (_) { return null; }
  const marquer = ligne => reessayer(() => modifierSession(agent, sessionId, x => {
    const y = estObjet(x.taches) && x.taches[cle];
    if (y) Object.assign(y, { ligne, fini: maintenantIso(), statut: st, resultat: res, clos: null, annonce: null,
      livraisonId: identite, livraisonsVues: [...new Set([...(y.livraisonsVues || []), identite])].slice(-100) });
  }));
  if (!close) {
    // Une nouvelle version encore en attente actualise la meme ligne.
    try { reessayer(() => changerEtat({ projet: t.projet, agent, id: t.ligne, statut: 'ouvert', note })); } catch (_) { /* close entre-temps : rien à rappeler */ }
    marquer(t.ligne);
    return Object.assign({}, t, { id: cle, statut: st, resultat: res });
  }
  if (!reprise) {
    if (!t.fini) marquer(t.ligne);
    return null;
  }
  const texte = `[agent] « ${t.titre} » (${t.genre}, ${cle}) : nouveau résultat rendu après la clôture de ${t.ligne}, à lire, vérifier et intégrer.`;
  const ligne = reessayer(() => ajouterLigne({ projet: t.projet, agent, texte, de: null, sessionId })); // ancre-mutation:livraison-reprise
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
    // Notes laissées par le sous-agent dans sa fiche : dites à l'orchestrateur avec le résultat et les rappels.
    let notes = 0;
    try { const i = lireIndexFiche(agent, id); notes = i ? (i.notes || 0) : 0; } catch (_) { notes = 0; }
    (t.fini ? attente : enCours).push(Object.assign({ id, notes }, t));
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

function decrireTache(t) {
  const details = [t.resultat ? `résultat : ${t.resultat}` : '', t.fiche && t.notes ? `sa fiche, ${t.notes} note(s) : ${t.fiche}` : ''].filter(Boolean);
  return `${t.ligne} « ${t.titre} »${details.length ? ` (${details.join(' ; ')})` : ''}`;
}

// Rappel de fin de tour : livraisons non traitées et non citées dans la réponse de l'orchestrateur.
// Un état inchangé ne bloque pas chaque tour. Le résultat reste conservé jusqu'à sa preuve de traitement.
function texteLivraisons({ agent, sessionId, dernierMessage }) {
  let etat;
  try { etat = livraisons({ agent, sessionId }); } catch (_) { return ''; }
  const msg = chaine(dernierMessage);
  const attente = etat.attente.filter(t => !msg.includes(t.ligne)); // ancre-mutation:livraison-rappel-fin-de-tour
  const nonDites = etat.attente.filter(t => !t.annonce);
  if (!attente.length) { noterAnnonce(agent, sessionId, nonDites, false); return ''; } // citées : déjà connues
  const empreinte = hashCourt(JSON.stringify(etat.attente.map(t => [t.ligne, t.livraisonId || t.fini]).sort()));
  const deja = modifierSession(agent, sessionId, s => {
    if (s.rappelLivraisonsStop === empreinte) return true;
    s.rappelLivraisonsStop = empreinte;
    return false;
  });
  if (deja) return '';
  noterAnnonce(agent, sessionId, nonDites, true);
  const liste = attente.slice(0, MAX_LIVRAISONS).map(decrireTache).join(' ; ');
  const plus = attente.length > MAX_LIVRAISONS ? ` ; et ${attente.length - MAX_LIVRAISONS} autre(s)` : '';
  return `Sous-agents TERMINÉS dont le résultat n'est pas traité (${attente.length}) : ${liste}${plus}. Avant de t'arrêter : lis chaque résultat, vérifie-le, intègre-le, puis cite [ctx C-NNNN] dans l'historique ; sinon dis à l'utilisateur lesquels restent et pourquoi.${texteEnCours(etat)}`;
}

function texteEnCours(etat) {
  const un = t => (t.notes ? `${t.ligne}, ${t.notes} note(s) dans sa fiche` : t.ligne);
  return etat.enCours.length ? ` Encore en cours : ${etat.enCours.length} (${etat.enCours.slice(0, MAX_LIVRAISONS).map(un).join(' ; ')}).` : '';
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

// Signalements écrits par les sous-agents dans leur fiche (note de genre deja-fait, bloque ou question) et
// pas encore dits à l'orchestrateur : dits tout de suite, sans attendre la fin du sous-agent. Une tâche déjà
// faite mais encore ouverte dans la liste ne doit ni être refaite ni rester ignorée ; le sous-agent qui le
// constate ne peut pas fermer la ligne, il le signale.
const CONSIGNES_SIGNALEMENT = {
  'deja-fait': 'Vérifie dans le code ou l\'historique : si c\'est exact, ferme la ligne par une preuve [ctx C-NNNN] ; sinon réponds-lui.',
  bloque: 'Débloque-le ou réponds-lui : il attend.',
  question: 'Réponds-lui.',
};

function texteSignalements(agent, sessionId, taches) {
  const out = [];
  const vus = {};
  for (const [id, t] of Object.entries(taches)) {
    if (!estObjet(t) || t.clos) continue;
    let index = null;
    try { index = lireIndexFiche(agent, id); } catch (_) { index = null; }
    const liste = index && Array.isArray(index.signalements) ? index.signalements : [];
    const deja = Number.isInteger(t.signalVus) ? t.signalVus : 0;
    if (liste.length <= deja) continue; // ancre-mutation:fiche-signalement
    for (const g of liste.slice(deja)) {
      out.push(`Signalement du sous-agent ${t.ligne} « ${t.titre} » (${g.genre}) : « ${chaine(g.texte)} ». ${CONSIGNES_SIGNALEMENT[g.genre] || ''} Sa fiche : ${index.fiche}.`);
    }
    vus[id] = liste.length;
  }
  if (!out.length) return '';
  try {
    reessayer(() => modifierSession(agent, sessionId, x => {
      if (estObjet(x.taches)) for (const [id, n] of Object.entries(vus)) if (estObjet(x.taches[id])) x.taches[id].signalVus = n;
    }));
  } catch (_) { /* redit au prochain événement : mieux qu'un signalement jamais dit */ }
  return out.slice(0, MAX_LIVRAISONS).join('\n') + (out.length > MAX_LIVRAISONS ? `\n(${out.length - MAX_LIVRAISONS} signalement(s) de plus dans les fiches)` : '');
}

// En cours de tour, sur un événement que l'orchestrateur lit avant de s'arrêter (outil, message, reprise) :
// les signalements de ses sous-agents, puis leurs fins et le rappel de ce qui attend.
function texteSuiviEnCours({ agent, sessionId }) {
  validerAgent(agent);
  const s = lireSession(agent, sessionId);
  // Signalements d'un autre agent principal sur une ligne de cette liste (boîte de l'agent).
  let agents = '';
  try { agents = texteSignalementsAgents({ agent, sessionId, session: s }); } catch (_) { agents = ''; } // ancre-mutation:signalements-agents
  const taches = s && estObjet(s.taches) ? s.taches : {};
  if (!Object.values(taches).some(t => estObjet(t) && !t.clos)) return agents;
  const signalements = texteSignalements(agent, sessionId, taches);
  const fins = texteFinsEtRappel(agent, sessionId, s, taches);
  return [agents, signalements, fins].filter(Boolean).join('\n');
}

// Trouvé dans une session réelle : l'événement de fin du sous-agent marque la fin sans rien dire à
// l'orchestrateur, et le rappel n'existait qu'en fin de tour ; un tour de plus de 4 heures a laissé
// 7 résultats sans rappel.
//  - fin pas encore dite à l'orchestrateur : annonce courte, une fois ;
//  - résultat déjà annoncé qui attend depuis plus du délai : rappel de tout ce qui attend, au plus une
//    fois par délai (20 minutes).
function texteFinsEtRappel(agent, sessionId, s, taches) {
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
// Signalements entre agents principaux (cas à couvrir : un agent voit dans la liste d'un autre une tâche
// encore ouverte alors qu'elle est faite). Un agent principal ne modifie jamais la liste d'un autre : il dépose un signalement dans la boîte
// de l'agent qui la tient (commande signaler). Celui-ci le reçoit à son prochain événement dans le projet de
// la ligne (texteSuiviEnCours), vérifie, et ferme la ligne par SA preuve. Tant que la ligne reste ouverte, le
// signalement reste dans la liste réinjectée au démarrage et après un compactage (contexteSession).
//   <racine>\.signalements\<destinataire>.jsonl     un signalement par ligne, jamais réécrit
//   <racine>\.signalements\<destinataire>.vus.json  octet de la boîte déjà annoncé, par projet
const MAX_SIGNALEMENTS_LISTE = 10;
const CONSIGNES_SIGNALEMENT_AGENT = {
  'deja-fait': ligne => `Vérifie dans le code ou l'historique : si c'est exact, ferme la ligne par une preuve [ctx ${ligne}] ; sinon laisse-la ouverte et dis à l'utilisateur pourquoi.`,
  bloque: () => 'Il attend cette ligne : traite-la, ou dis à l\'utilisateur ce qui manque.',
  question: () => 'Réponds dans ta prochaine réponse à l\'utilisateur.',
};

function cheminBoite(agent) { return path.join(racine(), '.signalements', `${agent}.jsonl`); }
function cheminVusBoite(agent) { return path.join(racine(), '.signalements', `${agent}.vus.json`); }
// « Déjà fait », « deja fait », « deja-fait » : le même genre.
function normaliserGenre(genre) {
  return chaine(genre).trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
}

// Dépose un signalement dans la boîte de l'agent `vers`, sur une ligne encore ouverte de SA liste.
function signalerAgent({ de, vers, projet, ligne, genre, texte }) {
  validerAgent(de);
  validerAgent(vers);
  if (de === vers) throw new Error('signaler prévient un AUTRE agent : ta propre liste se met à jour avec etat, et une ligne se ferme par une preuve [ctx]');
  validerProjet(projet);
  const id = normaliserId(ligne, 'C');
  const g = normaliserGenre(genre || 'deja-fait');
  if (!GENRES_SIGNALEMENT.has(g)) throw new Error(`genre inconnu : ${chaine(genre)} (deja-fait, bloque ou question)`);
  const t = chaine(texte).trim();
  if (!t) throw new Error('signaler : donne la preuve, le blocage ou la question');
  const l = lireLedger(projet, vers).lignes[id];
  if (!l) throw new Error(`${id} absente de la liste de ${vers} (projet ${projet})`);
  if (TERMINAUX.includes(l.statut)) throw new Error(`${id} est déjà « ${l.statut} » dans la liste de ${vers} : rien à signaler`);
  const sig = {
    id: `S-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, le: maintenantIso(), de, projet,
    ligne: id, genre: g, texte: t.replace(/\s+/g, ' ').slice(0, 1000),
  };
  const f = cheminBoite(vers);
  reessayer(() => avecVerrou(f, () => ajouterAuFichier(f, JSON.stringify(sig) + '\n'))); // ancre-mutation:signaler-boite
  return sig;
}

function lireBoite(agent, depuis) {
  const f = cheminBoite(agent);
  let taille;
  try { taille = fs.statSync(lp(f)).size; } catch (_) { return { fin: 0, signalements: [] }; }
  const out = [];
  const fin = lireLignesDepuis(f, Math.min(depuis || 0, taille), taille, l => {
    try { const o = JSON.parse(l.toString('utf8')); if (estObjet(o) && o.ligne && o.projet) out.push(o); } catch (_) { /* ligne illisible : ignorée */ }
  });
  return { fin, signalements: out };
}

function decrireSignalement(s) {
  const le = Date.parse(s.le || '');
  return `${s.ligne} (de ${s.de}, ${s.genre}${Number.isFinite(le) ? `, ${dateLocale(new Date(le))}` : ''}) : « ${chaine(s.texte).slice(0, 300)} »`;
}

// Signalements arrivés depuis la dernière annonce, pour le projet de la session : dits une fois.
function texteSignalementsAgents({ agent, sessionId, session }) {
  const s = session || lireSession(agent, sessionId);
  const projet = s && s.projet;
  if (!projet) return '';
  let taille;
  try { taille = fs.statSync(lp(cheminBoite(agent))).size; } catch (_) { return ''; }
  const lireVus = () => { try { const o = JSON.parse(sansBom(lireTexte(cheminVusBoite(agent)) || '{}')); return estObjet(o) ? o : {}; } catch (_) { return {}; } };
  const vus = lireVus();
  const cleVue = `${projet}:${sessionId || '*'}`;
  const depuis = Number.isFinite(vus[cleVue]) && vus[cleVue] <= taille ? vus[cleVue] : 0;
  if (depuis >= taille) return '';
  const { fin, signalements } = lireBoite(agent, depuis);
  const etat = etatDeSession(lireLedger(projet, agent), agent, sessionId);
  const nouveaux = signalements.filter(x => x.projet === projet && etat.lignes[x.ligne] && !TERMINAUX.includes(etat.lignes[x.ligne].statut));
  try {
    reessayer(() => avecVerrou(cheminVusBoite(agent), () => {
      const cour = lireVus();
      if (Number.isFinite(cour[cleVue]) && cour[cleVue] >= fin) return;
      cour[cleVue] = fin;
      ecrireAtomique(cheminVusBoite(agent), JSON.stringify(cour) + '\n');
    }));
  } catch (_) { /* redit au prochain événement : mieux qu'un signalement jamais dit */ }
  if (!nouveaux.length) return '';
  const textes = nouveaux.map(x => {
    const l = etat.lignes[x.ligne];
    const consigne = CONSIGNES_SIGNALEMENT_AGENT[x.genre] ? CONSIGNES_SIGNALEMENT_AGENT[x.genre](x.ligne) : '';
    const le = Date.parse(x.le || '');
    return `Signalement de ${x.de} sur ta ligne ${x.ligne} (${x.genre}${Number.isFinite(le) ? `, ${dateLocale(new Date(le))}` : ''} ; état de la ligne : ${l ? l.statut : 'absente de ta liste'}) : « ${chaine(x.texte).slice(0, 300)} ». ${consigne}`;
  });
  return textes.slice(0, MAX_LIVRAISONS).join('\n') + (textes.length > MAX_LIVRAISONS ? `\n(${textes.length - MAX_LIVRAISONS} signalement(s) de plus : ${cheminBoite(agent)})` : '');
}

// Signalements dont la ligne est encore ouverte : rappelés avec la liste (démarrage, reprise, compactage).
function texteSignalementsEnAttente({ agent, projet, sessionId }) {
  const { signalements } = lireBoite(agent, 0);
  if (!signalements.length) return '';
  const etat = etatDeSession(lireLedger(projet, agent), agent, sessionId);
  const ouverts = signalements.filter(x => x.projet === projet && etat.lignes[x.ligne] && !TERMINAUX.includes(etat.lignes[x.ligne].statut));
  if (!ouverts.length) return '';
  const plus = ouverts.length > MAX_SIGNALEMENTS_LISTE ? ` ; et ${ouverts.length - MAX_SIGNALEMENTS_LISTE} plus ancien(s) dans ${cheminBoite(agent)}` : '';
  return `Signalements d'autres agents sur des lignes encore ouvertes (${ouverts.length}) : ${ouverts.slice(-MAX_SIGNALEMENTS_LISTE).map(decrireSignalement).join(' ; ')}${plus}. Vérifie chacun : si c'est exact, ferme la ligne par une preuve [ctx C-NNNN].`;
}

// ---------------------------------------------------------------------------
// Fiches des sous-agents (un second fichier de contexte, propre à chaque
// sous-agent et signé par son ID de travail)
//
// Mesuré dans les sessions réelles de la nuit du 2026-10-02 : 51 sous-agents Claude compactés (81
// compactages) et 22 sous-agents Codex compactés 1 à 7 fois chacun. Après un compactage, un sous-agent
// n'avait que le résumé pour retrouver sa mission, et le hook de démarrage lui injectait la liste de
// l'ORCHESTRATEUR à la place (18 fois, 17 sous-agents).
//   <racine>/<projet>.<agent>/fiches/<genre>-<id court>.md   la fiche : identité, mission, notes
//   <racine>/.fiches/<agent>-<id>.json                        l'index : où est la fiche, à qui elle est
// Le hook crée la fiche. Le sous-agent n'y fait qu'AJOUTER des notes (commande note) ; il lit la liste de
// l'orchestrateur sans jamais la modifier. Sa fiche lui est rendue après un compactage de son contexte.
// Mission : copiée mot pour mot quand elle est lisible (Claude Code). Dans Codex 0.155 le message de
// lancement est chiffré, dans le rollout comme dans l'entrée des hooks : le sous-agent la recopie lui-même.

const MISSION_ABSENTE = '(mission non copiée automatiquement : le sous-agent la recopie ici, mot pour mot, avec la commande note --genre mission)';
// Notes que l'orchestrateur doit voir sans attendre la fin du sous-agent.
const GENRES_SIGNALEMENT = new Set(['deja-fait', 'bloque', 'question']);
// Une ligne ouverte n'est pas une mesure (règle « mesurer l'état avant d'entamer ») : dit à tout
// agent qui lit la liste d'un autre.
const OUVERT_NEST_PAS_PAS_FAIT = '« ouvert » veut dire « pas encore prouvé fait », pas « pas fait » : avant d\'agir sur une ligne ou de la dire non faite, mesure dans le code ou l\'historique.';
// Mis en tête de tout texte destiné à l'orchestrateur : un sous-agent peut le lire sans en être le
// destinataire (chez Codex il démarre avec une copie de la conversation du parent, mesuré le 2026-10-02).
const POUR_ORCHESTRATEUR = 'Pour l\'orchestrateur seulement (un sous-agent qui lit ceci s\'en tient à sa mission).';
const LIGNE_ABSENTE = '(pas encore de ligne)';
const MAX_MISSION_REPRISE = 4500;
const MAX_NOTES_REPRISE = 2500;

function idSur(id) { return chaine(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80); }
function cheminIndexFiche(agent, id) { return path.join(racine(), '.fiches', `${agent}-${idSur(id)}.json`); }

function lireIndexFiche(agent, id) {
  validerAgent(agent);
  const cle = idSur(id);
  if (!cle) return null;
  const t = lireTexte(cheminIndexFiche(agent, cle));
  if (t === null) return null;
  try { const o = JSON.parse(sansBom(t)); return estObjet(o) ? o : null; } catch (_) { return null; }
}

function ecrireIndexFiche(agent, id, index) {
  ecrireAtomique(cheminIndexFiche(agent, id), JSON.stringify(index, null, 1) + '\n');
}

// Branche et SHA du dossier de départ (un seul appel git, borné : sous forte charge, la fiche s'en passe).
function etatGitCourt(cwd) {
  if (!cwd) return '';
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h%x00%D'], {
      cwd, encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const [sha, refs] = out.trim().split('\0');
    if (!sha) return '';
    return `branche ${(/HEAD -> ([^,]+)/.exec(refs || '') || [])[1] || 'HEAD détaché'}, SHA de départ ${sha}`;
  } catch (_) { return ''; }
}

// Crée la fiche d'un sous-agent, ou la complète quand la mission ou la ligne de suivi arrivent après coup
// (les deux événements, démarrage du sous-agent et retour de l'outil de lancement, n'ont pas d'ordre garanti).
// titreRepli : titre fabriqué faute de mieux (« sous-agent general-purpose ») ; le vrai titre, quand il arrive,
// le remplace dans l'index et en tête de la fiche (mesuré le 2026-10-03 : il y restait). Retourne le chemin.
const titreDeFiche = t => chaine(t).replace(/\s+/g, ' ') || 'sans titre';

function creerFiche({ agent, sessionId, id, projet, ligne, titre, titreRepli, genre, mission, cwd }) {
  validerAgent(agent);
  const cle = idSur(id);
  if (!cle) return null;
  return reessayer(() => avecVerrou(cheminIndexFiche(agent, cle), () => {
    let index = lireIndexFiche(agent, cle);
    if (!index) {
      validerProjet(projet);
      const nom = `${idSur(genre) || 'agent'}-${cle.slice(-12)}.md`;
      index = {
        id: cle, agent, projet, ligne: null, session: sessionId || null, titre: chaine(titre), genre: chaine(genre),
        fiche: path.join(chemins(projet, agent).textes, 'fiches', nom), cree: maintenantIso(), mission: false, notes: 0,
      };
      if (titreRepli) index.titreRepli = true;
      const git = etatGitCourt(cwd);
      // « Fiche créée le » : la fiche peut naître en cours de route (premier outil, compactage), pas au lancement.
      const entete = [
        `# Fiche du sous-agent « ${titreDeFiche(titre)} »`,
        '',
        `- ID de travail : ${cle} (${chaine(genre) || 'agent'})`,
        `- Orchestrateur : ${agent}, session ${sessionId || 'inconnue'}, projet ${projet}`,
        `- Ligne de suivi dans la liste de l'orchestrateur : ${LIGNE_ABSENTE}`,
        `- Fiche créée le ${dateLocale()}${cwd ? ` dans ${cwd}` : ''}${git ? ` (${git})` : ''}`,
        '',
        '## Mission (mot pour mot)',
        '',
        MISSION_ABSENTE,
        '',
        '## Notes du sous-agent (ajoutées par lui, dans l\'ordre)',
        '',
      ].join('\n');
      ecrireAtomique(index.fiche, entete); // ancre-mutation:fiche-creation
    }
    const completer = (marque, valeur) => {
      const t = lireTexte(index.fiche);
      if (t === null || !t.includes(marque)) return false;
      ecrireAtomique(index.fiche, t.replace(marque, () => valeur));
      return true;
    };
    const texteMission = chaine(mission).trim();
    if (texteMission && !index.mission && completer(MISSION_ABSENTE, texteMission)) index.mission = true; // ancre-mutation:fiche-mission
    if (ligne && !index.ligne && completer(LIGNE_ABSENTE, `${ligne} (lecture seule pour le sous-agent)`)) index.ligne = ligne;
    if (titre && !titreRepli && index.titreRepli && chaine(titre) !== index.titre) {
      // Vrai titre arrivé après un titre de repli : remplacé en tête de la fiche, puis dans l'index.
      if (completer(`# Fiche du sous-agent « ${titreDeFiche(index.titre)} »`, `# Fiche du sous-agent « ${titreDeFiche(titre)} »`)) { // ancre-mutation:fiche-titre
        index.titre = chaine(titre);
        delete index.titreRepli;
      }
    } else if (titre && !index.titre) index.titre = chaine(titre);
    ecrireIndexFiche(agent, cle, index);
    return index.fiche;
  }));
}

function lireFiche(agent, id) {
  const index = lireIndexFiche(agent, id);
  if (!index) return null;
  const texte = lireTexte(index.fiche);
  return texte === null ? null : { index, texte };
}

// Note ajoutée par le sous-agent à SA fiche (jamais réécrite, jamais coupée). genre = mission : remplit la
// mission si elle n'a pas pu être copiée par le hook ; sinon la note s'ajoute, datée, à la suite.
function noterFiche({ agent, id, genre, texte }) {
  validerAgent(agent);
  const cle = idSur(id);
  if (!cle || !lireIndexFiche(agent, cle)) throw new Error(`aucune fiche pour le sous-agent ${chaine(id) || '(id manquant)'} (agent ${agent})`);
  const t = chaine(texte).trim();
  if (!t) throw new Error('note vide : donne le texte à noter');
  // Genre sans accents ni majuscules : « Déjà-fait », « deja fait » et « deja-fait » sont le même genre.
  const g = chaine(genre).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
  return reessayer(() => avecVerrou(cheminIndexFiche(agent, cle), () => {
    const index = lireIndexFiche(agent, cle);
    if (g === 'mission' && !index.mission) {
      const contenu = lireTexte(index.fiche);
      if (contenu !== null && contenu.includes(MISSION_ABSENTE)) {
        ecrireAtomique(index.fiche, contenu.replace(MISSION_ABSENTE, () => t));
        index.mission = true;
        ecrireIndexFiche(agent, cle, index);
        return { fiche: index.fiche, notes: index.notes || 0, mission: true };
      }
    }
    const etiquette = g === 'mission' ? 'complément de mission' : g;
    ajouterAuFichier(index.fiche, `- ${dateLocale()}${etiquette ? ` | ${etiquette}` : ''} | ${t.replace(/\r?\n/g, '\n  ')}\n`); // ancre-mutation:fiche-note
    index.notes = (index.notes || 0) + 1;
    index.derniereNote = maintenantIso();
    // Signalement : dit à l'orchestrateur dès son prochain événement (texteSignalements).
    if (GENRES_SIGNALEMENT.has(g)) {
      index.signalements = (Array.isArray(index.signalements) ? index.signalements : [])
        .concat({ le: index.derniereNote, genre: g, texte: t.replace(/\s+/g, ' ').slice(0, 400) }).slice(-50);
    }
    ecrireIndexFiche(agent, cle, index);
    return { fiche: index.fiche, notes: index.notes, mission: !!index.mission, signale: GENRES_SIGNALEMENT.has(g) };
  }));
}

function commandeNote(script, id, suite) { return `node "${chaine(script).replace(/\\/g, '/')}" note --fiche ${id} ${suite}`; }

// Lecture seule de la liste de l'orchestrateur : dit au sous-agent comment la lire, et ce qui lui est fermé.
function texteLectureSeule(script, projet) {
  const s = `node "${chaine(script).replace(/\\/g, '/')}"`;
  return `La liste de travail de l'orchestrateur se lit (Read, Get-Content, ou \`${s} chercher${projet ? ` --projet ${projet}` : ''} "mot"\` ; un identifiant, chercher C-0151 C-0152, rend ces lignes entières ; --agent claude ou --agent codex pour la liste d'un autre agent), elle ne se modifie pas : ajouter, etat, sans-travail et abandon lui sont réservés.`;
}

// Le sous-agent ne dévie pas : ce qu'il a hérité de l'orchestrateur ou ce
// qu'il lit dans sa liste ne lui donne aucun travail.
const NE_DEVIE_PAS = 'Ta mission est celle de ton lancement, rien d\'autre : les messages de l\'utilisateur, les « À trier » et les lignes ouvertes que tu as pu hériter de l\'orchestrateur ou lire dans sa liste s\'adressent à lui, ils ne te donnent aucun travail.';

// La mission prime sur la fiche. Constaté le 2026-10-07 dans Codex : dix sous-agents avaient pour mission de
// n'écrire que dans un dossier ; la consigne (« commence par la recopier ») leur a fait écrire leur mission
// dans leur fiche avant même de lire leur brief, deux l'ont signalé comme une écriture hors périmètre et
// l'orchestrateur a arrêté les dix. Depuis : lire la mission d'abord, et ne rien écrire dans la fiche quand
// elle interdit expressément toute écriture ailleurs (la fiche reste alors vide, le sous-agent le dit dans
// son rapport). Une mission qui attribue des fichiers ou qui interdit de modifier le dépôt (audit en lecture
// seule) n'interdit pas la fiche : sans cette précision, presque aucun sous-agent n'y noterait plus rien.
const RESERVE_FICHE = 'Lis d\'abord ta mission. Ta fiche est un carnet de suivi, hors de ton travail : une mission qui t\'attribue des fichiers, ou qui t\'interdit de modifier le dépôt (lecture seule), ne t\'interdit pas d\'y noter. Mais si elle t\'interdit expressément toute écriture ailleurs que dans ses livrables (« n\'écris nulle part ailleurs »), elle prime : n\'écris rien dans cette fiche, ni mission, ni note, ni signalement, et dis-le dans ton rapport.';
const SAUF_INTERDIT = 'sauf si ta mission t\'interdit expressément toute écriture ailleurs que dans ses livrables';

// Consigne donnée au sous-agent à son démarrage.
function texteConsigneSousAgent({ agent, id, script }) {
  const index = lireIndexFiche(agent, id);
  if (!index) return `Fichier contexte : tu es un sous-agent. ${NE_DEVIE_PAS} ${texteLectureSeule(script, null)} Rends ton résultat à l'orchestrateur, il mettra la liste à jour.`;
  const mission = index.mission ? 'Elle contient ta mission, mot pour mot.' : 'Ta mission n\'a pas pu y être copiée automatiquement.';
  const recopier = index.mission ? '' : ` recopie ta mission mot pour mot avec \`${commandeNote(script, index.id, '--genre mission "..."')}\`, puis`;
  return [
    `Fichier contexte : tu es un sous-agent${index.ligne ? ` (ligne ${index.ligne} de l'orchestrateur)` : ''}. Ta fiche : ${index.fiche}. ${mission}`,
    NE_DEVIE_PAS, // ancre-mutation:consigne-ne-devie-pas
    `${RESERVE_FICHE} Sinon,${recopier} note dans ta fiche ton avancement et ce que tu trouves, au fil du travail, pour ne rien perdre si ton contexte est compacté : \`${commandeNote(script, index.id, '"fait : ... ; reste : ... ; à inscrire : ..."')}\`. Après un compactage, c'est ta fiche qui fait foi, pas le résumé.`, // ancre-mutation:consigne-reserve
    `${texteLectureSeule(script, index.projet)} Dans cette liste, ${OUVERT_NEST_PAS_PAS_FAIT} Si tu constates qu'une ligne est déjà faite, tu ne la fermes pas : signale-le avec \`${commandeNote(script, index.id, '--genre deja-fait "C-NNNN : la preuve"')}\`, l'orchestrateur vérifiera. Même commande avec --genre bloque ou --genre question quand tu attends quelque chose de lui.`,
  ].join('\n');
}

// La consigne n'est donnée qu'une fois. Mesuré le 2026-10-02 dans Codex : celle du démarrage (SubagentStart)
// n'est arrivée qu'à 2 sous-agents sur 22 (hook de démarrage tué par son délai, ou jamais déclenché). Filet :
// tant qu'elle n'est pas marquée donnée, le premier événement du sous-agent qui peut injecter la donne.
// Second filet (constaté le 2026-10-02 : hook de démarrage tué par Codex APRÈS avoir posé sa marque, sortie
// jetée) : avec `fichier` (transcript du sous-agent), une marque posée mais jamais vérifiée fait
// chercher la consigne dans la fin du transcript, une seule fois ; absente, elle est redonnée, une seule fois.
// Une ligne compte si elle contient le début de la consigne, la commande note sur SA fiche et l'une des
// `formes` (ligne injectée par un hook : le brief peut citer la même phrase, mesuré chez Claude). Mesuré dans
// 9 rollouts Codex : consigne écrite 12 à 30 Ko avant la fin du premier résultat d'outil, 11 à 26 s avant le
// premier PostToolUse. Le transcript est lu en entier (64 derniers Mo au plus) : un sous-agent déjà avancé
// quand ce filet est installé a un rollout de 20 à 40 Mo, où sa consigne est loin de la fin. Retourne vrai si
// c'est à cet appel de la donner. Une fiche déjà rendue après un compactage vaut consigne. Verrou occupé :
// faux, la question sera reposée au prochain événement.
const DEBUT_CONSIGNE = 'Fichier contexte : tu es un sous-agent';
const QUEUE_CONSIGNE = 64 * 1024 * 1024;

function consigneDansTranscript(fichier, id, formes) {
  let taille;
  try { taille = fs.statSync(lp(fichier)).size; } catch (_) { return false; }
  // Suivi d'une espace : « --fiche th-1 » ne doit pas se trouver dans « --fiche th-11 ».
  const motif = `--fiche ${idSur(id)} `;
  let vue = false;
  try {
    lireLignesDepuis(fichier, Math.max(0, taille - QUEUE_CONSIGNE), taille, ligne => {
      if (vue || !ligne.includes(DEBUT_CONSIGNE) || !ligne.includes(motif)) return;
      if (!(formes || []).length || formes.some(f => ligne.includes(f))) vue = true; // ancre-mutation:consigne-vue
    });
  } catch (_) { return false; }
  return vue;
}

function consigneADonner({ agent, id, fichier, formes }) {
  const cle = idSur(id);
  const index = cle ? lireIndexFiche(agent, cle) : null;
  if (!index || index.reprises) return false;
  const verifier = !!fichier && !!index.consigneLe && !index.consigneVerifieeLe;
  if (index.consigneLe && !verifier) return false;
  // Lecture du transcript hors verrou ; le résultat n'est appliqué que si l'index n'a pas changé entre-temps.
  const vue = verifier ? consigneDansTranscript(fichier, cle, formes) : false;
  try {
    return !!reessayer(() => avecVerrou(cheminIndexFiche(agent, cle), () => {
      const cour = lireIndexFiche(agent, cle);
      if (!cour || cour.reprises) return false;
      if (!cour.consigneLe) {
        cour.consigneLe = maintenantIso();
        ecrireIndexFiche(agent, cle, cour);
        return true;
      }
      if (!verifier || cour.consigneVerifieeLe) return false;
      cour.consigneVerifieeLe = maintenantIso();
      cour.consigneVue = vue;
      ecrireIndexFiche(agent, cle, cour);
      return !vue; // ancre-mutation:consigne-redonnee
    }));
  } catch (_) { return false; }
}

// Fiche rendue au sous-agent après un compactage de SON contexte. Bornée : la mission par son début, les
// notes par leur fin (les plus récentes) ; toute coupe est dite, avec le chemin du texte entier.
function texteRepriseSousAgent({ agent, id, script }) {
  const f = lireFiche(agent, id);
  if (!f) return '';
  const t = f.texte;
  const iM = t.indexOf('## Mission');
  const iN = t.indexOf('## Notes du sous-agent');
  const entete = (iM >= 0 ? t.slice(0, iM) : '').trim();
  const mission = (iM >= 0 ? t.slice(iM, iN >= 0 ? iN : undefined) : t).trim();
  const notes = (iN >= 0 ? t.slice(iN) : '').trim();
  const m = mission.length > MAX_MISSION_REPRISE ? `${mission.slice(0, MAX_MISSION_REPRISE)} […]` : mission;
  const n = notes.length > MAX_NOTES_REPRISE ? `## Notes du sous-agent (les plus récentes)\n[…] ${notes.slice(notes.length - MAX_NOTES_REPRISE)}` : notes;
  const coupe = m !== mission || n !== notes;
  // Mission absente (Codex la chiffre) : la reprendre du brief en fichier quand l'orchestrateur en a donné un,
  // et le dire dans le rapport. « Redemande-la avant de continuer » n'a été suivi par aucun sous-agent.
  // Même réserve qu'au démarrage : rien ne s'écrit dans la fiche quand la mission l'interdit.
  const sansMission = f.index.mission ? '' : ` Ta mission n'y a pas été copiée : reprends-la de ton brief en fichier si l'orchestrateur t'en a donné un (sinon du résumé) et dis dans ton rapport qu'elle a été reprise ainsi ; recopie-la dans ta fiche (note --genre mission) ${SAUF_INTERDIT}.`; // ancre-mutation:reprise-sans-mission
  // La fiche porte la mission du lancement. Constaté le 2026-10-07 : des sous-agents relancés deux fois
  // recevaient après chaque compactage la mission du premier lancement, avec un nom de livrable périmé.
  const relance = ' Si l\'orchestrateur t\'a relancé depuis avec une nouvelle tâche, c\'est cette tâche qui vaut.'; // ancre-mutation:reprise-relance
  return [
    `Fichier contexte : ton contexte de sous-agent vient d'être compacté. Voici ta fiche (${f.index.fiche}) : c'est elle qui fait foi pour ta mission et ton avancement, pas le résumé de compactage.${relance}${coupe ? ' Elle est coupée ici : relis le fichier entier avant de continuer.' : ''}${sansMission}`,
    entete, m, n,
    `Continue à y noter ton avancement, ${SAUF_INTERDIT} : \`${commandeNote(script, f.index.id, '"..."')}\`. ${NE_DEVIE_PAS} ${texteLectureSeule(script, f.index.projet)}`, // ancre-mutation:reprise-reserve
  ].filter(Boolean).join('\n\n');
}

// Vrai si la fiche doit être rendue au sous-agent : son transcript contient un compactage écrit depuis le
// dernier passage (octet gardé dans l'index de sa fiche), ou l'événement lui-même l'annonce (annonce = true).
// Premier passage sur le transcript : sert de base, rien n'est rejoué. Le motif est cherché au début de la
// ligne seulement : un résultat d'outil qui cite le motif ne compte pas. Un même compactage peut être vu
// deux fois (par l'événement, puis dans le transcript, écrit juste après) : une seule reprise par fenêtre.
const FENETRE_REPRISE_MS = 300000;
// L'octet déjà vu n'avance que par paliers (ou quand un compactage est trouvé) : relire quelques centaines
// de kilooctets coûte moins qu'une écriture sous verrou à chaque outil du sous-agent. Mesuré le 2026-10-02
// dans Codex : avec une écriture par outil, le hook d'un sous-agent passait de 250 à 530 ms.
const PALIER_TRANSCRIPT = 1048576;

// L'événement de compactage lui-même (PostCompact, quand il porte l'identité du sous-agent : mesuré dans
// Codex 0.155) : la fiche sera rendue à son prochain outil, même si son transcript n'est pas lisible.
function noterCompactage({ agent, id }) {
  const cle = idSur(id);
  if (!cle || !lireIndexFiche(agent, cle)) return false;
  try {
    reessayer(() => avecVerrou(cheminIndexFiche(agent, cle), () => {
      const cour = lireIndexFiche(agent, cle);
      if (!cour) return;
      cour.compactageLe = maintenantIso();
      ecrireIndexFiche(agent, cle, cour);
    }));
    return true;
  } catch (_) { return false; }
}

function compactageDuSousAgent({ agent, id, fichier, motifs, annonce }) {
  const cle = idSur(id);
  const index = cle ? lireIndexFiche(agent, cle) : null;
  if (!index) return false;
  // Compactage annoncé par son événement et pas encore suivi d'une reprise.
  if (index.compactageLe && index.compactageLe > chaine(index.repriseLe)) annonce = true; // ancre-mutation:fiche-annonce-par-evenement
  let taille = -1;
  if (fichier && typeof fichier === 'string') { try { taille = fs.statSync(lp(fichier)).size; } catch (_) { taille = -1; } }
  const meme = taille >= 0 && index.transcriptFichier === normChemin(fichier);
  const vu = meme && Number.isFinite(index.transcriptVu) && index.transcriptVu <= taille ? index.transcriptVu : null;
  let trouve = false;
  let fin = taille;
  if (vu !== null && vu < taille) {
    fin = lireLignesDepuis(fichier, vu, taille, ligne => {
      if (trouve) return;
      const debut = ligne.subarray(0, 400);
      if ((motifs || []).some(m => debut.includes(m))) trouve = true; // ancre-mutation:fiche-compactage
    });
  }
  const recent = Date.now() - (Date.parse(index.repriseLe || '') || 0) < FENETRE_REPRISE_MS;
  const rendre = (trouve || !!annonce) && !recent; // ancre-mutation:fiche-reprise-unique
  // Rien à retenir : pas de reprise, pas de compactage vu, et l'octet n'a pas avancé d'un palier.
  const avancer = taille >= 0 && (vu === null || trouve || fin - vu >= PALIER_TRANSCRIPT);
  if (!rendre && !avancer) return false;
  try {
    reessayer(() => avecVerrou(cheminIndexFiche(agent, cle), () => {
      const cour = lireIndexFiche(agent, cle);
      if (!cour) return;
      if (avancer) { cour.transcriptVu = fin; cour.transcriptFichier = normChemin(fichier); }
      if (rendre) { cour.repriseLe = maintenantIso(); cour.reprises = (cour.reprises || 0) + 1; }
      ecrireIndexFiche(agent, cle, cour);
    }));
  } catch (_) { /* relu au prochain passage : au pire la reprise est redite */ }
  return rendre;
}

// ---------------------------------------------------------------------------
// Preuves

function texteHorsExemples(texte) {
  let bloc = null;
  return chaine(texte).split(/\r?\n/).map(l => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (!bloc) bloc = { car: fence[1][0], taille: fence[1].length };
      else if (fence[1][0] === bloc.car && fence[1].length >= bloc.taille && !l.slice(fence[0].length).trim()) bloc = null;
      return '';
    }
    if (bloc || /^\s*>/.test(l) || /\bexemple\s*:/i.test(l)) return '';
    return l;
  }).join('\n');
}

function extraireMarqueurs(texte) {
  const out = [];
  const t = texteHorsExemples(texte);
  RE_MARQUEUR.lastIndex = 0;
  let m;
  while ((m = RE_MARQUEUR.exec(t))) {
    const partiel = !!m[2];
    const debut = t.lastIndexOf('\n', m.index) + 1;
    const fin = t.indexOf('\n', m.index);
    const ligne = t.slice(debut, fin < 0 ? t.length : fin);
    if (!partiel && /\b(?:non[ -](?:termin[eé]|v[eé]rifi[eé]|trait[eé]|fait)s?|pas (?:fait|fini|termin[eé])|en[ -]cours|[aà] (?:faire|v[eé]rifier|traiter))\b/i.test(ligne)) continue;
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
  return chronometrer('preuves_ms', () => reconcilierChronometre({ agent, base }));
}

function reconcilierChronometre({ agent, base }) {
  validerAgent(agent);
  const b = base || config.maison();
  const fEtat = path.join(racine(), `.reconciliation-${agent}.json`);
  const parFichier = avecVerrou(fEtat, () => {
    let st = null;
    try { const t = lireTexte(fEtat); st = t ? JSON.parse(sansBom(t)) : null; } catch (_) { st = null; }
    const premierPassage = !st;
    const s = st || { fichiers: {} };
    s.fichiers = s.fichiers || {};
    s.attente = Array.isArray(s.attente) ? s.attente : [];
    for (const f of listerFichiersPreuve(b)) {
      let stat;
      try { stat = fs.statSync(lp(f)); } catch (_) { continue; }
      const cle = normChemin(f);
      const prec = s.fichiers[cle];
      if (prec && prec.mtimeMs === stat.mtimeMs && prec.taille === stat.size) continue;
      const texte = lireTexte(f);
      if (texte === null) continue;
      const lignes = texteHorsExemples(texte).split(/\r?\n/).filter(l => /\[ctx\s/i.test(l));
      const hashes = lignes.map(hashCourt);
      if (!premierPassage) {
        const anciens = new Set(prec ? prec.hashes : []);
        const marqueurs = [];
        lignes.forEach((l, i) => { if (!anciens.has(hashes[i])) marqueurs.push(...extraireMarqueurs(l)); });
        if (marqueurs.length) {
          const clePreuve = hashCourt(JSON.stringify([cle, hashes, marqueurs]));
          if (!s.attente.some(p => p.cle === clePreuve)) s.attente.push({ cle: clePreuve, fichier: f, marqueurs });
        }
      }
      s.fichiers[cle] = { mtimeMs: stat.mtimeMs, taille: stat.size, hashes: [...new Set(hashes)] };
    }
    s.maj = maintenantIso();
    ecrireAtomique(fEtat, JSON.stringify(s) + '\n');
    // Le curseur et la file sont ecrits ensemble AVANT l'application.
    // Une interruption conserve donc les preuves a rejouer.
    return s.attente.slice();
  });
  const total = { faits: [], partiels: [], ignores: [], projets: [] };
  for (const { cle, fichier, marqueurs } of parFichier) {
    const r = appliquerPreuves({ agent, marqueurs, preuve: `fichier ${fichier}` });
    for (const k of Object.keys(total)) total[k].push(...r[k].filter(x => !total[k].includes(x)));
    avecVerrou(fEtat, () => {
      const s = JSON.parse(sansBom(lireTexte(fEtat)));
      s.attente = (s.attente || []).filter(p => p.cle !== cle);
      ecrireAtomique(fEtat, JSON.stringify(s) + '\n');
    });
  }
  return total;
}

// Initialisation hors du budget du hook ; ensuite seuls les fichiers modifies sont relus.
function reconcilierDansHook({ agent, base }) {
  const f = path.join(racine(), `.reconciliation-${agent}.json`);
  if (fs.existsSync(lp(f))) return reconcilier({ agent, base });
  const marqueur = f + '.base-en-cours';
  fs.mkdirSync(lp(path.dirname(f)), { recursive: true });
  try { fs.closeSync(fs.openSync(lp(marqueur), 'wx')); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (Date.now() - fs.statSync(lp(marqueur)).mtimeMs < 120000) return { faits: [], partiels: [], ignores: [], projets: [] };
    fs.unlinkSync(lp(marqueur));
    try { fs.closeSync(fs.openSync(lp(marqueur), 'wx')); } catch (_) { return { faits: [], partiels: [], ignores: [], projets: [] }; }
  }
  const code = `try { require(${JSON.stringify(__filename)}).reconcilier(${JSON.stringify({ agent, base })}); } finally { try { require('fs').unlinkSync(${JSON.stringify(marqueur)}); } catch (_) {} }`;
  const enfant = require('child_process').spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  enfant.on('error', () => { try { fs.unlinkSync(lp(marqueur)); } catch (_) { /* prochain evenement */ } });
  enfant.unref();
  return { faits: [], partiels: [], ignores: [], projets: [] };
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

// Appel de la CLI par un sous-agent : lecture (lister, chercher, fiche) ou note sur SA fiche, rien d'autre.
function cliPermiseAuSousAgent(seg, agentId) {
  const m = RE_CLI_SEGMENT.exec(seg);
  if (!m) return false;
  const suite = seg.slice(m[0].length).trim();
  const commande = (/^["']?([a-z-]+)["']?(?=\s|$)/i.exec(suite) || [])[1];
  if (!commande) return false;
  if (CLI_SOUS_AGENT.has(commande.toLowerCase())) return true;
  if (commande.toLowerCase() !== 'note' || !agentId) return false;
  const fiche = (/(?:^|\s)--fiche(?:=|\s+)["']?([A-Za-z0-9_-]+)["']?(?=\s|$)/.exec(suite) || [])[1];
  return fiche === agentId; // ancre-mutation:note-propre-fiche
}

// sousAgent : { agentId } quand l'appelant est un sous-agent (CLI restreinte), sinon rien.
// opts : { masque : le même segment, chaînes vidées ; pipeline : vrai s'il reçoit la sortie d'un | }.
function segmentAutorise(seg, sousAgent, opts) {
  const o = opts || {};
  const s = seg.replace(/^[&\s]+/, '');
  if (!s) return true;
  if (RE_CLI_SEGMENT.test(s)) return sousAgent ? cliPermiseAuSousAgent(s, sousAgent.agentId) : true; // ancre-mutation:cli-sous-agent
  if (RE_AFFECTATION_LITTERALE.test(s)) return true;
  // Sous-expression de lecture seule, avec son accès ((Get-Content x).Count). Après l'opérateur d'appel &,
  // elle est refusée avant d'arriver ici (commandeLectureOuCli).
  if (RE_SEGMENT_SOUS_EXPRESSION.test(s)) return true;
  // Bloc sans effet en fin de pipeline (ForEach-Object { $_.Line }, Where-Object { $_.Name -like 'C-*' }) ou
  // Where-Object sans bloc : rien d'autre. ForEach-Object suivi d'un nom (-MemberName) appellerait une méthode.
  if (RE_SEGMENT_BLOC.test(s) || RE_SEGMENT_FILTRE.test(s)) return true;
  // Premier mot : programme nommé entre guillemets (chemin avec espaces : & 'C:\Program Files\Git\usr\bin\wc.exe').
  const m = s.match(/^(?:"([^"]+)"|'([^']+)'|([^\s"']+))/);
  if (!m) return false;
  let tok = (m[1] || m[2] || m[3]).replace(/\\/g, '/');
  tok = tok.slice(tok.lastIndexOf('/') + 1).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (tok === 'rg' && /(?:^|\s)--pre(?:=|\s|$)/i.test(s)) return false; // rg --pre exécute une commande par fichier
  if (!LECTURE.has(tok)) return false;
  // Variable ou sous-expression en argument : refusée après un | (liaison différée : un bloc qu'elle porterait
  // serait exécuté pour chaque objet reçu) et dans les fins de pipeline qui exécutent des blocs.
  if (o.pipeline || PIPELINE_A_BLOC.has(tok)) {
    const masque = typeof o.masque === 'string' ? o.masque.slice(seg.length - s.length) : s;
    const args = masque.slice(m[0].length).replace(/\$(?:null|true|false)\b/gi, '');
    if (args.includes('$') || args.includes(MARQUE_SOUS_EXPRESSION)) return false; // ancre-mutation:variable-pipeline
  }
  return true;
}

// Chaînes entre guillemets vidées (espaces), position par position : les index restent ceux de la commande,
// caractères hors du plan de base compris (maskQuotedSegments compte par points de code, ce qui décalait les
// segments). '' dans une chaîne simple y reste (apostrophe PowerShell ; en bash, fin et reprise de la chaîne).
function masquerChaines(c) {
  const masque = c.split(''); // ancre-mutation:masque-utf16
  let guillemet = '';
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (!guillemet) { if (ch === '"' || ch === '\'') guillemet = ch; continue; }
    if (ch === guillemet) {
      if (guillemet === '\'' && c[i + 1] === '\'') { masque[i] = ' '; masque[i + 1] = ' '; i++; continue; }
      let barres = 0;
      for (let j = i - 1; j >= 0 && c[j] === '\\'; j--) barres++;
      if (!(guillemet === '"' && (barres % 2 === 1 || c[i - 1] === '`'))) { guillemet = ''; continue; }
    }
    masque[i] = ' ';
  }
  return masque.join('');
}

// Ce que PowerShell lit autrement que masquerChaines (vérifié avec son analyseur, version 7.6, sans rien
// exécuter) : un guillemet typographique ouvre et ferme une chaîne comme son équivalent droit, et un commentaire
// peut porter une apostrophe qui, ici, ouvrirait une chaîne et cacherait la ligne suivante. Vrai si la commande
// porte l'une de ces formes. Tolérés, parce que sans effet dans les deux lectures : l'apostrophe typographique
// dans une chaîne entre guillemets doubles (le texte français d'une note), le guillemet double typographique
// dans une chaîne simple.
function lectureAmbigue(c) {
  let guillemet = '';
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (!guillemet) {
      if (ch === '"' || ch === '\'') guillemet = ch;
      else if (ch === '#' || RE_GUILLEMET_TYPOGRAPHIQUE.test(ch)) return true;
      continue;
    }
    if (ch === guillemet) {
      if (guillemet === '\'' && c[i + 1] === '\'') { i++; continue; }
      let barres = 0;
      for (let j = i - 1; j >= 0 && c[j] === '\\'; j--) barres++;
      if (!(guillemet === '"' && (barres % 2 === 1 || c[i - 1] === '`'))) guillemet = '';
      continue;
    }
    if (guillemet === '\'' ? RE_APOSTROPHE_TYPOGRAPHIQUE.test(ch) : RE_GUILLEMET_DOUBLE_TYPOGRAPHIQUE.test(ch)) return true;
  }
  return false;
}

// Sous-expressions dont le contenu est une lecture, de l'intérieur vers l'extérieur : remplacées par la marque
// dans la commande et dans son masque. Une parenthèse collée à ce qui la précède (nom de méthode ou de
// fonction, point, $, &) n'est jamais remplacée.
function marquerSousExpressions(c, masque, sousAgent, profondeur) {
  for (let tour = 0; tour < MAX_SOUS_EXPRESSIONS; tour++) {
    const avantTour = masque;
    let change = false;
    masque = avantTour.replace(/\(([^()]*)\)/g, (x, interieur, pos) => {
      if (pos > 0 && !/[\s(,@<]/.test(avantTour[pos - 1])) return x; // ancre-mutation:sous-expression-collee
      const contenu = c.slice(pos + 1, pos + x.length - 1);
      if (!/\S/.test(contenu) || !commandeLectureOuCli(contenu, sousAgent, profondeur + 1)) return x;
      change = true;
      const marque = MARQUE_SOUS_EXPRESSION.repeat(x.length);
      c = c.slice(0, pos) + marque + c.slice(pos + x.length);
      return marque;
    });
    if (!change) break;
  }
  return { c, masque };
}

// Segments d'une commande (séparés par && || ; | fin de ligne, et & seul), guillemets respectés.
function segmentsDe(c) {
  const masque = masquerChaines(c);
  const reSep = /&&|\|\||[;|\r\n]|(?<![<>])&(?![&>])/g;
  const out = [];
  let debut = 0;
  let m;
  while ((m = reSep.exec(masque))) { out.push(c.slice(debut, m.index).trim()); debut = m.index + m[0].length; }
  out.push(c.slice(debut).trim());
  return out.filter(Boolean);
}

// Commande d'un sous-agent qui appelle la CLI SANS viser la racine : seuls ses appels à la CLI sont
// contrôlés (le reste de sa commande est libre). Un appel qui n'est pas un segment propre (node -e,
// require du noyau, substitution) n'est pas vérifiable : refus.
function cliSeuleDuSousAgent(cmd, agentId) {
  const c = chaine(cmd);
  if (/\$\(|`/.test(c)) return false;
  if (lectureAmbigue(c)) return false; // ancre-mutation:cli-ambigue
  const appels = segmentsDe(c).map(s => s.replace(/^[&\s]+/, '')).filter(s => appelleCli(s));
  return appels.length > 0 && appels.every(s => RE_CLI_SEGMENT.test(s) && cliPermiseAuSousAgent(s, agentId));
}

// Vrai si la commande ne fait que lire (ou appeler la CLI context-ledger). profondeur : contenu d'une
// sous-expression (appel récursif), où la marque des sous-expressions intérieures est légitime.
function commandeLectureOuCli(cmd, sousAgent, profondeur) {
  const niveau = profondeur || 0;
  let c = chaine(cmd);
  if (/\$\(|`/.test(c)) return false; // substitution de commande : pas analysable, refus
  if (!niveau && c.includes(MARQUE_SOUS_EXPRESSION)) return false;
  if (!niveau && lectureAmbigue(c)) return false; // ancre-mutation:lecture-ambigue
  // Blocs sans effet ({ $_.Line }, format, filtre) neutralisés à longueur égale : les positions restent valables.
  let masque = masquerChaines(c).replace(RE_BLOC_SUR, x => ' '.repeat(x.length)); // ancre-mutation:blocs-surs
  ({ c, masque } = marquerSousExpressions(c, masque, sousAgent, niveau));
  // Parenthèses et accolades restantes hors guillemets : substitution de processus <( ) d'une écriture,
  // méthode (Get-Item x).Delete(), Test-Path ([IO.File]::Delete(..)), boucle, bloc { } : refus.
  if (/[(){}]/.test(masque)) return false;
  const reRedir = /(?:\d|&)?>{1,2}\s*(&\d|[^\s;|&<>]*)/g;
  let m;
  while ((m = reRedir.exec(masque))) {
    if (!/^(\/dev\/null|\$null|nul|&\d)$/i.test(m[1])) return false;
  }
  // Séparateurs : && || ; | fin de ligne, et & seul (arrière-plan bash, opérateur d'appel PowerShell),
  // sauf dans une redirection (2>&1, &>). Chaque segment garde le séparateur qui le précède.
  const reSep = /&&|\|\||[;|\r\n]|(?<![<>])&(?![&>])/g;
  let debut = 0;
  let sep = '';
  const bornes = [];
  while ((m = reSep.exec(masque))) { bornes.push([debut, m.index, sep]); debut = m.index + m[0].length; sep = m[0]; }
  bornes.push([debut, c.length, sep]);
  for (const [a, b, avant] of bornes) {
    const brut = c.slice(a, b);
    const g = brut.length - brut.trimStart().length;
    const d = brut.length - brut.trimEnd().length;
    const seg = brut.trim();
    if (!seg) continue;
    if (avant === '&' && seg.startsWith(MARQUE_SOUS_EXPRESSION)) return false; // ancre-mutation:sous-expression-appel (& (x) exécute ce que x nomme)
    if (!segmentAutorise(seg, sousAgent, { masque: masque.slice(a + g, b - d), pipeline: avant === '|' })) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Écriture d'un texte LITTÉRAL dans un fichier hors de la racine (le rapport d'un sous-agent), quand ce texte
// cite la racine ou la commande context-ledger. Constat réel du 2026-10-07 : 6 écritures refusées chez 5
// sous-agents qui écrivaient LEUR rapport ; chacun y a perdu un tour et trois ont écrit à l'orchestrateur.
// Seule forme prouvée : un here-string PowerShell littéral (@' ... '@ : rien n'y est développé ni exécuté)
// donné tel quel à Set-Content, Add-Content ou Out-File, vers un fichier de texte nommé en toutes lettres
// hors de la racine ; tout le reste de la commande est une lecture. En bash les mêmes caractères seraient
// du code : l'appelant doit savoir que la commande part dans PowerShell.

// Here-string littéral de la commande : { debut, fin } (délimiteurs compris). null s'il n'y en a pas
// exactement un, s'il n'est pas fermé, ou si la commande porte un here-string développé (@" "@).
function hereStringLitteral(c) {
  const reEntete = /@(['"])[ \t]*(?:\r\n|\n|\r)/y;
  // La fermeture commence une ligne. PowerShell prend aussi une apostrophe typographique pour une apostrophe,
  // et un retour chariot seul pour une fin de ligne : le texte s'arrête là où il s'arrêterait pour lui.
  const reFermeture = /[\r\n]['‘’‚‛]@/g; // ancre-mutation:texte-fermeture
  let trouve = null;
  let i = 0;
  while (i < c.length) {
    const ch = c[i];
    if (ch === '@') {
      reEntete.lastIndex = i;
      const m = reEntete.exec(c);
      if (m) {
        if (m[1] === '"' || trouve) return null;
        reFermeture.lastIndex = i + m[0].length - 1;
        const f = reFermeture.exec(c);
        if (!f) return null;
        trouve = { debut: i, fin: f.index + f[0].length };
        i = trouve.fin;
        continue;
      }
    }
    if (ch === '\'') { // chaîne simple : '' y est une apostrophe
      let j = i + 1;
      for (;;) {
        j = c.indexOf('\'', j);
        if (j < 0) return null;
        if (c[j + 1] !== '\'') break;
        j += 2;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"') { // chaîne double : `" et "" y sont un guillemet
      let j = i + 1;
      for (; j < c.length; j++) {
        if (c[j] === '`') { j++; continue; }
        if (c[j] !== '"') continue;
        if (c[j + 1] !== '"') break;
        j++;
      }
      if (j >= c.length) return null;
      i = j + 1;
      continue;
    }
    i++;
  }
  return trouve;
}

// Segments d'un masque (chaînes vidées), chacun avec le séparateur qui le précède.
function bornesSegments(masque) {
  const reSep = /&&|\|\||[;|\r\n]|(?<![<>])&(?![&>])/g;
  const out = [];
  let debut = 0;
  let sep = '';
  let m;
  while ((m = reSep.exec(masque))) { out.push({ a: debut, b: m.index, avant: sep }); debut = m.index + m[0].length; sep = m[0]; }
  out.push({ a: debut, b: masque.length, avant: sep });
  return out;
}

// Arguments d'une écriture : un chemin nommé, une valeur nommée, un encodage et des interrupteurs sans autre
// effet, rien d'autre (ni argument sans nom, ni -PassThru, ni bloc). Rend { chemin, valeur } (jetons bruts).
function argumentsEcriture(seg) {
  const reJeton = /\s+(?:(-[A-Za-z]+)|('(?:[^']|'')*')|("[^"$`]*")|(\$[A-Za-z_]\w*)|([^\s'"$`;|&<>(){},]+))/y;
  let pos = RE_CMDLET_ECRITURE.exec(seg)[0].length;
  const jetons = [];
  while (/\S/.test(seg.slice(pos))) {
    reJeton.lastIndex = pos;
    const m = reJeton.exec(seg);
    if (!m) return null;
    jetons.push(m[1] ? { param: m[1].toLowerCase() } : { valeur: m[2] || m[3] || m[4] || m[5] });
    pos = reJeton.lastIndex;
  }
  let chemin = null;
  let valeur = null;
  for (let k = 0; k < jetons.length; k++) {
    const p = jetons[k].param;
    if (!p) return null;
    const suivant = () => (jetons[k + 1] && jetons[k + 1].valeur !== undefined ? jetons[++k].valeur : null);
    if (p === '-literalpath' || p === '-path' || p === '-filepath') {
      if (chemin !== null || (chemin = suivant()) === null) return null;
    } else if (p === '-value' || p === '-inputobject') {
      if (valeur !== null || (valeur = suivant()) === null) return null;
    } else if (p === '-encoding') {
      if (!/^['"]?[A-Za-z0-9]+['"]?$/.test(suivant() || '')) return null;
    } else if (p === '-erroraction') {
      if (!/^(?:stop|continue|silentlycontinue|ignore)$/i.test(suivant() || '')) return null;
    } else if (p !== '-nonewline' && p !== '-force' && p !== '-append') return null;
  }
  return chemin === null ? null : { chemin, valeur };
}

// Valeur d'un jeton de chemin : chaîne littérale, mot nu, ou variable affectée UNE fois, à un littéral, avant
// l'écriture (deux affectations : la valeur lue ici ne serait pas forcément celle de l'écriture).
function valeurLitterale(jeton, segs, masque, limite, debutInstruction) {
  if (jeton[0] === '\'') return jeton.slice(1, -1).replace(/''/g, '\'');
  if (jeton[0] === '"') return jeton.slice(1, -1);
  if (jeton[0] !== '$') return jeton;
  const nom = jeton.slice(1);
  const reAff = new RegExp(`^\\$${nom}\\s*=\\s*(?:'([^']*)'|"([^"$\`]*)")$`, 'i');
  const iA = segs.findIndex(s => reAff.test(s.texte));
  if (iA < 0 || iA >= limite || !debutInstruction(segs[iA])) return null;
  const affectations = masque.match(new RegExp(`\\$${nom}\\s*(?:[-+*/%]|\\?\\?)?=(?!=)`, 'gi')) || [];
  if (affectations.length !== 1) return null; // ancre-mutation:cible-affectee-une-fois
  const m = reAff.exec(segs[iA].texte);
  return m[1] !== undefined ? m[1] : m[2];
}

// Fichier de texte nommé par son chemin complet, hors de la racine. Refusés : chemin relatif, lecteur de
// fournisseur PowerShell (Variable:, Function:, Env:), joker, variable, nom court, flux, script.
function cibleDeTexteHorsRacine(valeur, cwd) {
  const v = chaine(valeur);
  if (!/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(v)) return false; // ancre-mutation:texte-cible-complete
  if (/[*?[\]`$%~<>|"]/.test(v) || v.slice(2).includes(':')) return false; // ancre-mutation:texte-cible-nommee
  if (!RE_EXTENSION_TEXTE.test(v)) return false; // ancre-mutation:texte-cible-extension
  return !cheminDansRacine(v, cwd) && !texteToucheRacine(v);
}

function ecritureDeTexteLitteral(cmd, cwd, sousAgent) {
  const c0 = chaine(cmd);
  if (c0.includes(MARQUE_TEXTE) || c0.includes(MARQUE_SOUS_EXPRESSION)) return false;
  const h = hereStringLitteral(c0);
  if (!h) return false;
  // Pour toute la suite, le here-string n'est plus qu'une chaîne simple d'un caractère : son texte est hors jeu.
  const jeton = `'${MARQUE_TEXTE}'`;
  const c = c0.slice(0, h.debut) + jeton + c0.slice(h.fin);
  if (/\$\(|`/.test(c)) return false;
  // Hors du texte, rien de ce que PowerShell lit autrement que cette analyse, cible et arguments compris.
  if (lectureAmbigue(c)) return false; // ancre-mutation:texte-ambigu
  const masque = masquerChaines(c);
  const segs = bornesSegments(masque).map(s => Object.assign(s, { texte: c.slice(s.a, s.b).trim() })).filter(s => s.texte);
  const debutInstruction = s => s.avant === '' || s.avant === ';' || s.avant === '\n' || s.avant === '\r';
  const iE = segs.findIndex(s => RE_CMDLET_ECRITURE.test(s.texte));
  if (iE < 0 || segs.some((s, k) => k !== iE && RE_CMDLET_ECRITURE.test(s.texte))) return false;
  const ecr = segs[iE];
  if (segs[iE + 1] && !debutInstruction(segs[iE + 1])) return false; // l'écriture termine son pipeline
  const args = argumentsEcriture(ecr.texte);
  if (!args) return false;
  const consommes = [];
  let source; // ce qui porte le texte : le here-string lui-même, ou la variable qui l'a reçu
  if (ecr.avant === '|') {
    const entree = segs[iE - 1];
    if (!entree || !debutInstruction(entree) || args.valeur !== null) return false;
    source = entree.texte;
    consommes.push({ a: entree.a, b: ecr.b });
  } else {
    if (!debutInstruction(ecr) || args.valeur === null) return false;
    source = args.valeur;
    consommes.push(ecr);
  }
  if (source !== jeton) {
    const nom = (/^\$([A-Za-z_]\w*)$/.exec(source) || [])[1];
    if (!nom) return false;
    const reAff = new RegExp(`^\\$${nom}\\s*=\\s*'${MARQUE_TEXTE}'$`, 'i');
    const iA = segs.findIndex(s => reAff.test(s.texte));
    if (iA < 0 || iA >= iE || !debutInstruction(segs[iA])) return false;
    // Ailleurs dans la commande, cette variable n'est qu'une chaîne de plus : le reste doit être une lecture.
    consommes.push(segs[iA]);
  }
  const cible = valeurLitterale(args.chemin, segs, masque, iE, debutInstruction);
  if (cible === null || !cibleDeTexteHorsRacine(cible, cwd)) return false; // ancre-mutation:texte-hors-racine
  // Garde-fou courant avant d'écrire : if (Test-Path ...) { throw '...' }. Il arrête la commande, rien d'autre.
  for (const s of segs) if (RE_GARDE_FOU.test(s.texte)) consommes.push(s);
  let reste = c;
  for (const s of consommes) reste = reste.slice(0, s.a) + ' '.repeat(s.b - s.a) + reste.slice(s.b);
  if (reste.includes(MARQUE_TEXTE)) return false; // le texte sert ailleurs que dans l'écriture
  return commandeLectureOuCli(reste, sousAgent); // ancre-mutation:texte-reste-lecture
}

// powershell : l'appelant sait que la commande part dans PowerShell (outil PowerShell, ou adaptateur qui le
// sait pour son agent). Sans cette preuve, l'écriture d'un texte littéral n'est pas reconnue.
function gardeOutil({ input, generique, powershell }) {
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
    const dossier = ti.workdir || ti.cwd || inp.cwd;
    const touche = texteToucheRacine(cmd) || commandeViseRacine(cmd, dossier);
    // Texte littéral écrit hors de la racine (un rapport qui cite la liste) : seulement en PowerShell prouvé.
    const texte = qui => (powershell === true || OUTILS_POWERSHELL.includes(tn)) && ecritureDeTexteLitteral(cmd, dossier, qui); // ancre-mutation:texte-powershell
    if (sousAgent) {
      // Lecture permise, écriture refusée ; CLI : lecture, ou note sur sa propre fiche.
      const qui = { agentId: chaine(inp.agent_id) };
      if (touche) return commandeLectureOuCli(cmd, qui) || texte(qui) ? null : RAISON_SOUS_AGENT; // ancre-mutation:lecture-sous-agent
      if (appelleCli(cmd)) return cliSeuleDuSousAgent(cmd, qui.agentId) || texte(qui) ? null : RAISON_SOUS_AGENT;
      return null;
    }
    if (!touche) return null;
    return commandeLectureOuCli(cmd) || texte() ? null : RAISON_SHELL;
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

function commandes(script, projet, sessionId) {
  const s = `node "${chaine(script).replace(/\\/g, '/')}"`;
  return {
    ajouter: m => `${s} ajouter --projet ${projet}${sessionId ? ` --session ${sessionId}` : ''}${m ? ` --de ${m}` : ''} "texte mot pour mot"`,
    reprendre: `${s} reprendre --projet ${projet} --session ${sessionId || 'ID'} C-NNNN`,
    traiter: `${s} traiter --projet ${projet} --session ${sessionId || 'ID'} C-NNNN --preuve "rapport.md" --executant ID --verification "controle effectue" --resultat accepte`,
    sansTravail: m => `${s} sans-travail --projet ${projet} ${m} "raison courte"`,
    etat: `${s} etat --projet ${projet} C-NNNN en-cours|bloque-utilisateur|ouvert "note"`,
    abandon: `${s} abandon --projet ${projet} C-NNNN "citation EXACTE de l'utilisateur"`,
    lister: `${s} lister --projet ${projet}${sessionId ? ` --session ${sessionId}` : ''}`,
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

function etatDeSession(etat, agent, sessionId) {
  if (!sessionId) return etat; // API historique : la vue complete reste accessible.
  const s = lireSession(agent, sessionId) || {};
  const taches = Object.values(s.taches || {}).filter(t => t.projet === etat.projet).map(t => t.ligne);
  const reprises = s.reprises && s.reprises[etat.projet] || [];
  const demandes = Object.fromEntries(Object.entries(etat.demandes).filter(([, d]) => d.session === sessionId));
  const lignes = Object.fromEntries(Object.entries(etat.lignes).filter(([id, l]) =>
    l.session === sessionId || (l.de && demandes[l.de]) || taches.includes(id) || reprises.includes(id)));
  return { ...etat, demandes, lignes };
}

function reprendreLignes({ agent, projet, sessionId, ids }) {
  if (!sessionId) throw new Error('--session requis');
  const e = lireLedger(projet, agent);
  for (const id of ids) if (!e.lignes[id]) throw new Error(`${id} introuvable`);
  modifierSession(agent, sessionId, s => {
    s.reprises = s.reprises || {};
    s.reprises[projet] = [...new Set([...(s.reprises[projet] || []), ...ids])];
  });
}

function contexteMessage({ agent, projet, idMessage, script, sessionId }) {
  const cmd = commandes(script, projet, sessionId);
  const etat = etatDeSession(lireLedger(projet, agent), agent, sessionId);
  const entete = `Fichier contexte (projet ${projet}, agent ${agent}) : ${chemins(projet, agent).md}\n${POUR_ORCHESTRATEUR}`; // ancre-mutation:pour-orchestrateur
  const pied = `Nouveau message ${idMessage}. Avant d'agir : transforme-le en ligne(s) de travail avec \`${cmd.ajouter(idMessage)}\` ou classe-le avec \`${cmd.sansTravail(idMessage)}\`. Citer \`[ctx C-NNNN]\` dans l'historique ou le commit quand c'est fait ; \`[ctx C-NNNN partiel]\` si ce n'est pas fini.`;
  return composerContexte(entete, lignesCompactes(etat), pied, cmd.lister);
}

function contexteSession({ agent, projet, script, sessionId }) {
  const cmd = commandes(script, projet, sessionId);
  const complet = lireLedger(projet, agent);
  const etat = etatDeSession(complet, agent, sessionId);
  const alerte = avertissementSecours();
  let attente = '';
  try { attente = texteSignalementsEnAttente({ agent, projet, sessionId }); } catch (_) { attente = ''; } // ancre-mutation:signalements-attente
  const entete = `Fichier contexte (projet ${projet}, agent ${agent}) : ${chemins(projet, agent).md}\nCe fichier fait foi pour ce qui reste, pas le résumé de compactage.\n${POUR_ORCHESTRATEUR}${alerte ? '\n' + alerte : ''}${attente ? '\n' + attente : ''}`;
  const autres = sessionId ? Object.keys(complet.lignes).filter(id => !etat.lignes[id] && !TERMINAUX.includes(complet.lignes[id].statut)).length : 0;
  const scope = sessionId ? `\nPerimetre : cette conversation. ${autres} ligne(s) d'autres missions conservees sur disque, sans ordre de les executer. Pour reprendre une mission : \`${cmd.reprendre}\`. Pour un livrable examine et prouve : \`${cmd.traiter}\`.` : '';
  const pied = `Commandes : \`${cmd.ajouter()}\` ; \`${cmd.etat}\` ; \`${cmd.lister}\`. Une ligne ne disparaît que sur preuve [ctx C-NNNN] (historique, mémoire ou commit).${scope}`;
  return composerContexte(entete, lignesCompactes(etat), pied, cmd.lister);
}

function contexteApresPreuve({ agent, projet, script, resultat, preuve, sessionId }) {
  const cmd = commandes(script, projet, sessionId);
  const etat = etatDeSession(lireLedger(projet, agent), agent, sessionId);
  const faits = resultat.faits.length ? `Retiré sur preuve (${preuve}) : ${resultat.faits.join(', ')}.` : '';
  const partiels = resultat.partiels.length ? `Passé en-cours (partiel, ${preuve}) : ${resultat.partiels.join(', ')}.` : '';
  const entete = [`Fichier contexte (projet ${projet}, agent ${agent}) mis à jour.`, POUR_ORCHESTRATEUR, faits, partiels, 'Reste :'].filter(Boolean).join('\n');
  return composerContexte(entete, lignesCompactes(etat), '', cmd.lister);
}

// ---------------------------------------------------------------------------
// CLI

// Recu explicite pour un livrable hors historique.
// Le hook conserve une declaration verifiable, il ne rejoue pas le travail de l'agent.
function traiterLigne({ agent, projet, id, sessionId, executant, fichier, verification, resultat, reste }) {
  if (!sessionId || !chaine(executant).trim() || !chaine(verification).trim()) throw new Error('--session, --executant et --verification requis');
  if (!['accepte', 'rejete', 'partiel'].includes(resultat)) throw new Error('--resultat accepte|rejete|partiel requis');
  if (!fichier) throw new Error('--preuve requis');
  const chemin = path.resolve(fichier);
  const stat = fs.statSync(lp(chemin));
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('preuve attendue : fichier texte de 10 Mio au plus');
  const contenu = fs.readFileSync(lp(chemin));
  if (contenu.includes(0)) throw new Error('preuve binaire refusee');
  const texte = sansBom(contenu.toString('utf8'));
  const attendu = resultat === 'partiel' ? 'partiel' : 'traite';
  const lignes = texteHorsExemples(texte).split(/\r?\n/);
  const conforme = lignes.some(l => new RegExp(`\\bstatut\\s*:\\s*${attendu}\\b`, 'i').test(l)
    && extraireMarqueurs(l).some(m => m.id === id && m.partiel === (resultat === 'partiel')));
  if (!conforme) throw new Error(`preuve sans statut: ${attendu} et marqueur exact pour ${id}`);
  const e = lireLedger(projet, agent);
  const cible = e.lignes[id];
  if (!cible) throw new Error(`${id} introuvable`);
  if (!etatDeSession(e, agent, sessionId).lignes[id]) throw new Error('ligne hors de cette session : reprendre explicitement la mission avant de la traiter');
  if (resultat === 'rejete' && (!/^\[agent\]/.test(cible.texte) || !reste || reste === id || !e.lignes[reste] || TERMINAUX.includes(e.lignes[reste].statut))) {
    throw new Error('rejet : livraison [agent] et --reste pointant un travail encore ouvert requis');
  }
  const cloture = { version: 1, resultat, executant: chaine(executant), verificateur: `${agent}:${sessionId}`,
    verification: chaine(verification), fichier: chemin, empreinte: crypto.createHash('sha256').update(contenu).digest('hex'),
    date: maintenantIso(), reste: reste || null };
  return modifierLedger(projet, agent, (etat, o) => {
    const l = etat.lignes[id];
    if (resultat === 'rejete' && (!etat.lignes[reste] || TERMINAUX.includes(etat.lignes[reste].statut))) throw new Error('le reste doit encore etre ouvert');
    if (TERMINAUX.includes(l.statut) && l.statut !== 'fait') throw new Error('ligne abandonnee');
    if (l.statut === 'fait' && resultat === 'partiel') throw new Error('une ligne cloturee ne peut pas redevenir partielle');
    if (l.cloture && l.cloture.resultat !== 'partiel') return l.cloture;
    const avant = l.statut;
    l.statut = resultat === 'partiel' ? 'en-cours' : 'fait';
    l.preuve = `fichier ${chemin} (sha256 ${cloture.empreinte})`;
    l.cloture = cloture;
    l.maj = cloture.date;
    if (resultat === 'partiel') l.note = `partiel (preuve : ${l.preuve})`;
    o.journal({ evt: resultat === 'partiel' ? 'partiel' : 'fait', id, avant, preuve: l.preuve, cloture });
    return cloture;
  });
}

const USAGE = [
  'Usage : node context-ledger.js <commande> --projet <projet> [args]',
  '  traiter --projet P --session ID C-NNNN --preuve fichier --executant ID --verification "controle effectue" --resultat accepte|rejete|partiel [--reste C-NNNN]',
  '  reprendre --projet P --session ID C-NNNN [C-NNNN...]',
  '  ajouter --projet P [--de M-NNNN] "texte mot pour mot"',
  '  sans-travail --projet P M-NNNN "raison courte"',
  '  etat --projet P C-NNNN en-cours|bloque-utilisateur|ouvert ["note"]',
  '  abandon --projet P C-NNNN "citation EXACTE de l\'utilisateur"   (message écrit APRÈS la création de la ligne)',
  '  lister [--projet P]',
  '  chercher [--projet P] [--agent claude|codex] "mot" ["autre mot" ...]   (lecture seule : lignes C et messages M)',
  '       un identifiant (chercher C-0151 C-0152 M-0042) rend la ligne ou le message entier',
  '  fiche <ID du sous-agent>                                       (affiche la fiche d\'un sous-agent)',
  '  note --fiche <ID du sous-agent> [--genre mission|fait|reste|a-inscrire] "texte"   (ajoute une note à la fiche)',
  '       --genre deja-fait|bloque|question : la note est aussi signalée à l\'orchestrateur, à son prochain événement',
  '  help                                                           (cette aide)',
  '  signaler --agent A --projet P C-NNNN [--genre deja-fait|bloque|question] "texte"   (agent principal seulement)',
  '       prévient l\'agent A qu\'une ligne de SA liste est déjà faite, le bloque ou pose question ; A la vérifie',
  '       et ne la ferme que sur sa propre preuve',
  '  (--fichier <chemin> : lit le texte libre dans un fichier UTF-8)',
  'etat ne marque jamais « fait ». traiter exige un fichier de preuve et conserve le recu de verification.',
  'Sous-agents : lister, chercher, fiche et help en lecture ; note sur leur propre fiche ; rien d\'autre.',
].join('\n');

// Recherche en lecture seule dans la liste d'un projet : texte intégral et note des lignes C, texte des
// messages M. Faite pour les sous-agents qui doivent recouper un constat avec la liste (« ce reste est-il
// déjà suivi ? ») sans la lire en entier. Insensible à la casse, mot ou expression exacte.
const MAX_RESULTATS_RECHERCHE = 40;
// Un identifiant (C-0151, M-0042) rend sa ligne ou son message ENTIER : besoin relevé le 2026-10-02 dans les
// lectures refusées aux sous-agents (boucles sur plusieurs C-NNNN.txt). Texte borné, avec le fichier entier.
const RE_ID_RECHERCHE = /^[CM]-\d{4,}$/i;
const MAX_TEXTE_PAR_ID = 6000;

function texteParId(etat, id) {
  const o = id[0] === 'C' ? etat.lignes[id] : etat.demandes[id];
  if (!o) return null;
  const texte = chaine(o.texte);
  const coupe = texte.length > MAX_TEXTE_PAR_ID;
  const parts = [`${id} | ${o.date || ''} | ${o.statut}${o.de ? ` | de ${o.de}` : ''}${Array.isArray(o.lignes) && o.lignes.length ? ` | lignes ${o.lignes.join(', ')}` : ''}`];
  parts.push(`  texte : ${coupe ? `${texte.slice(0, MAX_TEXTE_PAR_ID)} […] (texte entier : ${cheminTexte(etat.projet, etat.agent, id)})` : texte}`);
  if (o.note) parts.push(`  note : ${chaine(o.note)}`);
  if (o.raison) parts.push(`  raison : ${chaine(o.raison)}`);
  if (o.citationUtilisateur) parts.push(`  citation de l'utilisateur : ${chaine(o.citationUtilisateur)}`);
  return parts.join('\n');
}

function chercher({ projet, agent, motifs }) {
  validerAgent(agent);
  const etat = lireLedger(projet, agent);
  const bas = t => chaine(t).toLowerCase();
  const out = [`Recherche dans ${projet}.${agent} (${Object.keys(etat.lignes).length} lignes C, ${Object.keys(etat.demandes).length} messages M) :`];
  for (const motif of motifs) {
    const m = bas(motif).trim();
    if (!m) continue;
    if (RE_ID_RECHERCHE.test(m)) {
      const t = texteParId(etat, m.toUpperCase()); // ancre-mutation:chercher-id
      out.push(t ? t : `« ${motif} » : absent de cette liste`);
      continue;
    }
    const touches = [];
    const voir = (id, o) => {
      for (const [nom, texte] of [['', chaine(o.texte)], ['note : ', chaine(o.note)]]) {
        const i = bas(texte).indexOf(m);
        if (i < 0) continue;
        const extrait = texte.slice(Math.max(0, i - 80), i + m.length + 140).replace(/\s+/g, ' ');
        touches.push(`${id} | ${o.statut} | ${nom}${i > 80 ? '…' : ''}${extrait}${i + m.length + 140 < texte.length ? '…' : ''}`);
        return;
      }
    };
    for (const id of trierIds(etat.lignes)) voir(id, etat.lignes[id]);
    for (const id of trierIds(etat.demandes)) voir(id, etat.demandes[id]);
    out.push(`« ${motif} » : ${touches.length} résultat(s)`);
    for (const t of touches.slice(0, MAX_RESULTATS_RECHERCHE)) out.push('  ' + t);
    if (touches.length > MAX_RESULTATS_RECHERCHE) out.push(`  (${touches.length - MAX_RESULTATS_RECHERCHE} de plus : précise le mot)`);
  }
  out.push(`Rappel : ${OUVERT_NEST_PAS_PAS_FAIT} Une ligne que tu constates déjà faite se signale à celui qui tient la liste (sous-agent : note --genre deja-fait dans ta fiche ; agent principal : signaler --agent <celui qui tient la liste> --projet <P> C-NNNN "la preuve"), elle ne se ferme que sur sa preuve.`); // ancre-mutation:chercher-rappel
  return out.join('\n');
}

function analyserArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(projet|de|fichier|agent|fiche|genre|session|executant|preuve|verification|resultat|reste)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    else pos.push(a);
  }
  return { opts, pos };
}

function executerCli(argv, { agent, script }) {
  const ok = sortie => ({ code: 0, sortie, erreur: '' });
  try {
    if (!agent) throw new Error('agent introuvable depuis l\'emplacement du script');
    const [commande, ...reste] = argv;
    // Aide (appelée aussi par les sous-agents) : rien à lire ni à écrire.
    if (['help', '--help', '-h', 'aide'].includes(commande)) return ok(USAGE); // ancre-mutation:cli-help
    // Lecture, fiches et signalements : rien à vérifier ni à écrire dans la liste de l'appelant.
    if (!['chercher', 'fiche', 'note', 'signaler'].includes(commande)) {
      try { assurerIntegrite(agent); } catch (_) { /* chaque écriture revérifie sous verrou */ }
    }
    const { opts, pos } = analyserArgs(reste);
    const texteLibre = debut => (opts.fichier ? sansBom(lireTexte(path.resolve(opts.fichier)) || '') : pos.slice(debut).join(' '));
    if (opts.projet !== undefined) validerProjet(opts.projet);
    switch (commande) {
      case 'traiter': {
        if (!opts.projet) throw new Error('--projet requis');
        const id = normaliserId(pos[0], 'C');
        const r = traiterLigne({ agent, projet: opts.projet, id, sessionId: opts.session, executant: opts.executant,
          fichier: opts.preuve, verification: opts.verification, resultat: opts.resultat, reste: opts.reste ? normaliserId(opts.reste, 'C') : null });
        return ok(`${id} : ${r.resultat}, verifie par ${r.verificateur}, preuve sha256 ${r.empreinte}.`);
      }
      case 'reprendre': {
        if (!opts.projet || !pos.length) throw new Error('--projet et identifiants requis');
        const ids = pos.map(id => normaliserId(id, 'C'));
        reprendreLignes({ agent, projet: opts.projet, sessionId: opts.session, ids });
        return ok(`Mission reprise pour la session ${opts.session} : ${ids.join(', ')}.`);
      }
      case 'ajouter': {
        if (!opts.projet) throw new Error('--projet requis');
        const id = ajouterLigne({ projet: opts.projet, agent, texte: texteLibre(0), de: opts.de || null, sessionId: opts.session });
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
        return ok(projets.map(p => rendreVue(etatDeSession(lireLedger(p, agent), agent, opts.session))).join('\n'));
      }
      case 'chercher': {
        // Lecture seule, y compris dans la liste d'un autre agent (--agent) : rien n'est écrit.
        const cible = opts.agent ? validerAgent(opts.agent) : agent;
        const motifs = pos.filter(x => chaine(x).trim());
        if (!motifs.length) throw new Error('chercher : au moins un mot à chercher');
        const projets = opts.projet ? [opts.projet] : listerProjets(cible);
        if (!projets.length) return ok(`Aucun fichier contexte pour l'agent ${cible}.`);
        return ok(projets.map(p => chercher({ projet: p, agent: cible, motifs })).join('\n'));
      }
      case 'note': {
        // Le sous-agent ajoute une note à SA fiche (la garde vérifie que --fiche est bien la sienne).
        if (!opts.fiche) throw new Error('note : --fiche <ID de travail du sous-agent> requis');
        const r = noterFiche({ agent, id: opts.fiche, genre: opts.genre, texte: texteLibre(0) });
        return ok(`Noté dans ${r.fiche} (${r.notes} note(s)${r.mission ? '' : ' ; mission encore absente : recopie-la avec --genre mission'}).`);
      }
      case 'signaler': {
        // Agent principal seulement (la garde le refuse aux sous-agents, qui signalent dans leur fiche).
        if (!opts.agent) throw new Error('signaler : --agent <agent qui tient la liste> requis');
        if (!opts.projet) throw new Error('--projet requis');
        const sig = signalerAgent({ de: agent, vers: validerAgent(opts.agent), projet: opts.projet, ligne: pos[0], genre: opts.genre, texte: texteLibre(1) });
        return ok(`Signalement ${sig.id} déposé pour ${opts.agent} sur ${sig.ligne} (projet ${opts.projet}, ${sig.genre}) : il le recevra à son prochain événement dans ce projet, et ne fermera la ligne que sur sa propre preuve.`);
      }
      case 'fiche': {
        const id = pos[0] || opts.fiche;
        const f = lireFiche(agent, id);
        if (!f) throw new Error(`aucune fiche pour le sous-agent ${id || '(ID manquant)'} (agent ${agent})`);
        return ok(f.texte);
      }
      default:
        return { code: 1, sortie: '', erreur: (commande ? `commande inconnue : ${commande}\n` : '') + USAGE };
    }
  } catch (e) {
    return { code: 1, sortie: '', erreur: `context-ledger : ${e && e.message ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Diagnostic : forme réelle des événements de hook et durée de chaque exécution, sans aucun contenu (ni
// prompt, ni commande, ni réponse : seulement les noms des champs et des identifiants). Actif seulement si
// le fichier drapeau existe ; écrit hors de la racine contexte. Sert à mesurer en production ce que les
// bancs ne font que simuler (règle : ne jamais supposer).
const DOSSIER_CAPTURE = path.join(os.tmpdir(), 'agent-memory-ledger', 'capture-hooks');

function capturerEvenement({ agent, input, octets }) {
  try { if (!fs.existsSync(path.join(DOSSIER_CAPTURE, 'actif'))) return; } catch (_) { return; }
  const i = estObjet(input) ? input : {};
  const court = v => (typeof v === 'string' ? v.slice(0, 260) : v);
  // Ligne courte dès le début : un hook tué par son délai n'écrit pas sa ligne de fin (process.on('exit')).
  // Un début sans fin au même pid = hook tué ; ni début ni fin = hook jamais lancé (environ 1,3 % des
  // PreToolUse de sous-agents Codex sans aucune trace le 2026-10-02).
  const debut = JSON.stringify({
    ts: maintenantIso(), evt: i.hook_event_name, session_id: court(i.session_id), agent_id: court(i.agent_id),
    tool_name: court(i.tool_name), pid: process.pid, demarrage_ms: Math.round(process.uptime() * 1000),
  }) + '\n';
  try {
    fs.mkdirSync(DOSSIER_CAPTURE, { recursive: true });
    fs.appendFileSync(path.join(DOSSIER_CAPTURE, `${agent || 'inconnu'}.debuts.jsonl`), debut); // ancre-mutation:capture-debut
  } catch (_) { /* diagnostic seulement */ }
  const ligne = {
    ts: maintenantIso(), agent: agent || null, evt: i.hook_event_name, cles: Object.keys(i).sort(),
    session_id: court(i.session_id), agent_id: court(i.agent_id), agent_type: court(i.agent_type),
    source: court(i.source), trigger: court(i.trigger), transcript_path: court(i.transcript_path),
    agent_transcript_path: court(i.agent_transcript_path), cwd: court(i.cwd), tool_name: court(i.tool_name),
    turn_id: court(i.turn_id), prompt_id: court(i.prompt_id), permission_mode: court(i.permission_mode),
    stop_hook_active: i.stop_hook_active, octets, pid: process.pid,
  };
  // Outils de lancement de sous-agents : noms des champs, et pour quelques champs connus leur longueur et
  // leurs 24 premiers caractères (savoir si le brief arrive en clair), jamais le texte entier.
  if (estObjet(i.tool_input) && /agent|spawn|workflow|task/i.test(chaine(i.tool_name))) {
    const apercu = {};
    for (const [k, v] of Object.entries(i.tool_input)) {
      apercu[k] = typeof v === 'string'
        ? (/^(message|prompt|task_name|agent_type|subagent_type|description|fork_turns|name)$/.test(k) ? `${v.length} car. : ${v.slice(0, 24)}` : `${v.length} car.`)
        : typeof v;
    }
    ligne.tool_input = apercu;
    if (estObjet(i.tool_response)) ligne.tool_response_cles = Object.keys(i.tool_response).sort();
    else if (i.tool_response !== undefined) ligne.tool_response_type = typeof i.tool_response;
  } else if (estObjet(i.tool_input)) {
    // Autres outils : la forme de l'entrée, jamais son contenu. Noms des champs, type de la commande (pour
    // un tableau : le programme et ses options jusqu'à celle qui introduit la commande) et shell nommé. Dit
    // quel shell exécutera la commande : la garde ne prouve pas la même chose en PowerShell et en bash.
    const ti = i.tool_input;
    const c = ti.command !== undefined ? ti.command : (ti.cmd !== undefined ? ti.cmd : ti.script);
    ligne.outil_cles = Object.keys(ti).sort().slice(0, 20);
    if (Array.isArray(c)) {
      const k = c.findIndex(x => /^(-lc|-c|\/c|-command)$/i.test(chaine(x)));
      ligne.outil_commande = c.slice(0, k >= 0 ? k + 1 : 1).map(x => chaine(x).split(/[\\/]/).pop().slice(0, 24)); // ancre-mutation:capture-forme-outil
    } else if (c !== undefined) ligne.outil_commande = typeof c;
    if (typeof ti.shell === 'string') ligne.outil_shell = ti.shell.slice(0, 24);
  } else if (i.tool_input !== undefined) ligne.outil_type = typeof i.tool_input;
  process.on('exit', () => {
    try {
      ligne.dur_ms = Math.round(process.uptime() * 1000); // démarrage de node compris
      for (const [k, v] of Object.entries(jalons)) if (v > 0) ligne[k] = v; // ancre-mutation:capture-jalons
      fs.mkdirSync(DOSSIER_CAPTURE, { recursive: true });
      fs.appendFileSync(path.join(DOSSIER_CAPTURE, `${agent || 'inconnu'}.jsonl`), JSON.stringify(ligne) + '\n');
    } catch (_) { /* diagnostic seulement */ }
  });
}

module.exports = {
  AGENTS, PLAFOND, STATUTS_MANUELS, TERMINAUX, OUTILS_FICHIER, OUTILS_SHELL, capturerEvenement,
  fixerBudget, tempsRestant,
  RAISON_FICHIER, RAISON_SHELL, RAISON_SOUS_AGENT,
  racine, agentDepuisChemin, projetDepuisCwd, chemins, listerProjets, listerProjetsTous,
  lireLedger, modifierLedger, allouerId, rendreVue, assurerVues,
  rejouerJournal, verifierEtat, assurerIntegrite,
  racineSecours, journalSecours, avertissementSecours,
  ajouterDemande, ajouterLigne, classerSansTravail, changerEtat, abandonner, trouverProjetDe,
  lireSession, modifierSession, lierSession, projetDeSession, enregistrerMessage, rappelStop,
  secours, contexteEchecMessage, lireLignesDepuis, suiteTranscript,
  suivreTache, finirTache, livraisons, tacheParAlias, texteLivraisons, texteFins, texteSuiviEnCours,
  signalerAgent, texteSignalementsAgents, texteSignalementsEnAttente, lireBoite,
  creerFiche, lireFiche, lireIndexFiche, noterFiche, chercher, MISSION_ABSENTE,
  texteConsigneSousAgent, consigneADonner, consigneDansTranscript, texteRepriseSousAgent, texteLectureSeule, compactageDuSousAgent, noterCompactage,
  transcriptDUnSousAgent, idDepuisTranscript,
  extraireMarqueurs, marqueursAjoutes, estFichierPreuve, preuveCommit, preuvesDepuisOutil,
  appliquerPreuves, reconcilier, reconcilierDansHook,
  gardeOutil, texteToucheRacine, commandeViseRacine, appelleCli, commandeLectureOuCli, lectureAmbigue,
  commandes, contexteMessage, contexteSession, contexteApresPreuve, composerContexte,
  executerCli,
};
