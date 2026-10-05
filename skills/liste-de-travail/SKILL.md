---
name: liste-de-travail
description: Règles de la liste de travail tenue par agent-memory-ledger. À utiliser dès qu'un hook injecte « Fichier contexte », un message M-NNNN à trier, une ligne C-NNNN, un rappel de sous-agent terminé ou un signalement de sous-agent, quand tu es toi-même un sous-agent qui reçoit sa fiche, et avant de répondre « c'est fini » ou « il ne reste que ».
---

# Liste de travail (fichier contexte)

Les hooks de ce plugin tiennent, sur disque, la liste de ce que l'utilisateur a demandé et de ce qui reste à faire. Elle survit aux compactages et aux changements de session. Elle fait foi : pas le résumé de la conversation, pas ta mémoire du fil.

## Ce que les hooks font seuls

- Chaque message de l'utilisateur est enregistré mot pour mot : `M-NNNN`, section « À trier ».
- La partie rattachée à cette conversation est réinjectée au début de session, après un compactage, et quand elle change. Les autres missions restent conservées sans ordre de les exécuter.
- Chaque sous-agent ou workflow lancé en arrière-plan reçoit une ligne `[agent]`. À sa fin, elle devient « TERMINÉ, résultat à traiter » : tu en es prévenu à ton prochain outil, puis rappelé toutes les 20 minutes tant que le résultat attend.
- Chaque sous-agent a sa fiche sur disque : sa mission mot pour mot, puis les notes qu'il y ajoute. Elle lui est rendue après un compactage de son contexte. Ce qu'il te signale (une ligne déjà faite, un blocage, une question) t'est dit à ton prochain événement, sans attendre sa fin.
- En fin de tour, un rappel est borné par message humain et par état des livraisons. Un résultat inchangé ne relance pas chaque tour ; il reste sur disque tant qu'il n'est pas prouvé traité.

Le texte injecté donne toujours la commande exacte à lancer, avec le bon chemin et le bon projet. Utilise-la telle quelle.

## Ce que tu fais

1. **Trier chaque message avant d'agir.** Une ligne par travail demandé, texte mot pour mot : `ajouter --projet P --de M-NNNN "texte"`. Une question ou une simple réponse : `sans-travail --projet P M-NNNN "raison"`.
2. **Inscrire ce que tu trouves en route** et qui n'est suivi nulle part : `ajouter --projet P --session ID "texte"` (sans `--de`). Exception : si tu suis un document de travail (plan à cases, audit, reste à faire), le problème s'ajoute dans ce document, pas ici. Une seule source par problème.
3. **Lire la sortie de `ajouter`** avant de citer un identifiant : la numérotation est commune à tous les projets et à toutes les sessions.
4. **Prouver pour retirer.** `etat` ne marque jamais « fait ». Quand le travail est fait, cite `[ctx C-NNNN]` dans l'entrée d'historique qui le décrit, ou dans le message du commit. Pour un rapport contrôlé : `traiter --projet P --session ID C-NNNN --preuve "controle.md" --executant ID --verification "controle effectue" --resultat accepte` ; le fichier doit porter `statut: traite` et le marqueur exact. `--resultat partiel` exige `statut: partiel` et `[ctx C-NNNN partiel]`, et conserve la ligne active. Une livraison rejetée exige un autre reste ouvert (`--resultat rejete --reste C-NNNN`). Ce reçu ne rejoue pas les preuves : tu dois effectuer le contrôle avant de le déposer.
5. **Dire l'état.** `etat --projet P C-NNNN en-cours|bloque-utilisateur|ouvert "note"`. `bloque-utilisateur` demande une raison : ce qui attend l'utilisateur.
6. **Traiter les résultats de sous-agents sans attendre la fin du tour.** Dès que l'étape en cours est finie : lis le résultat, vérifie-le, intègre-le, puis cite `[ctx C-NNNN]`. Jamais de fin de tour avec un résultat non traité sans le dire : si tu ne peux pas dans ce tour, dis à l'utilisateur lequel reste et pourquoi.
7. **Traiter un signalement de sous-agent dès qu'il est annoncé.** « Déjà fait » : vérifie dans le code ou l'historique ; si c'est exact, ferme la ligne par ta preuve `[ctx C-NNNN]`, sinon réponds-lui. « Bloqué » ou « question » : réponds-lui, il attend.
8. **Avant de dire « c'est fini » ou « il ne reste que »** : `lister --projet P --session ID`, et réponds depuis cette liste. Une ligne « ouverte » n'est pas une ligne « pas faite » : c'est une ligne pas encore prouvée faite. Mesure avant de la refaire. Une reprise autorisée utilise `reprendre --projet P --session ID C-NNNN` ; une nouvelle conversation ne reprend pas automatiquement tout le projet.
9. **Faire converger.** Avant de relancer un agent, lire son dernier résultat. Réutiliser les preuves dont la révision et le périmètre sont inchangés. Nommer le manque exact qui justifie une relance ; un rappel de hook ne suffit pas. Respecter les interdictions de délégation et d'écriture, y compris pour les commandes de suivi.

