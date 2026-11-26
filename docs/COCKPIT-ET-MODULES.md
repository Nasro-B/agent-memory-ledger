# Le Cockpit et ses modules

Le Cockpit est le nom donné à l'ensemble des réglages et des états que les agents partagent sur une machine : combien d'agents à la fois, ce qu'ils n'ont pas le droit de faire, ce qu'ils font quand l'utilisateur est absent, ce qui est en pause, où en est le quota. Chaque module est découpé en deux : une **logique pure** et un **noyau d'entrées-sorties** qui l'appelle.

## Ce qui est dans le dépôt à ce stade

- les **logiques pures** des huit modules, avec leurs bancs et leurs preuves par mutation ;
- le **noyau du Cockpit** (`scripts/lib/cockpit-core.js`), qui lit l'état réel du travail et le rend en une ligne ou en un bloc ;
- le noyau des **modèles par agent** (`scripts/lib/modeles-agents-core.js`) ;
- les **noyaux d'entrées-sorties** des cinq modules qui ont un état à eux : le Régulateur d'agents et sa file d'attente (`regulateur-core.js`), les Consignes (`consignes-core.js`), le Garde-quota (`quota-core.js`, avec sa lecture native `quota-native.cjs`), la Pause (`pause-core.js`) et la Nuit avec sa boîte (`nuit-core.js`) ; ils lisent et écrivent l'état dans le dossier d'état du Cockpit et appellent les logiques pures ;
- la **ligne de commande** complète (`scripts/cockpit.js`) : `ligne`, `instantane`, `rafraichir-git`, `politique`, `quota`, `config` (dont `config modeles`), `consignes`, `nuit`, `nuit-hook`, `pause`, `reprendre` et `pause-hook` ;
- la conversion des noms d'agents en clés d'état (`scripts/lib/agents-noms.js`, voir plus bas) ;
- les **six modules d'interface de Claude Code** (`mods/`, voir `docs/MODULES-INTERFACE.md`), qui branchent ces noyaux dans Claude Code ;
- les **hooks de Codex** (`scripts/codex/cockpit.js`, `regulateur.js`, `consignes.js` et `nuit.js`), l'outil qui les branche, les retire ou les vérifie dans le `hooks.json` de Codex (`scripts/codex/brancher.js`, et `node scripts/installer-codex.js --cockpit`), le point d'entrée de la file d'attente pour un autre processus (`scripts/regulateur-file.js`) et l'outil qui recopie une logique commune dans les modules qui en embarquent une copie (`scripts/synchroniser-mods.js`). Voir « Brancher dans Codex » plus bas.

Pour **Claude Code**, ces noyaux se branchent par les six modules d'interface de `mods/` (`docs/MODULES-INTERFACE.md`), qui sont facultatifs : sans eux, les noyaux se pilotent à la main, par la ligne de commande : le Régulateur ne limite aucun agent, les consignes ne sont rappelées ni vérifiées, le quota n'est lu par personne, la pause ne retient aucune session et la Nuit ne transforme aucune question en refus. Pour Codex, les hooks sont dans le dépôt mais **ne sont jamais branchés d'eux-mêmes** : `node scripts/installer-codex.js` (les hooks de base) ne les ajoute pas, et tant qu'ils ne sont pas branchés puis approuvés dans Codex, rien ne les appelle. Les commandes `nuit-hook` et `pause-hook` sont la forme d'appel des modules Nuit et Pause de Claude Code (un JSON lu sur l'entrée standard, un JSON rendu sur une ligne). Le Cockpit, lui, lit les fichiers d'état de tous les modules et les dit, sans jamais les écrire.

| Module | Fichier | Ce qu'il décide |
| --- | --- | --- |
| Réglages du Cockpit | `scripts/lib/config-logique.mjs` | les dépôts de travail suivis (« worktrees ») et le dossier des plans ; la commande `cockpit config`. Par défaut : aucun worktree, aucun dossier de plans, profondeur de recherche 3 |
| Régulateur | `scripts/lib/regulateur-logique.mjs` | combien d'agents tournent en parallèle (1 à 50, ou libre), la pause, la relance des agents échoués, la mise en file ; la commande `/plafond` |
| File d'attente | `scripts/lib/file-logique.mjs` | un agent refusé par le plafond attend son tour, le suivant est lancé dès qu'un créneau se libère, un agent échoué est relancé deux fois au plus |
| Consignes | `scripts/lib/consignes-logique.mjs` | les ordres permanents de l'utilisateur, rappelés à chaque requête, et leurs verrous (`push`, `deploiement`, `rebuild`, `agent`) qui refusent ce que le code sait reconnaître ; la commande `/consignes` |
| Nuit | `scripts/lib/nuit-logique.mjs` | quand l'utilisateur est absent : les questions bloquantes vont dans une boîte, les arrêts de garde deviennent des refus avec alternative, le travail continue sur les lignes ouvertes de la liste de travail, un récapitulatif attend le réveil ; la commande `/nuit` |
| Pause | `scripts/lib/pause-logique.mjs` | suspendre une session ou un agent sans le tuer, puis le reprendre. La pause est coopérative : elle retient la boucle avant sa prochaine étape, une réponse ou un outil déjà en cours va jusqu'au bout ; les commandes `/pause` et `/reprendre` |
| Quota | `scripts/lib/quota-logique.mjs` | les fenêtres de quota que le moteur rapporte, les alertes à 80 % puis 90 % (réglables), le blocage des nouveaux agents au seuil critique, la consigne au modèle, la remise à zéro ; la commande `/quota` |
| Modèles par agent | `scripts/lib/modeles-agents-logique.mjs` | le modèle imposé aux prochains sous-agents, par type de sous-agent ou par défaut ; ne réécrit jamais un lancement qui a déjà son modèle, un fork, un workflow ni un coéquipier |

