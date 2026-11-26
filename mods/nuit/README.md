# nuit : module d'interface de Claude Code

Quand l'utilisateur est absent ou dit /nuit : ses questions bloquantes vont en boîte au lieu d'attendre, les arrêts de garde deviennent des refus avec alternative, le travail continue sur les lignes ouvertes de la liste de travail, et un récap avec boutons l'attend au réveil. État et boîte partagés avec Codex et le Cockpit.

## Ce qu'il fait

Pendant la nuit ou l'absence : refuse la question bloquante et la met en boîte, transforme l'arrêt d'une garde de sécurité en refus avec alternative, enchaîne sur la ligne ouverte suivante à la fin d'un tour, donne le récap au réveil (un message de l'utilisateur met fin à la nuit), dessine le panneau Nuit (la boîte, avec ses boutons) et donne la commande `/nuit` (on, off, statut, recap, boite, repondre, ecarter...).

## Où il lit et écrit

Les fichiers d'état du Cockpit : le dossier `COCKPIT_DIR`, sinon `<maison>/cockpit` où la maison est `AGENT_MEMORY_LEDGER_HOME`, sinon `~/.agent-memory-ledger`. Ce sont les fichiers des noyaux et de `scripts/cockpit.js` : une valeur réglée par la ligne de commande est lue par le module, et l'inverse. Ici : `nuit.json` et `nuit-boite.json` (lus ; écrits par `scripts/cockpit.js nuit-hook`).

Ce module lance `scripts/cockpit.js` du plugin `agent-memory-ledger` (installé par la marketplace, ou le dépôt cloné) : il le trouve tout seul, ou par la variable d'environnement `AML_PLUGIN_DIR` (le dossier du plugin, celui qui contient `scripts/`). Sans lui, le module le dit et ne gêne rien.

## Installer, retirer

```
claude plugin marketplace add Nasro-B/agent-memory-ledger
claude plugin install nuit@agent-memory-ledger
```

Depuis un clone du dépôt, sans marketplace : `claude --plugin-dir mods/nuit`.

Pour le retirer : `claude plugin uninstall nuit@agent-memory-ledger`. Les fichiers d'état ne sont pas touchés. Le détail (ce que les modules changent, les bancs, les mutations) est dans `docs/MODULES-INTERFACE.md` du dépôt.
