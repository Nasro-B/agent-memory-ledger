# agent-memory-ledger

Mémoire partagée et liste de travail pour agents de code. Fonctionne avec **Claude Code** et **Codex**, ensemble ou séparément, sur la même mémoire.

Un agent de code oublie de cinq façons. Ce dépôt les ferme une par une, avec des hooks, sans service ni base de données : des fichiers texte dans un dossier.

| Ce qui se perd | Ce que fait le dépôt |
| --- | --- |
| Une demande faite il y a deux heures, disparue au compactage | Chaque message est enregistré mot pour mot sur disque, puis transformé en lignes de travail. Une ligne ne se retire que sur preuve écrite. |
| Un message envoyé pendant que l'agent travaille | Il est enregistré au prochain événement et rappelé une fois en fin de tour s'il n'est pas trié. Une ligne ouverte ou tenue à jour pendant le tour ne relance pas la fin de tour : elle reste dans la liste. |
| Le résultat d'un sous-agent, arrivé pendant un autre travail | Chaque sous-agent lancé devient une ligne. À sa fin elle passe à « résultat à traiter » : l'agent principal en est prévenu à son prochain outil, puis rappelé toutes les 20 minutes pendant un tour long. Au Stop, un état inchangé n'est rappelé qu'une fois. |
| La mission d'un sous-agent, quand SON contexte est compacté | Chaque sous-agent a sa fiche sur disque : sa mission mot pour mot et les notes qu'il y ajoute. Elle lui est rendue après un compactage de son contexte : c'est elle qui fait foi, pas le résumé. Avec Claude Code le hook copie la mission ; avec Codex, qui la chiffre, c'est à l'agent principal ou au sous-agent de l'y copier. La mission prime : si elle interdit toute écriture ailleurs que dans ses livrables, la fiche reste vide. |
| Ce qui a été fait hier, par cet agent ou par un autre | Chaque commit est journalisé, l'état des dépôts est sauvé avant un compactage, et l'historique récent est réinjecté après. |

