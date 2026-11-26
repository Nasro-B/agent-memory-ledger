# Le Cockpit et ses modules

Le Cockpit est le nom donné à l'ensemble des réglages et des états que les agents partagent sur une machine : combien d'agents à la fois, ce qu'ils n'ont pas le droit de faire, ce qu'ils font quand l'utilisateur est absent, ce qui est en pause, où en est le quota. Chaque module est découpé en deux : une **logique pure** et un **noyau d'entrées-sorties** qui l'appelle.

## Ce qui est dans le dépôt à ce stade

- les **logiques pures** des huit modules, avec leurs bancs et leurs preuves par mutation ;
- le **noyau du Cockpit** (`scripts/lib/cockpit-core.js`), qui lit l'état réel du travail et le rend en une ligne ou en un bloc ;
- le noyau des **modèles par agent** (`scripts/lib/modeles-agents-core.js`) ;
- la partie de la **ligne de commande** (`scripts/cockpit.js`) que ces deux noyaux servent seuls : `ligne`, `instantane`, `rafraichir-git` et `config` (dont `config modeles`).

Ne sont **pas** encore là : les noyaux d'entrées-sorties du Régulateur, du quota, des consignes, de la Nuit et de la pause, leurs commandes (`politique`, `quota`, `consignes`, `nuit`, `nuit-hook`, `pause`, `reprendre`, `pause-hook`), les hooks et les panneaux d'interface. Tant qu'ils ne sont pas là, ces modules ne font rien d'eux-mêmes : le Cockpit lit leurs fichiers d'état s'ils existent (ils seront écrits par ces noyaux, ou à la main) et les dit, sans jamais les écrire.

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
| `quota-<agent>.json` | la dernière mesure de quota d'un agent | le noyau du quota, à venir (la fonction `ecrireQuota` du noyau est là, sans appelant) |
| `modeles-agents.json` | les règles de modèle des sous-agents | `cockpit.js config modeles` |
| `politique-agents.json`, `file-agents.json`, `consignes.json`, `nuit.json`, `nuit-boite.json`, `pause.json` | l'état des autres modules | leurs noyaux, à venir ; le Cockpit ne fait que les lire |

### La commande

```
node scripts/cockpit.js ligne                    # une ligne d'état
node scripts/cockpit.js instantane [--json]      # l'état complet (ligne, ou JSON avec la ligne rendue par le noyau)
node scripts/cockpit.js rafraichir-git           # mesure git des worktrees réglés, écrit git-etat.json
node scripts/cockpit.js config                   # affiche les réglages
node scripts/cockpit.js config worktree ajouter <nom> <chemin>   # le chemin doit être la racine d'un dépôt git
node scripts/cockpit.js config plans <dossier>                   # le dossier doit exister
node scripts/cockpit.js config modeles json      # les règles de modèle des sous-agents
```

Les autres formes de `config` (`worktree retirer`, `worktrees defaut`, `plans exclure|inclure|profondeur|defaut`, `defaut`) et de `config modeles` (`defaut`, `type`, `retirer`) sont dans le message d'usage que la commande rend sur une saisie invalide. Une erreur va sur la sortie d'erreur, avec le code 2. Une commande qui ne change rien n'écrit rien. Les commandes des autres modules sont absentes : la commande inconnue le dit et liste celles qui existent.

## Les bancs et les preuves

Les bancs sont dans `tests/<module>-logique.test.js` pour les logiques, `tests/cockpit-core.test.js` pour le noyau du Cockpit et sa ligne de commande, `tests/modeles-agents-core.test.js` pour le noyau des modèles. Leurs scripts de mutation sont dans `tests/mutations/`, avec leur moteur commun `tests/lib/mutations-fichier.js` : chaque entrée altère un fragment exact du code dans une copie, et le banc doit rougir. Une altération qui laisse le banc vert désigne un comportement que rien ne protège. Les bancs du Cockpit n'écrivent jamais dans votre maison ni dans vos dépôts : chaque test a sa maison, ses dossiers d'état et ses dépôts git sous le dossier temporaire du système.

