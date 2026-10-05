# Protocole mémoire partagé entre agents

Ce protocole décrit où vit la mémoire, qui écrit quoi, et dans quel format. Il vaut pour tous les agents branchés sur la même maison (Claude Code, Codex). Les hooks du dépôt font la partie mécanique ; ce document dit ce qui reste à la charge de l'agent.

## 1. Où vit la mémoire

La maison est le dossier `~/.agent-memory-ledger` (ou celui de la variable `AGENT_MEMORY_LEDGER_HOME`). Elle est commune à tous les agents et à tous les projets.

| Système | Fichier | Rôle | Qui écrit |
| --- | --- | --- | --- |
| Liste de travail | `contexte/<projet>.<agent>.md` | ce qui reste à faire, mot pour mot | les hooks et la commande `context-ledger`, jamais à la main |
| Fiche d'un sous-agent | `contexte/<projet>.<agent>/fiches/<genre>-<identifiant>.md` | sa mission mot pour mot, puis ses notes | le hook la crée ; le sous-agent y ajoute ses notes (commande `note`), rien d'autre |
| Journal détaillé | `history/<projet>.<agent>.md` | une entrée par travail fait, la plus récente en haut | chaque agent dans SON fichier |
| Résumé commun | `Memory-Auto.md` | une ligne par événement, sous `### <projet>` | tous les agents, chacun ses lignes |
| Règles du projet | `history/<projet>.rules.md` | réflexes à appliquer en priorité | l'utilisateur ou l'agent, à la main |

`<agent>` vaut `claude`, `codex` ou `codex-home`. Le projet d'un dossier vient de la table `projets.json` de la maison, sinon du nom du dépôt git, sinon il n'y en a pas (voir `scripts/lib/config.js`). Les homes Codex gardent des signatures distinctes.

## 2. Au début d'une session

Les hooks injectent, sous un plafond de 9 000 caractères : la liste de travail du projet, l'alerte « session précédente non documentée », les règles du projet, les dernières lignes du résumé commun, le journal récent de chaque agent. Ce qui ne tient pas est nommé avec son chemin : le lire au besoin.

Après un compactage, ou à une reprise, c'est la liste de travail qui dit ce qui reste, pas le résumé de la conversation.

Les rappels portent sur la conversation courante. Pour reprendre un travail d'une autre conversation : `reprendre --projet P --session ID C-NNNN`, puis `lister --projet P --session ID`. Sans `--session`, la commande `lister` conserve l'accès à la vue globale pour diagnostic.

## 3. Pendant le travail

- Chaque message de l'utilisateur est enregistré mot pour mot dans la liste de travail (`M-NNNN`). Avant d'agir, le transformer en lignes de travail (`ajouter --de M-NNNN`), une ligne par travail demandé, ou le classer `sans-travail` avec sa raison.
- Un problème trouvé en route et suivi nulle part s'inscrit aussi (`ajouter` sans `--de`).
- Un sous-agent lancé reçoit une ligne `[agent]`. À sa fin, la ligne passe à « TERMINÉ, résultat à traiter » : lire le résultat, le vérifier, l'intégrer. Sa fin est annoncée à l'agent principal à son prochain outil ; pendant un tour long, un rappel revient toutes les 20 minutes tant qu'un résultat attend.
- Un sous-agent a sa fiche : sa mission mot pour mot (copiée par le hook quand elle est lisible, sinon recopiée par lui), puis ses notes d'avancement (`note --fiche <ID> "..."`). Après un compactage de SON contexte, sa fiche lui est rendue : c'est elle qui fait foi, pas le résumé. Avec Codex, où la mission est chiffrée pour les hooks, l'agent principal l'écrit aussi dans un fichier du dossier de travail avant de lancer le sous-agent, et lui en donne le chemin.
- Un sous-agent lit la liste de l'agent principal (fichier, ou commande `chercher`) et ne la modifie jamais. Sa mission est celle de son lancement : ce qu'il lit dans la liste, ou ce dont il a hérité, ne lui donne aucun travail.
- Dans la liste, « ouvert » veut dire « pas encore prouvé fait », pas « pas fait ». Un sous-agent qui constate qu'une ligne est déjà faite le signale (`note --fiche <ID> --genre deja-fait "C-NNNN : la preuve"`) ; l'agent principal vérifie et ferme la ligne par sa propre preuve. `--genre bloque` et `--genre question` passent par le même chemin : dits à l'agent principal à son prochain événement.

