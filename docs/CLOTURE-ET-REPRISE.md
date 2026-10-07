# Clôture, preuves et reprise sans boucle

Un hook conserve et rappelle le travail. Il ne décide pas de lancer un agent et ne prouve pas qu'un test a réussi. Le parent doit contrôler le résultat avant de le déclarer traité.

## Identifiants

| Identifiant | Sens |
| --- | --- |
| Session ou tâche (UUID ou ID du runtime) | Qui a travaillé, dans quelle conversation |
| ID de tour ou empreinte de livraison | Quel résultat a été remis ; un doublon ne crée pas un nouveau reste |
| C-NNNN | Travail ou livraison à suivre |
| SHA Git | Révision du code contrôlé ; plusieurs agents peuvent contrôler le même SHA |
| SHA-256 du fichier de preuve | Contenu précis du rapport au moment du reçu |

Il n'y a pas un commit par session ou par agent. Une mission de lecture peut n'avoir aucun commit. Le rapport doit alors nommer la révision contrôlée et les preuves exécutées, sans créer de commit artificiel.

## Traitement d'une livraison

1. Le sous-agent rend son rapport, les commandes et leurs résultats réels, la révision contrôlée, les fichiers et les restes. Il ajoute ses notes à sa fiche ; il ne ferme pas la liste du parent.
2. Le parent lit le résultat et contrôle les preuves pertinentes dans le code ou le système autorisé. Il réutilise un contrôle déjà exécuté si son périmètre, son code et son environnement pertinents sont inchangés.
3. Il écrit le compte rendu du contrôle dans le périmètre autorisé. Une ligne d'état complète porte `statut: traite [ctx C-NNNN]`. Une ligne partielle porte `statut: partiel [ctx C-NNNN partiel]`.
4. Il dépose le reçu :

```text
node "<script>" traiter --projet P --session <session-parent> C-NNNN --preuve "controle.md" --executant <ID-executant> --verification "sources et tests controles" --resultat accepte
```

`accepte` retire la ligne de la vue active et conserve son reçu dans l'état et le journal. `partiel` la laisse en cours. `rejete` traite la réception d'une livraison insuffisante, mais exige `--reste C-NNNN` vers un autre travail encore ouvert. Traiter une livraison ne clôture pas les problèmes qu'elle contient : chacun reste suivi par sa source de travail.

La commande exige un vrai fichier texte, le statut, le marqueur et une déclaration de contrôle. Le hook ne comprend pas les preuves et ne les rejoue pas : une déclaration fausse reste une faute de l'agent. Les anciens marqueurs dans l'historique ou un commit restent compatibles ; le reçu explicite apporte une provenance plus précise.

Si une mission interdit toute écriture de suivi hors de son dossier, respecter cette interdiction. Ne pas déplacer la preuve ni forcer une écriture dans le registre. Dire ce qui reste à enregistrer ; un rappel inchangé ne bloque plus chaque fin de tour.

## Sources de preuve

Les appels d'outils servent à retrouver une commande et son résultat, pas à déduire qu'un fichier a été lu ou qu'une tâche est faite. L'historique Git relie un changement à une révision. La mémoire et l'historique de travail décrivent la vérification et ses limites. Consulter les sources pertinentes à l'item ; ne pas rescanner tous les rollouts et tous les commits à chaque tour.

Le réconciliateur suit les fichiers de preuve modifiés. Il écrit son curseur et les preuves en attente ensemble, puis n'acquitte une preuve qu'après application. Une interruption entre ces étapes permet sa reprise, sans perte. Les exemples, blocs de code, citations et mentions négatives ne clôturent pas une ligne.

## Rappels et périmètre

- Les injections et `lister --session <ID>` portent sur cette conversation. Les autres missions restent sur disque ; leur existence n'est pas un ordre de les exécuter.
- Une reprise autorisée passe par `reprendre --projet P --session <ID> C-NNNN`.
- Une fin identique est ignorée. Une nouvelle livraison encore en attente met à jour la même ligne ; une nouvelle livraison après clôture crée une nouvelle ligne.
- Au Stop, le même état des livraisons n'est rappelé qu'une fois. Les annonces pendant le tour et les rappels espacés restent disponibles. Une absence de rappel n'est jamais une preuve d'achèvement.
- Au Stop, une ligne ouverte ou tenue à jour pendant le tour ne relance pas l'agent : elle reste dans la liste, qui fait foi. Seuls un message pas encore trié et un résultat de sous-agent pas encore traité relancent la fin de tour.
- Après compactage, le sous-agent reçoit sa propre fiche. Il ne reprend pas la liste ni les demandes héritées du parent. Une tâche plus récente donnée par le parent (une relance) remplace la mission portée par la fiche.
- La mission prime sur la fiche : un sous-agent dont la mission interdit expressément toute écriture ailleurs que dans ses livrables n'écrit rien dans sa fiche, et le dit dans son rapport. Un audit en lecture seule n'interdit pas la fiche, qui est hors du dépôt.

Une relance doit répondre à un manque nommé, après lecture du résultat existant. Une interdiction de délégation prime sur un rappel de hook. Les sécurités de commandes et de suivi restent actives.