```
npm run test:rapide        # tous les bancs, sans les mutations
npm run test:mutations     # les neuf scripts de mutation, l'un après l'autre (long)
node tests/mutations/mutations-cockpit.js --ancres   # vérifie, sans lancer le banc, que chaque ancre existe une fois
node tests/mutations/mutations-config-cli.js         # mutations de la seule commande config
```

## Notes pour qui branchera ces modules

- **Fichiers `.mjs`.** Chaque logique est un module ES sans aucun import. Les noyaux et les bancs la chargent par `require()` (Node 22.12 ou plus, sans avertissement). Un banc lit le fichier désigné par une variable d'environnement interne (par exemple `QUOTA_LOGIQUE_TESTE`, ou `COCKPIT_CORE_TESTE` et `COCKPIT_CLI_TESTE` pour le Cockpit) : c'est ainsi que les scripts de mutation lui donnent une copie altérée. Ne jamais la poser ailleurs.
- **Noms d'agents.** La file d'attente et la boîte de la Nuit n'acceptent que des noms en minuscules, chiffres et tirets (au plus 32 caractères, commençant par une lettre), et les fichiers `quota-<agent>.json` aussi. Les noms d'agents que connaît `scripts/lib/config.js` (par exemple `deepseek_H`) devront être convertis par les noyaux avant d'entrer dans ces états. Le Cockpit, lui, lit les listes de travail de tous les agents du dépôt, majuscules et tirets bas compris. Sans mesure de quota, il attend celles de `claude` et de `codex`.
- **Forme des lignes d'agents.** Le Cockpit reconnaît les sous-agents aux lignes que le noyau de la liste de travail écrit (`scripts/lib/context-ledger-core.js`) : le texte `[agent] « titre » (genre, identifiant) : ...` et les notes `agent en cours depuis ...`, `agent relancé depuis ...` et `TERMINÉ (statut) le ... : ...`. Un banc lance ce noyau pour s'en assurer. Si ces formes changent, le noyau du Cockpit et ce banc changent avec elles.
- **Messages.** Les textes que ces modules rendent au modèle sont en français et ne contiennent jamais de tiret cadratin, ce que les bancs vérifient. Ils nomment « l'utilisateur » : aucune identité n'y est écrite.
- **Alternatives de la Nuit.** Quand la garde de sécurité refuse une commande, la Nuit choisit la voie de remplacement d'après les libellés de `scripts/gardes/securite.js` et de `scripts/lib/checklist-commit.js`. Si ces libellés changent, `ALTERNATIVES` dans `nuit-logique.mjs` et son banc changent avec eux.
- **Réglages par défaut.** Rien n'est supposé de la machine : les dépôts suivis et le dossier des plans sont vides tant que `cockpit config` ne les pose pas. Sans dossier de plans, la ligne dit `plans ?`.
- **Fuseau horaire.** L'heure de la mesure de quota, dans la ligne, est celle de la machine.
- **Dépôts suivis.** Un dépôt qui n'a pas de branche `main` locale ou de distant est dit tel quel (`sans distant`, `? main`), jamais deviné. Le Cockpit ne lance que des commandes git en lecture, avec `--no-optional-locks`.

## Ce qui vient ensuite

Les noyaux d'entrées-sorties des autres modules (lecture et écriture atomique de leur état dans le dossier d'état du Cockpit), leurs commandes (`politique`, `quota`, `consignes`, `nuit`, `pause`, `reprendre`, et les commandes de hook `nuit-hook` et `pause-hook`, qui reprendront la ligne de commande de ce dépôt telle quelle), les hooks qui les branchent et les panneaux d'interface. Chaque module sera livré câblé de bout en bout : logique, noyau, commande, hook et réglage, avec les bancs qui le prouvent.
