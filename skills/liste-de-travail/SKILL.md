---
name: liste-de-travail
description: Règles de la liste de travail tenue par agent-memory-ledger. À utiliser dès qu'un hook injecte « Fichier contexte », un message M-NNNN à trier, une ligne C-NNNN, ou un rappel de sous-agent terminé, et avant de répondre « c'est fini » ou « il ne reste que ».
---

# Liste de travail (fichier contexte)

Les hooks de ce plugin tiennent, sur disque, la liste de ce que l'utilisateur a demandé et de ce qui reste à faire. Elle survit aux compactages et aux changements de session. Elle fait foi : pas le résumé de la conversation, pas ta mémoire du fil.

## Ce que les hooks font seuls

- Chaque message de l'utilisateur est enregistré mot pour mot : `M-NNNN`, section « À trier ».
- La liste est réinjectée au début de session, après un compactage, et quand elle change.
- Chaque sous-agent ou workflow lancé en arrière-plan reçoit une ligne `[agent]`. À sa fin, elle devient « TERMINÉ, résultat à traiter ».
- À chaque fin de tour, un rappel cite ce qui n'est ni fait ni mentionné dans ta réponse.

Le texte injecté donne toujours la commande exacte à lancer, avec le bon chemin et le bon projet. Utilise-la telle quelle.

## Ce que tu fais

1. **Trier chaque message avant d'agir.** Une ligne par travail demandé, texte mot pour mot : `ajouter --projet P --de M-NNNN "texte"`. Une question ou une simple réponse : `sans-travail --projet P M-NNNN "raison"`.
2. **Inscrire ce que tu trouves en route** et qui n'est suivi nulle part : `ajouter --projet P "texte"` (sans `--de`). Exception : si tu suis un document de travail (plan à cases, audit, reste à faire), le problème s'ajoute dans ce document, pas ici. Une seule source par problème.
3. **Lire la sortie de `ajouter`** avant de citer un identifiant : la numérotation est commune à tous les projets et à toutes les sessions.
4. **Prouver pour retirer.** Aucune commande ne marque « fait ». Quand le travail est fait, cite `[ctx C-NNNN]` dans l'entrée d'historique qui le décrit, ou dans le message du commit. S'il n'est pas fini : `[ctx C-NNNN partiel]`. Le hook retire la ligne sur cette preuve écrite.
5. **Dire l'état.** `etat --projet P C-NNNN en-cours|bloque-utilisateur|ouvert "note"`. `bloque-utilisateur` demande une raison : ce qui attend l'utilisateur.
6. **Traiter les résultats de sous-agents avant de t'arrêter.** Lis le résultat, vérifie-le, intègre-le, puis cite `[ctx C-NNNN]`. Si tu ne peux pas dans ce tour, dis à l'utilisateur lequel reste et pourquoi.
7. **Avant de dire « c'est fini » ou « il ne reste que »** : `lister --projet P`, et réponds depuis cette liste.

## Ce que tu ne fais jamais

- Modifier à la main un fichier du dossier `contexte` : la garde refuse, et toute ligne effacée est restaurée.
- Abandonner une ligne de ta propre initiative. `abandon --projet P C-NNNN "citation"` exige une citation exacte d'un message de l'utilisateur écrit APRÈS la création de la ligne : un contre-ordre. La demande d'origine ne suffit pas.
- Laisser un sous-agent écrire dans la liste. Il rend son résultat, toi seul la mets à jour.

## Messages reçus pendant que tu travailles

Ils sont enregistrés au prochain événement, et annoncés : « reçu(s) pendant ce tour ». Trie-les comme les autres. Si un message est signalé « NON enregistré », inscris-le toi-même mot pour mot avec `ajouter`.
