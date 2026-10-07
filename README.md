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

La commande `etat` ne marque jamais une ligne « faite ». Le marqueur `[ctx C-NNNN]` dans un historique ou un commit reste compatible. Pour un rapport examiné, `traiter` exige un fichier portant le statut et le marqueur exacts ; il conserve l'exécutant, le vérificateur et le SHA-256 de la preuve. Les exemples, citations et mentions de travail non terminé ne valent pas clôture. Une garde refuse toute modification à la main de la liste, et une ligne effacée est restaurée depuis un journal en ajout seul.

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
| `CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN` | délai, en minutes, du rappel en cours de tour des résultats de sous-agents non traités (défaut : 20) |
| `CONTEXT_LEDGER_BUDGET_MS` | budget de temps d'un hook de la liste de travail, en millisecondes, démarrage de node compris. À poser seulement si vous changez les délais des hooks : gardez-le sous le plus court (voir « Délais ») |
| `CONTEXT_LEDGER_SHELL` | shell dans lequel Codex lance ses commandes : `powershell` ou `bash`. Codex ne le dit pas aux hooks ; sans cette variable, la garde suppose PowerShell sous Windows et un shell POSIX ailleurs. À poser seulement si votre installation diffère (voir « Limites connues », garde) |

**Projets.** Le projet d'une session est le nom du dossier racine de son dépôt git (un worktree compte pour son dépôt). Pour regrouper plusieurs dossiers sous un nom, ou nommer un dossier qui n'est pas un dépôt, créez `projets.json` dans la maison :

```json
{ "projets": [ { "nom": "ma-boutique", "motif": "ma-boutique|boutique-admin" } ] }
```

Le motif est une expression régulière appliquée au chemin ; le premier qui correspond gagne. Un dépôt situé sous le dossier temporaire du système n'est pas pris pour un projet, sauf si la table le nomme. Hors de tout projet, la liste de travail range tout dans `_general`, et les hooks de mémoire ne font rien.

## Ce que font les hooks

| Événement | Liste de travail | Mémoire |
| --- | --- | --- |
| Début de session | réinjecte les demandes et travaux rattachés à cette conversation | règles du projet, résumé, journaux récents, alerte de travail non documenté |
| Message de l'utilisateur | enregistre mot pour mot | |
| Avant un outil | refuse l'écriture à la main dans la liste ; pour un sous-agent : lecture permise, écriture refusée ; un fichier à soi dont le texte cite la liste (un rapport) s'écrit quand même | |
| Après un outil | applique les preuves `[ctx]`, suit les sous-agents lancés, annonce ceux qui viennent de finir, dit leurs signalements et ceux d'un autre agent principal, rappelle les résultats qui attendent, enregistre les réponses de l'utilisateur à un questionnaire (Claude Code) ; pour un sous-agent : lui rend sa fiche après un compactage de son contexte, ou lui donne sa consigne si son démarrage a manqué | journalise les commits, compte les fichiers modifiés |
| Fin de tour | rappel borné par message humain et par état des livraisons ; un état inchangé ne provoque pas de nouvelle continuation | point de contrôle toutes les deux heures |
| Démarrage d'un sous-agent | crée sa fiche et lui donne sa consigne | |
| Fin d'un sous-agent | marque son résultat « à traiter » | |
| Avant compactage | | sauve l'état des dépôts |
| Après compactage | réinjecte la liste ; note le compactage d'un sous-agent, dont la fiche lui est rendue à son prochain outil | réinjecte les 12 dernières heures |
| Fin de session | | entrée « wip » si du travail n'est pas commité |

Tout texte destiné au modèle tient sous 9 000 caractères. Ce qui ne tient pas est coupé avec le chemin du texte complet, jamais en silence. Aucun hook ne bloque l'utilisateur sur une erreur interne, sauf la garde, qui refuse en cas de doute.

### Délais

Un hook tué pour délai dépassé ne rend rien : ni rappel, ni refus. Chaque hook de la liste de travail s'arrête donc de lui-même avant son délai : ses attentes (verrou occupé, réessais) sont bornées par une échéance comptée depuis le démarrage du processus, et il rend ce qu'il a. Ce qu'il n'a pas eu le temps de faire l'est à l'événement suivant.