## Le noyau du Cockpit

Il mesure l'état réel du travail et le rend en une ligne (`ligneCockpit`) ou en un bloc de 700 caractères au plus (`blocCockpit`, fait pour être injecté dans le contexte d'un agent). Il ne modifie jamais un dépôt, un plan ni la liste de travail : les seuls fichiers qu'il écrit sont les siens (voir plus bas).

| Ce qu'il mesure | D'où il le lit |
| --- | --- |
| La liste de travail de chaque agent | `<maison>/contexte/.etat/<projet>.<agent>.json` (ou `CONTEXT_LEDGER_DIR`), en lecture seule : lignes ouvertes, lignes bloquées (`bloque-utilisateur`), messages à trier. Les lignes terminales (`fait`, `abandon-utilisateur`) sont ignorées |
| Les sous-agents | les lignes `[agent] « nom » (genre, identifiant)` de cette liste. **En cours** : la note dit « agent en cours » ou « agent relancé » et la ligne a bougé dans les trois dernières heures. **Obsolète** : même note, mais plus ancienne ou sans date lisible (la fin n'a jamais été reçue). **À traiter** : fin `TERMINÉ (completed)` ou `TERMINÉ (terminé)`. **Échoué** : toute autre fin, y compris une fin inconnue, pour qu'elle alerte au lieu de passer pour un succès. **État inconnu** : une ligne d'agent dont la note n'est d'aucune de ces formes |
| L'état git | des dépôts réglés par `config worktree ajouter` : propre ou nombre de modifications (fichiers non suivis compris), écart avec `main` et avec le distant (les références de suivi locales : le Cockpit ne fait aucun `fetch`), `main` non poussé. La mesure est faite par `rafraichir-git`, puis relue avec son âge |
| L'avancement des plans | les cases `- [ ]` et `- [x]` des fichiers `.md` du dossier des plans réglé, jusqu'à la profondeur réglée, sans les dossiers exclus ni les liens symboliques |
| Le quota | un fichier `quota-<agent>.json` par agent (fenêtres, pourcentage consommé, remise à zéro), rendu avec l'heure de la mesure dans le fuseau horaire de la machine |
| Les autres modules | un résumé de la politique d'agents, de la file d'attente, des consignes, de la nuit et de la pause, lus à travers leurs logiques pures. Un fichier absent ou abîmé se lit comme vide ; seul le fichier des consignes abîmé est dit (« consignes illisibles »), parce que ses ordres ne sont alors plus rappelés |
| Les modèles par agent | `modeles-agents.json` |

La ligne ne dit que ce qui a quelque chose à dire : une politique inerte, une nuit finie sans question en boîte ou des sessions sans pause n'y figurent pas. Exemple, avec des noms inventés :

```
Cockpit | ledger 2 ouvertes, 1 bloquée, 1 à trier | agents 1 en cours, 1 échoué | APP propre, = main, = distant | API 3 modif, +2 main, +2 distant | plans 50 % (2/4) | quota claude 7 j 71 % consommes, 29 % restants (source, 10:42)
```

### Emplacements et fichiers d'état

Le dossier d'état du Cockpit est `COCKPIT_DIR`, sinon `<maison>/cockpit`, où la maison est `AGENT_MEMORY_LEDGER_HOME` (sinon `~/.agent-memory-ledger`, voir `scripts/lib/config.js`). Les emplacements sont lus à chaque appel. Écriture atomique (fichier voisin puis renommage, réessayé quand l'antivirus ou un lecteur tient le fichier un instant).