## 4. Quand un travail est fait

Écrire une entrée dans le journal de l'agent et une ligne dans le résumé commun. Un commit le fait tout seul (hook `commit.js`) ; pour un travail sans commit, l'écrire à la main.

Format, identique pour tous :

```markdown
## AAAA-MM-JJ HH:MM | fix | titre court | Claude

- ce qui a été fait, avec la preuve (test lancé, résultat)
- fichiers : lib/x.js, routes/y.js
- [ctx C-0012]
```

```markdown
- AAAA-MM-JJ HH:MM | fix | titre court | Claude
```

- Horodatage en heure locale.
- Type : `feat`, `fix`, `refactor`, `tests`, `config`, `docs`, `deploy`, ou le type du commit.
- Les entrées récentes vont en haut du journal, juste après la ligne `---`.
- Citer `[ctx C-NNNN]` retire la ligne de la liste de travail ; `[ctx C-NNNN partiel]` la laisse en cours. Aucune commande ne marque « fait » sans cette preuve écrite.
- Pour un livrable examiné, `traiter` valide un reçu contenant le fichier de preuve, son SHA-256, l'exécutant, le vérificateur, le résultat et les restes. Les statuts et les identifiants sont détaillés dans [CLOTURE-ET-REPRISE.md](CLOTURE-ET-REPRISE.md). Les journaux d'appels d'outils sont des indices, jamais une preuve automatique d'achèvement.

## 5. Règles d'or

1. Chacun écrit dans SON journal `<projet>.<agent>.md`, jamais dans celui d'un autre agent.
2. Le résumé commun est partagé : on y ajoute sa ligne signée, on ne modifie ni n'efface celle d'un autre.
3. Rien ne s'écrase : les entrées s'ajoutent.
4. Pas de doublon : ne pas réinsérer une ligne identique (les hooks dédoublonnent par SHA de commit).
5. Les hooks ne prouvent pas qu'un travail est branché, testé ou déployé : ils journalisent. La preuve reste à écrire.
6. La liste de travail ne se modifie jamais à la main : une garde refuse, et toute ligne effacée est restaurée.
7. Seul l'agent principal écrit dans la liste. Un sous-agent la lit, écrit dans sa fiche, et signale ce qu'il constate.

## 6. Ce que font les hooks

| Moment | Script | Effet |
| --- | --- | --- |
| Début de session | `claude/context-ledger.js` ou `codex/context-ledger.js` | réinjecte la liste de travail |
| Début de session | `memoire/demarrage.js` | réinjecte la mémoire du projet |
| Message de l'utilisateur | `context-ledger.js` | enregistre le message mot pour mot |
| Avant un outil | `context-ledger.js` | refuse toute écriture à la main dans la liste de travail ; pour un sous-agent : lecture permise, écriture refusée |
| Après un outil | `context-ledger.js` | applique les preuves `[ctx]`, suit les sous-agents lancés, annonce ceux qui viennent de finir, dit leurs signalements et rappelle les résultats qui attendent ; rend sa fiche à un sous-agent dont le contexte vient d'être compacté |
| Après un commit | `memoire/commit.js` | entrée signée dans le journal et le résumé |
| Après une écriture de fichier | `memoire/marqueur.js` | compte le travail non documenté |
| Fin de tour | `context-ledger.js` | rappel borné par message humain et par état des livraisons, sans continuation répétée d'un état inchangé |
| Fin de tour | `memoire/checkpoint.js` | point de contrôle toutes les deux heures |
| Démarrage d'un sous-agent | `context-ledger.js` | crée sa fiche et lui donne sa consigne (redonnée à son premier outil si cet événement a manqué, ou si sa conversation ne la contient pas) |
| Fin d'un sous-agent | `context-ledger.js` | marque son résultat « à traiter » |
| Avant compactage | `memoire/avant-compactage.js` | sauve l'état des dépôts |
| Après compactage | `context-ledger.js` | note le compactage d'un sous-agent ; Codex : programme la réinjection de la liste |
| Après compactage | `memoire/rappel.js` | réinjecte les 12 dernières heures |
| Fin de session | `memoire/fin-session.js` | entrée « wip » si du travail n'est pas commité |
