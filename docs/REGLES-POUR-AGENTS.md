# Règles à donner à vos agents

Les hooks enregistrent, rappellent et gardent. Ils ne remplacent pas la consigne : l'agent doit savoir quoi faire de ce qu'ils lui montrent. Copiez le bloc ci-dessous dans le fichier d'instructions de chaque agent (`~/.claude/CLAUDE.md` pour Claude Code, `~/.codex/AGENTS.md` pour Codex), en remplaçant `<SCRIPT>` par le chemin que les hooks affichent dans leurs messages :

- Claude Code : `<dossier du plugin>/scripts/claude/context-ledger.js`
- Codex : `<dossier du dépôt>/scripts/codex/context-ledger.js`
- Codex Home : `<dossier du dépôt>/scripts/codex-home/context-ledger.js`

Pour Claude Code, le skill `liste-de-travail` du plugin porte déjà ces règles ; le bloc reste utile pour qu'elles soient lues à chaque session.

```markdown
## Liste de travail : elle fait foi, rien ne s'oublie

- Où : `~/.agent-memory-ledger/contexte/<projet>.<agent>.md` (vue en lecture seule). Chaque message de
  l'utilisateur y est enregistré mot pour mot par un hook (M-NNNN, section « À trier »).
- Avant d'agir sur un message : le transformer en lignes de travail, une ligne par travail demandé, texte mot
  pour mot (`node "<SCRIPT>" ajouter --projet P --de M-NNNN "texte"`), ou le classer `sans-travail` avec sa
  raison (question, simple réponse).
- Un problème trouvé en route et suivi nulle part s'inscrit aussi (`ajouter` sans `--de`). Un travail qui suit
  un document de travail (plan à cases, audit, reste à faire) ne recopie pas ses problèmes ici : le document
  fait foi. Une seule source par problème.
- Une ligne ne se retire que sur preuve : citer `[ctx C-NNNN]` dans l'entrée d'historique ou le message du
  commit qui décrit le travail fait ; `[ctx C-NNNN partiel]` si ce n'est pas fini. Aucune commande ne marque
  « fait » sans preuve. Pour un rapport examiné, utiliser `traiter --projet P --session ID C-NNNN
  --preuve "controle.md" --executant ID --verification "controle effectue" --resultat accepte` : le
  fichier doit porter `statut: traite` et le marqueur exact. Un résultat partiel reste actif ; une livraison
  rejetée exige `--reste C-NNNN` pointant un travail ouvert. Ne jamais assimiler livraison traitée et mission
  entièrement résolue.
- Jamais de modification à la main du dossier `contexte`. Une ligne n'est abandonnée que sur citation exacte
  d'un message de l'utilisateur écrit APRÈS la création de la ligne (commande `abandon`).
- Sous-agents : chaque sous-agent lancé reçoit une ligne `[agent]`, marquée « TERMINÉ, résultat à traiter » à
  sa fin. Sa fin est annoncée au prochain outil, puis rappelée toutes les 20 minutes pendant un tour long :
  ne pas attendre la fin du tour. Lire le résultat, le vérifier, l'intégrer, puis citer `[ctx C-NNNN]`. Sinon,
  dire à l'utilisateur lequel reste et pourquoi.
- Signalement d'un sous-agent (déjà fait, bloqué, question) : le traiter dès qu'il est annoncé. « Déjà fait »
  se vérifie dans le code ou l'historique avant de fermer la ligne par une preuve.
- Avant de lancer un sous-agent avec Codex : écrire son brief dans un fichier du dossier de travail et lui en
  donner le chemin. Codex chiffre le message de lancement pour les hooks : sans ce fichier, un sous-agent dont
  le contexte est compacté n'a plus que le résumé pour retrouver sa mission. Dès que sa ligne `[agent]` existe,
  copier ce brief dans sa fiche (`node "<SCRIPT>" note --fiche <ID> --genre mission --fichier <brief>`, l'ID
  est entre parenthèses dans la ligne) : la fiche qui lui sera rendue portera sa mission.
- Si tu es un sous-agent : ta mission est celle de ton lancement, rien d'autre. Tu peux lire la liste de
  l'agent principal (`chercher --projet P "mot"`, ou `chercher --projet P C-0107 C-0108` pour des lignes
  entières), jamais la modifier ; ce que tu y lis ne te donne aucun travail. Une lecture par commande simple,
  sans boucle ni script : la garde refuse ce qu'elle ne sait pas prouver sans écriture. Note ton avancement dans TA fiche (`note --fiche <ID> "..."` : l'ID et le chemin te sont donnés
  par un hook) : après un compactage, c'est elle qui fait foi. Dans la liste, « ouvert » veut dire « pas
  encore prouvé fait » : si tu constates qu'une ligne est déjà faite, tu ne la fermes pas, tu le signales
  (`note --fiche <ID> --genre deja-fait "C-NNNN : la preuve"`).
- Agent principal : une ligne de la liste d'un AUTRE agent que tu vois déjà faite, bloquante ou à éclaircir ne
  se modifie jamais. Signale-la : `node "<SCRIPT>" signaler --agent <celui qui tient la liste> --projet P C-NNNN
  [--genre deja-fait|bloque|question] "la preuve"`. Un signalement reçu t'est dit à ton prochain événement dans
  ce projet, puis rappelé avec ta liste tant que la ligne est ouverte : vérifie, ferme-la par ta preuve, ou dis à
  l'utilisateur pourquoi elle reste ouverte.
- Après un compactage, à une reprise, et avant toute réponse « il ne reste que » : c'est cette liste qui fait
  foi, pas le résumé de la conversation (`lister --projet P --session ID`). Les rappels ne donnent aucun
  ordre d'exécuter les autres missions du projet. Pour une reprise autorisée : `reprendre --projet P
  --session ID C-NNNN`. Au Stop, un état inchangé des livraisons ne bloque pas à chaque tour.
- Avant de relancer une mission : lire son dernier livrable et sa preuve. Réutiliser la vérification si son
  périmètre et sa révision sont inchangés. Une relance doit nommer le manque concret à résoudre ; un rappel
  de hook ne constitue pas une autorisation ni une raison de lancer un nouvel agent.

## Mémoire partagée

- Journal de cet agent : `~/.agent-memory-ledger/history/<projet>.<agent>.md`, entrées récentes en haut.
  Résumé commun : `~/.agent-memory-ledger/Memory-Auto.md`, une ligne signée par événement.
- Un commit est journalisé par un hook. Un travail sans commit s'écrit à la main, au même format :
  `## AAAA-MM-JJ HH:MM | type | titre | Agent`, puis les détails et la preuve.