| Fichier | Contenu | Écrit par |
| --- | --- | --- |
| `config.json` | les réglages : worktrees mesurés, dossier des plans (absent ou mal formé : valeurs par défaut, champ par champ) | `cockpit.js config` |
| `git-etat.json`, `git-etat.verrou` | la dernière mesure git, et le verrou d'un rafraîchissement en cours (jamais deux ensemble ; un verrou périmé ou d'un processus mort est repris) | `cockpit.js rafraichir-git` |
| `quota-<agent>.json` | la dernière mesure de quota d'un agent | le noyau du quota (`mesurerCodex` depuis le rollout de Codex, `rafraichirNatif` depuis son serveur d'application) ; la mesure de Claude Code sera écrite par son adaptateur (`ecrireQuota` du noyau du Cockpit, sans appelant d'ici là) |
| `modeles-agents.json` | les règles de modèle des sous-agents | `cockpit.js config modeles` |
| `inj-<agent>-<session>.json`, `inj-<agent>-<session>.compacte` | l'état de la dernière injection du bloc dans un fil (empreinte, heure, consignes, quota) et la marque d'un compactage en attente de réinjection ; le nom de la session est assaini (lettres, chiffres, `_` et `-`, 64 caractères au plus) | le hook `scripts/codex/cockpit.js` (ceux de plus de trois jours sont supprimés au démarrage d'une session) |
| `politique-agents.json`, `file-agents.json`, `reservations-agents.json`, `consignes.json`, `garde-quota.json`, `nuit.json`, `nuit-boite.json`, `pause.json` et leurs fichiers voisins | l'état des autres modules (voir « Les noyaux des modules ») | leurs noyaux ; le Cockpit ne fait que les lire |

### La commande

```
node scripts/cockpit.js ligne                    # une ligne d'état
node scripts/cockpit.js instantane [--json]      # l'état complet (ligne, ou JSON avec la ligne rendue par le noyau)
node scripts/cockpit.js rafraichir-git           # mesure git des worktrees réglés, écrit git-etat.json
node scripts/cockpit.js politique 5              # Régulateur : au plus 5 agents en parallèle
node scripts/cockpit.js quota 70 85              # Garde-quota : alerte à 70 %, seuil critique à 85 %
node scripts/cockpit.js config                   # affiche les réglages
node scripts/cockpit.js config worktree ajouter <nom> <chemin>   # le chemin doit être la racine d'un dépôt git
node scripts/cockpit.js config plans <dossier>                   # le dossier doit exister
node scripts/cockpit.js config modeles json      # les règles de modèle des sous-agents
node scripts/cockpit.js consignes ajouter Pas de poussée sans mon ordre   # une consigne permanente
node scripts/cockpit.js nuit on --agent claude --session <conversation>   # commence la nuit
node scripts/cockpit.js pause --session <id ou titre>                     # met une session en pause
node scripts/cockpit.js reprendre tout                                    # lève toutes les pauses
```

`politique`, `quota`, `consignes`, `nuit`, `pause` et `reprendre` prennent les mêmes arguments que les commandes `/plafond`, `/quota`, `/consignes`, `/nuit`, `/pause` et `/reprendre` des adaptateurs, et rendent le même message : sans argument, l'état ou la liste. `nuit` accepte `--agent <agent>` (`claude` par défaut) et `--session <conversation>` (pour compter les lignes ouvertes de cette conversation) ; la ligne de commande n'a pas de conversation courante, `pause` et `reprendre` demandent donc `--session <id ou titre>` ou le mot `tout`. `nuit-hook` et `pause-hook` lisent un JSON sur l'entrée standard et rendent un JSON sur une ligne (une entrée illisible ou une panne est rendue en JSON avec le code 0) :

```
echo '{"agent":"claude","session":"S1","reason":"answer"}' | node scripts/cockpit.js nuit-hook continuer
echo '{"session":"S1","dureeMs":200}' | node scripts/cockpit.js pause-hook attendre
```

Les opérations de `nuit-hook` sont `question`, `garde`, `continuer`, `activite` et `commande` ; celles de `pause-hook`, `battre`, `commande` et `attendre`. Les autres formes de `config` (`worktree retirer`, `worktrees defaut`, `plans exclure|inclure|profondeur|defaut`, `defaut`) et de `config modeles` (`defaut`, `type`, `retirer`) sont dans le message d'usage que la commande rend sur une saisie invalide. Une erreur va sur la sortie d'erreur, avec le code 2. Une commande qui ne change rien n'écrit rien. La commande inconnue liste celles qui existent.

## Les noyaux des modules

Chaque noyau lit l'état de son module, appelle la logique pure, et n'écrit que si l'état change, dans le dossier d'état du Cockpit, de façon atomique. Les hooks de Codex (voir plus bas) appellent ceux du Cockpit, du Régulateur, du Garde-quota, des Consignes et de la Nuit ; aucun hook n'appelle encore celui de la Pause.

| Module | Noyau | Fichiers d'état | Ce qu'il fait |
| --- | --- | --- | --- |
| Régulateur | `regulateur-core.js` | `politique-agents.json`, `file-agents.json`, `reservations-agents.json` | la politique (plafond, pause, relance), la file d'attente des agents refusés par le plafond, les relances comptées, les réservations (une demande de la file que l'adaptateur s'apprête à lancer est réservée cinq minutes pour qu'un autre processus ne la lance pas aussi) ; les agents en cours et échoués d'une conversation, lus dans la liste de travail (un agent « en cours » depuis plus de trois heures est un zombie : il ne tient aucun créneau). Les écritures de la file se font sous un verrou entre processus (`scripts/lib/transaction.js`) |
| Consignes | `consignes-core.js` | `consignes.json` | la liste des ordres permanents, le texte à rappeler, la décision sur une commande ou sur un nouvel agent. Un fichier abîmé n'applique rien (il ne doit pas bloquer le travail) mais la commande refuse d'écrire par-dessus. Les jetons `{worktrees}` et `{plans}` des consignes valent les réglages du Cockpit |
| Garde-quota | `quota-core.js`, `quota-native.cjs` | `garde-quota.json`, `quota-<agent>.json`, `quota-native-<agent>.json`, `garde-quota-alertes-<agent>.json` ; `relais-<agent>.md` est le prompt de relais que l'agent écrit lui-même | les réglages, la lecture du quota de Codex dans la fin de son rollout (le dernier événement `token_count` de sa limite) et par son serveur d'application, les annonces (une alerte n'est mémorisée qu'une fois remise au modèle), la décision de lancer un agent |
| Pause | `pause-core.js` | `pause.json` et son verrou `pause.json.verrou` | les sessions ouvertes (un battement par session ; sans battement depuis cinq minutes, elle est morte), les pauses de sessions et d'agents, l'attente bornée d'une pause. Le verrou ne retient jamais une pause : tenu plus de deux secondes, il est ignoré |
| Nuit | `nuit-core.js` | `nuit.json`, `nuit-boite.json`, `nuit-boite-archive.jsonl`, `nuit-livraisons.json`, `nuit.verrou` | l'état de la nuit, la boîte des questions et des commandes à décider (une entrée par question ; les entrées traitées qui laissent leur place sont archivées), les refus de question, la transformation d'un arrêt de garde en refus avec alternative, l'enchaînement sur la ligne suivante, le récapitulatif, les réponses à dire sans attendre la fin du tour. Tout passe sous le verrou `nuit.verrou` (attente bornée à deux secondes) |

**Lecture native du quota de Codex.** `quota-native.cjs` démarre le serveur d'application de Codex (`codex app-server`), lui demande les limites du compte et ne garde que la limite `codex` (une autre limite seule n'est jamais prise pour elle, et une panne ou un délai dépassé rendent « indisponible », jamais zéro). Rien n'est supposé de la machine : le binaire est celui de la variable `AML_CODEX_BINAIRE` (un chemin ; s'il est donné et que le fichier n'existe pas, rien n'est lu), sinon le premier `codex` du `PATH` (`codex.exe` sous Windows : un lanceur `.cmd` ne se démarre pas sans shell) ; le dossier de configuration de Codex est `CODEX_HOME`, sinon `~/.codex`. Sans binaire trouvé, la lecture est indisponible sans erreur et le quota se lit dans le rollout. Une lecture au plus par minute et par agent ; seul l'agent `codex` en a une. `COCKPIT_QUOTA_NATIVE=0` la coupe : les bancs la posent, car ils ne lancent jamais un vrai binaire de Codex.

