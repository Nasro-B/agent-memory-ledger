# Gabarit de brief pour sous-agent

À copier, remplir, et alléger de ce qui ne s'applique pas. But, pour une mission de code : que le sous-agent commence à coder après une vingtaine d'appels d'outils, pas quatre-vingts. Pour une mission de lecture ou de vérification, le but est la couverture complète (section 3 bis). L'orchestrateur mesure l'état UNE fois et le transmet ici ; le sous-agent ne le refait pas.

Mesure d'origine, sur 40 sous-agents : médiane de 80 appels d'outils avant la première écriture. La vérification de l'état git pesait 2 % ; le coût était dans l'exploration et les lectures que le brief pouvait éviter. Les briefs les plus rapides (17 à 36 appels) nommaient le dossier de travail, interdisaient les autres et donnaient les fichiers exacts.

Pour une mission d'audit en lecture seule : garder les sections 1, 2, 3 et 3 bis, remplacer 4 et 5 par « aucune modification de fichier » et un format de rapport.

## 1. Où tu travailles (première ligne du brief, toujours)

Tu travailles dans `<chemin exact du worktree>` (branche `<branche>`, HEAD de départ `<sha court>`). N'utilise PAS `<autres worktrees du même dépôt>` : d'autres agents y travaillent, ne les touche jamais.

Contrôle de contexte, UNE commande, rien d'autre avant de coder :

    git rev-parse --show-toplevel; git branch --show-current; git rev-parse --short HEAD; git status --short

Si le résultat diffère de ce brief : arrête-toi et signale l'écart, ne le corrige pas seul.

## 2. Contexte déjà mesuré (ne le mesure pas à nouveau)

- Ce qui existe déjà, avec les chemins (vérifié par l'orchestrateur) : ...
- Ce qui n'existe pas (recherche faite, résultat vide confirmé) : ...
- Patron à suivre EXACTEMENT : `<commit ou fichier de référence>` (comment la fonctionnalité voisine a été branchée, avec chemins et noms de fonctions).

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
- Tu ne touches pas à la liste de travail (fichier contexte) et tu n'appelles pas `context-ledger` : tu rends ton résultat, l'orchestrateur la met à jour.
- Commit avec la liste explicite de tes seuls fichiers.

## 6. Fin et rapport

- Preuves attendues : tests nommés, exécutés, avec leur résultat réel ; essai du parcours réel si possible, en distinguant ce qui est prouvé en local, en réel, et non fait.
- Rapport final court : SHA des commits, fichiers touchés, tests lancés et résultat, restes, et ce qui attend l'orchestrateur.
- Couverture : fichiers lus en entier ou partiellement (plages de lignes) ; constats vus hors de ta mission, même si tu ne les traites pas.
- Aucun secret recopié en clair dans le rapport.