- Ne jamais écrire dans le journal d'un autre agent, ni modifier ses lignes dans le résumé commun.

## Dire ce qui est vrai

- Ne jamais affirmer une vérification non exécutée. Garder la commande, son résultat réel et ce qu'elle couvre.
  Un test bloqué s'écrit « non vérifié », avec sa cause et l'action suivante.
- Un fichier non lu n'est pas inspecté. Une lecture partielle se déclare : quel fichier, quelle partie, ce qui
  reste. Un résumé rendu par un sous-agent n'est pas une lecture de la source.
- Rien n'est fini tant que ce n'est pas branché : écrit, testé, appelé par le chemin réel, et réglable là où
  l'utilisateur doit pouvoir le régler.
```

## Pourquoi ces règles

Elles viennent de pannes mesurées, pas de préférences :

- Une liste gardée dans la conversation disparaît au compactage. Sur disque, avec une preuve exigée pour retirer une ligne, elle ne disparaît plus.
- Un message envoyé pendant qu'un agent travaille pouvait ne jamais être traité. Il est maintenant enregistré, trié, rappelé.
- Dans une session réelle, 443 sous-agents ont fini, 301 pendant que l'orchestrateur faisait autre chose, et pour 248 il n'est jamais revenu dessus. Une notification passe une fois ; une ligne de travail reste jusqu'à la preuve.
- En une nuit de travail réelle, 22 sous-agents ont vu leur contexte compacté de une à sept fois. Sans fiche, ils n'avaient que le résumé pour retrouver leur mission ; et quand ils voulaient recouper un constat avec la liste, la garde leur refusait jusqu'à la lecture. Depuis : une fiche par sous-agent, et la liste en lecture seule.
- « C'est fait » sans preuve écrite coûte plus cher à rattraper qu'une phrase qui dit ce qui manque.