**La garde interrogée par la Nuit.** Pour une commande, la Nuit lance elle-même la garde de sécurité (`scripts/gardes/securite.js`, avec `--agent` suivi du nom de l'agent du dépôt) et lit sa sortie : un refus (`deny`) devient un refus de la Nuit avec une alternative, une demande d'accord (`ask`, que seule la garde de Claude Code rend) devient une entrée de la boîte avec les boutons « Autoriser » et « Refuser ». Les autres agents reçoivent un refus quand la garde ne trouve pas d'ordre de l'utilisateur : leur poussée n'entre donc pas dans la boîte. La commande est lue dans `command`, `cmd`, `script` ou `input` ; une commande donnée en tableau n'est pas soumise à la garde par la Nuit (la garde elle-même la lit). `NUIT_GARDE` (un autre script de garde), `NUIT_GARDE_DELAI_MS` et `NUIT_VERROU_DELAI_MS` ne servent qu'aux bancs.

**Noms d'agents.** La file du Régulateur, la boîte de la Nuit et les fichiers `quota-<agent>.json` n'acceptent que des clés : minuscules, chiffres et tirets, une lettre en tête, 32 caractères au plus. `scripts/lib/agents-noms.js` est l'unique endroit qui convertit : `cleAgent('deepseek_H')` rend `deepseek-h` ; `nomsListe` rend les noms sous lesquels la liste de travail connaît cet agent (la clé et le nom du dépôt). Chaque noyau convertit à l'entrée de ses fonctions ; un nom qui n'est ni un agent du dépôt ni déjà une clé reste refusé (`Claude`, `deepseek_h`, `../x`).



## Brancher dans Codex

Les hooks sont les scripts de `scripts/codex/`. Codex les lance avec l'événement en JSON sur l'entrée standard et lit leur sortie JSON : le schéma de sortie de Codex est strict (un champ en trop invalide toute la sortie), les formes rendues sont celles de `tests/schemas-hooks-codex-0.155.json`, validées par `tests/hooks-codex-schema.test.js`. Chaque hook reçoit son agent par `--agent` : `codex` ou `deepseek_H`, les agents de `scripts/lib/config.js` autres que Claude Code ; le nom est converti en clé d'état par `agents-noms.js` (`deepseek_H` devient `deepseek-h`), et un autre nom est refusé : le hook se tait. Un hook ne bloque jamais le travail sur sa propre panne : toute erreur interne rend une sortie vide et le code 0. Un sous-agent (l'événement porte `agent_id` ou `agent_type`) ne reçoit jamais le Cockpit ni l'enchaînement de la Nuit ; les refus (consignes, plafond, quota, question de la Nuit) valent pour lui comme pour l'agent principal.

