# garde-quota : module d'interface de Claude Code

Les fenêtres de quota que le moteur rapporte, sous le prompt ; alertes à 80 % puis 90 % (avec un son), blocage des nouveaux agents et consigne de relais au seuil critique. Mesure partagée avec Codex et le Cockpit.

## Ce qu'il fait

Mesure le quota que le moteur rapporte, l'écrit pour le Cockpit et pour Codex, annonce l'attention puis le seuil critique (avec un son, réglable) et la remise à zéro, refuse le lancement d'un agent au seuil critique, ajoute au prompt la consigne de relais, et donne la commande `/quota` (seuils, blocage, consigne, son).

## Où il lit et écrit

Les fichiers d'état du Cockpit : le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit` où la maison est `AGENT_MEMORY_LEDGER_HOME`, sinon `~/.agent-memory-ledger`. Ce sont les fichiers des noyaux et de `scripts/cockpit.js` : une valeur réglée par la ligne de commande est lue par le module, et l'inverse. Ici : `garde-quota.json` (lu et écrit : les réglages) et `quota-claude.json` (écrit : la dernière mesure, lue par le Cockpit).

Ce module ne lance aucun script : il lit et écrit lui-même les fichiers d'état du Cockpit.

## Installer, retirer

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install garde-quota@agent-memory-ledger
```

Depuis un clone du dépôt, sans marketplace : `claude --plugin-dir mods/garde-quota`.

Pour le retirer : `claude plugin uninstall garde-quota@agent-memory-ledger`. Les fichiers d'état ne sont pas touchés. Le détail (ce que les modules changent, les bancs, les mutations) est dans `docs/MODULES-INTERFACE.md` du dépôt.
