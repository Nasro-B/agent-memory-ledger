'use strict';
// Preuve par mutation du banc du module Consignes en vigueur (mods/consignes/hooks/register.ts et la copie de la logique).
//   node tests/mutations/mutations-consignes-mod.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-consignes-mod.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-consignes-mod.js --liste         affiche les noms
//   node tests/mutations/mutations-consignes-mod.js --ancres        vérifie sans lancer le moteur que chaque ancre existe une fois
// Variable : CONSIGNES_MOD (dossier du module, défaut : mods/consignes du dépôt). Le moteur : voir tests/lib/mutations-mod.js (AML_MOTEUR_CLAUDE).
// Mutations équivalentes écartées : l'indentation du JSON écrit (le banc lit le contenu), le retour de `composition` au lieu
// d'une composition réécrite à l'identique (le moteur simulé de la composition ne porte que `sections`), et l'ajout d'une section
// sans texte quand il n'y a aucune consigne active (le moteur écarte une section dont le texte est nul).

const path = require('node:path');
const { executer } = require('../lib/mutations-mod.js');

const MOD = process.env.CONSIGNES_MOD || path.join(__dirname, '..', '..', 'mods', 'consignes');
const R = 'hooks/register.ts';
// L'échappement \uFEFF ne s'écrit pas tel quel dans un fichier passé par l'outil d'écriture (il y devient un caractère invisible).
const BOM = `${String.fromCharCode(92)}uFEFF`;

const LIRE_BOM = `JSON.parse(brut.replace(/^${BOM}/, ''))`;
const LIRE_BOM_CONFIG = `JSON.parse((await $.fs.read(await cheminConfig($))).replace(/^${BOM}/, ''))`;
const GARDE_BASH = "on('tool.call', { tool: 'Bash' }, async ($, e, next) => {\n    const raison = await raisonCommande($, e.command)\n\n    return raison === undefined ? next(e) : { deny: raison }";
const GARDE_PS = "on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {\n    const raison = await raisonCommande($, e.command)\n\n    return raison === undefined ? next(e) : { deny: raison }";

