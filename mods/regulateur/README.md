# regulateur : module d'interface de Claude Code

Plafond d'agents en parallèle, pause, file d'attente des agents refusés, relance des échoués, modèle par type d'agent, et rappel permanent de la politique. Politique et file partagées avec Codex et le Cockpit.

## Ce qu'il fait

Refuse le lancement d'un agent quand le plafond est atteint ou que le Régulateur est en pause, met l'agent refusé en file puis le lance dès qu'un créneau se libère, relance les agents échoués (deux fois au plus), impose le modèle réglé par type d'agent, rappelle la politique dans le prompt, et donne la commande `/plafond` (N, libre, pause, reprendre, relance, file).

## Où il lit et écrit

Les fichiers d'état du Cockpit : le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit` où la maison est `AGENT_MEMORY_LEDGER_HOME`, sinon `~/.agent-memory-ledger`. Ce sont les fichiers des noyaux et de `scripts/cockpit.js` : une valeur réglée par la ligne de commande est lue par le module, et l'inverse. Ici : `politique-agents.json` (lu et écrit), `modeles-agents.json` (lu) et la file d'attente (`file-agents.json`, par `scripts/regulateur-file.js`).

Ce module lance `scripts/regulateur-file.js` du plugin `agent-memory-ledger` (installé par la marketplace, ou le dépôt cloné) : il le trouve tout seul, ou par la variable d'environnement `AML_PLUGIN_DIR` (le dossier du plugin, celui qui contient `scripts/`). Sans lui, le module le dit et ne gêne rien.

## Installer, retirer

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install regulateur@agent-memory-ledger
```

Depuis un clone du dépôt, sans marketplace : `claude --plugin-dir mods/regulateur`.

Pour le retirer : `claude plugin uninstall regulateur@agent-memory-ledger`. Les fichiers d'état ne sont pas touchés. Le détail (ce que les modules changent, les bancs, les mutations) est dans `docs/MODULES-INTERFACE.md` du dépôt.
