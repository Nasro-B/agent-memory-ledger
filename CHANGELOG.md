# Journal des versions

Ce que chaque version apporte, et ce qu'il faut refaire, ou non, en la prenant. La version est celle du manifeste du plugin (`.claude-plugin/plugin.json`), la même que dans l'entrée de marketplace et dans `package.json`.

## 0.13.0

Apporte les **six modules d'interface de Claude Code** du Cockpit (`mods/` : `consignes`, `garde-quota`, `regulateur`, `pause`, `nuit`, `cockpit`) : des plugins de plus, déclarés dans la marketplace du dépôt, qui branchent les noyaux dans Claude Code (le plafond d'agents et la file avant le lancement d'un agent, les consignes avant chaque commande, le quota à chaque mesure, la Nuit à chaque question et à chaque fin de tour, la pause avant chaque étape, la bande et le panneau du Cockpit), avec leurs bancs du moteur de Claude Code et leurs preuves par mutation. Ils sont **facultatifs et indépendants** : qui n'en installe aucun n'a rien à faire. Chacun lit et écrit les fichiers d'état des noyaux et de `scripts/cockpit.js` (le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit`). Voir [Les modules d'interface de Claude Code](README.md#les-modules-dinterface-de-claude-code-facultatif) et [docs/MODULES-INTERFACE.md](docs/MODULES-INTERFACE.md).

**Mise à jour : rien à refaire.** Les modules d'interface sont des plugins à part : aucun n'est installé ni actif tant que vous ne l'installez pas. Le comportement des hooks et des gardes ne change pas.

## 0.12.0

Apporte les **hooks de Codex** du Cockpit et de ses modules : l'injection de l'état du travail, le plafond d'agents du Régulateur et sa file d'attente, le refus des commandes verrouillées par une consigne, la Nuit (question mise en boîte, enchaînement, réveil), l'outil qui les branche, les retire ou les vérifie dans le `hooks.json` de Codex (`node scripts/installer-codex.js --cockpit`), le point d'entrée de la file (`scripts/regulateur-file.js`) et l'outil qui recopie une logique commune dans les modules qui en embarquent une copie (`scripts/synchroniser-mods.js`). Ces hooks ne sont **jamais branchés d'eux-mêmes** : qui n'utilise que la liste de travail et la mémoire n'a rien à faire, et Codex demande d'approuver chaque hook ajouté (voir [Brancher le Cockpit dans Codex](README.md#brancher-le-cockpit-dans-codex-facultatif)).

**Mise à jour : rien à refaire.** Les hooks de Codex du Cockpit ne se branchent que par `node scripts/installer-codex.js --cockpit` : sans cette option, rien ne change.

## 0.11.0

Apporte les **noyaux d'entrées-sorties** de cinq modules du Cockpit : le Régulateur d'agents et sa file d'attente, les Consignes, le Garde-quota (avec la lecture native du quota de Codex), la Pause et la Nuit avec sa boîte. La commande `node scripts/cockpit.js` est complète (`politique`, `quota`, `consignes`, `nuit`, `nuit-hook`, `pause`, `reprendre`, `pause-hook` s'ajoutent aux quatre premières), et les noms d'agents du dépôt (`deepseek_H`) sont convertis en clés d'état par une seule fonction. Ces noyaux se pilotent par la ligne de commande (voir [docs/COCKPIT-ET-MODULES.md](docs/COCKPIT-ET-MODULES.md)).

**Mise à jour : rien à refaire.** Les noyaux du Régulateur d'agents, des Consignes, du Garde-quota (avec sa lecture native), de la Pause et de la Nuit sont ajoutés, avec les commandes `politique`, `quota`, `consignes`, `nuit`, `nuit-hook`, `pause`, `reprendre` et `pause-hook` de `scripts/cockpit.js`. Aucun hook ni aucune garde ne les appelle : le comportement des hooks et des gardes ne change pas. Les commandes n'écrivent que dans le dossier d'état du Cockpit. Un seul changement touche la liste de travail : l'enchaînement automatique de la Nuit (« NUIT : L'utilisateur est absent. Continue sans l'attendre ... ») n'est plus enregistré comme un message de l'utilisateur quand un adaptateur le reçoit.

## 0.10.0

Apporte le **noyau du Cockpit** : il mesure l'état réel du travail (la liste de travail de chaque agent, les sous-agents en cours, finis ou à traiter, l'état git des dépôts suivis, l'avancement des plans à cases, le quota) et le rend en une ligne ; avec le noyau des modèles par agent et la commande `node scripts/cockpit.js` (`ligne`, `instantane`, `rafraichir-git`, `config`).

**Mise à jour : rien à refaire.** Le noyau du Cockpit, le noyau des modèles par agent et la commande `scripts/cockpit.js` (`ligne`, `instantane`, `rafraichir-git`, `config`) sont ajoutés. Rien ne les appelle : ni hook ni garde, le comportement des hooks et des gardes ne change pas. La commande n'écrit que dans le dossier d'état du Cockpit (`COCKPIT_DIR`, sinon `cockpit/` dans la maison), et jamais dans vos dépôts, vos plans ou votre liste de travail.

## 0.9.0

Apporte les **logiques pures** du Cockpit et de ses modules (réglages, Régulateur d'agents et sa file d'attente, Consignes, Nuit, Pause, Garde-quota, modèles par agent), avec leurs bancs et leurs preuves par mutation.

**Mise à jour : rien à refaire.** Les logiques pures du Cockpit et de ses modules sont ajoutées, sans effet tant qu'aucune commande ni aucun hook ne les appelle : le comportement des hooks et des gardes ne change pas.

## 0.8.0

Apporte trois gardes (voir [Gardes](docs/GARDES.md)) : une garde de sécurité des commandes (refuse les commandes destructrices, demande confirmation pour une poussée ou un déploiement de production), un rappel avant commit (un commit qui touche une migration, une fonction déployée à part, une variable d'environnement ou une tâche planifiée est refusé tant que l'agent n'a pas confirmé l'action réelle) et une garde des caractères invisibles. Elles sont actives par défaut et se règlent dans `gardes.json`.

**Mise à jour : les trois gardes sont actives dès la mise à jour.** Pour en désactiver une, créez `gardes.json` dans la maison (`~/.agent-memory-ledger`, ou `AGENT_MEMORY_LEDGER_HOME`) : `{ "securite": { "actif": false } }`, `{ "checklist": { "actif": false } }` ou `{ "caracteres": { "actif": false } }`, ensemble ou séparément. Sans ce fichier rien n'est à faire. Seul un `false` écrit comme tel éteint une garde : un fichier illisible, ou une valeur autre qu'un booléen, laisse les gardes actives avec leurs valeurs par défaut, et elles le disent. Le rappel avant commit refuse aussi un commit qui touche une migration, une fonction déployée à part, une variable d'environnement lue par le code ou une tâche planifiée : si vous ne voulez pas de ce rappel, éteignez-le, ou retirez les catégories qui ne vous concernent pas (voir [Gardes](docs/GARDES.md)). Codex : `node scripts/installer-codex.js --appliquer` ajoute les nouveaux hooks, puis approuvez-les dans Codex.

## 0.7.0

Liste de travail :

- la mention complète n'est plus annulée par un mot de travail non fini d'une autre proposition de la ligne (et « non terminée », « à vérifier » avec accent ou au féminin sont reconnus) ;
- un commit est lu après `Set-Location`, `cd` ou `$d = '...'; git -C $d`, et un commit fait par un script est lu par la ligne que git écrit ;
- un commit sans mention est dit tout de suite ;
- les preuves « partiel » sont comptées et rappelées toutes les cinq ;
- le commit d'un sous-agent est annoncé à l'agent principal sans rien fermer ;
- la demande de message suggéré de Codex n'est plus un message de l'utilisateur ;
- `ajouter` avertit d'une ligne qui porte plusieurs travaux, d'une réponse de questionnaire ou d'une consigne ;
- les fichiers temporaires d'écritures interrompues de plus d'une heure sont retirés au démarrage ;
- le rapport de fin d'un sous-agent, que l'application remet comme un tour de l'utilisateur (balise `agent-message`), ne reçoit plus de numéro M, et suit une nouvelle ligne si celle du sous-agent est close ;
- un sous-agent relancé après la clôture de sa ligne est suivi de nouveau (Claude Code : le hook d'après outil écoute aussi l'envoi de message à un agent, `SendMessage`), au lieu de voir son second rapport écarté ;
- un sous-agent fini dont le résultat n'est pas prouvé traité est redit en entier, avec le chemin de son résultat, à chaque nouveau message de l'utilisateur, au démarrage, à la reprise, avec la liste redonnée après un compactage et à l'arrivée d'un rapport (jamais sur un simple outil) ;
- la garde de lecture des sous-agents analyse les scripts de lecture (boucles, affectations, méthodes de lecture, `git` en lecture) ;
- la copie de secours est asynchrone (un travailleur détaché la fait ; `CONTEXT_LEDGER_SECOURS_SYNCHRONE=1` rend l'ancien comportement).

Mémoire :

- les écritures du journal et du résumé passent sous un verrou, par remplacement atomique, et en une transaction rejouée si elle est interrompue ;
- le démarrage rappelle les 25 entrées les plus récentes par horodatage (et non les 25 premières lignes) ;
- le marqueur de travail non documenté compte les éditions et les fichiers distincts, et ignore une écriture échouée ;
- un point de contrôle ou un état avant compactage n'est écrit qu'une fois par minute.

**Mise à jour : rien à refaire.** Les fichiers existants restent lisibles (un marqueur ancien, sans liste de fichiers, s'affiche « fichiers distincts inconnus »).

## 0.6.0

L'agent `deepseek_H` (DeepSeek Harness) est accepté par les scripts de mémoire, avec son adaptateur `scripts/deepseek_h`. Rappel après compactage : fenêtre de six heures, entrées automatiques ignorées et comptées. Liste de travail : quand la liste injectée dépasse son plafond, les lignes les plus anciennes sautent, et cela est annoncé ; les lignes sans conversation sont montrées à part.

## 0.5.1

Bancs : les délais des processus qu'un banc lance sont des garde-fous larges, pas des mesures.

## 0.5.0

Fin de tour : le rappel des lignes ouvertes ou tenues à jour pendant le tour est retiré (la ligne reste dans la liste). Sous-agents : la consigne demande de lire la mission avant d'écrire dans la fiche, et de ne rien y écrire si la mission l'interdit. Un sous-agent peut écrire son rapport même quand son texte cite la liste.

## 0.4.0

Rappels bornés et clôtures tracées : reprises isolées par session, reçus explicites (commande `traiter`), livraisons dédoublonnées.

## 0.3.0

Boîte de signalements entre agents principaux (commande `signaler`).

## 0.2.0

Une fiche par sous-agent, liste en lecture seule pour les sous-agents, signalements, budget de temps des hooks.

**Mise à jour :**

- Claude Code : mettez le plugin à jour ; les deux nouveaux hooks (démarrage d'un sous-agent, après compactage) sont actifs à la session suivante.
- Codex : l'installateur ne modifie jamais un hook déjà en place, vos anciens délais (10 secondes) restent donc. Pour prendre les nouveaux : `node scripts/installer-codex.js --retirer --appliquer`, puis `node scripts/installer-codex.js --appliquer`, et approuvez de nouveau les hooks dans Codex. Si vous gardez les anciens délais, posez `CONTEXT_LEDGER_BUDGET_MS=8000` dans l'environnement où tourne Codex.

## 0.1.0

Première version : liste de travail et mémoire partagée pour Claude Code et Codex. Trois correctifs ont été publiés sous cette version sans la changer ; ils n'ont atteint aucune installation existante avant la 0.2.0 (voir « Avant de publier vos modifications » dans le README).
