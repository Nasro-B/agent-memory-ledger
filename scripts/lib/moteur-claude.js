'use strict';
// Le programme `claude` qui lance les bancs des modules d'interface (`claude plugin test <dossier>`), partagé par scripts/tester-mods.js et par le moteur de
// mutations des modules (tests/lib/mutations-mod.js).
//   AML_MOTEUR_CLAUDE   le programme à lancer (un chemin) ; défaut : la commande `claude` du chemin d'exécution.
// trouverMoteur() rend { moteur } quand le programme répond et connaît la sous-commande `plugin test`, sinon { erreur } avec la cause et quoi faire.
// Rien n'est supposé de la machine : ni emplacement d'installation, ni version.

const { spawnSync } = require('node:child_process');

function trouverMoteur() {
  const moteur = process.env.AML_MOTEUR_CLAUDE && process.env.AML_MOTEUR_CLAUDE.trim() ? process.env.AML_MOTEUR_CLAUDE.trim() : 'claude';
  const r = spawnSync(moteur, ['plugin', 'test', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error) return { erreur: `moteur introuvable : ${moteur} (${r.error.code || r.error.message}). Poser AML_MOTEUR_CLAUDE (le chemin du programme claude) ou mettre claude dans le chemin d'exécution.` };
  if (r.status !== 0 || !/plugin test/i.test(`${r.stdout}${r.stderr}`)) return { erreur: `${moteur} ne sait pas lancer les bancs d'un module (« plugin test » absent) : utiliser une version plus récente de Claude Code.` };
  return { moteur };
}

module.exports = { trouverMoteur };