Sur une machine saturée, le démarrage de node suffit à dépasser dix secondes (mesuré : de 12,9 à 21,6 secondes, presque tout avant la première ligne du script). Les fichiers fournis donnent donc 30 secondes aux hooks de la liste de travail pour Claude Code (20 au début de session) et 20 secondes pour Codex (15 pour le message, le début de session et l'après-outil). Le budget interne est réglé un peu dessous. Si vous changez ces délais, posez `CONTEXT_LEDGER_BUDGET_MS` sous le plus court.

### Mise à jour depuis une version précédente

- Claude Code : mettez le plugin à jour ; les deux nouveaux hooks (démarrage d'un sous-agent, après compactage) sont actifs à la session suivante.
- Codex : l'installateur ne modifie jamais un hook déjà en place, vos anciens délais (10 secondes) restent donc. Pour prendre les nouveaux : `node scripts/installer-codex.js --retirer --appliquer`, puis `node scripts/installer-codex.js --appliquer`, et approuvez de nouveau les hooks dans Codex. Si vous gardez les anciens délais, posez `CONTEXT_LEDGER_BUDGET_MS=8000` dans l'environnement où tourne Codex.

### Diagnostic

Pour connaître la forme et la durée réelles des événements que vos agents envoient aux hooks, créez un fichier vide nommé `actif` dans le dossier `agent-memory-ledger/capture-hooks` du dossier temporaire du système. Chaque hook de la liste de travail y ajoute alors une ligne dans `claude.jsonl` ou `codex.jsonl` : nom de l'événement, noms des champs reçus, identifiants, chemins, durée. Le contenu n'y est pas écrit (ni message, ni commande, ni réponse), à une exception près : pour un outil qui lance un sous-agent, la longueur et les 24 premiers caractères de quelques champs, ce qui suffit à voir si la mission arrive en clair ou chiffrée. Pour les autres outils, la ligne porte la forme de l'entrée, jamais sa valeur : noms des champs, type de la commande (texte, ou programme et options quand elle arrive en tableau) et shell s'il est nommé. Chaque hook y écrit aussi, dès son début, une ligne courte dans `claude.debuts.jsonl` ou `codex.debuts.jsonl` : un début sans fin au même numéro de processus est un hook tué par son délai, une absence des deux un hook jamais lancé. Supprimez le fichier `actif` pour arrêter.

## Ce qui est prouvé

Ce dépôt dit ce qui a été mesuré, et ce qui ne l'a pas été.

**Par bancs de tests** (sans modèle, payloads simulés) : les bancs historiques et leurs mutations sont complétés par `tests/anti-boucle.test.js`. Les nombres exacts et le résultat se lisent dans la sortie de la commande exécutée.

| Banc | Tests | Couvre |
| --- | --- | --- |
| `tests/anti-boucle.test.js` | 19 | perte de preuve, répétition des fins, périmètre de session, reçus, adaptateurs Claude Code et Codex |
| `tests/context-ledger-claude.test.js` | 91 | noyau et adaptateur Claude Code |
| `tests/context-ledger-codex.test.js` | 62 | adaptateur Codex, sorties validées contre le schéma de codex-cli 0.155 |
| `tests/memoire.test.js` | 14 | hooks de mémoire, détection de projet, installateur Codex |
| `tests/verifier-public.test.js` | 6 | contrôle avant publication |

Cent deux mutations y sont jouées : on casse volontairement une protection dans une copie du code (la garde, le dédoublonnage, le rappel, la restauration...) et le banc correspondant doit devenir rouge. Un banc qui reste vert quand le code est cassé ne prouve rien. Les bancs qui tiennent un verrou le posent à la première tentative du processus testé, pas avant son lancement, et ceux qui lancent dix processus à la fois vérifient que rien n'est perdu plutôt que tout aboutisse du premier coup : sous forte charge, node démarrait après la fin du verrou et une mutation restait verte, ou un message partait en copie de secours et le banc était rouge à tort. Les délais des processus qu'un banc lance sont des garde-fous larges, pas des mesures : une relance de contrôle qui demande cent secondes au repos dépassait trois minutes sous charge.

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

**Pas encore observé en conditions réelles** : l'écriture, par un vrai sous-agent, d'un rapport dont le texte cite la liste (prouvée par bancs, par le rejeu des 6 commandes réelles refusées, et par l'analyseur de PowerShell) ; la boîte de signalements entre agents principaux (prouvée par bancs) ; la consigne redonnée au premier outil quand le hook de démarrage a été interrompu après l'avoir comptée (prouvée par bancs ; sa recherche a été vérifiée sur les conversations réelles : trouvée dans les 11 où elle a été reçue, absente de la douzième) ; la garde élargie aux sous-expressions et aux blocs sans effet, et `chercher` par identifiant (prouvés par bancs) ; la fiche rendue à un sous-agent Claude Code après un compactage de son contexte ; l'installation par `/plugin install` ; les hooks d'outils et de fin de tour quand le code vient de ce dépôt plutôt que de l'installation d'origine ; macOS et Linux (développé et testé sous Windows 11, Node 22). Les hooks de mémoire sont une réécriture, commune aux deux agents, de hooks utilisés au quotidien : sous cette forme, ils sont prouvés par bancs.

Si vous constatez un écart, ouvrez un ticket avec le payload du hook : c'est lui qui tranche.

## Tests

```
npm test                      # tous les bancs ; long, chaque hook testé est un vrai processus (une demi-heure sur une machine chargée)
npm run test:rapide           # sans les mutations
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
- Garde : un sous-agent lit la liste par une commande simple : un fichier nommé, une sous-expression de lecture (`(Get-Content x).Count`), un bloc sans effet en fin de pipeline (`ForEach-Object { $_.Line }`, `ForEach-Object { '{0}: {1}' -f $_.LineNumber, $_.Line }`, `Where-Object { $_.Name -like 'C-*' }`), ou la commande `chercher`. Une boucle, l'affectation du résultat d'une commande, un appel de bibliothèque, un appel de méthode ou une chaîne seule (en bash, elle s'exécute) sont refusés, parce que la garde ne sait pas prouver qu'ils n'écrivent pas ; de même une variable passée à une commande qui reçoit un pipeline, qui pourrait porter un bloc exécuté pour chaque objet. Le refus dit quoi utiliser à la place, dont `chercher C-0151 C-0152` pour lire plusieurs lignes.
- Codex : le rappel de fin de tour passe par un blocage du Stop, une fois par message humain ou état des livraisons, pour deux motifs seulement : un message de l'utilisateur pas encore trié, un résultat de sous-agent pas encore traité. Une ligne ouverte ou tenue à jour pendant le tour ne bloque pas. Une tâche encore ouverte reste conservée ; l'absence de blocage ne signifie pas qu'elle est faite.
- Copie de secours : chaque écriture du journal y est recopiée dans le même hook. Si son disque est lent ou en veille, cette écriture attend. Seule la liste de ses projets est gardée à part, pour ne pas relire son dossier à chaque événement.
- Claude Code : le filet qui donne sa consigne à un sous-agent à son premier outil ne joue que pour les outils que le hook écoute (écriture de fichier, shell, lancement d'agent). Un sous-agent qui ne fait que lire ne la reçoit que par l'événement de démarrage.
- Codex : le filet « travail non commité » tourne à chaque fin de tour, parce que le délai de son événement de fin de session (une seconde par défaut, trois au plus) est trop court. Il n'écrit qu'une entrée par état.
- Claude Code : le filet de fin de session peut être annulé quand la session se ferme très vite (constaté une fois : « Hook cancelled »). Rien n'est perdu : le marqueur de travail non documenté reste, et l'alerte s'affiche au démarrage suivant.
- La détection d'un commit lit la ligne de commande, puis vérifie HEAD : un commit fait par un outil graphique n'est pas journalisé.
- Ce dépôt ne contient pas de garde de commandes dangereuses. Il protège la liste de travail, pas votre machine.

## Autres documents

- [docs/PROTOCOLE-MEMOIRE.md](docs/PROTOCOLE-MEMOIRE.md) : où vit la mémoire, formats, règles.
- [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md) : le bloc à copier dans vos instructions.
- [docs/GABARIT-BRIEF-SOUS-AGENT.md](docs/GABARIT-BRIEF-SOUS-AGENT.md) : un brief qui fait démarrer un sous-agent vite et rend compte de ce qu'il a lu.

## Licence

MIT. Les schémas de `tests/schemas-hooks-codex-0.155.json` proviennent de [Codex](https://github.com/openai/codex) (Apache-2.0) et ne servent qu'aux tests.
