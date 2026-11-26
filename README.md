# agent-memory-ledger

Mémoire partagée et liste de travail pour agents de code. Fonctionne avec **Claude Code** et **Codex**, ensemble ou séparément, sur la même mémoire. Des hooks et des fichiers texte dans un dossier : ni service, ni base de données.

Le dépôt a trois parties. La première suffit à elle seule ; les deux autres s'ajoutent si vous les voulez.

| Partie | Ce qu'elle fait | À l'installation | Détail |
| --- | --- | --- | --- |
| **1. Mémoire et liste de travail** | chaque message de l'utilisateur est enregistré mot pour mot puis devient une ligne de travail, qui ne se retire que sur preuve écrite ; le résultat d'un sous-agent ne s'oublie plus ; l'historique survit aux compactages | active | ce README, [docs/PROTOCOLE-MEMOIRE.md](docs/PROTOCOLE-MEMOIRE.md), [docs/CLOTURE-ET-REPRISE.md](docs/CLOTURE-ET-REPRISE.md) |
| **2. Gardes** | refusent les commandes destructrices, demandent confirmation pour une poussée ou un déploiement de production, rappellent l'action réelle avant un commit sensible, refusent les caractères invisibles | actives, réglables et désactivables une à une | [Gardes](#gardes), [docs/GARDES.md](docs/GARDES.md) |
| **3. Cockpit et ses modules** | l'état du travail en une ligne, et cinq modules : Régulateur d'agents, Consignes, Nuit, Pause, Garde-quota | rien n'est branché : chaque pièce s'ajoute à la demande | [Le Cockpit et ses modules](#le-cockpit-et-ses-modules-facultatif), [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md), [docs/MODULES-INTERFACE.md](docs/MODULES-INTERFACE.md) |

Ce que chaque version a apporté, et ce qu'il faut refaire en la prenant : [CHANGELOG.md](CHANGELOG.md).

## Sommaire

- [Ce que le dépôt empêche de perdre](#ce-que-le-dépôt-empêche-de-perdre)
- [Comment ça marche](#comment-ça-marche)
- [Installation](#installation)
- [Démarrage en cinq minutes](#démarrage-en-cinq-minutes)
- [Utilisation](#utilisation)
- [Sous-agents](#sous-agents)
- [Entre agents principaux](#entre-agents-principaux)
- [Où sont les données](#où-sont-les-données)
- [Ce que font les hooks](#ce-que-font-les-hooks)
- [Gardes](#gardes)
- [Le Cockpit et ses modules (facultatif)](#le-cockpit-et-ses-modules-facultatif)
- [Ce qui est prouvé](#ce-qui-est-prouvé)
- [Tests](#tests)
- [Avant de publier vos modifications](#avant-de-publier-vos-modifications)
- [Limites connues](#limites-connues)
- [Autres documents](#autres-documents)

## Ce que le dépôt empêche de perdre

Un agent de code oublie de cinq façons. La mémoire et la liste de travail les ferment une par une.

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

La commande `etat` ne marque jamais une ligne « faite ». Le marqueur `[ctx C-NNNN]` dans un historique ou un commit reste compatible. Pour un rapport examiné, `traiter` exige un fichier portant le statut et le marqueur exacts ; il conserve l'exécutant, le vérificateur et le SHA-256 de la preuve. Les exemples, citations et mentions de travail non terminé ne valent pas clôture : un mot comme « en cours », « à faire » ou « non vérifié » annule une mention complète quand il est dans la même proposition qu'elle (entre deux « ; », points ou « | »), pas quand il est ailleurs dans la ligne. Un commit ne ferme une ligne que si son message porte la mention et que le hook retrouve son dépôt ; le commit d'un sous-agent ne ferme rien. Le détail est dans [docs/CLOTURE-ET-REPRISE.md](docs/CLOTURE-ET-REPRISE.md#ce-qui-ferme-une-ligne-et-ce-qui-la-laisse-ouverte). Une garde refuse toute modification à la main de la liste, et une ligne effacée est restaurée depuis un journal en ajout seul.

Les rappels automatiques portent sur la conversation courante. Les autres missions restent sur disque ; `reprendre --session <ID> C-NNNN` les rattache explicitement à une reprise. Un événement de fin reçu deux fois ne recrée pas un travail déjà traité. Le fonctionnement et les limites sont décrits dans [docs/CLOTURE-ET-REPRISE.md](docs/CLOTURE-ET-REPRISE.md).

La mémoire a trois étages, communs à tous les agents :

- `contexte/` : la liste de travail, par projet et par agent ;
- `history/<projet>.<agent>.md` : le journal détaillé, un fichier par agent ;
- `Memory-Auto.md` : le résumé commun, une ligne par événement.

Le détail est dans [docs/PROTOCOLE-MEMOIRE.md](docs/PROTOCOLE-MEMOIRE.md).

## Installation

Il faut git et Node.js 22.12 ou plus (développé et testé avec Node 22 ; les versions antérieures ne sont pas testées, et le Cockpit charge ses logiques, des modules ES, par `require`, ce que Node fait sans option depuis la 22.12, et sans avertissement depuis la 22.13).

### Claude Code

```
/plugin marketplace add Nasro-B/agent-memory-ledger
/plugin install agent-memory-ledger@agent-memory-ledger
```

Les hooks sont actifs à la session suivante. Le plugin apporte aussi le skill `liste-de-travail`, qui donne à l'agent les règles de la liste.

### Les modules d'interface de Claude Code (facultatif)

Six plugins de plus, dans `mods/`, que la marketplace du dépôt déclare : installez ceux que vous voulez.

```
/plugin install consignes@agent-memory-ledger
/plugin install garde-quota@agent-memory-ledger
/plugin install regulateur@agent-memory-ledger
/plugin install pause@agent-memory-ledger
/plugin install nuit@agent-memory-ledger
/plugin install cockpit@agent-memory-ledger
```

`regulateur`, `pause`, `nuit` et `cockpit` lancent un script du plugin `agent-memory-ledger` (`scripts/regulateur-file.js` ou `scripts/cockpit.js`) : ils le trouvent dans le plugin installé à côté d'eux ou dans le dépôt cloné, ou par la variable d'environnement `AML_PLUGIN_DIR` (le dossier du plugin). Tous lisent et écrivent le dossier d'état du Cockpit (`COCKPIT_DIR`, sinon `<maison>/cockpit`), le même que `scripts/cockpit.js`. Pour retirer un module : `/plugin uninstall <nom>@agent-memory-ledger` ; les fichiers d'état restent. Ce que chaque module change, comment le tester et ses limites : [docs/MODULES-INTERFACE.md](docs/MODULES-INTERFACE.md).

### Codex

Codex lit ses hooks dans `hooks.json`, dans son dossier de configuration. Clonez le dépôt à un endroit stable, puis :

```
node scripts/installer-codex.js              # montre ce qui serait ajouté, n'écrit rien
node scripts/installer-codex.js --appliquer  # écrit, après une copie de sauvegarde
```

L'installateur ne modifie ni ne déplace aucun hook existant : il ajoute les siens dans de nouveaux groupes, à la fin de chaque événement. Codex garde une approbation par hook, identifié par sa position ; vos approbations restent donc valables. Ouvrez ensuite Codex et approuvez les nouveaux hooks : tant que ce n'est pas fait, il ne les exécute pas.

Pour retirer : `node scripts/installer-codex.js --retirer --appliquer`. Pour un autre dossier de configuration : `--home <dossier>` (ou la variable `CODEX_HOME`).

#### Brancher le Cockpit dans Codex (facultatif)

Les hooks du Cockpit (état du travail injecté dans le contexte, plafond d'agents et file d'attente, consignes verrouillées, Nuit) ne sont pas dans les hooks de base : ils se branchent à la demande, après l'installation de base, par la même commande avec `--cockpit`.

```
node scripts/installer-codex.js --cockpit                          # montre l'état de chaque composant, n'écrit rien
node scripts/installer-codex.js --cockpit --appliquer              # branche les huit composants
node scripts/installer-codex.js --cockpit --appliquer --composant nuit             # un seul composant
node scripts/installer-codex.js --cockpit --appliquer --agent deepseek_H --home <dossier>
node scripts/installer-codex.js --cockpit --retirer --appliquer    # retire seulement ceux du Cockpit
node scripts/codex/brancher.js verifier --fichier <hooks.json> --agent codex --composant file
```

Comme l'installation de base, c'est un ajout de nouveaux groupes à la fin de chaque événement, avec une sauvegarde de `hooks.json` par composant (`hooks.json.avant-agent-memory-ledger-<composant>`, écrite une seule fois) : aucun hook existant n'est modifié ni déplacé. **À approuver dans Codex** : ouvrez Codex et approuvez chaque nouveau hook ; tant que ce n'est pas fait, il ne l'exécute pas. Les réglages que ces hooks appliquent (plafond, file, consignes, nuit, quota) s'écrivent avec `node scripts/cockpit.js` ; chaque composant, son événement et ce qu'il fait sont décrits dans [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md#brancher-dans-codex). Attention : `node scripts/installer-codex.js --retirer` (sans `--cockpit`) retire tous les hooks de ce dépôt, ceux du Cockpit compris.

### Les règles à donner à l'agent

Les hooks enregistrent, rappellent et gardent. L'agent doit savoir quoi en faire. Copiez dans vos fichiers d'instructions le bloc de [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md). Sans lui, l'agent voit la liste mais ne sait pas qu'elle fait foi.

## Démarrage en cinq minutes

1. Installez le plugin (Claude Code) ou lancez l'installateur (Codex), puis ouvrez une nouvelle session, de préférence dans un dépôt git : hors de tout projet, la liste de travail range tout dans `_general` et les hooks de mémoire ne font rien.
2. Écrivez une demande. Le hook l'enregistre mot pour mot sous un numéro `M-NNNN`, dans le dossier `contexte/` de la maison (`~/.agent-memory-ledger`), et la remet à l'agent avec la commande exacte à lancer.
3. L'agent en fait une ligne de travail (`ajouter --de M-NNNN "texte mot pour mot"`), fait le travail, puis écrit la preuve : la mention `[ctx C-NNNN]` dans son journal ou dans le message du commit. La ligne se retire de la liste sur cette preuve, et seulement sur elle.
4. Copiez dans vos fichiers d'instructions le bloc de [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md) : sans lui, l'agent voit la liste mais ne sait pas qu'elle fait foi.

Trois commandes suffisent pour suivre ce qui se passe (`<script>` est donné plus bas, et les hooks l'affichent avec son chemin exact) :

```
node "<script>" lister --projet P --session ID      # ce qui reste ouvert pour cette conversation
node "<script>" chercher --projet P "mot"           # les lignes et les messages qui contiennent le mot
node "<script>" etat --projet P C-0107 en-cours "note"   # dire où en est une ligne, sans jamais la fermer
```

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
| `CONTEXT_LEDGER_DIR` | dossier de la liste de travail (défaut : `contexte/` dans la maison) |
| `COCKPIT_DIR` | dossier d'état du Cockpit : réglages, mesures, états des modules (défaut : `cockpit/` dans la maison) |
| `AML_CODEX_BINAIRE` | chemin du binaire de Codex pour la lecture native du quota (défaut : le premier `codex` du `PATH`, `codex.exe` sous Windows). Le dossier de configuration de Codex est `CODEX_HOME`, sinon `~/.codex`. Sans binaire trouvé, la lecture native est indisponible et le quota se lit dans le rollout |
| `COCKPIT_QUOTA_NATIVE` | `0` coupe la lecture native du quota de Codex |
| `CONTEXT_LEDGER_SECOURS_DIR` | copie de secours du journal de la liste, de préférence sur un autre disque ; si le dossier principal est effacé, la liste est reconstruite depuis cette copie |
| `CONTEXT_LEDGER_SECOURS_SYNCHRONE` | `1` : la copie de secours est écrite par le hook lui-même, qui attend le disque. Sans cette valeur, un travailleur détaché la fait (défaut, quand `CONTEXT_LEDGER_SECOURS_DIR` est posé). Sert aux bancs, ou à qui veut la copie à jour avant chaque réponse du hook |
| `CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN` | délai, en minutes, du rappel en cours de tour des résultats de sous-agents non traités (défaut : 20) |
| `CONTEXT_LEDGER_BUDGET_MS` | budget de temps d'un hook de la liste de travail, en millisecondes, démarrage de node compris. À poser seulement si vous changez les délais des hooks : gardez-le sous le plus court (voir « Délais ») |
| `AML_DELAI_VERROU_MS` | délai, en millisecondes, d'attente du verrou des écritures de mémoire (défaut : 5000). Sert aux bancs ; il n'y a aucune raison d'y toucher |
| `AML_GARDES_SCRIPTS`, `AML_GARDES_EN_MUTATION`, `AML_GARDES_BASE_TESTS` | bancs seulement : dossier `scripts/` à tester, drapeau d'une exécution sur une copie mutée, dossier de travail des bancs des gardes. Ne jamais les poser |
| `COCKPIT_CORE_TESTE`, `COCKPIT_CLI_TESTE`, `CONSIGNES_CORE_TESTE`, `REGULATEUR_CORE_TESTE`, `QUOTA_CORE_TESTE`, `QUOTA_NATIVE_TESTE`, `PAUSE_CORE_TESTE`, `NUIT_CORE_TESTE`, `AGENTS_NOMS_TESTE` | bancs seulement : noyau, ligne de commande ou module à tester (une copie altérée, pour les preuves par mutation). Ne jamais les poser |
| `NUIT_GARDE`, `NUIT_GARDE_DELAI_MS`, `NUIT_VERROU_DELAI_MS` | bancs seulement : une fausse garde de sécurité à la place de `scripts/gardes/securite.js` que la Nuit interroge, le délai de cette garde, le délai d'attente du verrou de la Nuit. Ne jamais les poser |
| `AML_PANNE_TEST` | bancs seulement : `apres-premiere-ecriture` interrompt une transaction de mémoire après son premier fichier, pour prouver qu'elle est rejouée. Ne jamais le poser |
| `CONTEXT_LEDGER_SHELL` | shell dans lequel Codex lance ses commandes : `powershell` ou `bash`. Codex ne le dit pas aux hooks ; sans cette variable, la garde suppose PowerShell sous Windows et un shell POSIX ailleurs. À poser seulement si votre installation diffère (voir [docs/LIMITES.md](docs/LIMITES.md), garde) |

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

Ce que chaque version apporte et ce qu'il faut refaire, ou non, en la prenant : [CHANGELOG.md](CHANGELOG.md). En bref : les trois gardes sont actives dès la 0.8.0 (pour en éteindre une, voir [Gardes](#gardes)), et la 0.8.0 demande à Codex `node scripts/installer-codex.js --appliquer` puis l'approbation des nouveaux hooks ; rien du Cockpit ne se branche de lui-même, les versions 0.9.0 à 0.13.0 ne changent donc rien tant que vous ne branchez rien.

### Diagnostic

Pour connaître la forme et la durée réelles des événements que vos agents envoient aux hooks, créez un fichier vide nommé `actif` dans le dossier `agent-memory-ledger/capture-hooks` du dossier temporaire du système. Chaque hook de la liste de travail y ajoute alors une ligne dans `claude.jsonl` ou `codex.jsonl` : nom de l'événement, noms des champs reçus, identifiants, chemins, durée. Le contenu n'y est pas écrit (ni message, ni commande, ni réponse), à une exception près : pour un outil qui lance un sous-agent, la longueur et les 24 premiers caractères de quelques champs, ce qui suffit à voir si la mission arrive en clair ou chiffrée. Pour les autres outils, la ligne porte la forme de l'entrée, jamais sa valeur : noms des champs, type de la commande (texte, ou programme et options quand elle arrive en tableau) et shell s'il est nommé. Chaque hook y écrit aussi, dès son début, une ligne courte dans `claude.debuts.jsonl` ou `codex.debuts.jsonl` : un début sans fin au même numéro de processus est un hook tué par son délai, une absence des deux un hook jamais lancé. Supprimez le fichier `actif` pour arrêter.

## Gardes

Trois gardes protègent la machine et le dépôt de l'utilisateur, par opposition à la liste de travail qui protège la mémoire. Elles sont **actives par défaut**, sans fichier de réglage.

| Garde | Ce qu'elle fait |
| --- | --- |
| Sécurité des commandes | refuse les commandes destructrices (suppression récursive forcée, `git reset --hard`, `git clean -f`, poussée forcée, saut des vérifications de git, suppression d'une branche protégée) ; demande confirmation pour `git push` et pour un déploiement de production |
| Rappel avant commit | refuse un commit dont le diff préparé touche une migration, une fonction déployée à part, une variable d'environnement ou une tâche planifiée, tant que l'agent n'a pas confirmé l'action réelle pour ce diff exact |
| Caractères invisibles | refuse toute écriture dont le texte contient un caractère invisible ou un « filigrane » typographique, et relit la réponse de l'agent en fin de tour |

Pour en éteindre une, créez `gardes.json` dans la maison (`~/.agent-memory-ledger`, ou `AGENT_MEMORY_LEDGER_HOME`) :

```json
{ "checklist": { "actif": false } }
```

Seul un `false` écrit comme tel éteint une garde, et un `gardes.json` mal formé n'en désarme jamais une. Chaque règle, le réglage complet, le hook git natif (le seul qui bloque réellement un commit) et le cas des sous-agents : [docs/GARDES.md](docs/GARDES.md).

## Le Cockpit et ses modules (facultatif)

Le Cockpit mesure l'état réel du travail (la liste de travail de chaque agent, les sous-agents en cours, finis ou à traiter, l'état git des dépôts suivis, l'avancement des plans à cases, le quota) et le rend en une ligne. Cinq modules partagent son dossier d'état :

| Module | Ce qu'il fait |
| --- | --- |
| Régulateur d'agents | plafond d'agents en parallèle, pause, file d'attente des agents refusés par le plafond, relance des agents échoués, modèle imposé par type de sous-agent |
| Consignes | les ordres permanents de l'utilisateur, rappelés à chaque requête, avec des verrous qui refusent ce que le code sait reconnaître (poussée, déploiement, build mobile, nouvel agent) |
| Nuit | quand l'utilisateur est absent : les questions bloquantes vont dans une boîte, les arrêts de garde deviennent des refus avec alternative, le travail continue sur les lignes ouvertes de la liste, un récapitulatif attend le réveil |
| Pause | suspendre une session ou un agent sans le tuer, puis le reprendre ; la pause est coopérative |
| Garde-quota | les fenêtres de quota, des alertes à 80 % puis 90 % (réglables), le blocage des nouveaux agents au seuil critique |

Rien n'est branché d'office : qui n'utilise que la mémoire et la liste de travail n'a rien à faire. Trois façons de s'en servir, de la plus légère à la plus complète :

- **La ligne de commande.** `node scripts/cockpit.js ligne` rend l'état en une ligne ; `politique`, `quota`, `consignes`, `nuit`, `pause`, `reprendre` et `config` règlent les modules. Elle n'écrit que dans le dossier d'état du Cockpit (`COCKPIT_DIR`, sinon `cockpit/` dans la maison), jamais dans vos dépôts, vos plans ou votre liste de travail.
- **Codex.** `node scripts/installer-codex.js --cockpit --appliquer` branche les hooks du Cockpit, du Régulateur, des Consignes et de la Nuit (voir [Brancher le Cockpit dans Codex](#brancher-le-cockpit-dans-codex-facultatif)). La Pause n'a pas de hook de Codex.
- **Claude Code.** Six plugins facultatifs et indépendants (voir [Les modules d'interface de Claude Code](#les-modules-dinterface-de-claude-code-facultatif)).

Les réglages sont communs : une valeur posée par la ligne de commande est appliquée par les hooks de Codex et par les modules de Claude Code, et une valeur posée dans Claude Code (`/plafond`, `/quota`, `/consignes`) est lue par la ligne de commande. Le détail de chaque module, de ses fichiers d'état et de ses commandes est dans [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md) ; celui des six modules de Claude Code, dans [docs/MODULES-INTERFACE.md](docs/MODULES-INTERFACE.md).

## Ce qui est prouvé

Ce dépôt dit ce qui a été mesuré, et ce qui ne l'a pas été. Le détail est dans [docs/PREUVES.md](docs/PREUVES.md) : la table des bancs, ce qui a été observé en session réelle (y compris ce qui s'est mal passé) et ce qui n'a pas encore été observé.

- **Par bancs** (à la 0.13.0) : 1 621 tests dans `npm test` et 474 pour les six modules d'interface (`npm run test:mods`), sans modèle, sur des événements simulés. Des preuves par mutation les accompagnent : on casse volontairement une protection dans une copie du code, et le banc doit rougir. 3 158 mutations pour le Cockpit (`npm run test:mutations`), 1 081 pour les modules d'interface (`npm run test:mutations-mods`), et celles de la mémoire, de la liste de travail et des gardes, jouées par leurs bancs.
- **En conditions réelles** : la mémoire et la liste de travail, observées avec Claude Code et Codex sur l'installation dont ce code est issu.
- **Pas encore observé en conditions réelles** : les trois gardes, les hooks de Codex du Cockpit et les six modules d'interface chargés depuis ce dépôt ; macOS et Linux.

## Tests

```
npm test                      # tous les bancs de Node ; long, chaque hook testé est un vrai processus (un quart d'heure environ, davantage sur une machine chargée)
npm run test:rapide           # les mêmes, sans leurs mutations
node --test tests/memoire.test.js   # un seul banc
npm run test:mutations        # les trente scripts de mutation du Cockpit (logiques, noyaux, commandes, hooks de Codex, emplacements des modules), l'un après l'autre ; très long
npm run test:mods             # les bancs des six modules d'interface de Claude Code, par `claude plugin test` (le moteur : AML_MOTEUR_CLAUDE, sinon la commande claude) ; hors de `npm test`
npm run test:mutations-mods   # les six scripts de mutation des modules, l'un après l'autre ; long
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

La liste complète est dans [docs/LIMITES.md](docs/LIMITES.md). Les principales :

- Seul l'agent principal écrit dans la liste. Un sous-agent lancé par un sous-agent n'est pas suivi : celui qui l'a lancé rend compte.
- Codex chiffre la mission d'un sous-agent partout où un hook peut la lire : c'est au sous-agent de la recopier dans sa fiche.
- Un hook d'agent n'est pas une barrière absolue : un hook tué pour délai dépassé ne rend rien, et un outil que le hook ne couvre pas n'est pas jugé. Seul le hook git natif bloque réellement un commit.
- La garde de sécurité lit du texte, pas un shell : une commande construite dynamiquement échappe à la lecture.
- Les hooks gardent et rappellent : ils ne font pas converger un agent.
- Les hooks de Codex du Cockpit et les six modules d'interface de Claude Code sont prouvés par bancs ; aucun n'a encore été observé dans une vraie session depuis ce dépôt.
- Développé et testé sous Windows 11 avec Node 22 ; macOS et Linux non observés.

## Autres documents

- [CHANGELOG.md](CHANGELOG.md) : ce que chaque version apporte, et ce qu'il faut refaire en la prenant.
- [docs/PROTOCOLE-MEMOIRE.md](docs/PROTOCOLE-MEMOIRE.md) : où vit la mémoire, formats, règles.
- [docs/CLOTURE-ET-REPRISE.md](docs/CLOTURE-ET-REPRISE.md) : ce qui ferme une ligne et ce qui la laisse ouverte, les reprises par conversation, les limites.
- [docs/GARDES.md](docs/GARDES.md) : les trois gardes, règle par règle, leur réglage (`gardes.json`), le hook git natif, les sous-agents.
- [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md) : ce que sont le Cockpit et ses modules, ce qui est dans le dépôt à ce stade (les logiques pures, le noyau du Cockpit, les noyaux des cinq autres modules, la ligne de commande complète et les hooks de Codex), comment brancher, vérifier et retirer chaque composant dans Codex.
- [docs/MODULES-INTERFACE.md](docs/MODULES-INTERFACE.md) : les six modules d'interface de Claude Code (`mods/`) : ce que chacun branche, comment les installer et les retirer, où ils lisent, écrivent et lancent (dossier d'état, script du plugin), les bancs, les mutations et les limites.
- [docs/PREUVES.md](docs/PREUVES.md) : la table des bancs, ce qui a été observé en session réelle, ce qui ne l'a pas encore été.
- [docs/LIMITES.md](docs/LIMITES.md) : toutes les limites connues.
- [docs/REGLES-POUR-AGENTS.md](docs/REGLES-POUR-AGENTS.md) : le bloc à copier dans vos instructions.
- [docs/GABARIT-BRIEF-SOUS-AGENT.md](docs/GABARIT-BRIEF-SOUS-AGENT.md) : un brief qui fait démarrer un sous-agent vite et rend compte de ce qu'il a lu.

## Licence

MIT. Les schémas de `tests/schemas-hooks-codex-0.155.json` proviennent de [Codex](https://github.com/openai/codex) (Apache-2.0) et ne servent qu'aux tests.
