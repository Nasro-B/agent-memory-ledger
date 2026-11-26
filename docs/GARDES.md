# Gardes

Le détail des trois gardes. Le [README](../README.md#gardes) n'en donne que la synthèse.

Trois gardes protègent la machine et le dépôt de l'utilisateur, par opposition à la liste de travail qui protège la mémoire. Elles sont **actives par défaut**, sans fichier de réglage, avec des valeurs sûres et neutres. Elles sont branchées dans les hooks de Claude Code (`hooks/hooks.json`) et dans le modèle de hooks de Codex (`codex/hooks.modele.json`).

## Sécurité des commandes (`scripts/gardes/securite.js`)

Hook avant un outil de shell. Toutes les règles trouvées dans une commande sont rapportées d'un coup. Si la commande ne peut pas être analysée (entrée illisible, guillemet ou substitution jamais fermés, option globale de git inconnue), elle est refusée, avec la raison.

| Réaction | Règle |
| --- | --- |
| Refuse | suppression récursive forcée : `rm` avec option récursive et option de force, combinées (`-rf`), séparées (`-r ... -f`) ou longues ; formes Windows (`Remove-Item -Recurse -Force`, `rmdir`/`rd`/`del`/`erase` avec `/s`) |
| Refuse | `git clean` avec `-f` (fichiers non suivis supprimés, sans corbeille) |
| Refuse | `git reset --hard` |
| Refuse | poussée forcée : `--force`, `--force-with-lease`, `-f`, refspec en `+` ; même derrière `git -C`, `-c`, un alias, `env`, `sudo`, `bash -c`, `pwsh -Command`, `cmd /c` ou un sous-shell |
| Refuse | l'option de saut des vérifications de git (`--no-verify`), qui contourne les hooks, dont le rappel avant commit |
| Refuse | suppression ou renommage d'une branche protégée (motifs de `gardes.json`, aucun par défaut), en local et sur le dépôt distant |
| Refuse | `git commit` dont le diff préparé touche une catégorie du rappel avant commit sans confirmation pour ce diff exact (voir « Rappel avant commit » plus bas) |
| Refuse | `wrangler deploy` sans `--keep-vars` (règle d'outil, désactivable : `wrangler-keep-vars`) |
| Demande confirmation | `git push` (nom `poussee`) et `vercel --prod` (nom `deploiement-production`), plus les commandes que `gardes.json` ajoute |
| Signale | `vercel env add` sans `printf` : une valeur collée peut porter des sauts de ligne invisibles (règle d'outil, désactivable : `vercel-env-sans-printf`) |

Un exemple affiché n'est pas une commande : `echo "git push"`, `rg "git push"` ou `Set-Content -Value 'git push'` passent. Le corps d'un here-document (`<<'FIN'`) ou d'un here-string PowerShell (`@'` ... `'@`) est du texte, qui peut contenir une apostrophe isolée (un message de commit en français) : il est sauté, sauf si la ligne qui l'annonce nomme un interpréteur (`bash`, `sh`, `pwsh`, `python`, `iex`...), auquel cas il est lu comme des commandes. Les enveloppes que l'analyse ne sait pas ouvrir (`xargs`, `find -exec`, `Invoke-Expression`, `eval`, `Start-Process`, `python -c`...) retombent sur le texte : un `git push` qui y figure suffit à refuser.

**Confirmation selon l'agent.**
- Claude Code : la garde répond « ask », l'utilisateur tranche.
- Codex et les autres agents (tout agent dont `--agent` n'est pas `claude`, y compris un agent non nommé) : ils ne savent pas demander confirmation dans ce hook, la commande est donc **refusée**, sauf si l'utilisateur vient de l'ordonner dans son message du tour en cours. Ce message est lu dans la liste de travail (il faut donc que ses hooks tournent). Mots d'ordre par défaut : `push`, `pousse`... pour une poussée ; `deploy`, `déploie`, `mets en production`... pour un déploiement (ils se règlent). Une phrase négative, une question, un récit au passé, l'ordre d'un tour précédent, une session inconnue, une liste de travail illisible : refus. Un sous-agent ne pousse ni ne déploie jamais. Un ordre n'autorise jamais une poussée forcée ni une règle de refus.

## Rappel avant commit (`scripts/gardes/checklist-*.js`, `scripts/lib/checklist-commit.js`)

Un oubli fréquent : committer une migration jamais appliquée, une variable jamais posée, une fonction jamais déployée, une tâche planifiée jamais vérifiée. La garde lit le diff **préparé** (jamais le message de commit) et, si une catégorie sensible est touchée, refuse le commit tant que l'agent n'a pas confirmé, catégorie par catégorie, que l'action réelle est faite, **pour ce diff exact**.

Les quatre catégories par défaut (toutes règlables) :

| Nom | Déclencheur | Question posée |
| --- | --- | --- |
| `migrations` | un fichier préparé `migrations/**/*.sql` | schéma appliqué en réel sur la bonne base ? |
| `fonctions` | un fichier préparé sous `supabase/functions/` | fonction(s) déployée(s) en réel ? |
| `variables` | une ligne ajoutée qui lit une variable d'environnement (`process.env.NOM`, `Deno.env.get("NOM")`) | variable(s) posée(s) en réel dans chaque environnement ? |
| `taches` | une ligne ajoutée qui planifie une tâche de base (l'appel `cron` suivi de `.schedule(`, ou le nom de l'extension de planification `pg` suivi de `_cron`) | tâche(s) planifiée(s) vérifiée(s) active(s) sur la bonne base ? |

Le refus donne la commande de confirmation, avec le chemin réel du script du plugin. Trois réponses par catégorie : `oui` (fait et vérifié), `na` (non applicable, ou déjà prouvé plus tôt) et `non` (pas fait : documente l'état, **ne débloque pas**).

```
node "<plugin>/scripts/gardes/checklist-confirmer.js" --cwd="<dépôt>" --migrations=oui --variables=na
```

La confirmation est liée à l'empreinte du diff préparé (liste des fichiers et texte du diff) : toute modification de l'index, un fichier ajouté, retiré ou modifié, la rend caduque. Elle est écrite dans le dossier git du dépôt (`agent-memory-ledger-checklist.json`, dans `.git/worktrees/<nom>/` pour un worktree, qui a donc sa propre confirmation), jamais dans l'arbre de travail. **Lancez la confirmation seule, puis le commit dans une commande séparée.** `git commit --amend` n'est pas contrôlé (l'index est déjà figé).

**Hook git natif.** Les hooks d'agents peuvent laisser passer une commande (délai dépassé, outil non couvert, autre shell) ; sur l'installation d'origine, en mode automatique, un commit non confirmé est même passé malgré le refus du hook d'un agent (constat unique, jamais rejoué ici). Seul un hook git bloque réellement le commit, quel que soit l'outil, y compris un `git commit` tapé à la main. Dans le dépôt à protéger :

```sh
# .githooks/pre-commit
#!/bin/sh
node "<plugin>/scripts/gardes/checklist-hook-git.js" || exit 1
```

puis `git config core.hooksPath .githooks` (avec husky : la même ligne dans `.husky/pre-commit`). Le hook refuse aussi quand la vérification elle-même tombe en panne (index illisible) : il ne laisse jamais passer faute d'avoir pu vérifier.

## Caractères invisibles (`scripts/gardes/caracteres.js`)

Trois modes.
- **Avant une écriture** : refuse tout fichier, toute commande et tout patch dont le texte ÉCRIT contient un caractère invisible ou un « filigrane » typographique : espaces insécables, fines et larges, largeur nulle, marques de direction, caractères de tag, sélecteurs de variation, remplisseurs, séparateurs de ligne exotiques, contrôles C0 et C1. L'ancien texte (`old_string`), les chemins et les lignes retirées d'un patch ne sont jamais contrôlés : retirer un invisible reste possible. Exceptions étroites : une marque d'ordre des octets en tête de texte, une marque de direction dans un texte arabe, hébreu ou persan, un sélecteur de variation ou un liant de largeur nulle collé à un pictogramme, et la commande `node ... context-ledger.js` (elle cite mot pour mot les messages de l'utilisateur). Cette garde laisse passer quand son entrée est illisible : elle ne doit jamais bloquer les autres outils.
- **Ligne de commande** : `node scripts/gardes/caracteres.js --scan <fichier>...` liste les occurrences (code 1 s'il y en a), `--fix <fichier>...` les remplace (espace normale, saut de ligne, ou suppression).
- **Fin de tour** : `--stop` relit la dernière réponse de l'agent. Si elle contient un caractère interdit, la garde refuse une fois de finir le tour : l'agent doit redonner sa réponse corrigée. Un hook de fin de tour ne peut pas empêcher l'affichage : la réponse est déjà vue, il ne peut que forcer la correction. Une seule relance par message (`stop_hook_active`) ; les sous-agents ne sont pas contrôlés. Le tiret long (U+2014) n'est contrôlé que si `gardes.json` le demande (`caracteres.tiretLongFinDeTour`, faux par défaut). Un journal sans texte (agent, source, longueur, refus) est tenu dans `<maison>/etat/garde-caracteres-fin-de-tour.jsonl`.

## Réglage : `gardes.json`

Fichier facultatif dans la maison. Tout est facultatif aussi à l'intérieur.

```json
{
  "securite": {
    "actif": true,
    "branchesProtegees": ["^sauvegarde-", { "motif": "\\bPROD\\b", "casse": true }],
    "confirmer": ["poussee", "deploiement-production", { "nom": "publication", "motif": "\\bmon-outil\\s+publier\\b", "message": "Publication détectée.", "ordre": "deploiement" }],
    "ordreUtilisateur": { "actif": true, "motsPoussee": ["push", "pousse"], "motsDeploiement": ["deploy", "déploie"] },
    "reglesDesactivees": ["wrangler-keep-vars", "vercel-env-sans-printf"]
  },
  "checklist": {
    "actif": true,
    "categories": [
      { "nom": "migrations", "fichiers": "(^|/)schema/.*\\.sql$" },
      { "nom": "variables", "actif": false },
      { "nom": "secrets", "fichiers": "(^|/)secrets/", "contenu": "SECRET_[A-Z_]+", "libelle": "secrets du coffre", "question": "secret(s) créé(s) dans le coffre ?" }
    ]
  },
  "caracteres": { "actif": true, "tiretLongFinDeTour": false }
}
```

| Clé | Effet | Défaut |
| --- | --- | --- |
| `securite.actif`, `checklist.actif`, `caracteres.actif` | éteint une garde (seul `false` éteint) | `true` |
| `securite.branchesProtegees` | motifs (expressions régulières, sans casse sauf `"casse": true`) cherchés dans le texte des commandes git et dans chacun de leurs arguments, pour refuser la suppression ou le renommage d'une branche. Un motif invalide est cherché comme texte littéral | aucun : sans motif, seules la poussée forcée et les règles générales jouent |
| `securite.confirmer` | commandes qui demandent confirmation : `poussee`, `deploiement-production`, ou un objet `{ nom, motif, message, ordre }` (`ordre` : `poussee` ou `deploiement`, l'ordre de l'utilisateur qui la débloque chez un agent qui ne sait pas demander) | `["poussee", "deploiement-production"]` |
| `securite.ordreUtilisateur` | `false`, ou `{ actif, motsPoussee, motsDeploiement }` : fragments d'expressions régulières qui valent ordre. `false` : l'ordre de l'utilisateur ne débloque plus jamais rien, un agent sans confirmation ne pousse plus | actif, mots français et anglais |
| `securite.reglesDesactivees` | règles d'outil à éteindre : `wrangler-keep-vars`, `vercel-env-sans-printf`. Les règles générales ne se désactivent pas une à une | aucune |
| `checklist.categories` | une entrée par catégorie : `nom` (minuscules, chiffres, tirets), `fichiers` (motif sur le chemin d'un fichier préparé), `contenu` (motif sur les lignes ajoutées), `libelle`, `question`, `actif`. Un nom connu remplace les champs donnés de la catégorie par défaut ; `"actif": false` la retire ; un nom nouveau en ajoute une | les quatre catégories ci-dessus |
| `caracteres.tiretLongFinDeTour` | contrôle aussi le tiret long en fin de tour | `false` |

**Un `gardes.json` mal formé ne désarme jamais une garde.** Fichier illisible (JSON invalide, contenu qui n'est pas un objet) : les valeurs par défaut s'appliquent, les trois gardes restent actives, et chaque garde le dit dans son message (la garde des caractères le dit quand elle refuse). Valeur mal formée (un texte à la place d'un booléen, une liste attendue qui n'en est pas une, un motif invalide, une clé inconnue) : la valeur par défaut de cette seule clé est gardée et l'écart est rendu.

## Gardes et sous-agents

- La garde de sécurité juge les commandes d'un sous-agent comme celles de l'agent principal ; il ne peut jamais utiliser l'ordre de l'utilisateur pour pousser ou déployer.
- Le rappel avant commit s'applique aux commits de tout agent, sous-agents compris, et le hook git natif aussi.
- La garde des caractères contrôle les écritures de tous les agents ; le mode fin de tour ne contrôle pas les sous-agents.

Les règles que l'agent doit connaître (ne jamais contourner un refus, confirmer en deux commandes séparées) sont dans [docs/REGLES-POUR-AGENTS.md](REGLES-POUR-AGENTS.md).