Les hooks n'ont aucun réglage à eux : ils lisent le dossier d'état du Cockpit (`COCKPIT_DIR`, sinon `<maison>/cockpit`) et la liste de travail, que la ligne de commande écrit. `tests/cockpit-codex-reglages.test.js` le prouve : chaque test pose un réglage par `node scripts/cockpit.js`, lance le hook comme Codex le fait, et vérifie qu'il l'applique puis qu'il cesse de l'appliquer quand la commande le retire.

| Hook | Ce qu'il lit | Ce que la ligne de commande écrit |
| --- | --- | --- |
| `cockpit.js` | tout l'état du Cockpit (voir « Emplacements et fichiers d'état »), le rollout de Codex (`transcript_path`) pour le quota | `config`, `politique`, `quota`, `consignes`, `nuit`, `pause`, `rafraichir-git` |
| `regulateur.js` | `politique-agents.json`, `file-agents.json` et `reservations-agents.json`, `garde-quota.json`, le rollout | `politique` (plafond, `pause`, `reprendre`, `libre`, `relance`, `file on`, `file vider`), `quota` |
| `consignes.js` | `consignes.json`, et `config.json` pour les jetons `{worktrees}` et `{plans}` | `consignes`, `config` |
| `nuit.js` | `nuit.json`, `nuit-boite.json`, la liste de travail de l'agent, `politique-agents.json` (pause), `garde-quota.json` et le rollout (arrêts) | `nuit` |

### Les composants

Un composant est un groupe de hooks qu'on branche ensemble : un script, un ou plusieurs événements, un matcher éventuel. Le Régulateur demande trois composants (le refus, le résultat, la file), la Nuit deux, le Cockpit un ou deux.