## Ce que tu ne fais jamais

- Modifier à la main un fichier du dossier `contexte` : la garde refuse, et toute ligne effacée est restaurée.
- Abandonner une ligne de ta propre initiative. `abandon --projet P C-NNNN "citation"` exige une citation exacte d'un message de l'utilisateur écrit APRÈS la création de la ligne : un contre-ordre. La demande d'origine ne suffit pas.
- Laisser un sous-agent écrire dans la liste. Il peut la lire ; il rend son résultat, toi seul la mets à jour.

## Si tu es un sous-agent

Un hook te le dit : « Fichier contexte : tu es un sous-agent », avec le chemin de ta fiche et tes commandes.

- Ta mission est celle de ton lancement, rien d'autre. Les messages de l'utilisateur, les « À trier » et les lignes ouvertes que tu lis dans la liste, ou dont tu as hérité, s'adressent à l'agent principal : ils ne te donnent aucun travail.
- Si ta mission n'est pas dans ta fiche, recopie-la d'abord mot pour mot : `note --fiche <ID> --genre mission "..."`.
- Note ton avancement dans ta fiche au fil du travail : `note --fiche <ID> "fait : ... ; reste : ..."`. Après un compactage de ton contexte, ta fiche t'est rendue : c'est elle qui fait foi, pas le résumé.
- La liste de l'agent principal se lit (le fichier, `chercher --projet P "mot"`, ou `chercher --projet P C-0107 C-0108` pour des lignes entières), elle ne se modifie pas. Une lecture par commande simple, sans boucle ni script.
- Tu constates qu'une ligne de la liste est déjà faite : tu ne la fermes pas, tu le signales avec sa preuve (`note --fiche <ID> --genre deja-fait "C-NNNN : la preuve"`). Bloqué, ou une question pour l'agent principal : `--genre bloque`, `--genre question`.

## Entre agents principaux

- Une ligne de la liste d'un AUTRE agent que tu vois déjà faite, qui te bloque ou qui pose question : ne la modifie pas, signale-la (`signaler --agent <celui qui tient la liste> --projet P C-NNNN [--genre deja-fait|bloque|question] "la preuve"`).
- Un signalement reçu t'est dit à ton prochain événement, puis rappelé avec ta liste tant que la ligne est ouverte : vérifie, ferme-la par ta preuve, ou dis à l'utilisateur pourquoi elle reste ouverte.

## Messages reçus pendant que tu travailles

Ils sont enregistrés au prochain événement, et annoncés : « reçu(s) pendant ce tour ». Trie-les comme les autres. Les réponses de l'utilisateur à un questionnaire sont enregistrées de la même façon : ce sont ses décisions. Si un message est signalé « NON enregistré », inscris-le toi-même mot pour mot avec `ajouter`.