Depuis la 0.8.0, le dépôt apporte aussi trois gardes (voir [Gardes](#gardes)) : une garde de sécurité des commandes (refuse les commandes destructrices, demande confirmation pour une poussée ou un déploiement de production), un rappel avant commit (un commit qui touche une migration, une fonction déployée à part, une variable d'environnement ou une tâche planifiée est refusé tant que l'agent n'a pas confirmé l'action réelle) et une garde des caractères invisibles. Elles sont actives par défaut et se règlent dans `gardes.json`.

Depuis la 0.9.0, le dépôt apporte aussi les **logiques pures** du Cockpit et de ses modules (réglages, Régulateur d'agents et sa file d'attente, Consignes, Nuit, Pause, Garde-quota, modèles par agent), avec leurs bancs et leurs preuves par mutation. Elles ne sont pas encore branchées : ni noyau d'entrées-sorties, ni commande, ni hook (voir [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md)).

## Comment ça marche

```
message de l'utilisateur ──► M-0042 (mot pour mot, « à trier »)
                                │  l'agent : ajouter --de M-0042 "..."
                                ▼
                             C-0107 (ligne de travail : ouvert, en-cours, bloque-utilisateur)
                                │  l'agent fait le travail, puis écrit dans l'historique ou le commit :
                                │  « ... [ctx C-0107] »
                                ▼
                             retirée de la liste, sur cette preuve
```

La commande `etat` ne marque jamais une ligne « faite ». Le marqueur `[ctx C-NNNN]` dans un historique ou un commit reste compatible. Pour un rapport examiné, `traiter` exige un fichier portant le statut et le marqueur exacts ; il conserve l'exécutant, le vérificateur et le SHA-256 de la preuve. Les exemples, citations et mentions de travail non terminé ne valent pas clôture : un mot comme « en cours », « à faire » ou « non vérifié » annule une mention complète quand il est dans la même proposition qu'elle (entre deux « ; », points ou « | »), pas quand il est ailleurs dans la ligne. Un commit ne ferme une ligne que si son message porte la mention et que le hook retrouve son dépôt ; le commit d'un sous-agent ne ferme rien. Le détail est dans [docs/CLOTURE-ET-REPRISE.md](docs/CLOTURE-ET-REPRISE.md#ce-qui-ferme-une-ligne-et-ce-qui-la-laisse-ouverte). Une garde refuse toute modification à la main de la liste, et une ligne effacée est restaurée depuis un journal en ajout seul.

Les rappels automatiques portent sur la conversation courante. Les autres missions restent sur disque ; `reprendre --session <ID> C-NNNN` les rattache explicitement à une reprise. Un événement de fin reçu deux fois ne recrée pas un travail déjà traité. Le fonctionnement et les limites sont décrits dans [docs/CLOTURE-ET-REPRISE.md](docs/CLOTURE-ET-REPRISE.md).

La mémoire a trois étages, communs à tous les agents :

- `contexte/` : la liste de travail, par projet et par agent ;
- `history/<projet>.<agent>.md` : le journal détaillé, un fichier par agent ;
- `Memory-Auto.md` : le résumé commun, une ligne par événement.

Le détail est dans [docs/PROTOCOLE-MEMOIRE.md](docs/PROTOCOLE-MEMOIRE.md).

## Installation

Il faut git et Node.js 22 (la version utilisée pour le développement et les tests ; les versions antérieures ne sont pas testées).

### Claude Code

```
/plugin marketplace add Nasro-B/agent-memory-ledger
/plugin install agent-memory-ledger@agent-memory-ledger
```

Les hooks sont actifs à la session suivante. Le plugin apporte aussi le skill `liste-de-travail`, qui donne à l'agent les règles de la liste.

### Codex

Codex lit ses hooks dans `hooks.json`, dans son dossier de configuration. Clonez le dépôt à un endroit stable, puis :

```
node scripts/installer-codex.js              # montre ce qui serait ajouté, n'écrit rien
node scripts/installer-codex.js --appliquer  # écrit, après une copie de sauvegarde
```

L'installateur ne modifie ni ne déplace aucun hook existant : il ajoute les siens dans de nouveaux groupes, à la fin de chaque événement. Codex garde une approbation par hook, identifié par sa position ; vos approbations restent donc valables. Ouvrez ensuite Codex et approuvez les nouveaux hooks : tant que ce n'est pas fait, il ne les exécute pas.

Pour retirer : `node scripts/installer-codex.js --retirer --appliquer`. Pour un autre dossier de configuration : `--home <dossier>` (ou la variable `CODEX_HOME`).

### Les règles à donner à l'agent

Les hooks enregistrent, rappellent et gardent. L'agent doit savoir quoi en faire. Copiez dans vos fichiers d'instructions le bloc de [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md). Sans lui, l'agent voit la liste mais ne sait pas qu'elle fait foi.

## Utilisation

Les hooks affichent toujours la commande exacte, avec le bon chemin et le bon projet. Les commandes de l'agent principal :

```
node "<script>" ajouter --projet P --de M-0042 "texte mot pour mot"   # un message devient une ligne de travail
node "<script>" ajouter --projet P --session ID "problème trouvé en route"
node "<script>" sans-travail --projet P M-0042 "simple question"      # un message qui ne demande aucun travail
node "<script>" etat --projet P C-0107 en-cours|bloque-utilisateur|ouvert "note"
node "<script>" abandon --projet P C-0107 "citation exacte de l'utilisateur"
node "<script>" lister --projet P --session ID
node "<script>" reprendre --projet P --session ID C-0107
node "<script>" traiter --projet P --session ID C-0107 --preuve "controle.md" --executant ID --verification "sources et tests controles" --resultat accepte
```

Lecture seule, et commandes ouvertes aux sous-agents :

```
node "<script>" chercher --projet P "mot" "autre mot"                 # lignes C et messages M qui contiennent le mot
node "<script>" chercher --projet P C-0107 M-0042                     # ces lignes ou messages, en entier
node "<script>" chercher --agent codex "mot"                          # dans la liste d'un autre agent
node "<script>" fiche <ID>                                            # la fiche d'un sous-agent
node "<script>" note --fiche <ID> [--genre g] "texte"                 # un sous-agent ajoute une note à SA fiche
node "<script>" help                                                  # l'aide
```

`<script>` est `scripts/claude/context-ledger.js` ou `scripts/codex/context-ledger.js`. Un texte long ou plein de guillemets se passe par `--fichier <chemin>`.

Abandonner une ligne exige une citation exacte d'un message écrit par l'utilisateur **après** la création de la ligne : un contre-ordre. La demande d'origine ne suffit pas.

## Sous-agents

Un sous-agent ne tient pas la liste. Il a sa propre fiche, et il lit la liste sans la modifier.

- **Sa fiche.** Le hook crée `contexte/<projet>.<agent>/fiches/<genre>-<identifiant>.md` : l'identité du sous-agent, sa ligne de suivi, sa mission mot pour mot, puis ses notes. Avec Claude Code, la mission est copiée par le hook. Avec Codex, le message de lancement arrive chiffré aux hooks : le sous-agent la recopie lui-même, après l'avoir lue, sur la consigne qu'il reçoit.
- **Sa mission prime sur sa fiche.** Si sa mission lui interdit expressément toute écriture ailleurs que dans ses livrables (« n'écris nulle part ailleurs »), il n'écrit rien dans sa fiche, ni mission, ni note, ni signalement, et le dit dans son rapport. Sa consigne le lui dit, et lui demande de lire sa mission avant tout. Une mission qui attribue des fichiers, ou qui interdit seulement de modifier le dépôt (audit en lecture seule), n'interdit pas la fiche : elle est hors du dépôt. Une fiche restée vide n'est ni un écart ni une raison d'arrêter le sous-agent : dites dans le brief si la fiche est permise, et donnez la mission dans un fichier du dossier permis.
- **Sa consigne.** Il la reçoit à son démarrage ; si cet événement manque ou arrive trop tard, elle lui est donnée à son premier outil, une seule fois. Si le hook de démarrage a été interrompu après l'avoir comptée comme donnée (sa sortie est alors perdue), le premier outil la cherche dans la conversation du sous-agent et la redonne si elle n'y est pas, une seule fois aussi. Elle dit où est sa fiche, comment y noter, ce qui lui est fermé et comment lire la liste.
- **Ses notes.** Il n'écrit que dans sa fiche, par ajout : `note --fiche <ID> "fait : ... ; reste : ..."`. La garde refuse qu'il note dans la fiche d'un autre.
- **Après un compactage de son contexte**, sa fiche lui est rendue (mission et dernières notes) : c'est elle qui fait foi, pas le résumé. Elle porte la mission de son lancement : une tâche plus récente donnée par l'agent principal (une relance) la remplace, et la fiche rendue le dit. Il ne reçoit jamais la liste de l'agent principal à la place.
- **Il lit la liste, il ne la modifie pas.** Lecture directe du fichier, ou commande `chercher` : un identifiant rend la ligne entière, `--agent` lit la liste d'un autre agent. `ajouter`, `etat`, `sans-travail` et `abandon` lui sont refusés.
- **Il ne dévie pas.** Sa consigne le dit : sa mission est celle de son lancement ; les messages de l'utilisateur et les lignes ouvertes qu'il lit, ou dont il a hérité, s'adressent à l'agent principal et ne lui donnent aucun travail. La liste injectée à l'agent principal porte la mention « Pour l'orchestrateur seulement », parce qu'un sous-agent peut la voir sans en être le destinataire : avec Codex, il démarre avec une copie de la conversation de l'agent principal.
- **« Ouvert » ne veut pas dire « pas fait »**, mais « pas encore prouvé fait ». Un sous-agent qui constate qu'une ligne est déjà faite ne la ferme pas, il le signale : `note --fiche <ID> --genre deja-fait "C-0107 : la preuve"`. L'agent principal lit le signalement à son prochain événement, vérifie, et ferme la ligne par sa propre preuve. Deux autres signalements passent par le même chemin : `--genre bloque` et `--genre question`.

## Entre agents principaux

Chaque agent principal tient sa propre liste. Quand l'un voit dans la liste d'un autre une ligne déjà faite, qui le bloque ou qui pose question, il ne la modifie pas : il la signale.

```
node "<script>" signaler --agent claude --projet P C-0107 "corrigé par le commit abc1234"
node "<script>" signaler --agent codex --projet P C-0042 --genre question "quelle branche pour ce correctif ?"
```

Le signalement va dans la boîte de l'agent qui tient la liste (`contexte/.signalements/<agent>.jsonl`). Celui-ci le reçoit à son prochain événement dans ce projet, une seule fois ; tant que la ligne reste ouverte, le signalement revient avec sa liste au démarrage et après un compactage. Il vérifie, puis ferme la ligne par sa propre preuve, ou dit à l'utilisateur pourquoi elle reste ouverte. Un sous-agent ne signale pas à un autre agent : il le fait dans sa fiche, et son agent principal relaie s'il le faut.

## Où sont les données

Dans `~/.agent-memory-ledger`, jamais dans vos dépôts. Pour un autre emplacement : la variable `AGENT_MEMORY_LEDGER_HOME`.

| Variable | Effet |
| --- | --- |
| `AGENT_MEMORY_LEDGER_HOME` | dossier de la mémoire (défaut : `~/.agent-memory-ledger`) |
| `CONTEXT_LEDGER_SECOURS_DIR` | copie de secours du journal de la liste, de préférence sur un autre disque ; si le dossier principal est effacé, la liste est reconstruite depuis cette copie |
| `CONTEXT_LEDGER_SECOURS_SYNCHRONE` | `1` : la copie de secours est écrite par le hook lui-même, qui attend le disque. Sans cette valeur, un travailleur détaché la fait (défaut, quand `CONTEXT_LEDGER_SECOURS_DIR` est posé). Sert aux bancs, ou à qui veut la copie à jour avant chaque réponse du hook |
| `CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN` | délai, en minutes, du rappel en cours de tour des résultats de sous-agents non traités (défaut : 20) |
| `CONTEXT_LEDGER_BUDGET_MS` | budget de temps d'un hook de la liste de travail, en millisecondes, démarrage de node compris. À poser seulement si vous changez les délais des hooks : gardez-le sous le plus court (voir « Délais ») |
| `AML_DELAI_VERROU_MS` | délai, en millisecondes, d'attente du verrou des écritures de mémoire (défaut : 5000). Sert aux bancs ; il n'y a aucune raison d'y toucher |
| `AML_GARDES_SCRIPTS`, `AML_GARDES_EN_MUTATION`, `AML_GARDES_BASE_TESTS` | bancs seulement : dossier `scripts/` à tester, drapeau d'une exécution sur une copie mutée, dossier de travail des bancs des gardes. Ne jamais les poser |
| `AML_PANNE_TEST` | bancs seulement : `apres-premiere-ecriture` interrompt une transaction de mémoire après son premier fichier, pour prouver qu'elle est rejouée. Ne jamais le poser |
| `CONTEXT_LEDGER_SHELL` | shell dans lequel Codex lance ses commandes : `powershell` ou `bash`. Codex ne le dit pas aux hooks ; sans cette variable, la garde suppose PowerShell sous Windows et un shell POSIX ailleurs. À poser seulement si votre installation diffère (voir « Limites connues », garde) |

**Projets.** Le projet d'une session est le nom du dossier racine de son dépôt git (un worktree compte pour son dépôt). Pour regrouper plusieurs dossiers sous un nom, ou nommer un dossier qui n'est pas un dépôt, créez `projets.json` dans la maison :

```json
{ "projets": [ { "nom": "ma-boutique", "motif": "ma-boutique|boutique-admin" } ] }
```

Le motif est une expression régulière appliquée au chemin ; le premier qui correspond gagne. Un dépôt situé sous le dossier temporaire du système n'est pas pris pour un projet, sauf si la table le nomme. Hors de tout projet, la liste de travail range tout dans `_general`, et les hooks de mémoire ne font rien.

**Gardes.** Le réglage des trois gardes est dans `gardes.json`, dans la maison, facultatif (voir [Gardes](#gardes)).

## Ce que font les hooks

| Événement | Liste de travail | Mémoire |
| --- | --- | --- |
| Début de session | réinjecte les demandes et travaux rattachés à cette conversation, et redit les sous-agents finis non traités | règles du projet, résumé, journaux récents, alerte de travail non documenté |
| Message de l'utilisateur | enregistre mot pour mot (jamais le rapport de fin d'un sous-agent, remis sous la balise `agent-message`) ; redit en entier les sous-agents finis dont le résultat n'est pas traité | |
| Avant un outil | refuse l'écriture à la main dans la liste ; pour un sous-agent : lecture permise, écriture refusée ; un fichier à soi dont le texte cite la liste (un rapport) s'écrit quand même | |
| Après un outil | applique les preuves `[ctx]` (y compris celles d'un commit fait par un script, lu par la ligne que git écrit), dit tout de suite qu'un commit ne porte aucune mention, rappelle les preuves « partiel » répétées, suit les sous-agents lancés et relancés (Claude Code : le message qui fait repartir un agent déjà fini), annonce ceux qui viennent de finir et leurs commits (sans les appliquer), dit leurs signalements et ceux d'un autre agent principal, rappelle les résultats qui attendent, enregistre les réponses de l'utilisateur à un questionnaire (Claude Code) ; pour un sous-agent : lui rend sa fiche après un compactage de son contexte, ou lui donne sa consigne si son démarrage a manqué | journalise les commits (journal et résumé en une transaction), compte les éditions et les fichiers distincts |
| Fin de tour | rappel borné par message humain et par état des livraisons ; un état inchangé ne provoque pas de nouvelle continuation | point de contrôle toutes les deux heures |
| Démarrage d'un sous-agent | crée sa fiche et lui donne sa consigne | |
| Fin d'un sous-agent | marque son résultat « à traiter » | |
| Avant compactage | | sauve l'état des dépôts |
| Après compactage | réinjecte la liste (avec les sous-agents finis non traités) ; note le compactage d'un sous-agent, dont la fiche lui est rendue à son prochain outil | réinjecte les 6 dernières heures, sans les entrées automatiques |
| Fin de session | | entrée « wip » si du travail n'est pas commité |

Hooks des gardes (en plus du tableau ci-dessus) :

| Événement | Garde | Claude Code | Codex |
| --- | --- | --- | --- |
| Avant un outil de shell | sécurité des commandes et rappel avant commit (`scripts/gardes/securite.js --agent <agent>`) | `Bash`, `PowerShell` ; délai 30 s | tous les outils (seuls ceux qui portent une commande sont jugés : champs `command`, `cmd`, `script` ou `input`) ; délai 30 s |
| Avant une écriture ou une commande | caractères invisibles (`scripts/gardes/caracteres.js`) | `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `PowerShell` ; délai 10 s | tous les outils ; délai 15 s |
| Fin de tour | réponse sans caractère invisible (`scripts/gardes/caracteres.js --stop --agent <agent>`) | délai 10 s | délai 15 s |
| `git commit` (hook git natif) | rappel avant commit, quel que soit l'outil (`scripts/gardes/checklist-hook-git.js`) | à installer dans le dépôt | à installer dans le dépôt |

Tout texte destiné au modèle tient sous 9 000 caractères. Ce qui ne tient pas est coupé avec le chemin du texte complet, jamais en silence. Aucun hook ne bloque l'utilisateur sur une erreur interne, sauf la garde de la liste de travail et la garde de sécurité (avec le rappel avant commit), qui refusent en cas de doute ; la garde des caractères laisse passer quand son entrée est illisible.

### Délais

Un hook tué pour délai dépassé ne rend rien : ni rappel, ni refus. Chaque hook de la liste de travail s'arrête donc de lui-même avant son délai : ses attentes (verrou occupé, réessais) sont bornées par une échéance comptée depuis le démarrage du processus, et il rend ce qu'il a. Ce qu'il n'a pas eu le temps de faire l'est à l'événement suivant.

Sur une machine saturée, le démarrage de node suffit à dépasser dix secondes (mesuré : de 12,9 à 21,6 secondes, presque tout avant la première ligne du script). Les fichiers fournis donnent donc 30 secondes aux hooks de la liste de travail pour Claude Code (20 au début de session) et 20 secondes pour Codex (15 pour le message, le début de session et l'après-outil). Le budget interne est réglé un peu dessous. Si vous changez ces délais, posez `CONTEXT_LEDGER_BUDGET_MS` sous le plus court.

### Mise à jour depuis une version précédente

- **0.9.0, rien à refaire.** Les logiques pures du Cockpit et de ses modules sont ajoutées, sans effet tant qu'aucune commande ni aucun hook ne les appelle : le comportement des hooks et des gardes ne change pas.
- **0.8.0, les trois gardes sont actives dès la mise à jour.** Pour en désactiver une, créez `gardes.json` dans la maison (`~/.agent-memory-ledger`, ou `AGENT_MEMORY_LEDGER_HOME`) : `{ "securite": { "actif": false } }`, `{ "checklist": { "actif": false } }` ou `{ "caracteres": { "actif": false } }`, ensemble ou séparément. Sans ce fichier rien n'est à faire. Seul un `false` écrit comme tel éteint une garde : un fichier illisible, ou une valeur autre qu'un booléen, laisse les gardes actives avec leurs valeurs par défaut, et elles le disent. Le rappel avant commit refuse aussi un commit qui touche une migration, une fonction déployée à part, une variable d'environnement lue par le code ou une tâche planifiée : si vous ne voulez pas de ce rappel, éteignez-le, ou retirez les catégories qui ne vous concernent pas (voir [Gardes](#gardes)). Codex : `node scripts/installer-codex.js --appliquer` ajoute les nouveaux hooks, puis approuvez-les dans Codex.
- 0.7.0, liste de travail : la mention complète n'est plus annulée par un mot de travail non fini d'une autre proposition de la ligne (et « non terminée », « à vérifier » avec accent ou au féminin sont reconnus) ; un commit est lu après `Set-Location`, `cd` ou `$d = '...'; git -C $d`, et un commit fait par un script est lu par la ligne que git écrit ; un commit sans mention est dit tout de suite ; les preuves « partiel » sont comptées et rappelées toutes les cinq ; le commit d'un sous-agent est annoncé à l'agent principal sans rien fermer ; la demande de message suggéré de Codex n'est plus un message de l'utilisateur ; `ajouter` avertit d'une ligne qui porte plusieurs travaux, d'une réponse de questionnaire ou d'une consigne ; les fichiers temporaires d'écritures interrompues de plus d'une heure sont retirés au démarrage ; le rapport de fin d'un sous-agent, que l'application remet comme un tour de l'utilisateur (balise `agent-message`), ne reçoit plus de numéro M, et suit une nouvelle ligne si celle du sous-agent est close ; un sous-agent relancé après la clôture de sa ligne est suivi de nouveau (Claude Code : le hook d'après outil écoute aussi l'envoi de message à un agent, `SendMessage`), au lieu de voir son second rapport écarté ; un sous-agent fini dont le résultat n'est pas prouvé traité est redit en entier, avec le chemin de son résultat, à chaque nouveau message de l'utilisateur, au démarrage, à la reprise, avec la liste redonnée après un compactage et à l'arrivée d'un rapport (jamais sur un simple outil) ; la garde de lecture des sous-agents analyse les scripts de lecture (boucles, affectations, méthodes de lecture, `git` en lecture) ; la copie de secours est asynchrone (un travailleur détaché la fait ; `CONTEXT_LEDGER_SECOURS_SYNCHRONE=1` rend l'ancien comportement). Mémoire : les écritures du journal et du résumé passent sous un verrou, par remplacement atomique, et en une transaction rejouée si elle est interrompue ; le démarrage rappelle les 25 entrées les plus récentes par horodatage (et non les 25 premières lignes) ; le marqueur de travail non documenté compte les éditions et les fichiers distincts, et ignore une écriture échouée ; un point de contrôle ou un état avant compactage n'est écrit qu'une fois par minute. Rien à refaire : les fichiers existants restent lisibles (un marqueur ancien, sans liste de fichiers, s'affiche « fichiers distincts inconnus »).
- Claude Code : mettez le plugin à jour ; les deux nouveaux hooks (démarrage d'un sous-agent, après compactage) sont actifs à la session suivante.
- Codex : l'installateur ne modifie jamais un hook déjà en place, vos anciens délais (10 secondes) restent donc. Pour prendre les nouveaux : `node scripts/installer-codex.js --retirer --appliquer`, puis `node scripts/installer-codex.js --appliquer`, et approuvez de nouveau les hooks dans Codex. Si vous gardez les anciens délais, posez `CONTEXT_LEDGER_BUDGET_MS=8000` dans l'environnement où tourne Codex.

### Diagnostic

Pour connaître la forme et la durée réelles des événements que vos agents envoient aux hooks, créez un fichier vide nommé `actif` dans le dossier `agent-memory-ledger/capture-hooks` du dossier temporaire du système. Chaque hook de la liste de travail y ajoute alors une ligne dans `claude.jsonl` ou `codex.jsonl` : nom de l'événement, noms des champs reçus, identifiants, chemins, durée. Le contenu n'y est pas écrit (ni message, ni commande, ni réponse), à une exception près : pour un outil qui lance un sous-agent, la longueur et les 24 premiers caractères de quelques champs, ce qui suffit à voir si la mission arrive en clair ou chiffrée. Pour les autres outils, la ligne porte la forme de l'entrée, jamais sa valeur : noms des champs, type de la commande (texte, ou programme et options quand elle arrive en tableau) et shell s'il est nommé. Chaque hook y écrit aussi, dès son début, une ligne courte dans `claude.debuts.jsonl` ou `codex.debuts.jsonl` : un début sans fin au même numéro de processus est un hook tué par son délai, une absence des deux un hook jamais lancé. Supprimez le fichier `actif` pour arrêter.

## Gardes

Trois gardes protègent la machine et le dépôt de l'utilisateur, par opposition à la liste de travail qui protège la mémoire. Elles sont **actives par défaut**, sans fichier de réglage, avec des valeurs sûres et neutres. Elles sont branchées dans les hooks de Claude Code (`hooks/hooks.json`) et dans le modèle de hooks de Codex (`codex/hooks.modele.json`).

### Sécurité des commandes (`scripts/gardes/securite.js`)

Hook avant un outil de shell. Toutes les règles trouvées dans une commande sont rapportées d'un coup. Si la commande ne peut pas être analysée (entrée illisible, guillemet ou substitution jamais fermés, option globale de git inconnue), elle est refusée, avec la raison.

| Réaction | Règle |
| --- | --- |
| Refuse | suppression récursive forcée : `rm` avec option récursive et option de force, combinées (`-rf`), séparées (`-r ... -f`) ou longues ; formes Windows (`Remove-Item -Recurse -Force`, `rmdir`/`rd`/`del`/`erase` avec `/s`) |
| Refuse | `git clean` avec `-f` (fichiers non suivis supprimés, sans corbeille) |
| Refuse | `git reset --hard` |
| Refuse | poussée forcée : `--force`, `--force-with-lease`, `-f`, refspec en `+` ; même derrière `git -C`, `-c`, un alias, `env`, `sudo`, `bash -c`, `pwsh -Command`, `cmd /c` ou un sous-shell |
| Refuse | l'option de saut des vérifications de git (`--no-verify`), qui contourne les hooks, dont le rappel avant commit |
| Refuse | suppression ou renommage d'une branche protégée (motifs de `gardes.json`, aucun par défaut), en local et sur le dépôt distant |
| Refuse | `git commit` dont le diff préparé touche une catégorie du rappel avant commit sans confirmation pour ce diff exact (voir plus bas) |
| Refuse | `wrangler deploy` sans `--keep-vars` (règle d'outil, désactivable : `wrangler-keep-vars`) |
| Demande confirmation | `git push` (nom `poussee`) et `vercel --prod` (nom `deploiement-production`), plus les commandes que `gardes.json` ajoute |
| Signale | `vercel env add` sans `printf` : une valeur collée peut porter des sauts de ligne invisibles (règle d'outil, désactivable : `vercel-env-sans-printf`) |

Un exemple affiché n'est pas une commande : `echo "git push"`, `rg "git push"` ou `Set-Content -Value 'git push'` passent. Le corps d'un here-document (`<<'FIN'`) ou d'un here-string PowerShell (`@'` ... `'@`) est du texte, qui peut contenir une apostrophe isolée (un message de commit en français) : il est sauté, sauf si la ligne qui l'annonce nomme un interpréteur (`bash`, `sh`, `pwsh`, `python`, `iex`...), auquel cas il est lu comme des commandes. Les enveloppes que l'analyse ne sait pas ouvrir (`xargs`, `find -exec`, `Invoke-Expression`, `eval`, `Start-Process`, `python -c`...) retombent sur le texte : un `git push` qui y figure suffit à refuser.

**Confirmation selon l'agent.**
- Claude Code : la garde répond « ask », l'utilisateur tranche.
- Codex et les autres agents (tout agent dont `--agent` n'est pas `claude`, y compris un agent non nommé) : ils ne savent pas demander confirmation dans ce hook, la commande est donc **refusée**, sauf si l'utilisateur vient de l'ordonner dans son message du tour en cours. Ce message est lu dans la liste de travail (il faut donc que ses hooks tournent). Mots d'ordre par défaut : `push`, `pousse`... pour une poussée ; `deploy`, `déploie`, `mets en production`... pour un déploiement (ils se règlent). Une phrase négative, une question, un récit au passé, l'ordre d'un tour précédent, une session inconnue, une liste de travail illisible : refus. Un sous-agent ne pousse ni ne déploie jamais. Un ordre n'autorise jamais une poussée forcée ni une règle de refus.

### Rappel avant commit (`scripts/gardes/checklist-*.js`, `scripts/lib/checklist-commit.js`)

Un oubli fréquent : committer une migration jamais appliquée, une variable jamais posée, une fonction jamais déployée, une tâche planifiée jamais vérifiée. La garde lit le diff **préparé** (jamais le message de commit) et, si une catégorie sensible est touchée, refuse le commit tant que l'agent n'a pas confirmé, catégorie par catégorie, que l'action réelle est faite, **pour ce diff exact**.

Les quatre catégories par défaut (toutes règlables) :

| Nom | Déclencheur | Question posée |
| --- | --- | --- |
| `migrations` | un fichier préparé `migrations/**/*.sql` | schéma appliqué en réel sur la bonne base ? |
| `fonctions` | un fichier préparé sous `supabase/functions/` | fonction(s) déployée(s) en réel ? |
| `variables` | une ligne ajoutée qui lit une variable d'environnement (`process.env.NOM`, `Deno.env.get("NOM")`) | variable(s) posée(s) en réel dans chaque environnement ? |
| `taches` | une ligne ajoutée qui planifie une tâche de base (l'appel `cron` suivi de `.schedule(`, ou le nom de l'extension de planification `pg` suivi de `_cron`) | tâche(s) planifiée(s) vérifiée(s) active(s) sur la bonne base ? |

Le refus donne la commande de confirmation, avec le chemin réel du script du plugin. Trois réponses par catégorie : `oui` (fait et vérifié), `na` (non applicable, ou déjà prouvé plus tôt) et `non` (pas fait : documente l'état, **ne débloque pas**).

```
node "<plugin>/scripts/gardes/checklist-confirmer.js" --cwd="<dépôt>" --migrations=oui --variables=na
```

La confirmation est liée à l'empreinte du diff préparé (liste des fichiers et texte du diff) : toute modification de l'index, un fichier ajouté, retiré ou modifié, la rend caduque. Elle est écrite dans le dossier git du dépôt (`agent-memory-ledger-checklist.json`, dans `.git/worktrees/<nom>/` pour un worktree, qui a donc sa propre confirmation), jamais dans l'arbre de travail. **Lancez la confirmation seule, puis le commit dans une commande séparée.** `git commit --amend` n'est pas contrôlé (l'index est déjà figé).

**Hook git natif.** Les hooks d'agents peuvent laisser passer une commande (délai dépassé, outil non couvert, autre shell) ; sur l'installation d'origine, en mode automatique, un commit non confirmé est même passé malgré le refus du hook d'un agent (constat unique, jamais rejoué ici). Seul un hook git bloque réellement le commit, quel que soit l'outil, y compris un `git commit` tapé à la main. Dans le dépôt à protéger :

```sh
# .githooks/pre-commit
#!/bin/sh
node "<plugin>/scripts/gardes/checklist-hook-git.js" || exit 1
```

puis `git config core.hooksPath .githooks` (avec husky : la même ligne dans `.husky/pre-commit`). Le hook refuse aussi quand la vérification elle-même tombe en panne (index illisible) : il ne laisse jamais passer faute d'avoir pu vérifier.

### Caractères invisibles (`scripts/gardes/caracteres.js`)

Trois modes.
- **Avant une écriture** : refuse tout fichier, toute commande et tout patch dont le texte ÉCRIT contient un caractère invisible ou un « filigrane » typographique : espaces insécables, fines et larges, largeur nulle, marques de direction, caractères de tag, sélecteurs de variation, remplisseurs, séparateurs de ligne exotiques, contrôles C0 et C1. L'ancien texte (`old_string`), les chemins et les lignes retirées d'un patch ne sont jamais contrôlés : retirer un invisible reste possible. Exceptions étroites : une marque d'ordre des octets en tête de texte, une marque de direction dans un texte arabe, hébreu ou persan, un sélecteur de variation ou un liant de largeur nulle collé à un pictogramme, et la commande `node ... context-ledger.js` (elle cite mot pour mot les messages de l'utilisateur). Cette garde laisse passer quand son entrée est illisible : elle ne doit jamais bloquer les autres outils.
- **Ligne de commande** : `node scripts/gardes/caracteres.js --scan <fichier>...` liste les occurrences (code 1 s'il y en a), `--fix <fichier>...` les remplace (espace normale, saut de ligne, ou suppression).
- **Fin de tour** : `--stop` relit la dernière réponse de l'agent. Si elle contient un caractère interdit, la garde refuse une fois de finir le tour : l'agent doit redonner sa réponse corrigée. Un hook de fin de tour ne peut pas empêcher l'affichage : la réponse est déjà vue, il ne peut que forcer la correction. Une seule relance par message (`stop_hook_active`) ; les sous-agents ne sont pas contrôlés. Le tiret long (U+2014) n'est contrôlé que si `gardes.json` le demande (`caracteres.tiretLongFinDeTour`, faux par défaut). Un journal sans texte (agent, source, longueur, refus) est tenu dans `<maison>/etat/garde-caracteres-fin-de-tour.jsonl`.

### Réglage : `gardes.json`

Fichier facultatif dans la maison. Tout est facultatif aussi à l'intérieur.

```json
{
  "securite": {
    "actif": true,
    "branchesProtegees": ["^sauvegarde-", { "motif": "\\bPROD\\b", "casse": true }],
    "confirmer": ["poussee", "deploiement-production", { "nom": "publication", "motif": "\\bmon-outil\\s+publier\\b", "message": "Publication détectée.", "ordre": "deploiement" }],
    "ordreUtilisateur": { "actif": true, "motsPoussee": ["push", "pousse"], "motsDeploiement": ["deploy", "déploie"] },
    "reglesDesactivees": ["wrangler-keep-vars", "vercel-env-sans-printf"]
  },
  "checklist": {
    "actif": true,
    "categories": [
      { "nom": "migrations", "fichiers": "(^|/)schema/.*\\.sql$" },
      { "nom": "variables", "actif": false },
      { "nom": "secrets", "fichiers": "(^|/)secrets/", "contenu": "SECRET_[A-Z_]+", "libelle": "secrets du coffre", "question": "secret(s) créé(s) dans le coffre ?" }
    ]
  },
  "caracteres": { "actif": true, "tiretLongFinDeTour": false }
}
```

| Clé | Effet | Défaut |
| --- | --- | --- |
| `securite.actif`, `checklist.actif`, `caracteres.actif` | éteint une garde (seul `false` éteint) | `true` |
| `securite.branchesProtegees` | motifs (expressions régulières, sans casse sauf `"casse": true`) cherchés dans le texte des commandes git et dans chacun de leurs arguments, pour refuser la suppression ou le renommage d'une branche. Un motif invalide est cherché comme texte littéral | aucun : sans motif, seules la poussée forcée et les règles générales jouent |
| `securite.confirmer` | commandes qui demandent confirmation : `poussee`, `deploiement-production`, ou un objet `{ nom, motif, message, ordre }` (`ordre` : `poussee` ou `deploiement`, l'ordre de l'utilisateur qui la débloque chez un agent qui ne sait pas demander) | `["poussee", "deploiement-production"]` |
| `securite.ordreUtilisateur` | `false`, ou `{ actif, motsPoussee, motsDeploiement }` : fragments d'expressions régulières qui valent ordre. `false` : l'ordre de l'utilisateur ne débloque plus jamais rien, un agent sans confirmation ne pousse plus | actif, mots français et anglais |
| `securite.reglesDesactivees` | règles d'outil à éteindre : `wrangler-keep-vars`, `vercel-env-sans-printf`. Les règles générales ne se désactivent pas une à une | aucune |
| `checklist.categories` | une entrée par catégorie : `nom` (minuscules, chiffres, tirets), `fichiers` (motif sur le chemin d'un fichier préparé), `contenu` (motif sur les lignes ajoutées), `libelle`, `question`, `actif`. Un nom connu remplace les champs donnés de la catégorie par défaut ; `"actif": false` la retire ; un nom nouveau en ajoute une | les quatre catégories ci-dessus |
| `caracteres.tiretLongFinDeTour` | contrôle aussi le tiret long en fin de tour | `false` |

**Un `gardes.json` mal formé ne désarme jamais une garde.** Fichier illisible (JSON invalide, contenu qui n'est pas un objet) : les valeurs par défaut s'appliquent, les trois gardes restent actives, et chaque garde le dit dans son message (la garde des caractères le dit quand elle refuse). Valeur mal formée (un texte à la place d'un booléen, une liste attendue qui n'en est pas une, un motif invalide, une clé inconnue) : la valeur par défaut de cette seule clé est gardée et l'écart est rendu.

### Gardes et sous-agents

- La garde de sécurité juge les commandes d'un sous-agent comme celles de l'agent principal ; il ne peut jamais utiliser l'ordre de l'utilisateur pour pousser ou déployer.
- Le rappel avant commit s'applique aux commits de tout agent, sous-agents compris, et le hook git natif aussi.
- La garde des caractères contrôle les écritures de tous les agents ; le mode fin de tour ne contrôle pas les sous-agents.

Les règles que l'agent doit connaître (ne jamais contourner un refus, confirmer en deux commandes séparées) sont dans [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md).

## Ce qui est prouvé

Ce dépôt dit ce qui a été mesuré, et ce qui ne l'a pas été.

**Par bancs de tests** (sans modèle, payloads simulés) : les bancs historiques et leurs mutations sont complétés par `tests/anti-boucle.test.js`. Les nombres exacts et le résultat se lisent dans la sortie de la commande exécutée.

| Banc | Tests | Couvre |
| --- | --- | --- |
| `tests/anti-boucle.test.js` | 19 | perte de preuve, répétition des fins, périmètre de session, reçus, adaptateurs Claude Code et Codex |
| `tests/context-ledger-claude.test.js` | 107 | noyau et adaptateur Claude Code |
| `tests/context-ledger-fermeture.test.js` | 17 | fermeture des lignes : mentions, commits lus (dossiers, sortie d'un script), commit sans mention, preuves partielles, commits de sous-agents, conseils de `ajouter`, textes de machine, fichiers temporaires, rapports de sous-agents, sous-agents finis redits et sous-agents relancés |
| `tests/context-ledger-codex.test.js` | 72 | adaptateur Codex, sorties validées contre le schéma de codex-cli 0.155 |
| `tests/memoire.test.js` | 25 | hooks de mémoire, détection de projet, installateur Codex, verrou et transaction des écritures, entrées récentes, marqueur |
| `tests/verifier-public.test.js` | 6 | contrôle avant publication |
| `tests/gardes-securite.test.js` | 31 | garde de sécurité : chaque règle de refus, de confirmation et d'avertissement avec son cas voisin qui passe, options globales de git et alias, poussées enveloppées, here-documents, ordre de l'utilisateur chez Codex, analyse impossible, réglage, sorties validées contre le schéma de codex-cli 0.155, sortie en panne, hooks et installateur ; 30 mutations |
| `tests/gardes-checklist.test.js` | 15 | rappel avant commit sur de vrais dépôts git temporaires : détection, refus, confirmation, caducité du diff, worktree, hook git natif réel, vérification en panne, réglage ; 12 mutations |
| `tests/gardes-caracteres.test.js` | 16 | garde des caractères : chaque code de la liste, exceptions, Edit et patch, lignes de commande, fin de tour (transcription, anti-boucle, schéma de Stop), réglage ; 14 mutations |
| `tests/config-logique.test.js` | 42 | réglages du Cockpit (worktrees suivis, dossier des plans) et leur commande ; 171 mutations |
| `tests/regulateur-logique.test.js` | 41 | plafond d'agents, pause, relance, rappels ; 76 mutations |
| `tests/file-logique.test.js` | 78 | file d'attente des agents : mise en file, ordre, relances, purge, textes ; 268 mutations |
| `tests/consignes-logique.test.js` | 61 | consignes permanentes et verrous (poussée, déploiement, build mobile, agent) ; 248 mutations |
| `tests/nuit-logique.test.js` | 176 | absence de l'utilisateur : boîte de questions, arrêts de garde, enchaînement, récapitulatif ; 611 mutations |
| `tests/pause-logique.test.js` | 49 | pause coopérative des sessions et des agents ; 235 mutations |
| `tests/quota-logique.test.js` | 68 | fenêtres de quota, alertes, blocage, consigne, remise à zéro ; 163 mutations |
| `tests/modeles-agents-logique.test.js` | 4 | modèle imposé aux prochains sous-agents |
| `tests/mutations-fichier.test.js` | 7 | moteur commun des mutations : refuse un `require` relatif non réécrit |

Plus de cent quarante mutations y sont jouées pour la mémoire, la liste de travail et les gardes (dont 56 pour les gardes : 30, 12 et 14), et 1 772 pour les logiques du Cockpit (`npm run test:mutations`) : on casse volontairement une protection dans une copie du code (la garde, le dédoublonnage, le rappel, la restauration...) et le banc correspondant doit devenir rouge. Un banc qui reste vert quand le code est cassé ne prouve rien. Les bancs qui tiennent un verrou le posent à la première tentative du processus testé, pas avant son lancement, et ceux qui lancent dix processus à la fois vérifient que rien n'est perdu plutôt que tout aboutisse du premier coup : sous forte charge, node démarrait après la fin du verrou et une mutation restait verte, ou un message partait en copie de secours et le banc était rouge à tort. Les délais des processus qu'un banc lance sont des garde-fous larges, pas des mesures : une relance de contrôle qui demande cent secondes au repos dépassait trois minutes sous charge.

**En conditions réelles** :

- Claude Code (2.1.284, Windows 11) : l'enregistrement des messages, y compris ceux envoyés pendant un tour, la garde, le retrait sur preuve, le rappel de fin de tour, l'enregistrement des réponses à un questionnaire et la réinjection de la liste après deux compactages réels ont été observés en session réelle, sur l'installation dont ce code est issu. Sous-agents : dans une session qui en a lancé 24, chaque lancement a créé sa ligne et chaque fin a été marquée. Lus dans le transcript de l'agent principal : l'annonce d'une fin quatre secondes après (à l'outil suivant), le rappel en cours de tour vingt et une minutes après le précédent, puis le rappel à deux fins de tour de suite ; les 24 lignes ont ensuite été fermées sur preuve. C'est cette session qui a montré le défaut corrigé depuis : avant, un sous-agent fini pendant un tour long n'était rappelé qu'à la fin du tour, et 7 résultats avaient attendu plus de quatre heures sans rappel.
- Ce dépôt lui-même, chargé par `claude --plugin-dir` (Claude Code 2.1.214) : le hook réel a enregistré mot pour mot le message de la session, dans une maison de test.
- Codex (0.155), sur l'installation dont ce code est issu : les 24 conversations d'une même nuit ont été relues en entier (2 principales, 22 de sous-agents). Le texte des hooks arrive au modèle en message « developer », après un message de l'utilisateur, une commande, un patch, un outil de collaboration et un compactage. Lus dans ces conversations : les messages enregistrés, la liste réinjectée, 14 annonces de fin de sous-agent et 17 rappels en cours de tour reçus par l'agent principal, des lignes retirées sur preuve, et 19 fois une fiche rendue à un sous-agent après le compactage de son contexte (7 sous-agents). Sur 2 579 événements mesurés ensuite, le plus long a pris 2,6 secondes. La forme des événements a été vérifiée dans le code source de Codex ; les sorties sont validées contre le schéma de cette version.
- Cette même nuit a montré trois défauts, corrigés depuis : la garde refusait aux sous-agents jusqu'à la lecture de la liste ; un sous-agent compacté n'avait que le résumé pour retrouver sa mission (22 sous-agents Codex compactés de une à sept fois, 51 sous-agents Claude Code) ; et la consigne de démarrage n'arrivait qu'à 2 sous-agents Codex sur 22.
- Le lendemain, 12 sous-agents Codex lancés après ces correctifs : 11 ont reçu leur consigne, 9 à leur démarrage et 2 par le filet de leur premier outil ; leurs fiches portent 10 missions et 34 notes, avec un signalement « déjà fait » ; 75 recherches par `chercher` ; 99 fiches rendues après un compactage ; aucune liste de l'agent principal ne leur a été injectée. Deux défauts, corrigés depuis : le douzième n'a jamais eu sa consigne, parce que Codex a interrompu le hook de démarrage (délai de 5 secondes) après que celui-ci l'avait comptée comme donnée ; et 95 appels d'outil qui lisaient la liste leur ont été refusés en une soirée, surtout des boucles et des scripts PowerShell. Rejoués dans la garde actuelle, 17 de ces 95 passent ; pour les boucles, qui lisaient plusieurs lignes l'une après l'autre, `chercher` rend maintenant une ligne par son identifiant.
- Claude Code, un sous-agent d'essai : consigne reçue au démarrage, fiche créée avec sa mission copiée par le hook, note dans sa fiche, `chercher` et lecture de la liste acceptés, `ajouter` et note dans la fiche d'un autre refusés, signalement reçu par l'agent principal à son outil suivant.
- Quatre jours plus tard, une nuit de 10 sous-agents Codex (version 0.4.0), leurs conversations mesurées en entier : la consigne est arrivée aux 10 à leur démarrage et les 10 ont recopié leur mission dans leur fiche ; la fiche leur a été rendue après 54 compactages sur 56 ; chaque fin a été annoncée à l'agent principal en moins d'une minute, et une fin répétée n'a pas créé de seconde ligne ; une autre conversation du même projet n'a rien reçu de leurs livraisons. Sur 9 913 hooks mesurés, aucun n'a dépassé son délai (le plus long : une fin de sous-agent, 16,5 secondes). Lecture de la liste par ces sous-agents : 305 appels, 23 refusés.
- Cette nuit a montré trois défauts, corrigés dans la 0.5.0. La consigne de démarrage faisait écrire le sous-agent dans sa fiche alors que sa mission limitait l'écriture à un dossier : deux l'ont signalé, et l'agent principal a arrêté les dix. En fin de tour, le rappel des lignes ouvertes ou tenues à jour pendant le tour revenait à presque chaque tour (5 tours sur 7 dans une conversation de dépannage) : l'agent donnait une seconde réponse sans rien changer. Et le dossier de la copie de secours, sur un disque lent, était relu à chaque événement.
- Les 6 écritures de rapport refusées cette nuit-là (voir plus bas) ont été rejouées dans la garde de la 0.5.0, avec les 23 lectures refusées : 5 des 6 écritures passent, la sixième (un appel de bibliothèque) reste refusée et le refus dit par où passer ; les 23 lectures, toutes des scripts, restent refusées. Pour savoir dans quel shell partent ces commandes, la capture de diagnostic a été complétée puis lue : sur 1 483 commandes reçues par le hook avant leur exécution, Codex donne chaque fois le texte de la commande seul, sans nommer de shell ; et sur 4 718 commandes exécutées en trois jours dans 18 conversations, toutes sont parties dans PowerShell, y compris celles des 704 appels qui ne nommaient aucun shell. L'analyseur de PowerShell 7.6, consulté sans rien exécuter, a servi de référence pour les limites d'un here-string et a montré deux formes que la garde lisait mal (guillemet typographique, apostrophe dans un commentaire) : elles sont refusées depuis, et sur 5 447 commandes réelles, dont 510 regardées par la garde, ce refus ne change aucun verdict.

**Observé, et défavorable** : pendant cette nuit, aucun des 22 sous-agents Codex n'a écrit dans sa fiche, ni note ni mission, même après l'avoir reçue. Ils n'avaient pas eu la consigne de démarrage ; et Codex chiffre la mission partout (entrée des hooks, conversation du parent, conversation du sous-agent), le hook ne peut donc pas la copier à leur place. Avec Codex, la fiche rendue après un compactage ne portait ni mission ni notes : elle a servi à ne pas injecter la liste du parent et à redire au sous-agent de s'en tenir à sa mission. Avec Claude Code, la mission est copiée par le hook, sans dépendre du sous-agent. Lecture de la liste par ces sous-agents après le correctif : 235 lectures passées, 23 refusées (boucles et affectations PowerShell que la garde ne sait pas analyser ; avant le correctif : 17 refus sur 29). Le lendemain, les sous-agents qui avaient reçu leur consigne ont écrit dans leur fiche (voir plus haut).

Pendant la nuit des 10 sous-agents : ils n'ont presque rien noté de leur avancement (une ou deux notes chacun en quatre heures) ; l'agent principal n'a traité aucune des 49 livraisons en attente, malgré 14 rappels ; après chacun de ses 14 compactages, il a répondu de nouveau au dernier message de l'utilisateur ; en plus des 23 lectures refusées, la garde a refusé 6 fois à un sous-agent (5 d'entre eux) d'écrire son propre rapport, parce que son texte citait le chemin de la liste ou la commande de la liste ; chacun y a perdu un tour et trois ont écrit à l'agent principal. Les hooks gardent et rappellent : ils ne font pas converger un agent. Côté Claude Code, le même jour : un hook coupé à son délai de 30 secondes et un autre de 21 secondes, alors que node avait démarré en 41 millisecondes ; la cause n'est pas établie. Depuis, la capture de diagnostic écrit la durée de chaque étape (attente d'un verrou, copie de secours, transcript, preuves).

**Pas encore observé en conditions réelles** : les trois gardes de la 0.8.0 chargées par un vrai Claude Code ou un vrai Codex depuis ce dépôt (prouvées par bancs, sur des appels d'outils simulés, des sorties validées contre le schéma de hooks de codex-cli 0.155 et de vrais dépôts git temporaires ; le hook git natif, lui, a refusé et laissé passer de vrais `git commit` dans ces bancs) ; la réponse « ask » de Claude Code à une poussée ; le mode fin de tour dans une vraie session ; l'effet d'un refus de hook sur le tour de l'agent ; l'ordre de l'utilisateur lu dans la liste de travail d'un vrai tour de Codex ; l'écriture, par un vrai sous-agent, d'un rapport dont le texte cite la liste (prouvée par bancs, par le rejeu des 6 commandes réelles refusées, et par l'analyseur de PowerShell) ; la boîte de signalements entre agents principaux (prouvée par bancs) ; la consigne redonnée au premier outil quand le hook de démarrage a été interrompu après l'avoir comptée (prouvée par bancs ; sa recherche a été vérifiée sur les conversations réelles : trouvée dans les 11 où elle a été reçue, absente de la douzième) ; la garde élargie aux sous-expressions, aux blocs sans effet, aux boucles, aux affectations et aux méthodes de lecture, `chercher` par identifiant, la copie de secours asynchrone, la redite des sous-agents finis à chaque nouveau message, le suivi d'un sous-agent relancé après la clôture de sa ligne, et la lecture d'un commit par la sortie d'un script (prouvés par bancs) ; la fiche rendue à un sous-agent Claude Code après un compactage de son contexte ; l'installation par `/plugin install` ; les hooks d'outils et de fin de tour quand le code vient de ce dépôt plutôt que de l'installation d'origine ; macOS et Linux (développé et testé sous Windows 11, Node 22). Les hooks de mémoire sont une réécriture, commune aux deux agents, de hooks utilisés au quotidien : sous cette forme, ils sont prouvés par bancs.

Si vous constatez un écart, ouvrez un ticket avec le payload du hook : c'est lui qui tranche.

## Tests

```
npm test                      # tous les bancs ; long, chaque hook testé est un vrai processus (une demi-heure sur une machine chargée)
npm run test:rapide           # sans les mutations
npm run test:mutations        # les sept scripts de mutation des logiques du Cockpit, l'un après l'autre ; très long
node --test tests/memoire.test.js
```

Les bancs n'écrivent jamais dans votre mémoire : chaque test a sa propre maison sous le dossier temporaire.

## Avant de publier vos modifications

```
node scripts/verifier-public.js
node scripts/verifier-public.js --termes ~/mes-termes-prives.txt
```

Le premier contrôle cherche les chemins de profil, les chemins absolus, les adresses, les clés et les caractères invisibles. Le second ajoute votre liste de termes interdits (noms, projets, domaines), une expression par ligne, dans un fichier gardé hors du dépôt.

Les deux vérifient aussi la version du plugin : la même dans le manifeste, dans l'entrée de marketplace et dans `package.json`, et changée dès que le code a changé depuis votre dernière publication. Claude Code garde une installation sur la copie de la version installée tant que cette chaîne ne change pas : un correctif poussé sans la changer n'atteint personne. C'est arrivé à ce dépôt : trois correctifs publiés sous la version 0.1.0 n'ont atteint aucune installation existante avant la 0.2.0.

## Limites connues

- Seul l'agent principal écrit dans la liste. Un sous-agent lancé par un sous-agent n'est pas suivi : celui qui l'a lancé rend compte. Il a sa fiche, mais ses signalements ne sont pas relayés à l'agent principal.
- Codex : la mission d'un sous-agent est chiffrée partout où un hook peut la lire. C'est donc au sous-agent de la recopier dans sa fiche ; s'il ne l'a pas fait, sa fiche rendue après un compactage lui dit de la reprendre de son brief en fichier (sinon du résumé) et de le dire dans son rapport. Deux parades, côté agent principal : donner aussi la mission dans un fichier du dossier de travail, que le sous-agent pourra relire ; et copier ce fichier dans la fiche du sous-agent (`note --fiche <ID> --genre mission --fichier <brief>`), pour que la fiche rendue porte la mission. Quand la mission interdit d'écrire ailleurs que dans ses livrables, personne n'écrit dans la fiche : seul le fichier du brief, dans le dossier permis, rend la mission après un compactage.
- Garde, écriture d'un fichier à soi dont le texte cite la liste (le rapport d'un sous-agent) : une seule forme est reconnue, parce que c'est la seule que la garde sait prouver sans risque. En PowerShell : un here-string littéral (`@'` ... `'@`, où rien n'est développé ni exécuté) donné tel quel à `Set-Content`, `Add-Content` ou `Out-File`, par un tube, par `-Value`, ou par une variable qui l'a reçu ; une cible nommée par `-LiteralPath`, `-Path` ou `-FilePath`, en chemin complet, hors de la liste, fichier de texte (`.md`, `.txt`, `.json`, `.csv`, `.log`, `.yml`...) ; le reste de la commande ne fait que lire. Un garde-fou `if (Test-Path ...) { throw '...' }` est admis. Tout le reste est refusé comme avant (appel de bibliothèque, texte construit, cible calculée ou relative, script, here-string développé), et le refus dit par où passer : l'outil de fichier (patch, écriture), dont seul le chemin est jugé, reste ouvert dans tous les shells. En bash les mêmes caractères seraient du code : la forme n'est reconnue que si le shell est PowerShell. Claude Code le dit par le nom de l'outil. Codex ne le dit pas : la garde suppose PowerShell sous Windows et un shell POSIX ailleurs, `CONTEXT_LEDGER_SHELL` corrige ; un appel qui demanderait à Codex un autre shell que celui par défaut n'est pas visible des hooks.
- Garde, formes que PowerShell lit autrement : une commande qui porte un guillemet typographique là où PowerShell en ferait le début ou la fin d'une chaîne, ou un commentaire (`#` hors d'une chaîne), est refusée, même si elle a l'air d'une lecture. L'apostrophe typographique reste permise dans une chaîne entre guillemets doubles : le texte français d'une note passe.
- Garde : un sous-agent lit la liste par une commande simple : un fichier nommé, une sous-expression de lecture (`(Get-Content x).Count`), un bloc sans effet en fin de pipeline (`ForEach-Object { $_.Line }`, `ForEach-Object { '{0}: {1}' -f $_.LineNumber, $_.Line }`, `Where-Object { $_.Name -like 'C-*' }`), ou la commande `chercher`. Elle analyse aussi un script de lecture dont chaque étape ne fait que lire : une boucle `foreach`, une boucle `for` à bornes littérales (au plus 10 000 tours, indice jamais modifié), l'affectation d'une valeur lue (`$x = Get-Content ...`), un `if` / `else` dont la condition et le corps ne font que lire, les méthodes .NET de lecture d'une liste fixe (`ReadAllText`, `Combine`, `Trim`, `Split`...), et `git` en lecture avec `--no-textconv` (`status`, `log`, `show`, `diff`, `branch --list`, `grep`...). Tout ce qui peut écrire ou exécuter autre chose est refusé, parce que la garde ne sait pas prouver qu'il n'écrit pas : un appel de méthode hors de la liste (`.Delete()`), `Invoke-Expression`, `& $variable`, une chaîne seule (en bash, elle s'exécute), une redirection vers un fichier, un bloc qui contient autre chose que de la lecture, `Get-Content variable:`, et une variable passée à une commande qui reçoit un pipeline, qui pourrait porter un bloc exécuté pour chaque objet. Le refus dit ce qui passe, dont `chercher C-0151 C-0152` pour lire plusieurs lignes.
- Codex : le rappel de fin de tour passe par un blocage du Stop, une fois par message humain ou état des livraisons, pour deux motifs seulement : un message de l'utilisateur pas encore trié, un résultat de sous-agent pas encore traité. Une ligne ouverte ou tenue à jour pendant le tour ne bloque pas. Une tâche encore ouverte reste conservée ; l'absence de blocage ne signifie pas qu'elle est faite.
- Copie de secours : le hook ne touche pas à son dossier, qui peut être sur un disque lent ou en veille et lui faire dépasser son budget de temps. Il dépose un jalon dans la racine et détache un processus travailleur qui recopie les journaux ; la copie peut donc avoir quelques secondes de retard, et si la racine est effacée dans cet intervalle, la dernière écriture n'y est pas. Une panne du dossier est tracée dans la racine, dite au démarrage, et la prochaine écriture la rattrape. `CONTEXT_LEDGER_SECOURS_SYNCHRONE=1` rend la copie synchrone : le hook attend alors le disque, comme avant la 0.7.0. Seule la liste des projets de la copie est gardée à part, pour ne pas relire son dossier à chaque événement.
- Claude Code : le filet qui donne sa consigne à un sous-agent à son premier outil ne joue que pour les outils que le hook écoute (écriture de fichier, shell, lancement d'agent). Un sous-agent qui ne fait que lire ne la reçoit que par l'événement de démarrage.
- Codex : le filet « travail non commité » tourne à chaque fin de tour, parce que le délai de son événement de fin de session (une seconde par défaut, trois au plus) est trop court. Il n'écrit qu'une entrée par état.
- Claude Code : le filet de fin de session peut être annulé quand la session se ferme très vite (constaté une fois : « Hook cancelled »). Rien n'est perdu : le marqueur de travail non documenté reste, et l'alerte s'affiche au démarrage suivant.
- La détection d'un commit lit la ligne de commande, puis vérifie HEAD : un commit fait par un outil graphique n'est pas journalisé. Pour la liste de travail, un commit fait par un script n'est lu que si git en écrit la ligne sur la sortie (un commit lancé avec `-q` n'en écrit pas) et si le dépôt est cité par la commande ou est le dossier courant ; `--amend` n'est pas lu (ni par la liste, ni par le journal) : écrivez alors la mention dans l'historique.
- La mention d'un commit n'est jamais appliquée à la place d'un sous-agent : même avec `[ctx C-NNNN]`, son commit est seulement annoncé à l'agent principal.
- Gardes : un hook d'agent n'est pas une barrière absolue. Un hook tué pour délai dépassé ne rend rien (la commande passe), un outil que le hook ne couvre pas n'est pas jugé, et sur l'installation d'origine un commit non confirmé est passé malgré le refus d'un hook (voir « Gardes »). Seul le hook git natif bloque réellement un commit. Pour le reste, la garde est un filet, pas une prison : elle lit la ligne de commande, elle ne surveille pas ce qu'un script ou un programme lancé fait ensuite.
- Garde de sécurité : l'analyse lit du texte, pas un shell. Une commande construite dynamiquement (variable, fichier de script lancé, programme qui lance git) échappe à la lecture ; les enveloppes connues (`xargs`, `Invoke-Expression`, `eval`, `python -c`...) retombent sur le texte, les autres non. Les règles de refus généraux portent sur le texte de la commande : un message de commit qui cite `git reset --hard` en clair est refusé (écrivez le message dans un fichier avec `git commit -F`). Un message de commit en here-document ou here-string passe, avec ses apostrophes, si la ligne qui l'annonce ne nomme pas d'interpréteur.
- Garde de sécurité, Codex : l'ordre de l'utilisateur n'est lu que dans la liste de travail du tour en cours ; sans ses hooks (ou si leur délai est dépassé), la poussée est refusée, ce qui est le côté sûr.
- Rappel avant commit : la confirmation vaut pour l'index tel qu'il était quand elle a été donnée. Un `git commit -a` ou un commit qui nomme des fichiers (`--only`) change ce qui est réellement commité : le hook git natif voit l'index de ce commit-là et peut demander une nouvelle confirmation (raisonné d'après le fonctionnement de git, non mesuré). Les catégories par défaut sont celles d'un projet web avec une base ; ajoutez les vôtres dans `gardes.json`. Au-delà de 64 Mo de diff préparé, la lecture échoue et le commit est refusé comme une vérification en panne (non essayé).
- Garde des caractères : elle ne voit que le texte que l'outil écrit. Un fichier déjà sale n'est pas nettoyé de lui-même (`--scan`, `--fix`), et un outil qui écrit autrement que par les hooks couverts n'est pas contrôlé. Le mode fin de tour ne peut que demander une réponse corrigée : le texte fautif a déjà été affiché.
- Gardes : développées et testées sous Windows 11 avec Node 22 ; macOS et Linux non observés. Les bancs lancent de vrais processus `git` et `node`.

## Autres documents

- [docs/PROTOCOLE-MEMOIRE.md](docs/PROTOCOLE-MEMOIRE.md) : où vit la mémoire, formats, règles.
- [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md) : ce que sont le Cockpit et ses modules, ce qui est dans le dépôt à ce stade (les logiques pures), ce qui vient ensuite.
- [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md) : le bloc à copier dans vos instructions.
- [docs/GABARIT-BRIEF-SOUS-AGENT.md](docs/GABARIT-BRIEF-SOUS-AGENT.md) : un brief qui fait démarrer un sous-agent vite et rend compte de ce qu'il a lu.

## Licence

MIT. Les schémas de `tests/schemas-hooks-codex-0.155.json` proviennent de [Codex](https://github.com/openai/codex) (Apache-2.0) et ne servent qu'aux tests.
