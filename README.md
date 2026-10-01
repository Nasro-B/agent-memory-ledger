# agent-memory-ledger

Mémoire partagée et liste de travail pour agents de code. Fonctionne avec **Claude Code** et **Codex**, ensemble ou séparément, sur la même mémoire.

Un agent de code oublie de quatre façons. Ce dépôt les ferme une par une, avec des hooks, sans service ni base de données : des fichiers texte dans un dossier.

| Ce qui se perd | Ce que fait le dépôt |
| --- | --- |
| Une demande faite il y a deux heures, disparue au compactage | Chaque message est enregistré mot pour mot sur disque, puis transformé en lignes de travail. Une ligne ne se retire que sur preuve écrite. |
| Un message envoyé pendant que l'agent travaille | Il est enregistré au prochain événement et rappelé en fin de tour tant qu'il n'est pas trié. |
| Le résultat d'un sous-agent, arrivé pendant un autre travail | Chaque sous-agent lancé devient une ligne. À sa fin elle passe à « résultat à traiter » : l'agent principal en est prévenu à son prochain outil, puis rappelé toutes les 20 minutes pendant un tour long, et à chaque fin de tour. |
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

Aucune commande ne marque une ligne « faite ». Il n'y a qu'un chemin : citer `[ctx C-NNNN]` là où le travail est décrit (entrée d'historique ou message de commit). Une garde refuse toute modification à la main de la liste, et une ligne effacée est restaurée depuis un journal en ajout seul.

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

Les hooks affichent toujours la commande exacte, avec le bon chemin et le bon projet. Les cinq commandes :

```
node "<script>" ajouter --projet P --de M-0042 "texte mot pour mot"   # un message devient une ligne de travail
node "<script>" ajouter --projet P "problème trouvé en route"         # une ligne sans message d'origine
node "<script>" sans-travail --projet P M-0042 "simple question"      # un message qui ne demande aucun travail
node "<script>" etat --projet P C-0107 en-cours|bloque-utilisateur|ouvert "note"
node "<script>" abandon --projet P C-0107 "citation exacte de l'utilisateur"
node "<script>" lister --projet P
```

`<script>` est `scripts/claude/context-ledger.js` ou `scripts/codex/context-ledger.js`. Un texte long ou plein de guillemets se passe par `--fichier <chemin>`.

Abandonner une ligne exige une citation exacte d'un message écrit par l'utilisateur **après** la création de la ligne : un contre-ordre. La demande d'origine ne suffit pas.

## Où sont les données

Dans `~/.agent-memory-ledger`, jamais dans vos dépôts. Pour un autre emplacement : la variable `AGENT_MEMORY_LEDGER_HOME`.

| Variable | Effet |
| --- | --- |
| `AGENT_MEMORY_LEDGER_HOME` | dossier de la mémoire (défaut : `~/.agent-memory-ledger`) |
| `CONTEXT_LEDGER_SECOURS_DIR` | copie de secours du journal de la liste, de préférence sur un autre disque ; si le dossier principal est effacé, la liste est reconstruite depuis cette copie |
| `CONTEXT_LEDGER_RAPPEL_LIVRAISONS_MIN` | délai, en minutes, du rappel en cours de tour des résultats de sous-agents non traités (défaut : 20) |

**Projets.** Le projet d'une session est le nom du dossier racine de son dépôt git (un worktree compte pour son dépôt). Pour regrouper plusieurs dossiers sous un nom, ou nommer un dossier qui n'est pas un dépôt, créez `projets.json` dans la maison :

```json
{ "projets": [ { "nom": "ma-boutique", "motif": "ma-boutique|boutique-admin" } ] }
```

Le motif est une expression régulière appliquée au chemin ; le premier qui correspond gagne. Un dépôt situé sous le dossier temporaire du système n'est pas pris pour un projet, sauf si la table le nomme. Hors de tout projet, la liste de travail range tout dans `_general`, et les hooks de mémoire ne font rien.

## Ce que font les hooks

| Événement | Liste de travail | Mémoire |
| --- | --- | --- |
| Début de session | réinjecte ce qui reste | règles du projet, résumé, journaux récents, alerte de travail non documenté |
| Message de l'utilisateur | enregistre mot pour mot | |
| Avant un outil | refuse l'écriture à la main dans la liste | |
| Après un outil | applique les preuves `[ctx]`, suit les sous-agents lancés, annonce ceux qui viennent de finir et rappelle les résultats qui attendent, enregistre les réponses de l'utilisateur à un questionnaire (Claude Code) | journalise les commits, compte les fichiers modifiés |
| Fin de tour | rappelle ce qui n'est ni fait ni cité, et les résultats de sous-agents non traités | point de contrôle toutes les deux heures |
| Fin d'un sous-agent | marque son résultat « à traiter » | |
| Avant compactage | | sauve l'état des dépôts |
| Après compactage | réinjecte la liste | réinjecte les 12 dernières heures |
| Fin de session | | entrée « wip » si du travail n'est pas commité |

Tout texte destiné au modèle tient sous 9 000 caractères. Ce qui ne tient pas est coupé avec le chemin du texte complet, jamais en silence. Aucun hook ne bloque l'utilisateur sur une erreur interne, sauf la garde, qui refuse en cas de doute.

## Ce qui est prouvé

Ce dépôt dit ce qui a été mesuré, et ce qui ne l'a pas été.

**Par bancs de tests** (sans modèle, payloads simulés) : 139 tests, tous verts.

| Banc | Tests | Couvre |
| --- | --- | --- |
| `tests/context-ledger-claude.test.js` | 71 | noyau et adaptateur Claude Code |
| `tests/context-ledger-codex.test.js` | 49 | adaptateur Codex, sorties validées contre le schéma de codex-cli 0.155 |
| `tests/memoire.test.js` | 14 | hooks de mémoire, détection de projet, installateur Codex |
| `tests/verifier-public.test.js` | 5 | contrôle avant publication |

Quarante-deux mutations y sont jouées : on casse volontairement une protection dans une copie du code (la garde, le dédoublonnage, le rappel, la restauration...) et le banc correspondant doit devenir rouge. Un banc qui reste vert quand le code est cassé ne prouve rien.

**En conditions réelles** :

- Claude Code (2.1.284, Windows 11) : l'enregistrement des messages, y compris ceux envoyés pendant un tour, la garde, le retrait sur preuve, le rappel de fin de tour, l'enregistrement des réponses à un questionnaire et la réinjection de la liste après deux compactages réels ont été observés en session réelle, sur l'installation dont ce code est issu. Sous-agents : dans une session qui en a lancé 24, chaque lancement a créé sa ligne et chaque fin a été marquée. Lus dans le transcript de l'agent principal : l'annonce d'une fin quatre secondes après (à l'outil suivant), le rappel en cours de tour vingt et une minutes après le précédent, puis le rappel à deux fins de tour de suite ; les 24 lignes ont ensuite été fermées sur preuve. C'est cette session qui a montré le défaut corrigé depuis : avant, un sous-agent fini pendant un tour long n'était rappelé qu'à la fin du tour, et 7 résultats avaient attendu plus de quatre heures sans rappel.
- Ce dépôt lui-même, chargé par `claude --plugin-dir` (Claude Code 2.1.214) : le hook réel a enregistré mot pour mot le message de la session, dans une maison de test.
- Codex (0.155) : la forme des événements a été vérifiée dans le code source de Codex et dans des sessions réelles ; les sorties sont validées contre le schéma de cette version.

**Pas encore observé en conditions réelles** : la liste de travail et le suivi des sous-agents dans une session Codex ; l'installation par `/plugin install` ; les hooks d'outils et de fin de tour quand le code vient de ce dépôt plutôt que de l'installation d'origine ; macOS et Linux (développé et testé sous Windows 11, Node 22). Les hooks de mémoire sont une réécriture, commune aux deux agents, de hooks utilisés au quotidien : sous cette forme, ils sont prouvés par bancs.

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

## Limites connues

- Seul l'agent principal écrit dans la liste. Un sous-agent lancé par un sous-agent n'est pas suivi : celui qui l'a lancé rend compte.
- Codex : le texte ajouté par un hook après un outil n'a pas été observé côté modèle. Le rappel de fin de tour passe donc par un blocage du Stop, qui est le canal sûr ; il fait continuer le tour une fois.
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
