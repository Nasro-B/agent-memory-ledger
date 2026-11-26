# cockpit : module d'interface de Claude Code

Bande et panneau d'état du travail : liste de travail, sous-agents, git des dépôts suivis, plans, quota, et les réglages du Cockpit. Le panneau lance les commandes du Cockpit (modèles des agents, dépôts suivis, pause).

## Ce qu'il fait

Mesure l'état du travail par `scripts/cockpit.js instantane --json` toutes les 30 secondes (git toutes les 5 minutes), dessine une bande au-dessus du prompt et un panneau par vue (ensemble, agents, projets, plans, réglages), et donne la commande `/cockpit` (le panneau, ou `/cockpit config ...` pour les réglages). Les boutons du panneau lancent `scripts/cockpit.js` (config, pause, reprendre).

## Où il lit et écrit

Les fichiers d'état du Cockpit : le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit` où la maison est `AGENT_MEMORY_LEDGER_HOME`, sinon `~/.agent-memory-ledger`. Ce sont les fichiers des noyaux et de `scripts/cockpit.js` : une valeur réglée par la ligne de commande est lue par le module, et l'inverse. Ici : rien directement : tout passe par `scripts/cockpit.js`, qui lit et écrit le dossier d'état du Cockpit.

Ce module lance `scripts/cockpit.js` du plugin `agent-memory-ledger` (installé par la marketplace, ou le dépôt cloné) : il le trouve tout seul, ou par la variable d'environnement `AML_PLUGIN_DIR` (le dossier du plugin, celui qui contient `scripts/`). Sans lui, le module le dit et ne gêne rien.

## Installer, retirer

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install cockpit@agent-memory-ledger
```

Depuis un clone du dépôt, sans marketplace : `claude --plugin-dir mods/cockpit`.

Pour le retirer : `claude plugin uninstall cockpit@agent-memory-ledger`. Les fichiers d'état ne sont pas touchés. Le détail (ce que les modules changent, les bancs, les mutations) est dans `docs/MODULES-INTERFACE.md` du dépôt.
