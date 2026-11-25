# Le Cockpit et ses modules

Le Cockpit est le nom donné à l'ensemble des réglages et des états que les agents partagent sur une machine : combien d'agents à la fois, ce qu'ils n'ont pas le droit de faire, ce qu'ils font quand l'utilisateur est absent, ce qui est en pause, où en est le quota. Chaque module est découpé en deux : une **logique pure** et un **noyau d'entrées-sorties** qui l'appelle.

## Ce qui est dans le dépôt à ce stade

Seules les **logiques pures** sont là, avec leurs bancs et leurs preuves par mutation. Elles ne lisent pas le disque, n'ouvrent pas le réseau et n'ont pas d'horloge cachée : l'instant, l'état et les vérifications leur sont donnés par l'appelant. Aucune commande, aucun hook, aucun panneau et aucun noyau d'entrées-sorties ne les branche encore : ils viennent dans les versions suivantes. Tant qu'ils ne sont pas là, ces modules ne font rien d'eux-mêmes.

| Module | Fichier | Ce qu'il décide |
| --- | --- | --- |
| Réglages du Cockpit | `scripts/lib/config-logique.mjs` | les dépôts de travail suivis (« worktrees ») et le dossier des plans ; la commande `cockpit config`. Par défaut : aucun worktree, aucun dossier de plans, profondeur de recherche 3 |
| Régulateur | `scripts/lib/regulateur-logique.mjs` | combien d'agents tournent en parallèle (1 à 50, ou libre), la pause, la relance des agents échoués, la mise en file ; la commande `/plafond` |
| File d'attente | `scripts/lib/file-logique.mjs` | un agent refusé par le plafond attend son tour, le suivant est lancé dès qu'un créneau se libère, un agent échoué est relancé deux fois au plus |
| Consignes | `scripts/lib/consignes-logique.mjs` | les ordres permanents de l'utilisateur, rappelés à chaque requête, et leurs verrous (`push`, `deploiement`, `rebuild`, `agent`) qui refusent ce que le code sait reconnaître ; la commande `/consignes` |
| Nuit | `scripts/lib/nuit-logique.mjs` | quand l'utilisateur est absent : les questions bloquantes vont dans une boîte, les arrêts de garde deviennent des refus avec alternative, le travail continue sur les lignes ouvertes de la liste de travail, un récapitulatif attend le réveil ; la commande `/nuit` |
| Pause | `scripts/lib/pause-logique.mjs` | suspendre une session ou un agent sans le tuer, puis le reprendre. La pause est coopérative : elle retient la boucle avant sa prochaine étape, une réponse ou un outil déjà en cours va jusqu'au bout ; les commandes `/pause` et `/reprendre` |
| Quota | `scripts/lib/quota-logique.mjs` | les fenêtres de quota que le moteur rapporte, les alertes à 80 % puis 90 % (réglables), le blocage des nouveaux agents au seuil critique, la consigne au modèle, la remise à zéro ; la commande `/quota` |
| Modèles par agent | `scripts/lib/modeles-agents-logique.mjs` | le modèle imposé aux prochains sous-agents, par type de sous-agent ou par défaut ; ne réécrit jamais un lancement qui a déjà son modèle, un fork, un workflow ni un coéquipier |

Les bancs sont dans `tests/<module>-logique.test.js` (`tests/modeles-agents-logique.test.js` pour le dernier). Leurs scripts de mutation sont dans `tests/mutations/`, avec leur moteur commun `tests/lib/mutations-fichier.js` : chaque entrée altère un fragment exact du code dans une copie, et le banc doit rougir. Une altération qui laisse le banc vert désigne un comportement que rien ne protège.

```
npm run test:rapide        # tous les bancs, sans les mutations
npm run test:mutations     # les sept scripts de mutation, l'un après l'autre (long)
node tests/mutations/mutations-quota-logique.js --ancres   # vérifie, sans lancer le banc, que chaque ancre existe une fois
```

## Notes pour qui branchera ces logiques

- **Fichiers `.mjs`.** Chaque logique est un module ES sans aucun import. Les bancs la chargent par `require()` (Node 22.12 ou plus, sans avertissement). Un banc lit le fichier désigné par une variable d'environnement interne (par exemple `QUOTA_LOGIQUE_TESTE`) : c'est ainsi que les scripts de mutation lui donnent une copie altérée. Ne jamais la poser ailleurs.
- **Noms d'agents.** La file d'attente et la boîte de la Nuit n'acceptent que des noms en minuscules, chiffres et tirets (au plus 32 caractères, commençant par une lettre). Les noms d'agents que connaît `scripts/lib/config.js` (par exemple `deepseek_H`) devront être convertis par le noyau avant d'entrer dans ces états.
- **Messages.** Les textes que ces modules rendent au modèle sont en français et ne contiennent jamais de tiret cadratin, ce que les bancs vérifient. Ils nomment « l'utilisateur » : aucune identité n'y est écrite.
- **Alternatives de la Nuit.** Quand la garde de sécurité refuse une commande, la Nuit choisit la voie de remplacement d'après les libellés de `scripts/gardes/securite.js` et de `scripts/lib/checklist-commit.js`. Si ces libellés changent, `ALTERNATIVES` dans `nuit-logique.mjs` et son banc changent avec eux.
- **Réglages par défaut.** Rien n'est supposé de la machine : les dépôts suivis et le dossier des plans sont vides tant que la commande de configuration, à venir, ne les pose pas.

## Ce qui vient ensuite

Les noyaux d'entrées-sortie de chaque module (lecture et écriture atomique de leur état dans la maison du dépôt), les commandes, les hooks qui les branchent et les panneaux d'interface. Chaque module sera livré câblé de bout en bout : logique, noyau, commande, hook et réglage, avec les bancs qui le prouvent.
