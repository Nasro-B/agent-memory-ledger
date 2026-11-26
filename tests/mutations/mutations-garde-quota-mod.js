'use strict';
// Preuve par mutation du banc du module Garde-quota (mods/garde-quota/hooks/register.ts et la copie de la logique).
//   node tests/mutations/mutations-garde-quota-mod.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-garde-quota-mod.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-garde-quota-mod.js --liste         affiche les noms
//   node tests/mutations/mutations-garde-quota-mod.js --ancres        vérifie sans lancer le moteur que chaque ancre existe une fois
// Variable : GARDE_QUOTA_MOD (dossier du module, défaut : mods/garde-quota du dépôt). Le moteur : voir tests/lib/mutations-mod.js (AML_MOTEUR_CLAUDE).
// Mutation équivalente écartée : renvoyer `{ sections: [...] }` au lieu de la composition quand il n'y a rien à ajouter
// (le moteur simulé de la composition ne porte que `sections`) ; l'indentation du JSON écrit (le banc lit le contenu).

const path = require('node:path');
const { executer } = require('../lib/mutations-mod.js');

const MOD = process.env.GARDE_QUOTA_MOD || path.join(__dirname, '..', '..', 'mods', 'garde-quota');
const R = 'hooks/register.ts';

const MUTATIONS = [
  // démarrage et commande
  { nom: 'gq-commande-non-enregistree', f: R, de: "await $.command.register({ name: 'quota', description: 'Garde-quota : seuils, blocage des agents, consigne, son (/quota 80 90, /quota bloquer off)' })", vers: '' },
  { nom: 'gq-commande-mauvais-nom', f: R, de: "{ command: 'quota' }", vers: "{ command: 'quotas' }" },
  { nom: 'gq-statut-demarrage-omis', f: R, de: "    $.ui.status(texteStatut(await fenetresActuelles($), await lireConfig($), await $.clock.now()))\n\n    return next(e)", vers: '    return next(e)' },
  { nom: 'gq-cmd-erreur-ignoree', f: R, de: 'if (analyse.erreur !== undefined) return { text: analyse.erreur }', vers: '' },
  { nom: 'gq-cmd-toujours-ecrire', f: R, de: 'if (JSON.stringify(analyse.config) !== JSON.stringify(avant)) {', vers: 'if (true) {' },
  { nom: 'gq-cmd-jamais-ecrire', f: R, de: 'if (JSON.stringify(analyse.config) !== JSON.stringify(avant)) {', vers: 'if (false) {' },
  { nom: 'gq-cmd-sans-heure', f: R, de: 'JSON.stringify({ ...analyse.config, maj }, null, 2)', vers: 'JSON.stringify(analyse.config, null, 2)' },
  { nom: 'gq-cmd-sans-statut', f: R, de: "return { text: statut === undefined ? analyse.message : `${analyse.message}\\n${statut}` }", vers: 'return { text: analyse.message }' },
  { nom: 'gq-cmd-statut-toujours', f: R, de: "return { text: statut === undefined ? analyse.message : `${analyse.message}\\n${statut}` }", vers: "return { text: `${analyse.message}\\n${statut}` }" },
  { nom: 'gq-cmd-fichier-faux', f: R, de: "const NOM_CONFIG = 'garde-quota.json'", vers: "const NOM_CONFIG = 'quota.json'" },
  // réglages
  { nom: 'gq-config-non-normalisee', f: R, de: 'return normaliserConfig(JSON.parse(await $.fs.read(await fichier($, NOM_CONFIG))))', vers: 'return JSON.parse(await $.fs.read(await fichier($, NOM_CONFIG)))' },
  { nom: 'gq-config-defauts-perdus', f: R, de: '  } catch {\n    return normaliserConfig(null)\n  }', vers: '  } catch {\n    return {}\n  }' },
  { nom: 'gq-config-panne-propagee', f: R, de: "  try {\n    return normaliserConfig(JSON.parse(await $.fs.read(await fichier($, NOM_CONFIG))))\n  } catch {\n    return normaliserConfig(null)\n  }", vers: '  return normaliserConfig(JSON.parse(await $.fs.read(await fichier($, NOM_CONFIG))))' },
  // fenêtres mesurées
  { nom: 'gq-fenetres-panne-propagee', f: R, de: "  try {\n    return normaliserFenetres((await $.session.usage()).rateLimits)\n  } catch {\n    return []\n  }", vers: '  return normaliserFenetres((await $.session.usage()).rateLimits)' },
  { nom: 'gq-fenetres-non-normalisees', f: R, de: 'return normaliserFenetres((await $.session.usage()).rateLimits)', vers: 'return (await $.session.usage()).rateLimits as Fenetre[]' },
  // mesure
  { nom: 'gq-mesure-ignoree', f: R, de: "if (e.changed.includes('rateLimits')) await mesurer($, e.rateLimits)", vers: '' },
  { nom: 'gq-mesure-toujours', f: R, de: "if (e.changed.includes('rateLimits')) await mesurer($, e.rateLimits)", vers: 'await mesurer($, e.rateLimits)' },
  { nom: 'gq-mesure-mauvaise-unite', f: R, de: "e.changed.includes('rateLimits')", vers: "e.changed.includes('context')" },
  { nom: 'gq-mesure-brute-perdue', f: R, de: 'await mesurer($, e.rateLimits)', vers: 'await mesurer($, [])' },
  { nom: 'gq-fichier-quota-faux', f: R, de: "const NOM_QUOTA = 'quota-claude.json'", vers: "const NOM_QUOTA = 'quota.json'" },
  { nom: 'gq-fichier-vide-ecrase', f: R, de: '  if (fenetres.length === 0) return\n  try {', vers: '  try {' },
  { nom: 'gq-fichier-sans-heure', f: R, de: "mesureA: new Date(maintenant).toISOString(), source: 'garde-quota'", vers: "source: 'garde-quota'" },
  { nom: 'gq-fichier-source', f: R, de: "source: 'garde-quota'", vers: "source: 'mod'" },
  { nom: 'gq-fichier-echec-propage', f: R, de: "  try {\n    await $.fs.write(await fichier($, NOM_QUOTA), JSON.stringify({ fenetres, mesureA: new Date(maintenant).toISOString(), source: 'garde-quota' }, null, 2))\n  } catch {\n    // le Cockpit dira que la mesure est ancienne\n  }", vers: "  await $.fs.write(await fichier($, NOM_QUOTA), JSON.stringify({ fenetres, mesureA: new Date(maintenant).toISOString(), source: 'garde-quota' }, null, 2))" },
  { nom: 'gq-fichier-non-ecrit', f: R, de: '  await ecrireQuota($, fenetres, maintenant)\n', vers: '' },
  { nom: 'gq-statut-omis', f: R, de: '  $.ui.status(texteStatut(fenetres, config, maintenant))\n\n  const annonces', vers: '\n  const annonces' },
  // annonces
  { nom: 'gq-annonces-omises', f: R, de: '$.ui.toast(texteAlerte(a, maintenant, config), { timeoutMs: DUREE_TOAST_MS })', vers: '' },
  { nom: 'gq-annonces-sans-memoire', f: R, de: "await $.store.set('deja', annonces.deja)", vers: '' },
  { nom: 'gq-annonces-memoire-ignoree', f: R, de: "alertes(fenetres, config, maintenant, await $.store.get('deja'))", vers: 'alertes(fenetres, config, maintenant, [])' },
  { nom: 'gq-annonces-toast-duree', f: R, de: 'const DUREE_TOAST_MS = 15_000', vers: 'const DUREE_TOAST_MS = 4_000' },
  { nom: 'gq-son-toujours', f: R, de: "if (config.son) enFond(jouerSon($, a.niveau === 'critique' ? 'Hand' : 'Exclamation'))", vers: "enFond(jouerSon($, a.niveau === 'critique' ? 'Hand' : 'Exclamation'))" },
  { nom: 'gq-son-jamais', f: R, de: "if (config.son) enFond(jouerSon($, a.niveau === 'critique' ? 'Hand' : 'Exclamation'))", vers: '' },
  { nom: 'gq-son-critique-comme-attention', f: R, de: "a.niveau === 'critique' ? 'Hand' : 'Exclamation'", vers: "'Exclamation'" },
  { nom: 'gq-son-attention-comme-critique', f: R, de: "a.niveau === 'critique' ? 'Hand' : 'Exclamation'", vers: "'Hand'" },
  { nom: 'gq-son-sans-enfond', f: R, de: "if (config.son) enFond(jouerSon($, a.niveau === 'critique' ? 'Hand' : 'Exclamation'))", vers: "if (config.son) void jouerSon($, a.niveau === 'critique' ? 'Hand' : 'Exclamation')" },
  { nom: 'gq-enfond-sans-catch', f: R, de: '  travail.catch(() => {})', vers: '  void travail' },
  { nom: 'gq-son-options', f: R, de: "['powershell', '-NoProfile', '-NonInteractive', '-Command',", vers: "['powershell', '-Command'," },
  { nom: 'gq-son-sans-attente', f: R, de: '.Play(); Start-Sleep -Milliseconds 1500`', vers: '.Play()`' },
  { nom: 'gq-son-delai', f: R, de: 'const DELAI_SON_MS = 10_000', vers: 'const DELAI_SON_MS = 60_000' },
  // remise à zéro
  { nom: 'gq-hauts-non-gardes', f: R, de: "await $.store.set('hauts', suivi.hauts)", vers: '' },
  { nom: 'gq-hauts-ignores', f: R, de: "suivreHauts(await $.store.get('hauts'), fenetres, config, maintenant)", vers: 'suivreHauts([], fenetres, config, maintenant)' },
  { nom: 'gq-remise-non-memorisee', f: R, de: "await $.store.set('remise', { noms: suivi.remises, ts: maintenant })", vers: '' },
  { nom: 'gq-remise-sans-date', f: R, de: 'ts: maintenant })', vers: 'ts: 0 })' },
  { nom: 'gq-remise-toast-omis', f: R, de: '$.ui.toast(`Quota remis à zéro : ${suivi.remises.join(\', \')}`, { timeoutMs: DUREE_TOAST_MS })', vers: '' },
  { nom: 'gq-remise-toujours', f: R, de: 'if (suivi.remises.length > 0) {', vers: 'if (true) {' },
  { nom: 'gq-remise-son-toujours', f: R, de: "if (config.son) enFond(jouerSon($, 'Asterisk'))", vers: "enFond(jouerSon($, 'Asterisk'))" },
  { nom: 'gq-remise-son-jamais', f: R, de: "if (config.son) enFond(jouerSon($, 'Asterisk'))", vers: '' },
  // lancement d'un agent
  { nom: 'gq-spawn-refus-perdu', f: R, de: 'if (!decision.autorise) return { deny: decision.raison }', vers: '' },
  { nom: 'gq-spawn-raison-perdue', f: R, de: 'return { deny: decision.raison }', vers: "return { deny: 'non' }" },
  { nom: 'gq-spawn-fenetres-ignorees', f: R, de: 'decisionAgent(await fenetresActuelles($), await lireConfig($), await $.clock.now())', vers: 'decisionAgent([], await lireConfig($), await $.clock.now())' },
  { nom: 'gq-spawn-config-ignoree', f: R, de: 'decisionAgent(await fenetresActuelles($), await lireConfig($), await $.clock.now())', vers: 'decisionAgent(await fenetresActuelles($), normaliserConfig(null), await $.clock.now())' },
  { nom: 'gq-spawn-heure-ignoree', f: R, de: 'decisionAgent(await fenetresActuelles($), await lireConfig($), await $.clock.now())', vers: 'decisionAgent(await fenetresActuelles($), await lireConfig($), 0)' },
  // consigne dans le prompt
  { nom: 'gq-prompt-consigne-omise', f: R, de: "if (critique !== null) ajouts.push({ id: 'garde-quota:critique', text: critique, scope: 'session' })", vers: '' },
  { nom: 'gq-prompt-id-faux', f: R, de: "id: 'garde-quota:critique'", vers: "id: 'garde-quota'" },
  { nom: 'gq-prompt-section-partagee', f: R, de: "id: 'garde-quota:critique', text: critique, scope: 'session'", vers: "id: 'garde-quota:critique', text: critique, scope: 'shared'" },
  { nom: 'gq-prompt-relais-faux', f: R, de: "const RELAIS = { autre: 'Codex', nom: 'relais-codex.md' }", vers: "const RELAIS = { autre: 'Claude', nom: 'relais-claude.md' }" },
  { nom: 'gq-prompt-fenetres-ignorees', f: R, de: 'consigne(await fenetresActuelles($), config, maintenant, await relais($))', vers: 'consigne([], config, maintenant, await relais($))' },
  { nom: 'gq-prompt-remise-omise', f: R, de: "if (retour !== null) ajouts.push({ id: 'garde-quota:remise', text: retour, scope: 'session' })", vers: '' },
  { nom: 'gq-prompt-remise-sans-reglage', f: R, de: 'const retour = config.consigne && remiseRecente(remise, maintenant) ?', vers: 'const retour = remiseRecente(remise, maintenant) ?' },
  { nom: 'gq-prompt-remise-toujours', f: R, de: 'remiseRecente(remise, maintenant) ? consigneRemise(remise?.noms) : null', vers: 'consigneRemise(remise?.noms)' },
  { nom: 'gq-prompt-remise-jamais', f: R, de: 'remiseRecente(remise, maintenant) ? consigneRemise(remise?.noms) : null', vers: 'null' },
  { nom: 'gq-prompt-remise-id-faux', f: R, de: "id: 'garde-quota:remise'", vers: "id: 'garde-quota:critique'" },
  { nom: 'gq-prompt-remise-section-partagee', f: R, de: "id: 'garde-quota:remise', text: retour, scope: 'session'", vers: "id: 'garde-quota:remise', text: retour, scope: 'shared'" },
  { nom: 'gq-prompt-ajouts-perdus', f: R, de: '{ sections: [...composition.sections, ...ajouts] }', vers: '{ sections: [...composition.sections] }' },
  { nom: 'gq-prompt-base-perdue', f: R, de: '{ sections: [...composition.sections, ...ajouts] }', vers: '{ sections: [...ajouts] }' },
  { nom: 'gq-prompt-ajouts-en-tete', f: R, de: '{ sections: [...composition.sections, ...ajouts] }', vers: '{ sections: [...ajouts, ...composition.sections] }' },
  // dossier d'état (emplacements-logique.mjs) : tous les fichiers sont dans le dossier du Cockpit, un dossier introuvable est dit ou toléré
  { nom: 'gq-dossier-fichier-relatif', f: R, de: 'return `${await dossierEtat($)}/${nom}`', vers: 'return nom' },
  { nom: 'gq-dossier-commande-erreur-propagee', f: R, de: "    try {\n      fichierConfig = await fichier($, NOM_CONFIG)\n    } catch (erreur) {\n      return { text: erreur instanceof Error ? erreur.message : String(erreur) }\n    }", vers: '    fichierConfig = await fichier($, NOM_CONFIG)' },
  { nom: 'gq-dossier-commande-message-perdu', f: R, de: 'return { text: erreur instanceof Error ? erreur.message : String(erreur) }', vers: "return { text: 'erreur' }" },
  { nom: 'gq-relais-sans-dossier-propage', f: R, de: "  try {\n    return { autre: RELAIS.autre, fichier: await fichier($, RELAIS.nom) }\n  } catch {\n    return { autre: RELAIS.autre }\n  }", vers: '  return { autre: RELAIS.autre, fichier: await fichier($, RELAIS.nom) }' },
  { nom: 'gq-relais-sans-dossier-autre-perdu', f: R, de: '  } catch {\n    return { autre: RELAIS.autre }\n  }', vers: "  } catch {\n    return { autre: 'Claude' }\n  }" },
];

executer({ mod: MOD, mutations: MUTATIONS, argv: process.argv.slice(2), concurrence: 4 })
  .then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
