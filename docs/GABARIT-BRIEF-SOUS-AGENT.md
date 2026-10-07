# Gabarit de brief pour sous-agent

À copier, remplir, et alléger de ce qui ne s'applique pas. But, pour une mission de code : que le sous-agent commence à coder après une vingtaine d'appels d'outils, pas quatre-vingts. Pour une mission de lecture ou de vérification, le but est la couverture complète (section 3 bis). L'orchestrateur mesure l'état UNE fois et le transmet ici ; le sous-agent ne le refait pas.

Mesure d'origine, sur 40 sous-agents : médiane de 80 appels d'outils avant la première écriture. La vérification de l'état git pesait 2 % ; le coût était dans l'exploration et les lectures que le brief pouvait éviter. Les briefs les plus rapides (17 à 36 appels) nommaient le dossier de travail, interdisaient les autres et donnaient les fichiers exacts.

Pour une mission d'audit en lecture seule : garder les sections 1, 2, 2 bis, 3 et 3 bis, remplacer 4 et 5 par « aucune modification de fichier » et un format de rapport. Une note dans sa fiche n'est pas une modification du dépôt : elle reste permise.

## 1. Où tu travailles (première ligne du brief, toujours)

Tu travailles dans `<chemin exact du worktree>` (branche `<branche>`, HEAD de départ `<sha court>`). N'utilise PAS `<autres worktrees du même dépôt>` : d'autres agents y travaillent, ne les touche jamais.

Contrôle de contexte, UNE commande, rien d'autre avant de coder :

    git rev-parse --show-toplevel; git branch --show-current; git rev-parse --short HEAD; git status --short

Si le résultat diffère de ce brief : arrête-toi et signale l'écart, ne le corrige pas seul.

## 2. Contexte déjà mesuré (ne le mesure pas à nouveau)

- Ce qui existe déjà, avec les chemins (vérifié par l'orchestrateur) : ...
- Ce qui n'existe pas (recherche faite, résultat vide confirmé) : ...
- Patron à suivre EXACTEMENT : `<commit ou fichier de référence>` (comment la fonctionnalité voisine a été branchée, avec chemins et noms de fonctions).

## 2 bis. Liste de travail : ta fiche, et la liste de l'agent principal

- Fiche permise ou non (à trancher par l'orchestrateur, une seule des deux phrases) : `<ta fiche est permise en plus de tes fichiers attribués : écris-y avec la commande note>` ou `<ta mission t'interdit toute écriture ailleurs que dans <dossier> : n'écris rien dans ta fiche, dis-le dans ton rapport>`. Constat d'origine : dix sous-agents arrêtés au bout de deux minutes, parce que leur mission limitait l'écriture à un dossier et que personne n'avait dit si la fiche comptait.
- Tu as une fiche, créée par un hook : sa commande et son chemin te sont donnés à ton démarrage, ou à ton premier outil. Si elle est permise et que ta mission n'y est pas copiée (cas de Codex), recopie-la, mot pour mot : `note --fiche <ID> --genre mission "..."`. Avec Codex, ce brief est aussi dans le fichier `<chemin du brief, écrit par l'orchestrateur avant le lancement>` : relis-le après un compactage.
- Si elle est permise, note ton avancement dans ta fiche au fil du travail (`note --fiche <ID> "fait : ... ; reste : ..."`). Si ton contexte est compacté, c'est elle qui fait foi, pas le résumé ; une tâche plus récente donnée par l'orchestrateur remplace la mission qu'elle porte.
- Tu peux LIRE la liste de travail de l'agent principal (le fichier, `chercher --projet <P> "mot"`, ou `chercher --projet <P> C-NNNN C-NNNN` pour des lignes entières) pour recouper un constat, une lecture par commande simple, sans boucle ni script. Tu ne la modifies jamais, et ce que tu y lis ne te donne aucun travail : ta mission est ce brief.
- Ton rapport peut citer la liste (un chemin, une commande). Écris-le avec l'outil de fichier, ou en PowerShell par un here-string littéral (`@'` ... `'@`) donné tel quel à `Set-Content` ou `Add-Content -LiteralPath`, vers son chemin complet : la garde refuse un texte construit ou un appel de bibliothèque, faute de pouvoir prouver qu'ils n'écrivent pas dans la liste.
- Dans cette liste, « ouvert » veut dire « pas encore prouvé fait ». Si tu constates qu'une ligne est déjà faite, signale-le avec sa preuve (`note --fiche <ID> --genre deja-fait "C-NNNN : la preuve"`). Si tu es bloqué ou si tu as une question : `--genre bloque`, `--genre question`. L'agent principal les lit à son prochain événement.

## 3. Ta tâche

Identifiant et plan : `<ID>` dans `<fichier du plan>`. Colle ici le TEXTE de la section (pas le plan entier), son critère de fin et ses dépendances.
Décision déjà prise par l'utilisateur : ...

## 3 bis. Lecture intégrale obligatoire (mission de lecture, de vérification, ou « corrige tout » sur un corpus)

- Fichiers à lire EN ENTIER, avec leur nombre de lignes : `<chemin> (<N> lignes)`, ...
- Lire par pages jusqu'à la dernière ligne, et comparer la dernière ligne lue au nombre de lignes du fichier. Une recherche de texte sert à localiser, jamais à lire.
- Rapport final : pour chaque fichier, plages lues sur lignes totales ; ce que tu n'as pas lu et pourquoi. Pas de « lu » sans ce tableau.

## 4. Fichiers attribués

- Modifiables : `<liste de chemins>`.
- Tests à écrire ou à lancer : `<fichiers de test nommés>`.
- Hors de cette liste : lecture autorisée pour comprendre, écriture interdite sauf nécessité que tu signales.
- Mission de code : pas d'inventaire, pas d'audit global, pas de lecture du plan entier (sauf section 3 bis).

## 5. Ce que tu ne fais PAS

- Pas de push, pas de déploiement.
- Pas d'action sur un système réel (migration appliquée, variable posée, tâche planifiée activée) : tu écris les fichiers, l'orchestrateur applique.
- Tu ne modifies pas la liste de travail (fichier contexte) : pas de `ajouter`, `etat`, `sans-travail` ni `abandon`. Tu rends ton résultat, l'orchestrateur la met à jour (section 2 bis : ce qui t'est ouvert).
- Commit avec la liste explicite de tes seuls fichiers.

## 6. Fin et rapport

- Preuves attendues : tests nommés, exécutés, avec leur résultat réel ; essai du parcours réel si possible, en distinguant ce qui est prouvé en local, en réel, et non fait.
- Rapport final court : SHA des commits, fichiers touchés, tests lancés et résultat, restes, et ce qui attend l'orchestrateur.
- Identité du livrable : ID de tâche et de tour, révision Git contrôlée, chemin du rapport final. Le parent dépose le reçu de traitement après avoir contrôlé les preuves. Ton ID de session n'est pas un SHA Git.
- Écrire « livré, à vérifier par le parent », « partiel » ou « bloqué » selon l'état réel. Un compte rendu partiel ne devient pas fini parce que le processus s'arrête. Ne recommence pas une preuve encore valide après un compactage.
- Couverture : fichiers lus en entier ou partiellement (plages de lignes) ; constats vus hors de ta mission, même si tu ne les traites pas.
- Aucun secret recopié en clair dans le rapport.