const MUTATIONS = [
  // lecture du fichier
  { nom: 'cm-lire-chemin-faux', f: R, de: "const NOM_FICHIER = 'consignes.json'", vers: "const NOM_FICHIER = 'consignes2.json'" },
  { nom: 'cm-lire-absent-compte-illisible', f: R, de: "  } catch {\n    return { etat: normaliserEtat(null), illisible: false }\n  }\n  try {", vers: "  } catch {\n    return { etat: normaliserEtat(null), illisible: true }\n  }\n  try {" },
  { nom: 'cm-lire-abime-non-signale', f: R, de: "  } catch {\n    return { etat: normaliserEtat(null), illisible: true }\n  }\n}", vers: "  } catch {\n    return { etat: normaliserEtat(null), illisible: false }\n  }\n}" },
  { nom: 'cm-lire-bom-non-retire', f: R, de: LIRE_BOM, vers: 'JSON.parse(brut)' },
  { nom: 'cm-lire-non-normalise', f: R, de: `etat: normaliserEtat(${LIRE_BOM})`, vers: `etat: ${LIRE_BOM} as Etat` },
  { nom: 'cm-lire-abime-applique', f: R, de: "    return { etat: normaliserEtat(null), illisible: true }", vers: "    return { etat: normaliserEtat({ consignes: [{ id: 1, texte: 'x', verrou: 'push' }] }), illisible: true }" },
  // démarrage
  { nom: 'cm-commande-non-enregistree', f: R, de: "    await $.command.register({ name: 'consignes', description: 'Consignes en vigueur : ordres permanents, rappelés à chaque requête (/consignes ajouter, verrou, pause, retirer)' })\n", vers: '' },
  { nom: 'cm-commande-mauvais-nom', f: R, de: "$.command.register({ name: 'consignes', description", vers: "$.command.register({ name: 'consigne', description" },
  { nom: 'cm-statut-demarrage-omis', f: R, de: "    $.ui.status(texteStatut((await lire($)).etat))\n\n    return next(e)", vers: '    return next(e)' },
  { nom: 'cm-statut-demarrage-etat-ignore', f: R, de: '    $.ui.status(texteStatut((await lire($)).etat))\n\n    return next(e)', vers: '    $.ui.status(texteStatut(normaliserEtat(null)))\n\n    return next(e)' },
  { nom: 'cm-demarrage-sans-next', f: R, de: '    $.ui.status(texteStatut((await lire($)).etat))\n\n    return next(e)', vers: '    $.ui.status(texteStatut((await lire($)).etat))\n\n    return { cwd: e.cwd }' },
  // refus des commandes
  { nom: 'cm-bash-non-garde', f: R, de: GARDE_BASH, vers: GARDE_BASH.replace("{ tool: 'Bash' }", "{ tool: 'Bash2' }") },
  { nom: 'cm-powershell-non-garde', f: R, de: GARDE_PS, vers: GARDE_PS.replace("{ tool: 'PowerShell' }", "{ tool: 'PowerShell2' }") },
  { nom: 'cm-bash-commande-ignoree', f: R, de: GARDE_BASH, vers: GARDE_BASH.replace('raisonCommande($, e.command)', "raisonCommande($, '')") },
  { nom: 'cm-powershell-commande-ignoree', f: R, de: GARDE_PS, vers: GARDE_PS.replace('raisonCommande($, e.command)', "raisonCommande($, '')") },
  { nom: 'cm-bash-refus-ignore', f: R, de: GARDE_BASH, vers: GARDE_BASH.replace('raison === undefined ? next(e) : { deny: raison }', 'next(e)') },
  { nom: 'cm-powershell-refus-ignore', f: R, de: GARDE_PS, vers: GARDE_PS.replace('raison === undefined ? next(e) : { deny: raison }', 'next(e)') },
  { nom: 'cm-bash-tout-refuse', f: R, de: GARDE_BASH, vers: GARDE_BASH.replace('raison === undefined ? next(e) : { deny: raison }', '{ deny: raison ?? "non" }') },
  { nom: 'cm-powershell-tout-refuse', f: R, de: GARDE_PS, vers: GARDE_PS.replace('raison === undefined ? next(e) : { deny: raison }', '{ deny: raison ?? "non" }') },
  { nom: 'cm-bash-raison-perdue', f: R, de: GARDE_BASH, vers: GARDE_BASH.replace('{ deny: raison }', "{ deny: 'refusé' }") },
  { nom: 'cm-powershell-raison-perdue', f: R, de: GARDE_PS, vers: GARDE_PS.replace('{ deny: raison }', "{ deny: 'refusé' }") },
  { nom: 'cm-decision-etat-ignore', f: R, de: 'const decision = decisionCommande(etat, commande, await lireValeurs($))', vers: 'const decision = decisionCommande(normaliserEtat(null), commande, await lireValeurs($))' },
  { nom: 'cm-decision-commande-ignoree', f: R, de: 'const decision = decisionCommande(etat, commande, await lireValeurs($))', vers: "const decision = decisionCommande(etat, '', await lireValeurs($))" },
  { nom: 'cm-decision-passage-rapide-etat-ignore', f: R, de: 'if (decisionCommande(etat, commande).autorise) return undefined', vers: 'if (decisionCommande(normaliserEtat(null), commande).autorise) return undefined' },
  { nom: 'cm-decision-passage-rapide-commande-ignoree', f: R, de: 'if (decisionCommande(etat, commande).autorise) return undefined', vers: "if (decisionCommande(etat, '').autorise) return undefined" },
  { nom: 'cm-decision-passage-rapide-omis', f: R, de: '  if (decisionCommande(etat, commande).autorise) return undefined\n', vers: '' },
  { nom: 'cm-decision-valeurs-perdues', f: R, de: 'const decision = decisionCommande(etat, commande, await lireValeurs($))', vers: 'const decision = decisionCommande(etat, commande)' },
  { nom: 'cm-decision-inversee', f: R, de: 'return decision.autorise ? undefined : decision.raison', vers: 'return decision.autorise ? decision.raison : undefined' },
  { nom: 'cm-decision-toujours-passe', f: R, de: 'return decision.autorise ? undefined : decision.raison', vers: 'return undefined' },
  // refus des agents
  { nom: 'cm-agent-non-garde', f: R, de: '    if (!decision.autorise) return { deny: decision.raison }\n', vers: '' },
  { nom: 'cm-agent-raison-perdue', f: R, de: 'if (!decision.autorise) return { deny: decision.raison }', vers: "if (!decision.autorise) return { deny: 'refusé' }" },
  { nom: 'cm-agent-etat-ignore', f: R, de: 'if (!decisionAgent(etat).autorise) {', vers: 'if (!decisionAgent(normaliserEtat(null)).autorise) {' },
  { nom: 'cm-agent-second-etat-ignore', f: R, de: 'const decision = decisionAgent(etat, await lireValeurs($))', vers: 'const decision = decisionAgent(normaliserEtat(null), await lireValeurs($))' },
  { nom: 'cm-agent-passage-rapide-omis', f: R, de: 'if (!decisionAgent(etat).autorise) {', vers: 'if (true) {' },
  { nom: 'cm-agent-valeurs-perdues', f: R, de: 'const decision = decisionAgent(etat, await lireValeurs($))', vers: 'const decision = decisionAgent(etat)' },
  { nom: 'cm-agent-tout-refuse', f: R, de: '      if (!decision.autorise) return { deny: decision.raison }\n    }\n\n    return next(e)', vers: '      if (!decision.autorise) return { deny: decision.raison }\n    }\n\n    return { deny: "non" }' },
  { nom: 'cm-agent-sans-next', f: R, de: '      if (!decision.autorise) return { deny: decision.raison }\n    }\n\n    return next(e)', vers: '      if (!decision.autorise) return { deny: decision.raison }\n    }\n\n    return { model: "m", agentId: "x" }' },
  // rappel dans le prompt
  { nom: 'cm-prompt-texte-omis', f: R, de: 'return texte === null ? composition : { sections:', vers: 'return true ? composition : { sections:' },
  { nom: 'cm-prompt-id-faux', f: R, de: "id: 'consignes:en-vigueur'", vers: "id: 'consignes'" },
  { nom: 'cm-prompt-section-partagee', f: R, de: "scope: 'session' as const", vers: "scope: 'shared' as const" },
  { nom: 'cm-prompt-texte-perdu', f: R, de: "{ id: 'consignes:en-vigueur', text: texte, scope", vers: "{ id: 'consignes:en-vigueur', text: 'x', scope" },
  { nom: 'cm-prompt-base-perdue', f: R, de: 'sections: [...composition.sections, { id: ', vers: 'sections: [{ id: ' },
  { nom: 'cm-prompt-en-tete', f: R, de: "{ sections: [...composition.sections, { id: 'consignes:en-vigueur', text: texte, scope: 'session' as const }] }", vers: "{ sections: [{ id: 'consignes:en-vigueur', text: texte, scope: 'session' as const }, ...composition.sections] }" },
  { nom: 'cm-prompt-etat-ignore', f: R, de: '    const { etat } = await lire($)\n    $.ui.status(texteStatut(etat))', vers: '    const etat = normaliserEtat(null)\n    $.ui.status(texteStatut(etat))' },
  { nom: 'cm-prompt-statut-omis', f: R, de: '    $.ui.status(texteStatut(etat))\n    const texte = texteInjection(etat, await lireValeurs($))', vers: '    const texte = texteInjection(etat, await lireValeurs($))' },
  { nom: 'cm-prompt-valeurs-perdues', f: R, de: 'const texte = texteInjection(etat, await lireValeurs($))', vers: 'const texte = texteInjection(etat)' },
  { nom: 'cm-prompt-composition-ignoree', f: R, de: '    const composition = await next(e)\n    const { etat } = await lire($)', vers: '    const composition = { sections: [] as never[] }\n    const { etat } = await lire($)' },
  // commande /consignes
  { nom: 'cm-cmd-mauvais-nom', f: R, de: "on('command.run', { command: 'consignes' }", vers: "on('command.run', { command: 'consigne' }" },
  { nom: 'cm-cmd-illisible-ignore', f: R, de: "    if (illisible) return { text: `${fichier} est illisible : corrige-le ou supprime-le, puis recommence (rien n'a été écrit).` }\n", vers: '' },
  { nom: 'cm-cmd-illisible-message', f: R, de: ' est illisible : corrige-le ou supprime-le, puis recommence (rien n\'a été écrit).', vers: ' est illisible.' },
  { nom: 'cm-cmd-args-ignores', f: R, de: 'analyserCommande(e.args, etat, await lireValeurs($))', vers: "analyserCommande('', etat, await lireValeurs($))" },
  { nom: 'cm-cmd-etat-ignore', f: R, de: 'analyserCommande(e.args, etat, await lireValeurs($))', vers: 'analyserCommande(e.args, normaliserEtat(null), await lireValeurs($))' },
  { nom: 'cm-cmd-valeurs-perdues', f: R, de: 'analyserCommande(e.args, etat, await lireValeurs($))', vers: 'analyserCommande(e.args, etat)' },
  { nom: 'cm-cmd-erreur-ignoree', f: R, de: '    if (analyse.erreur !== undefined) return { text: analyse.erreur }\n', vers: '' },
  { nom: 'cm-cmd-erreur-message', f: R, de: 'if (analyse.erreur !== undefined) return { text: analyse.erreur }', vers: "if (analyse.erreur !== undefined) return { text: 'erreur' }" },
  { nom: 'cm-cmd-ecrit-toujours', f: R, de: 'if (JSON.stringify(analyse.etat) !== JSON.stringify(etat)) {', vers: 'if (true) {' },
  { nom: 'cm-cmd-n-ecrit-jamais', f: R, de: 'if (JSON.stringify(analyse.etat) !== JSON.stringify(etat)) {', vers: 'if (false) {' },
  { nom: 'cm-cmd-date-fausse', f: R, de: 'new Date(await $.clock.now()).toISOString()', vers: 'new Date(0).toISOString()' },
  { nom: 'cm-cmd-sans-date', f: R, de: 'JSON.stringify({ ...analyse.etat, maj }, null, 2)', vers: 'JSON.stringify({ ...analyse.etat }, null, 2)' },
  { nom: 'cm-cmd-ecrit-ancien-etat', f: R, de: 'JSON.stringify({ ...analyse.etat, maj }, null, 2)', vers: 'JSON.stringify({ ...etat, maj }, null, 2)' },
  { nom: 'cm-cmd-chemin-ecriture-faux', f: R, de: 'await $.fs.write(fichier, JSON.stringify', vers: "await $.fs.write(fichier + '.x', JSON.stringify" },
  { nom: 'cm-cmd-echec-propage', f: R, de: "      try {\n        await $.fs.write(fichier, JSON.stringify({ ...analyse.etat, maj }, null, 2))\n      } catch (erreur) {\n        return { text: `Écriture impossible dans ${fichier} (${erreur instanceof Error ? erreur.message : String(erreur)}) : rien n'a changé.` }\n      }", vers: "      await $.fs.write(fichier, JSON.stringify({ ...analyse.etat, maj }, null, 2))" },
  { nom: 'cm-cmd-echec-sans-cause', f: R, de: '(${erreur instanceof Error ? erreur.message : String(erreur)})', vers: '()' },
  { nom: 'cm-cmd-echec-sans-chemin', f: R, de: "`Écriture impossible dans ${fichier} (", vers: '`Écriture impossible (' },
  { nom: 'cm-cmd-echec-message-court', f: R, de: ") : rien n'a changé.` }", vers: ').` }' },
  { nom: 'cm-cmd-statut-apres-ecriture-omis', f: R, de: '      $.ui.status(texteStatut(analyse.etat))\n', vers: '' },
  { nom: 'cm-cmd-statut-ancien-etat', f: R, de: '      $.ui.status(texteStatut(analyse.etat))', vers: '      $.ui.status(texteStatut(etat))' },
  { nom: 'cm-cmd-message-perdu', f: R, de: 'return { text: analyse.message }', vers: "return { text: '' }" },
  // réglages du Cockpit (jetons {worktrees} et {plans}) : config.json, sinon les défauts. `valeursJetons` normalise elle-même ses entrées.
  { nom: 'cm-valeurs-chemin-faux', f: R, de: "const NOM_CONFIG = 'config.json'", vers: "const NOM_CONFIG = 'config2.json'" },
  { nom: 'cm-valeurs-bom-non-retire', f: R, de: LIRE_BOM_CONFIG, vers: 'JSON.parse(await $.fs.read(await cheminConfig($)))' },
  { nom: 'cm-valeurs-abime-vide', f: R, de: '  } catch {\n    return valeursJetons(null)\n  }', vers: "  } catch {\n    return { worktrees: '', plans: '' }\n  }" },
  { nom: 'cm-valeurs-abime-config-ignoree', f: R, de: `return valeursJetons(${LIRE_BOM_CONFIG})`, vers: 'return valeursJetons(null)' },
  // dossier d'état (emplacements-logique.mjs) : les deux fichiers sont dans le dossier du Cockpit, et un dossier introuvable est dit
  { nom: 'cm-dossier-consignes-relatif', f: R, de: '`${await dossierEtat($)}/${NOM_FICHIER}`', vers: '`${NOM_FICHIER}`' },
  { nom: 'cm-dossier-config-relatif', f: R, de: '`${await dossierEtat($)}/${NOM_CONFIG}`', vers: '`${NOM_CONFIG}`' },
  { nom: 'cm-dossier-commande-erreur-propagee', f: R, de: "    try {\n      fichier = await cheminConsignes($)\n    } catch (erreur) {\n      return { text: erreur instanceof Error ? erreur.message : String(erreur) }\n    }", vers: '    fichier = await cheminConsignes($)' },
  { nom: 'cm-dossier-commande-message-perdu', f: R, de: 'return { text: erreur instanceof Error ? erreur.message : String(erreur) }', vers: "return { text: 'erreur' }" },
];

executer({ mod: MOD, mutations: MUTATIONS, argv: process.argv.slice(2), concurrence: 3 })
  .then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