| Composant | Script | Événement (matcher) | Ce qu'il fait |
| --- | --- | --- | --- |
| `cockpit` | `cockpit.js` | `SessionStart`, `UserPromptSubmit`, `PostCompact` | injecte l'état du travail : le bloc du Cockpit, puis le rappel du Régulateur quand sa politique n'est pas inerte, les lignes du Garde-quota (alerte d'attention ou critique, consigne de relais au seuil critique, relance après la remise à zéro) et les consignes en vigueur. `SessionStart` injecte toujours ; `UserPromptSubmit` n'injecte que si le texte a changé (hors horodatage) et que la dernière injection de ce fil date de plus de dix minutes, sauf une alerte critique, une remise à zéro du quota ou un changement des consignes, qui ne l'attendent pas. `PostCompact` n'injecte rien (le schéma de Codex l'interdit) mais efface l'état d'injection du fil : le message suivant réinjecte ce que le compactage a pu faire oublier. La mesure git des dépôts suivis est lancée en arrière-plan quand elle manque ou a plus de dix minutes, et n'est jamais attendue |
| `cockpit-outils` | `cockpit.js` | `PostToolUse` | le premier outil qui suit un compactage réinjecte le bloc, une seule fois ; sans compactage, le script sort tout de suite (il tourne après chaque outil) |
| `regulateur` | `regulateur.js` | `PreToolUse` (`spawn_agent`) | refuse le lancement d'un agent quand une fenêtre de quota est au seuil critique (Garde-quota, en premier), puis selon la politique (plafond atteint, pause). Avec la file activée, la demande refusée au plafond est mise en file avec ses arguments exacts, et le refus le dit. Un lancement autorisé qui correspond à une demande de la file la réserve |
| `regulateur-resultat` | `regulateur.js` | `PostToolUse` (`spawn_agent`) | acquitte la réservation : seul un succès connu (une réponse sans erreur, avec l'identifiant de l'agent lancé) retire la demande de la file ; un échec la garde et lève la réservation. Sans ce composant, une demande lancée resterait en file |
| `file` | `regulateur.js` | `Stop` | un hook ne peut pas lancer d'agent, il peut seulement faire continuer le modèle : avec la file activée et un créneau libre, il lui ordonne de lancer le suivant de la file (arguments exacts) et de relancer les agents échoués (relance activée, deux fois au plus chacun). Une seule continuation par message de l'utilisateur ; rien en pause ni au seuil critique du quota |
| `consignes` | `consignes.js` | `PreToolUse` (tous les outils) | refuse une commande (lue dans `command`, `cmd`, `script` ou `input`, un tableau de mots étant joint ; `apply_patch` est exempté) ou un lancement d'agent que les verrous des consignes reconnaissent. Le texte des consignes, lui, est rappelé par `cockpit` |
| `nuit` | `nuit.js` | `PreToolUse` (`request_user_input`) | pendant la nuit ou l'absence, la question bloquante est refusée et mise en boîte, et le modèle reçoit la marche à suivre |
| `nuit-tours` | `nuit.js` | `Stop`, `UserPromptSubmit` | l'enchaînement (le modèle reçoit l'ordre de continuer avec la ligne ouverte suivante de la conversation, sauf pause du Régulateur, quota critique, plafond de tours ou ligne qui n'avance pas ; une continuation par message) et le réveil (le message de l'utilisateur met fin à la nuit et le récapitulatif est donné au modèle, une fois) |

Le matcher d'un composant ne retient que l'outil qui le concerne ; `consignes` n'en a pas, parce que le nom de l'outil qui exécute une commande varie (`Bash`, `exec_command`...) : le hook lit lui-même la commande.

### Brancher, vérifier, retirer

Par l'installateur de Codex, à la demande : sans l'option `--cockpit`, il n'ajoute aucun de ces hooks, et qui n'utilise que la liste de travail et la mémoire n'a rien à faire.

```
node scripts/installer-codex.js --cockpit                      # montre l'état de chaque composant, n'écrit rien
node scripts/installer-codex.js --cockpit --appliquer          # branche les huit composants
node scripts/installer-codex.js --cockpit --retirer --appliquer
node scripts/installer-codex.js --cockpit --appliquer --composant nuit            # un seul composant
node scripts/installer-codex.js --cockpit --appliquer --agent deepseek_H --home <dossier>   # un autre agent, un autre dossier de configuration
```

L'option `--cockpit` demande que `hooks.json` existe déjà (sinon : « lance d'abord `node scripts/installer-codex.js --appliquer` », qui branche les hooks de base). `--home` (ou `CODEX_HOME`) désigne le dossier de configuration de Codex ; `--agent` vaut `codex` par défaut. Ou par l'outil, composant par composant (`cockpit` par défaut) :

```
node scripts/codex/brancher.js brancher --fichier <hooks.json> --agent codex --composant regulateur
node scripts/codex/brancher.js verifier --fichier <hooks.json> --agent codex --composant regulateur   # « branché : PreToolUse » ou « pas branché »
node scripts/codex/brancher.js retirer  --fichier <hooks.json> --agent codex --composant regulateur
```

Règles : l'outil ajoute un **nouveau** groupe par événement et ne modifie ni ne déplace aucun groupe existant ; il sauvegarde `<hooks.json>.avant-agent-memory-ledger-<composant>` une seule fois (la sauvegarde n'est jamais écrasée) ; il conserve la marque d'ordre des octets, la fin de ligne finale et le style des retours à la ligne du fichier ; il est idempotent ; chaque agent a ses propres groupes (la commande porte `--agent`), retirer l'un ne touche pas l'autre ; chaque composant ne voit et ne retire que ses événements (`cockpit` et `cockpit-outils` lancent le même script, sur des événements différents). Les commandes écrites entourent le dossier du dépôt de guillemets (le chemin peut contenir des espaces). `node scripts/installer-codex.js --retirer`, sans `--cockpit`, retire **tous** les hooks dont la commande appelle un script de ce dépôt, ceux du Cockpit compris.

**À approuver dans Codex.** Codex garde une approbation par hook, identifié par « fichier:événement:groupe:rang » : après un branchement, ouvrez Codex et approuvez chaque nouveau hook (écran des hooks) ; tant que ce n'est pas fait, il ne les exécute pas. Les approbations déjà données restent valables, puisqu'aucun hook existant n'est modifié ni déplacé. Un hook branché mais pas approuvé ne fait rien, sans erreur.

### Les deux autres scripts

