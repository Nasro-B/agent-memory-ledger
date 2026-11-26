# consignes : module d'interface de Claude Code

Les ordres permanents de l'utilisateur, rappelés à chaque requête (donc intacts après un compactage), et refusés par le code quand il peut les vérifier : push, déploiement, rebuild, nouvel agent. Liste partagée avec Codex et le Cockpit.

## Ce qu'il fait

Rappelle à chaque requête les consignes actives de l'utilisateur (section de session du prompt système, intacte après un compactage), refuse une commande Bash ou PowerShell et le lancement d'un agent quand un verrou (`push`, `deploiement`, `rebuild`, `agent`) les reconnaît, et donne la commande `/consignes` (liste, ajouter, retirer, pause, reprendre, verrou).

## Où il lit et écrit

Les fichiers d'état du Cockpit : le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit` où la maison est `AGENT_MEMORY_LEDGER_HOME`, sinon `~/.agent-memory-ledger`. Ce sont les fichiers des noyaux et de `scripts/cockpit.js` : une valeur réglée par la ligne de commande est lue par le module, et l'inverse. Ici : `consignes.json` (lu et écrit) et `config.json` (lu : les jetons `{worktrees}` et `{plans}` des consignes valent les réglages du Cockpit).

Ce module ne lance aucun script : il lit et écrit lui-même les fichiers d'état du Cockpit.

## Installer, retirer

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install consignes@agent-memory-ledger
```

Depuis un clone du dépôt, sans marketplace : `claude --plugin-dir mods/consignes`.

Pour le retirer : `claude plugin uninstall consignes@agent-memory-ledger`. Les fichiers d'état ne sont pas touchés. Le détail (ce que les modules changent, les bancs, les mutations) est dans `docs/MODULES-INTERFACE.md` du dépôt.
