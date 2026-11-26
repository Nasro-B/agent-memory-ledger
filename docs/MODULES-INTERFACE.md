# Les modules d'interface de Claude Code

Le dépôt a des **noyaux** (`scripts/lib/*-core.js`), une **ligne de commande** (`scripts/cockpit.js`) et des **hooks de Codex** qui les branchent dans Codex. Les six modules de `mods/` les branchent dans **Claude Code** : ce sont des plugins de plus, déclarés dans la marketplace du dépôt, dont `hooks/hooks.json` désigne un module de fonctions (`register.ts` ou `register.tsx`) écrit contre l'interface du moteur de Claude Code (événements de session, d'outil, de lancement d'agent, de composition du prompt, de commande ; bande, panneau et ligne de statut).

Ils sont **facultatifs et indépendants** : qui n'en installe aucun n'a rien à faire, et chacun s'installe et se retire seul.

| Module | Commandes | Ce qu'il branche | Fichiers d'état (dossier d'état du Cockpit) | Script du plugin lancé |
| --- | --- | --- | --- | --- |
| `consignes` | `/consignes` | rappelle les consignes actives dans le prompt à chaque requête ; refuse une commande Bash ou PowerShell et le lancement d'un agent que le verrou d'une consigne reconnaît | `consignes.json` (lu, écrit), `config.json` (lu) | aucun |
| `garde-quota` | `/quota` | mesure le quota que le moteur rapporte, annonce l'attention puis le seuil critique (avec un son, réglable) et la remise à zéro, refuse le lancement d'un agent au seuil critique, ajoute la consigne de relais au prompt | `garde-quota.json` (lu, écrit), `quota-claude.json` (écrit) | aucun |
| `regulateur` | `/plafond` | refuse le lancement d'un agent au plafond ou en pause, le met en file puis le lance dès qu'un créneau se libère, relance les échoués, impose le modèle réglé par type d'agent, rappelle la politique dans le prompt | `politique-agents.json` (lu, écrit), `modeles-agents.json` (lu), `file-agents.json` (par le script) | `scripts/regulateur-file.js` |
| `pause` | `/pause`, `/reprendre` | retient la boucle d'une session ou d'un agent avant sa prochaine requête au modèle et avant son prochain outil, bande avec les boutons Pause et Reprendre | `pause.json` (lu ; écrit par le noyau) | `scripts/cockpit.js pause-hook` |
| `nuit` | `/nuit` | pendant la nuit ou l'absence : met en boîte la question bloquante, transforme l'arrêt d'une garde en refus avec alternative, enchaîne sur la ligne ouverte suivante, donne le récap au réveil, panneau de la boîte | `nuit.json`, `nuit-boite.json` (lus ; écrits par le noyau) | `scripts/cockpit.js nuit-hook` |
| `cockpit` | `/cockpit` | bande et panneau d'état du travail (liste de travail, sous-agents, git, plans, quota, réglages) ; les boutons lancent les commandes du Cockpit | aucun directement | `scripts/cockpit.js` |

## Installer, retirer

Depuis la marketplace du dépôt :

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install consignes@agent-memory-ledger
claude plugin install garde-quota@agent-memory-ledger
claude plugin install regulateur@agent-memory-ledger
claude plugin install pause@agent-memory-ledger
claude plugin install nuit@agent-memory-ledger
claude plugin install cockpit@agent-memory-ledger
```

(Ou `/plugin install <nom>@agent-memory-ledger` dans une session.) Depuis un clone du dépôt, sans marketplace, pour essayer un module : `claude --plugin-dir mods/<nom>`. Les modules sont actifs à la session suivante.

Pour retirer un module : `claude plugin uninstall <nom>@agent-memory-ledger`. Rien d'autre n'est à défaire : un module n'écrit aucun réglage de Claude Code et ne touche pas aux fichiers d'état en partant (ils restent, et les noyaux, la ligne de commande et les hooks de Codex continuent de les lire).

Ce que les modules **changent** : ils ajoutent des sections au prompt système (`consignes:en-vigueur`, `garde-quota:critique`, `garde-quota:remise`, `regulateur:politique`, `nuit:rappel`), des lignes de statut, une bande au-dessus du prompt (`pause`, `cockpit`), un panneau (`nuit`, `cockpit`), des commandes, et ils peuvent **refuser** un outil ou le lancement d'un agent (consignes, plafond, quota, nuit). Ils ne modifient ni un dépôt, ni un plan, ni la liste de travail.

## Où ils lisent, écrivent et lancent

Le moteur de Claude Code ne donne à un module ni le dossier de l'utilisateur ni le chemin d'un script : il donne les variables d'environnement et le dossier du module. `scripts/lib/emplacements-logique.mjs` (copié, octet pour octet, dans `hooks/` de chaque module : un module ne peut importer que des fichiers de son propre dossier) en déduit :

- **Le dossier d'état du Cockpit**, le même calcul que les noyaux et `scripts/cockpit.js` : `COCKPIT_DIR` ; sinon `<maison>/cockpit`, la maison étant `AGENT_MEMORY_LEDGER_HOME` ; sinon `<dossier de l'utilisateur>/.agent-memory-ledger/cockpit` (`USERPROFILE` sous Windows, `HOME` ailleurs). Une valeur réglée par la ligne de commande est donc lue par le module, et l'inverse : `tests/mods-etat.test.js` le prouve avec de vrais processus et la copie de la logique de chaque module. Un chemin relatif est relatif au dossier de travail de la session : donnez un chemin absolu.
- **Le script du plugin** (`scripts/cockpit.js` ou `scripts/regulateur-file.js`) : `AML_PLUGIN_DIR` (le dossier du plugin `agent-memory-ledger`, celui qui contient `scripts/`) ; sinon le dépôt qui contient le module (`mods/<nom>` sous la racine du dépôt) ; sinon le plugin installé à côté du module (même marketplace, la version la plus récente qui a le script). Introuvable, le module le dit (la bande du Cockpit, le texte de `/pause`, `/nuit` ou `/plafond`) et **ne bloque rien** : une panne du script n'a jamais retenu une session, refusé une question ni empêché un lancement.

Les variables lues sont celles que `claude plugin validate` liste pour chaque module : `COCKPIT_DIR`, `AGENT_MEMORY_LEDGER_HOME`, `USERPROFILE`, `HOME` et `AML_PLUGIN_DIR`. Elles sont lues à chaque appel.

## Les noms de commandes

`/consignes`, `/quota`, `/plafond`, `/pause`, `/reprendre`, `/nuit`, `/cockpit`. Le moteur refuse l'enregistrement d'une commande qui porte le nom d'une commande intégrée : si une version de Claude Code en ajoute une de même nom, le module ne s'enregistre pas (le hook de démarrage échoue, le module reste sans commande).

## Les bancs et les preuves

Chaque module a ses bancs, que le moteur de Claude Code exécute (`claude plugin test mods/<nom>`), dans un environnement qui ressemble à celui de ses hooks : le monde (fichiers, noyau, agents, horloge) est simulé sous le module, qui est exercé comme dans une session (événements, commandes, boutons montés sur la bande et le panneau).

```
npm run test:mods                          # les bancs de Node des modules, puis le moteur sur chaque module, l'un après l'autre
node scripts/tester-mods.js pause nuit     # seulement ceux nommés
npm run test:mutations-mods                # les six scripts de mutation des modules, l'un après l'autre ; très long
node tests/mutations/mutations-pause-mod.js --ancres   # vérifie, sans le moteur, que chaque ancre existe une fois
claude plugin validate --strict mods/pause # le module est valide, et ses bancs sont typés contre le moteur courant
```

Le moteur est le programme de la variable `AML_MOTEUR_CLAUDE`, sinon la commande `claude` du chemin d'exécution ; sans lui, `tester-mods.js` et les scripts de mutation le disent (code 2) et ne lancent rien. Ces bancs n'entrent **pas** dans `npm test`, qui reste jouable avec Node seul. `npm test` contient en revanche ceux de Node : `tests/emplacements-logique.test.js` (le calcul des emplacements, comparé à celui du noyau), `tests/mods-structure.test.js` (manifestes, marketplace, copies des logiques identiques à la source, déclarations de types, rien de privé), `tests/mods-etat.test.js` (les fichiers d'état partagés avec la ligne de commande) et `tests/synchroniser-mods.test.js` (dérive des copies).

Une mutation altère une ancre exacte du code du module, dans une copie temporaire, et le banc doit rougir. Chaque script a, à côté de ses mutations, la liste de celles qu'il écarte et pourquoi (équivalentes, ou non observables par le moteur de test).

Les logiques pures (`*-logique.mjs`) ne s'écrivent qu'une fois, dans `scripts/lib/`. Pour en changer une : modifiez la source, puis `node scripts/synchroniser-mods.js --nom <nom>-logique.mjs mods/<nom>...` recopie la copie de chaque module qui en porte une ; ses déclarations de types (`<nom>-logique.d.mts`) se tiennent à jour à la main, un banc compare leurs noms aux exports.

## Limites

- **Jamais chargés dans une vraie session depuis ce dépôt.** Les bancs passent par le moteur de test de Claude Code, qui simule le moteur de la session. Ce moteur de test accepte ce que le vrai moteur peut refuser (le nom d'une commande intégrée, par exemple), et il ne lève jamais le signal d'arrêt d'une étape : ce qui dépend du signal d'arrêt (la libération d'une pause par le bouton Stop) n'est donc pas prouvé par les bancs.
- **Un hook qui lève une exception est écarté sans bruit** par le moteur : un module qui lèverait à chaque étape sur un fichier absent passerait inaperçu des bancs. Les modules attrapent leurs lectures et leurs appels de script ; les mutations qui ne sont observables que par une exception sont écartées et dites en tête de leur script.
- **La pause est coopérative** : elle retient la boucle avant sa prochaine étape ou son prochain outil, une réponse ou un outil déjà en cours va jusqu'au bout, et Stop reste l'arrêt immédiat. Un message tapé pendant un tour n'est traité qu'après le tour, y compris `/pause` et `/reprendre` : les boutons de la bande et du panneau agissent tout de suite.
- **Les accords de la Nuit** (une commande que l'utilisateur autorise par le bouton « Autoriser » du panneau ou par `/nuit repondre N Autoriser` tapé par lui, retenue en mémoire du module et jointe à l'appel du noyau) sont couverts par `mods/nuit/tests/accords.test.ts` et par des mutations dédiées (`nm-accord-*`, `nm-lot-*`).
- **Le son d'alerte du Garde-quota** passe par une commande PowerShell (`System.Media.SystemSounds`), parce que `$.audio.play` ne joue rien sur un terminal Windows : là où cette commande n'existe pas, l'alerte reste à l'écran et le son est sans effet.
- **Pas de `tsconfig.json` ni de types du moteur** : le dossier `.claude-plugin/types` d'un module est généré par l'application et ne se publie pas, et le `tsconfig.json` des sources n'en est que l'extension. `claude plugin validate` n'en a pas besoin et type les bancs contre les types du moteur courant.