- `scripts/regulateur-file.js` : les opérations de la file d'attente (`mettreEnFile`, `purgerFile`, `retirerReconnue`, `viderFile`, `lireFile`) en ligne de commande, pour un processus qui ne charge pas le noyau : `node scripts/regulateur-file.js '{"operation":"lireFile","args":[]}'` rend `{"value":...}`. Une opération qui n'est pas dans la liste, des arguments qui ne sont pas une liste ou une panne vont sur la sortie d'erreur, code 1.
- `scripts/synchroniser-mods.js` : recopie une logique commune (`scripts/lib/<nom>-logique.mjs`) dans le dossier `hooks/` de chaque module d'interface qui en embarque une copie (un module ne peut importer que des fichiers de son propre dossier), ou, avec `--verifier`, compare sans rien écrire (code 1 si une copie diffère ou manque). Sans `--nom`, c'est la logique du Régulateur. Le banc de dérive (`tests/synchroniser-mods.test.js`) compare ces copies à la source dans `mods/<nom>/hooks` (aucun test n'est ignoré depuis que les modules sont là) ; `tests/mods-structure.test.js` compare aussi les copies des logiques des modules qui n'y figurent pas (les modèles par agent, les emplacements).

## Les bancs et les preuves

Les bancs sont dans `tests/<module>-logique.test.js` pour les logiques, `tests/cockpit-core.test.js` pour le noyau du Cockpit, `tests/modeles-agents-core.test.js` pour le noyau des modèles, `tests/<module>-core.test.js` pour les noyaux des cinq autres modules (et leurs commandes de la ligne de commande, lancées comme processus), `tests/quota-native.test.js` pour la lecture native du quota et `tests/agents-noms.test.js` pour la conversion des noms d'agents. Les hooks de Codex ont leurs bancs, lancés comme Codex les lance (l'événement en JSON sur l'entrée standard, un vrai processus par appel) : `tests/cockpit-codex.test.js`, `tests/regulateur-codex.test.js`, `tests/consignes-codex.test.js` et `tests/nuit-codex.test.js` pour chaque hook, `tests/cockpit-brancher.test.js` pour l'outil de branchement, `tests/cockpit-installateur.test.js` pour l'option `--cockpit` de l'installateur, `tests/hooks-codex-schema.test.js` pour leurs sorties contre le schéma de codex-cli 0.155, `tests/cockpit-codex-reglages.test.js` pour les réglages de la ligne de commande appliqués par les hooks, `tests/regulateur-file.test.js` et `tests/synchroniser-mods.test.js` pour les deux autres scripts. Leurs scripts de mutation sont dans `tests/mutations/`, avec leur moteur commun `tests/lib/mutations-fichier.js` : chaque entrée altère un fragment exact du code dans une copie, et le banc doit rougir. Une altération qui laisse le banc vert désigne un comportement que rien ne protège. Les bancs du Cockpit et des noyaux n'écrivent jamais dans votre maison ni dans vos dépôts : chaque test a sa maison, ses dossiers d'état et ses dépôts git sous le dossier temporaire du système. Ils ne lancent jamais un vrai binaire de Codex : la lecture native du quota est essayée contre un faux serveur d'application, le lancement de `quota-native.cjs` par le noyau du quota est remplacé par un espion, et les bancs des hooks posent `COCKPIT_QUOTA_NATIVE=0`. Les bancs des hooks ne touchent jamais un vrai dossier de Codex : l'outil de branchement et l'installateur travaillent sur un `hooks.json` temporaire.

```
npm run test:rapide        # tous les bancs, sans les mutations
npm run test:mutations     # tous les scripts de mutation, l'un après l'autre (très long)
node tests/mutations/mutations-cockpit.js --ancres   # vérifie, sans lancer le banc, que chaque ancre existe une fois
node tests/mutations/mutations-config-cli.js         # mutations de la seule commande config
node tests/mutations/mutations-nuit-core.js          # mutations du noyau de la Nuit ; mutations-nuit-cli.js pour ses commandes
node tests/mutations/mutations-regulateur-codex.js   # mutations du hook de Codex du Régulateur ; mutations-cockpit-codex.js, -consignes-codex.js, -nuit-codex.js, -cockpit-brancher.js, -installateur-cockpit.js, -regulateur-file.js, -synchroniser-mods.js et -reglages-codex.js pour les autres
```

## Notes pour qui branchera ces modules

- **Fichiers `.mjs`.** Chaque logique est un module ES sans aucun import. Les noyaux et les bancs la chargent par `require()` (Node 22.12 ou plus, sans avertissement). Un banc lit le fichier désigné par une variable d'environnement interne (par exemple `QUOTA_LOGIQUE_TESTE`, `COCKPIT_CORE_TESTE` et `COCKPIT_CLI_TESTE` pour le Cockpit et sa ligne de commande, `NUIT_CORE_TESTE` pour le noyau de la Nuit) : c'est ainsi que les scripts de mutation lui donnent une copie altérée. Ne jamais la poser ailleurs.
- **Noms d'agents.** La file d'attente et la boîte de la Nuit n'acceptent que des noms en minuscules, chiffres et tirets (au plus 32 caractères, commençant par une lettre), et les fichiers `quota-<agent>.json` aussi. Les noms d'agents que connaît `scripts/lib/config.js` (par exemple `deepseek_H`) sont convertis par `scripts/lib/agents-noms.js` avant d'entrer dans ces états (voir « Les noyaux des modules »). Le Cockpit, lui, lit les listes de travail de tous les agents du dépôt, majuscules et tirets bas compris. Sans mesure de quota, il attend celles de `claude` et de `codex`.
- **Forme des lignes d'agents.** Le Cockpit reconnaît les sous-agents aux lignes que le noyau de la liste de travail écrit (`scripts/lib/context-ledger-core.js`) : le texte `[agent] « titre » (genre, identifiant) : ...` et les notes `agent en cours depuis ...`, `agent relancé depuis ...` et `TERMINÉ (statut) le ... : ...`. Un banc lance ce noyau pour s'en assurer. Si ces formes changent, le noyau du Cockpit et ce banc changent avec elles.
- **Messages.** Les textes que ces modules rendent au modèle sont en français et ne contiennent jamais de tiret cadratin, ce que les bancs vérifient. Ils nomment « l'utilisateur » : aucune identité n'y est écrite.
- **Alternatives de la Nuit.** Quand la garde de sécurité refuse une commande, la Nuit choisit la voie de remplacement d'après les libellés de `scripts/gardes/securite.js` et de `scripts/lib/checklist-commit.js`. Si ces libellés changent, `ALTERNATIVES` dans `nuit-logique.mjs` et son banc changent avec eux. Le noyau de la Nuit lance cette garde et lit sa sortie : les bancs du noyau en essaient la vraie sortie (`rm -rf`) et des fausses gardes pour les autres formes.
- **Réglages par défaut.** Rien n'est supposé de la machine : les dépôts suivis et le dossier des plans sont vides tant que `cockpit config` ne les pose pas. Sans dossier de plans, la ligne dit `plans ?`.
- **Enchaînement de la Nuit et liste de travail.** Le texte que la Nuit soumet au modèle pour enchaîner (« NUIT : L'utilisateur est absent. Continue sans l'attendre ... ») revient à l'adaptateur comme un message de l'utilisateur : `texteDeMachine` (dans `scripts/lib/context-ledger-core.js`) le reconnaît à son début exact, et il ne reçoit donc pas de numéro de message. Une réponse de la boîte commence par le même préfixe « NUIT : » mais porte une décision de l'utilisateur : elle reçoit un numéro.
- **Fuseau horaire.** L'heure de la mesure de quota, dans la ligne, est celle de la machine.
- **Dépôts suivis.** Un dépôt qui n'a pas de branche `main` locale ou de distant est dit tel quel (`sans distant`, `? main`), jamais deviné. Le Cockpit ne lance que des commandes git en lecture, avec `--no-optional-locks`.

- **Hooks de Codex.** Chaque hook lit ce que la ligne de commande écrit (voir « Brancher dans Codex »). Le hook du Cockpit ne branche pas `PostToolUse` avec le composant `cockpit` : c'est le composant `cockpit-outils`, à part parce qu'il lance un processus après chaque outil de Codex. De même, le résultat d'un lancement d'agent (composant `regulateur-resultat`) est ce qui retire une demande lancée de la file : branchez-le avec `regulateur` et `file`, `node scripts/installer-codex.js --cockpit` les branche tous.
- **Deux hooks `Stop`.** `file` et `nuit-tours` répondent chacun à `Stop` par une demande de continuer (`{"decision":"block","reason":...}`) ; avec les deux branchés, Codex reçoit deux réponses. Chacun ne parle que dans son cas (une file avec un créneau libre, une nuit avec une ligne ouverte) et une seule fois par message, mais la façon dont Codex combine deux réponses de ce genre n'a pas été observée.
- **Pas de hook pour la Pause.** Les hooks de Codex couvrent le Cockpit, le Régulateur et sa file, les Consignes, la Nuit et, à travers eux, le Garde-quota. La pause (`cockpit.js pause`, `pause-hook`) n'a pas de hook de Codex : elle est prévue pour Claude Code.
- **Agents.** `--agent` accepte `codex`, `deepseek_H` et toute clé d'état valide ; les noms libres de la forme `Claude` ou `deepseek_h` sont refusés. La lecture native du quota ne vaut que pour `codex`.

## Ce qui vient ensuite

Les modules d'interface de Claude Code (`mods/`) sont dans le dépôt, câblés de bout en bout : logique, noyau, commande, module, réglage, avec les bancs du moteur et les mutations qui les prouvent. Pour Codex, c'est fait pour le Cockpit, le Régulateur, les Consignes et la Nuit. Ce qui n'a pas été observé (aucun hook de Codex n'a été chargé par un vrai Codex depuis ce dépôt, aucun module n'a été chargé dans une vraie session de Claude Code depuis ce dépôt) est dit dans le README et dans `docs/MODULES-INTERFACE.md`.
