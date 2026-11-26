# pause : module d'interface de Claude Code

Pause et reprise des sessions et des agents : boutons Pause et Reprendre dans la bande au-dessus du prompt, commandes /pause et /reprendre. La pause est coopérative (la boucle s'arrête avant sa prochaine étape ou son prochain outil, Stop reste l'arrêt immédiat). État partagé entre toutes les sessions et avec le Cockpit.

## Ce qu'il fait

Retient la boucle d'une session ou d'un agent avant sa prochaine requête au modèle et avant son prochain outil tant que sa pause dure, inscrit la session par un battement toutes les 30 secondes, dessine une bande avec les boutons Pause et Reprendre au-dessus du prompt, et donne les commandes `/pause` et `/reprendre` (tout, session, agent, agents, statut). La pause est coopérative : Stop reste l'arrêt immédiat.

## Où il lit et écrit

Les fichiers d'état du Cockpit : le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit` où la maison est `AGENT_MEMORY_LEDGER_HOME`, sinon `~/.agent-memory-ledger`. Ce sont les fichiers des noyaux et de `scripts/cockpit.js` : une valeur réglée par la ligne de commande est lue par le module, et l'inverse. Ici : `pause.json` (lu ; écrit par `scripts/cockpit.js pause-hook`).

Ce module lance `scripts/cockpit.js` du plugin `agent-memory-ledger` (installé par la marketplace, ou le dépôt cloné) : il le trouve tout seul, ou par la variable d'environnement `AML_PLUGIN_DIR` (le dossier du plugin, celui qui contient `scripts/`). Sans lui, le module le dit et ne gêne rien.

## Installer, retirer

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install pause@agent-memory-ledger
```

Depuis un clone du dépôt, sans marketplace : `claude --plugin-dir mods/pause`.

Pour le retirer : `claude plugin uninstall pause@agent-memory-ledger`. Les fichiers d'état ne sont pas touchés. Le détail (ce que les modules changent, les bancs, les mutations) est dans `docs/MODULES-INTERFACE.md` du dépôt.
