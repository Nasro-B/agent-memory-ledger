'use strict';
// Preuve par mutation du banc du module Régulateur d'agents (mods/regulateur/hooks/register.ts et la copie de la logique).
//   node tests/mutations/mutations-regulateur-mod.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-regulateur-mod.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-regulateur-mod.js --liste         affiche les noms
//   node tests/mutations/mutations-regulateur-mod.js --ancres        vérifie sans lancer le moteur que chaque ancre existe une fois
// Variable : REGULATEUR_MOD (dossier du module, défaut : mods/regulateur du dépôt). Le moteur : voir tests/lib/mutations-mod.js (AML_MOTEUR_CLAUDE).
// La file d'attente se lit et s'écrit par scripts/regulateur-file.js (un processus, sous le verrou de la file) : les mutations de la file portent sur ce que le
// module demande (l'opération, ses arguments, l'heure qui sert à la purge) et sur ce qu'il fait de la réponse ; la logique de la file elle-même est prouvée par
// ses propres mutations (tests/mutations/mutations-regulateur-core.js et mutations-file-logique.js).
// Mutations équivalentes ou non observables écartées : l'indentation du JSON écrit par la mod (le banc lit le contenu, pas la mise en
// page) ; ajouter une section `text: null` quand la politique est inerte (le moteur refuse la section invalide en sautant le hook, le
// prompt reste celui du moteur) ; le verrou qui rend un dépilage qui échoue (le dépilage attrape tout, il ne rejette jamais) ;
// enlever la condition `file` du suivi d'un lancement du modèle (la relance et le message relisent la politique à la fin de l'agent) ;
// retirer la remise à zéro du contexte de lancement (il est réassigné avant chaque lancement) ; l'indéfini ignoré par `suivre` (aucun
// tour de sous-agent n'arrive sans identifiant). Famille « protection contre un rejet après déchargement » (`enFond` sans catch) :
// observable par un test qui fait lever le moteur au message envoyé au modèle PENDANT le test (voir
// mutations-cockpit-mod.js pour la cause de l'ancienne survie) ; `enFond(depiler($))` ne peut pas rejeter (le dépilage attrape tout).
// Équivalentes ou non observables (retirées après essai) : le try/catch autour de la suite d'un tour d'agent (sans lui le moteur
// ignore le hook en le signalant dans sa trace : le résultat du tour est le même) ; la garde `entree === undefined` du dépilage (la boucle
// garantit une entrée) ; `return { cwd }` à la place de `next(e)` au démarrage (le monde simulé répond la même chose).
// Non muté : la boucle du dépilage sans `return` après un refus (elle ne s'arrêterait jamais : aucun verdict possible).
// Équivalente par le moteur de test : un hook `agent.spawn` qui renvoie `{ deny }` APRÈS avoir appelé
// `next(e)` n'a aucun effet, l'agent est déjà lancé et le moteur rend le résultat de `next` (mutation retirée : `return { deny: 'x' }`
// à la place de `return lance`).
// Garde-fou du dépilage : la boucle est bornée par MAX_FILE lancements par passe ; sans elle, une entrée qui ne partirait
// pas de la file (`mod-regul-depile-entree-gardee`) bouclait sans fin et le banc n'avait aucun verdict (délai de 180 s).

const path = require('node:path');
const { executer } = require('../lib/mutations-mod.js');

const MOD = process.env.REGULATEUR_MOD || path.join(__dirname, '..', '..', 'mods', 'regulateur');
const R = 'hooks/register.ts';
const L = 'hooks/regulateur-logique.mjs';

const REFUS = "decision.mettreEnFile ? await refuserEnFile($, lancement) : decision.raison";
const SUIVI_MODELE = "if (politique.file && !e.fork && e.isTeammate !== true) suivre(lance.agentId, { description: e.description, demande: demandeDeLancement(lancement), essais: 0, viaFile: false })";
// Les arguments de l'opération `mettreEnFile` d'un refus, et ceux d'une relance en tête de file : le module envoie l'heure qui sert à la purge côté script.
const PURGE = "[{ agent: AGENT, session, description: e.description, demande: demandeDeLancement(e), maintenant }]";
const CONTEXTE = "lancementPropre = { description: entree.description, demande: entree.demande, essais: entree.essais, viaFile: true }";
const FILE_EN_TETE = "[{ agent: AGENT, session, description: suivi.description, demande: suivi.demande, maintenant, essais: suivi.essais + 1, enTete: true }]";

const MUTATIONS = [
  // refus au lancement
  { nom: 'mod-regul-pas-de-refus', f: R, de: `      if (!decision.autorise) return { deny: ${REFUS} }\n`, vers: '' },
  { nom: 'mod-regul-refus-sans-raison', f: R, de: REFUS, vers: "'non'" },
  { nom: 'mod-regul-refus-toujours-en-file', f: R, de: REFUS, vers: 'await refuserEnFile($, lancement)' },
  { nom: 'mod-regul-refus-jamais-en-file', f: R, de: REFUS, vers: 'decision.raison' },
  { nom: 'mod-regul-liste-lue-meme-inerte', f: R, de: 'if (politique.pause || politique.max !== null) {', vers: 'if (true) {' },
  { nom: 'mod-regul-pause-ignoree', f: R, de: 'if (politique.pause || politique.max !== null) {', vers: 'if (politique.max !== null) {' },
  { nom: 'mod-regul-plafond-ignore', f: R, de: 'if (politique.pause || politique.max !== null) {', vers: 'if (politique.pause) {' },
  { nom: 'mod-regul-panne-de-comptage-bloque', f: R, de: '    return creneauxOccupes(await $.agent.list())\n  } catch {\n    return null\n  }', vers: '    return creneauxOccupes(await $.agent.list())\n  } catch {\n    return 999\n  }' },
  { nom: 'mod-regul-fichier-faux', f: R, de: "const NOM_FICHIER = 'politique-agents.json'", vers: "const NOM_FICHIER = 'politique.json'" },
  { nom: 'mod-regul-politique-non-normalisee', f: R, de: 'return normaliserPolitique(JSON.parse(await $.fs.read(await fichier($, NOM_FICHIER))))', vers: 'return JSON.parse(await $.fs.read(await fichier($, NOM_FICHIER)))' },
  { nom: 'mod-regul-fichier-absent-bloque', f: R, de: '  } catch {\n    return normaliserPolitique(null)\n  }', vers: '  } catch {\n    return { max: 1, pause: false, relance: false, file: false }\n  }' },
  // un lancement de la mod elle-même
  { nom: 'mod-regul-propre-plafonne', f: R, de: 'if (next.origin.plugin === PLUGIN) {', vers: 'if (false) {' },
  { nom: 'mod-regul-propre-toujours', f: R, de: 'if (next.origin.plugin === PLUGIN) {', vers: 'if (true) {' },
  { nom: 'mod-regul-plugin-nom-faux', f: R, de: "const PLUGIN = 'regulateur'", vers: "const PLUGIN = 'regulateur2'" },
  { nom: 'mod-regul-propre-sans-suivi', f: R, de: '      if (lancementPropre !== null) suivre(propre.agentId, lancementPropre)\n', vers: '' },
  { nom: 'mod-regul-propre-sans-resultat', f: R, de: '      return propre\n    }', vers: "      return { deny: 'x' }\n    }" },
  // suivi des lancements du modèle
  { nom: 'mod-regul-suivi-fork', f: R, de: 'if (politique.file && !e.fork && e.isTeammate !== true) suivre(', vers: 'if (politique.file && e.isTeammate !== true) suivre(' },
  { nom: 'mod-regul-suivi-coequipier', f: R, de: 'if (politique.file && !e.fork && e.isTeammate !== true) suivre(', vers: 'if (politique.file && !e.fork) suivre(' },
  { nom: 'mod-regul-suivi-via-file', f: R, de: 'essais: 0, viaFile: false })', vers: 'essais: 0, viaFile: true })' },
  { nom: 'mod-regul-suivi-essais', f: R, de: 'essais: 0, viaFile: false })', vers: 'essais: 1, viaFile: false })' },
  { nom: 'mod-regul-suivi-demande', f: R, de: "suivre(lance.agentId, { description: e.description, demande: demandeDeLancement(lancement), essais: 0", vers: 'suivre(lance.agentId, { description: e.description, demande: {}, essais: 0' },
  { nom: 'mod-regul-suivi-description', f: R, de: "suivre(lance.agentId, { description: e.description, demande", vers: "suivre(lance.agentId, { description: 'x', demande" },
  { nom: 'mod-regul-suivi-eviction-limite', f: R, de: 'if (suivis.size > MAX_SUIVIS) {', vers: 'if (suivis.size >= MAX_SUIVIS) {' },
  { nom: 'mod-regul-suivi-sans-eviction', f: R, de: 'if (suivis.size > MAX_SUIVIS) {', vers: 'if (false) {' },
  { nom: 'mod-regul-suivi-max', f: R, de: 'const MAX_SUIVIS = 200', vers: 'const MAX_SUIVIS = 199' },
  { nom: 'mod-regul-suivi-eviction-ordre', f: R, de: 'const plusAncien = suivis.keys().next().value\n    if (plusAncien !== undefined) suivis.delete(plusAncien)', vers: 'const plusAncien = [...suivis.keys()].at(-1)\n    if (plusAncien !== undefined) suivis.delete(plusAncien)' },
  // fin d'un agent
  { nom: 'mod-regul-fin-sans-suite', f: R, de: '        await apresFin($, e.agentId, e.reason, e.answer)\n', vers: '' },
  { nom: 'mod-regul-fin-agent-ignore', f: R, de: 'if (e.agentId !== undefined) {\n      try {', vers: 'if (false) {\n      try {' },
  { nom: 'mod-regul-fin-sans-resultat', f: R, de: "    const resultat = await next(e)\n    if (e.agentId", vers: "    const resultat = { text: '' }\n    if (e.agentId" },
  { nom: 'mod-regul-fin-raison-ignoree', f: R, de: 'await apresFin($, e.agentId, e.reason, e.answer)', vers: "await apresFin($, e.agentId, 'answer', e.answer)" },
  { nom: 'mod-regul-fin-reponse-perdue', f: R, de: 'await apresFin($, e.agentId, e.reason, e.answer)', vers: "await apresFin($, e.agentId, e.reason, '')" },
  { nom: 'mod-regul-fin-agent-faux', f: R, de: 'await apresFin($, e.agentId, e.reason, e.answer)', vers: "await apresFin($, 'autre', e.reason, e.answer)" },
  { nom: 'mod-regul-apres-suivi-oublie', f: R, de: '    suivis.delete(agentId)\n', vers: '' },
  { nom: 'mod-regul-apres-reussite-inversee', f: R, de: "    if (reason === 'answer') {\n      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))", vers: "    if (reason !== 'answer') {\n      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))" },
  { nom: 'mod-regul-apres-reussite-toujours-dite', f: R, de: "      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))", vers: "      informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))" },
  { nom: 'mod-regul-apres-reussite-jamais-dite', f: R, de: "      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))", vers: '      void reponse' },
  { nom: 'mod-regul-apres-reussite-sans-reponse', f: R, de: "issue: 'termine', reponse }))", vers: "issue: 'termine', reponse: '' }))" },
  { nom: 'mod-regul-apres-reussite-sans-description', f: R, de: "informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))", vers: "informer($, texteFinAgent({ description: '', issue: 'termine', reponse }))" },
  { nom: 'mod-regul-apres-interrompu-ignore', f: R, de: "    } else if (reason === 'aborted') {", vers: "    } else if (false) {" },
  { nom: 'mod-regul-apres-interrompu-toujours-dit', f: R, de: "      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'interrompu' }))", vers: "      informer($, texteFinAgent({ description: suivi.description, issue: 'interrompu' }))" },
  { nom: 'mod-regul-apres-interrompu-jamais-dit', f: R, de: "      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'interrompu' }))", vers: '      void reason' },
  { nom: 'mod-regul-apres-relance-sans-file', f: R, de: "    } else if (politique.file && politique.relance && suivi.essais < MAX_RELANCES) {", vers: "    } else if (politique.relance && suivi.essais < MAX_RELANCES) {" },
  { nom: 'mod-regul-apres-relance-sans-option', f: R, de: "    } else if (politique.file && politique.relance && suivi.essais < MAX_RELANCES) {", vers: "    } else if (politique.file && suivi.essais < MAX_RELANCES) {" },
  { nom: 'mod-regul-apres-relance-sans-limite', f: R, de: "    } else if (politique.file && politique.relance && suivi.essais < MAX_RELANCES) {", vers: "    } else if (politique.file && politique.relance) {" },
  { nom: 'mod-regul-apres-relance-limite-large', f: R, de: "suivi.essais < MAX_RELANCES) {", vers: "suivi.essais <= MAX_RELANCES) {" },
  { nom: 'mod-regul-apres-relance-sans-mise-en-file', f: R, de: '      const relance = await mettreEnFileEnTete($, suivi)\n', vers: '      const relance = true\n' },
  { nom: 'mod-regul-apres-relance-echec-dit-reussi', f: R, de: "issue: relance ? 'echec' : 'echec-final', essai: suivi.essais + 1 }))", vers: "issue: 'echec', essai: suivi.essais + 1 }))" },
  { nom: 'mod-regul-apres-relance-essai-faux', f: R, de: "issue: relance ? 'echec' : 'echec-final', essai: suivi.essais + 1 }))", vers: "issue: relance ? 'echec' : 'echec-final', essai: suivi.essais }))" },
  { nom: 'mod-regul-apres-abandon-ignore', f: R, de: "    } else if (politique.file && politique.relance) {\n      informer($, texteFinAgent({ description: suivi.description, issue: 'abandon' }))", vers: "    } else if (false) {\n      informer($, texteFinAgent({ description: suivi.description, issue: 'abandon' }))" },
  { nom: 'mod-regul-apres-abandon-sans-option', f: R, de: "    } else if (politique.file && politique.relance) {\n      informer(", vers: "    } else if (politique.file) {\n      informer(" },
  { nom: 'mod-regul-apres-abandon-issue', f: R, de: "issue: 'abandon' }))", vers: "issue: 'echec-final' }))" },
  { nom: 'mod-regul-apres-echec-final-ignore', f: R, de: "    } else if (suivi.viaFile) {\n      informer($, texteFinAgent({ description: suivi.description, issue: 'echec-final' }))", vers: "    } else if (false) {\n      informer($, texteFinAgent({ description: suivi.description, issue: 'echec-final' }))" },
  { nom: 'mod-regul-apres-echec-final-toujours', f: R, de: "    } else if (suivi.viaFile) {\n      informer($, texteFinAgent({ description: suivi.description, issue: 'echec-final' }))", vers: "    } else {\n      informer($, texteFinAgent({ description: suivi.description, issue: 'echec-final' }))" },
  { nom: 'mod-regul-apres-depilage-oublie', f: R, de: '  await depiler($, agentId)\n}', vers: '}' },
  { nom: 'mod-regul-apres-depilage-sans-exclusion', f: R, de: '  await depiler($, agentId)\n}', vers: '  await depiler($)\n}' },
  { nom: 'mod-regul-apres-depilage-exclusion-fausse', f: R, de: '  await depiler($, agentId)\n}', vers: "  await depiler($, 'autre')\n}" },
  // relance en tête de file
  { nom: 'mod-regul-relance-sans-purge', f: R, de: FILE_EN_TETE, vers: FILE_EN_TETE.replace('demande: suivi.demande, maintenant, ', 'demande: suivi.demande, ') },
  { nom: 'mod-regul-relance-pas-en-tete', f: R, de: FILE_EN_TETE, vers: FILE_EN_TETE.replace(', enTete: true', '') },
  { nom: 'mod-regul-relance-essais-perdus', f: R, de: FILE_EN_TETE, vers: FILE_EN_TETE.replace('essais: suivi.essais + 1, ', '') },
  { nom: 'mod-regul-relance-essais-faux', f: R, de: FILE_EN_TETE, vers: FILE_EN_TETE.replace('essais: suivi.essais + 1', 'essais: suivi.essais') },
  { nom: 'mod-regul-relance-demande-perdue', f: R, de: FILE_EN_TETE, vers: FILE_EN_TETE.replace('demande: suivi.demande', 'demande: {}') },
  { nom: 'mod-regul-relance-description-perdue', f: R, de: FILE_EN_TETE, vers: FILE_EN_TETE.replace('description: suivi.description', "description: ''") },
  { nom: 'mod-regul-relance-refus-ignore', f: R, de: 'if (r.refus !== undefined) return false\n    await dire($, await lireFile($))\n    return true', vers: 'await dire($, await lireFile($))\n    return true' },
  { nom: 'mod-regul-relance-ecriture-ignoree', f: R, de: '    return true\n  } catch { return false }\n}', vers: '    return true\n  } catch { return true }\n}' },
  { nom: 'mod-regul-relance-sans-statut', f: R, de: 'if (r.refus !== undefined) return false\n    await dire($, await lireFile($))\n    return true', vers: 'if (r.refus !== undefined) return false\n    return true' },
  { nom: 'mod-regul-relance-toujours-reussie', f: R, de: 'if (r.refus !== undefined) return false', vers: 'if (r.refus !== undefined) return true' },
  // mise en file
  { nom: 'mod-regul-file-fork', f: R, de: "if (e.fork || e.isTeammate === true || e.prompt.trim() === '') return texteRefusSansFile('invalide')", vers: "if (e.isTeammate === true || e.prompt.trim() === '') return texteRefusSansFile('invalide')" },
  { nom: 'mod-regul-file-coequipier', f: R, de: "if (e.fork || e.isTeammate === true || e.prompt.trim() === '') return texteRefusSansFile('invalide')", vers: "if (e.fork || e.prompt.trim() === '') return texteRefusSansFile('invalide')" },
  { nom: 'mod-regul-file-prompt-vide', f: R, de: "if (e.fork || e.isTeammate === true || e.prompt.trim() === '') return texteRefusSansFile('invalide')", vers: "if (e.fork || e.isTeammate === true) return texteRefusSansFile('invalide')" },
  { nom: 'mod-regul-file-prompt-blanc', f: R, de: "e.prompt.trim() === '') return texteRefusSansFile('invalide')", vers: "e.prompt === '') return texteRefusSansFile('invalide')" },
  { nom: 'mod-regul-file-sans-purge', f: R, de: PURGE, vers: PURGE.replace(', maintenant }]', ' }]') },
  { nom: 'mod-regul-file-agent-faux', f: R, de: PURGE, vers: PURGE.replace('agent: AGENT', "agent: 'codex'") },
  { nom: 'mod-regul-file-session-ignoree', f: R, de: PURGE, vers: PURGE.replace('session, description', "session: 'autre', description") },
  { nom: 'mod-regul-file-description-perdue', f: R, de: PURGE, vers: PURGE.replace('description: e.description', "description: ''") },
  { nom: 'mod-regul-file-demande-perdue', f: R, de: PURGE, vers: PURGE.replace('demande: demandeDeLancement(e)', 'demande: { prompt: e.prompt }') },
  { nom: 'mod-regul-file-date-perdue', f: R, de: PURGE, vers: PURGE.replace(', maintenant }]', ', maintenant: 0 }]') },
  { nom: 'mod-regul-file-refus-ignore', f: R, de: "    if (r.refus !== undefined) return texteRefusSansFile(r.refus)\n    await dire(", vers: '    await dire(' },
  { nom: 'mod-regul-file-refus-raison', f: R, de: 'return texteRefusSansFile(r.refus)', vers: "return texteRefusSansFile('invalide')" },
  { nom: 'mod-regul-file-ecriture-toujours', f: R, de: "texteRefusSansFile(transaction ? 'ecriture' : 'invalide')", vers: "texteRefusSansFile('ecriture')" },
  { nom: 'mod-regul-file-ecriture-ignoree', f: R, de: "texteRefusSansFile(transaction ? 'ecriture' : 'invalide')", vers: "texteRefusSansFile('invalide')" },
  { nom: 'mod-regul-file-ecriture-jamais', f: R, de: '    transaction = true\n', vers: '' },
  { nom: 'mod-regul-file-ecriture-raison', f: R, de: "transaction ? 'ecriture' : 'invalide'", vers: "transaction ? 'pleine' : 'invalide'" },
  { nom: 'mod-regul-file-sans-statut', f: R, de: '    await dire($, await lireFile($))\n\n    return texteRefus(', vers: '\n    return texteRefus(' },
  { nom: 'mod-regul-file-total-faux', f: R, de: 'total: r.total, mode', vers: 'total: 1, mode' },
  { nom: 'mod-regul-file-position-faux', f: R, de: 'texteRefus({ position: r.position,', vers: 'texteRefus({ position: 1,' },
  { nom: 'mod-regul-file-mode-faux', f: R, de: "mode: 'code' })", vers: "mode: 'modele' })" },
  { nom: 'mod-regul-file-panne-propagee', f: R, de: "  } catch {\n    return texteRefusSansFile(transaction ? 'ecriture' : 'invalide')\n  }\n}", vers: "  } catch (e) {\n    throw e\n  }\n}" },
  { nom: 'mod-regul-file-panne-raison', f: R, de: "'ecriture' : 'invalide')", vers: "'ecriture' : 'pleine')" },
  // créneaux libres
  { nom: 'mod-regul-libres-sans-maximum', f: R, de: 'if (politique.max === null) return Number.MAX_SAFE_INTEGER', vers: 'if (politique.max === null) return 0' },
  { nom: 'mod-regul-libres-fini-oublie', f: R, de: '(await $.agent.list()).filter(a => a.id !== termine)', vers: '(await $.agent.list())' },
  { nom: 'mod-regul-libres-fini-inverse', f: R, de: '.filter(a => a.id !== termine)', vers: '.filter(a => a.id === termine)' },
  { nom: 'mod-regul-libres-calcul', f: R, de: 'return politique.max - creneauxOccupes(agents)', vers: 'return politique.max' },
  { nom: 'mod-regul-libres-panne-libre', f: R, de: '    return politique.max - creneauxOccupes(agents)\n  } catch {\n    return null\n  }', vers: '    return politique.max - creneauxOccupes(agents)\n  } catch {\n    return 1\n  }' },
  // raison du refus d'un autre plugin
  { nom: 'mod-regul-refus-repete', f: R, de: '  if (raison === derniereRaison) return\n', vers: '' },
  { nom: 'mod-regul-refus-jamais-retenu', f: R, de: '  derniereRaison = raison\n', vers: '' },
  { nom: 'mod-regul-refus-toast', f: R, de: "un agent de la file n'a pas pu être lancé (${raison}). Il reste en tête de la file.", vers: "un agent n'a pas pu être lancé (${raison})." },
  { nom: 'mod-regul-refus-raison-retenue-apres-succes', f: R, de: '        derniereRaison = null\n', vers: '' },
  // dépilage
  { nom: 'mod-regul-depile-file-ignoree', f: R, de: 'if (!politique.file || politique.pause) return', vers: 'if (politique.pause) return' },
  { nom: 'mod-regul-depile-pause-ignoree', f: R, de: 'if (!politique.file || politique.pause) return', vers: 'if (!politique.file) return' },
  { nom: 'mod-regul-depile-purge-ignoree', f: R, de: '      if (retirees > 0) await dire($, etat)', vers: '      if (false) await dire($, etat)' },
  { nom: 'mod-regul-depile-purge-toujours', f: R, de: '      if (retirees > 0) await dire($, etat)', vers: '      if (true) await dire($, etat)' },
  { nom: 'mod-regul-depile-purge-sans-etat', f: R, de: '      let etat = await lireFile($)', vers: '      let etat = { prochain: 1, entrees: [], relances: {} } as Etat' },
  { nom: 'mod-regul-depile-purge-sans-ecriture', f: R, de: "      const retirees = await operationFile<number>($, 'purgerFile', [maintenant])", vers: '      const retirees = 0' },
  { nom: 'mod-regul-depile-un-seul', f: R, de: 'for (let lances = 0; lances < MAX_FILE && prochaines(etat, AGENT, session, 1, maintenant).length > 0; lances++) {', vers: 'for (let lances = 0; lances < 1 && prochaines(etat, AGENT, session, 1, maintenant).length > 0; lances++) {' },
  { nom: 'mod-regul-depile-session-ignoree', f: R, de: 'for (let lances = 0; lances < MAX_FILE && prochaines(etat, AGENT, session, 1, maintenant).length > 0; lances++) {\n        const libres = await creneauxLibres($, politique, termine)\n        if (libres === null || libres < 1) return\n        const entree = prochaines(etat, AGENT, session, 1, maintenant)[0]', vers: 'for (let lances = 0; lances < MAX_FILE && etat.entrees.some(e => e.agent === AGENT); lances++) {\n        const libres = await creneauxLibres($, politique, termine)\n        if (libres === null || libres < 1) return\n        const entree = etat.entrees.find(e => e.agent === AGENT)' },
  { nom: 'mod-regul-depile-panne-lance', f: R, de: 'if (libres === null || libres < 1) return', vers: 'if (libres !== null && libres < 1) return' },
  { nom: 'mod-regul-depile-zero-libre-lance', f: R, de: 'if (libres === null || libres < 1) return', vers: 'if (libres === null || libres < 0) return' },
  { nom: 'mod-regul-depile-agent-faux', f: R, de: 'const entree = prochaines(etat, AGENT, session, 1, maintenant)[0]', vers: "const entree = prochaines(etat, 'codex', session, 1, maintenant)[0]" },
  { nom: 'mod-regul-depile-derniere-entree', f: R, de: 'const entree = prochaines(etat, AGENT, session, 1, maintenant)[0]', vers: 'const entree = prochaines(etat, AGENT, session, 50, maintenant).at(-1)' },
  { nom: 'mod-regul-depile-contexte-perdu', f: R, de: CONTEXTE, vers: 'lancementPropre = null' },
  { nom: 'mod-regul-depile-contexte-hors-file', f: R, de: CONTEXTE, vers: CONTEXTE.replace('viaFile: true', 'viaFile: false') },
  { nom: 'mod-regul-depile-contexte-essais', f: R, de: CONTEXTE, vers: CONTEXTE.replace('essais: entree.essais', 'essais: 0') },
  { nom: 'mod-regul-depile-contexte-description', f: R, de: CONTEXTE, vers: CONTEXTE.replace('description: entree.description', "description: ''") },
  { nom: 'mod-regul-depile-contexte-demande', f: R, de: CONTEXTE, vers: CONTEXTE.replace('demande: entree.demande', 'demande: {}') },
  { nom: 'mod-regul-depile-arguments-perdus', f: R, de: 'r = await $.agent.spawn(argumentsDeLancement(entree.demande))', vers: "r = await $.agent.spawn({ prompt: 'x' })" },
  { nom: 'mod-regul-depile-refus-ignore', f: R, de: '        if (r.deny !== undefined) {', vers: '        if (false) {' },
  { nom: 'mod-regul-depile-refus-muet', f: R, de: '          signalerRefus($, r.deny)\n\n          return', vers: '          return' },
  { nom: 'mod-regul-depile-entree-gardee', f: R, de: "        await operationFile<boolean>($, 'retirerReconnue', [AGENT, session, entree.demande])\n", vers: '' },
  { nom: 'mod-regul-depile-retire-tout', f: R, de: "'retirerReconnue', [AGENT, session, entree.demande]", vers: "'viderFile', [AGENT, session]" },
  { nom: 'mod-regul-depile-sans-ecriture', f: R, de: "'retirerReconnue', [AGENT, session, entree.demande]", vers: "'retirerReconnue', [AGENT, 'autre', entree.demande]" },
  { nom: 'mod-regul-depile-sans-statut', f: R, de: '        etat = await lireFile($)\n        await dire($, etat)\n        void $.ui.toast', vers: '        etat = await lireFile($)\n        void $.ui.toast' },
  { nom: 'mod-regul-depile-sans-annonce', f: R, de: "        void $.ui.toast(`Régulateur d'agents : « ${entree.description} » lancé depuis la file.`)\n", vers: '' },
  { nom: 'mod-regul-depile-annonce-texte', f: R, de: "« ${entree.description} » lancé depuis la file.`", vers: "« ${entree.description} » lancé.`" },
  { nom: 'mod-regul-depile-panne-propagee', f: R, de: "    } catch {\n      // une panne du dépilage ne bloque jamais le travail : la minuterie réessaie\n    }", vers: '    } finally {\n    }' },
  { nom: 'mod-regul-depile-sans-verrou', f: R, de: 'const suite = verrou.then(travail, travail)', vers: 'const suite = travail()' },
  { nom: 'mod-regul-depile-termine-ignore', f: R, de: 'const libres = await creneauxLibres($, politique, termine)', vers: 'const libres = await creneauxLibres($, politique, undefined)' },
  // commande
  { nom: 'mod-regul-compose-sans-section', f: R, de: ": { sections: [...composition.sections, { id: 'regulateur:politique', text: texte, scope: 'session' as const }] }", vers: ': composition' },
  { nom: 'mod-regul-section-partagee', f: R, de: "scope: 'session' as const", vers: "scope: 'shared' as const" },
  { nom: 'mod-regul-section-id', f: R, de: "id: 'regulateur:politique'", vers: "id: 'regulateur:autre'" },
  { nom: 'mod-regul-compose-section-au-debut', f: R, de: '[...composition.sections, { id:', vers: '[{ id:' },
  { nom: 'mod-regul-commande-non-enregistree', f: R, de: "    await $.command.register({ name: 'plafond', description: \"Plafond d'agents en parallèle : /plafond N, pause, reprendre, libre, relance on|off, file on|off|vider\" })\n", vers: '' },
  { nom: 'mod-regul-commande-erreur-ecrit', f: R, de: 'if (analyse.erreur !== undefined) return { text: analyse.erreur }', vers: '' },
  { nom: 'mod-regul-commande-toujours-ecrire', f: R, de: 'if (JSON.stringify(analyse.politique) !== JSON.stringify(avant)) {', vers: 'if (true) {' },
  { nom: 'mod-regul-commande-jamais-ecrire', f: R, de: 'if (JSON.stringify(analyse.politique) !== JSON.stringify(avant)) {', vers: 'if (false) {' },
  { nom: 'mod-regul-commande-sans-heure', f: R, de: "      const maj = new Date(await $.clock.now()).toISOString()\n      await $.fs.write(fichierPolitique, ", vers: "      const maj = 'x'\n      await $.fs.write(fichierPolitique, " },
  { nom: 'mod-regul-commande-sans-compte', f: R, de: 'analyserCommande(e.args, avant, await agentsOccupes($))', vers: 'analyserCommande(e.args, avant)' },
  { nom: 'mod-regul-commande-mauvais-nom', f: R, de: "{ command: 'plafond' }", vers: "{ command: 'plafon' }" },
  { nom: 'mod-regul-commande-sans-message', f: R, de: 'return { text: analyse.message }', vers: "return { text: '' }" },
  { nom: 'mod-regul-commande-vider-ignore', f: R, de: '    if (analyse.viderFile === true) {', vers: '    if (false) {' },
  { nom: 'mod-regul-commande-vider-toujours', f: R, de: '    if (analyse.viderFile === true) {', vers: '    if (true) {' },
  { nom: 'mod-regul-commande-vider-tout', f: R, de: "'viderFile', [AGENT, session]", vers: "'viderFile', [null, null]" },
  { nom: 'mod-regul-commande-vider-session-ignoree', f: R, de: "'viderFile', [AGENT, session]", vers: "'viderFile', [AGENT, null]" },
  { nom: 'mod-regul-commande-vider-agent-ignore', f: R, de: "'viderFile', [AGENT, session]", vers: "'viderFile', [null, session]" },
  { nom: 'mod-regul-commande-vider-sans-ecriture', f: R, de: "        const retirees = await operationFile<number>($, 'viderFile', [AGENT, session])", vers: '        const retirees = 0' },
  { nom: 'mod-regul-commande-vider-toujours-ecrire', f: R, de: 'return { text: texteVidee(retirees) }', vers: 'return { text: texteVidee(retirees + 1) }' },
  { nom: 'mod-regul-commande-vider-sans-statut', f: R, de: '        await dire($, await lireFile($))\n\n        return { text: texteVidee(retirees) }', vers: '\n        return { text: texteVidee(retirees) }' },
  { nom: 'mod-regul-commande-vider-message', f: R, de: 'return { text: texteVidee(retirees) }', vers: "return { text: 'vidée' }" },
  { nom: 'mod-regul-commande-sans-depilage', f: R, de: '    await depiler($)\n\n    return { text: analyse.message }', vers: '    return { text: analyse.message }' },
  // démarrage
  { nom: 'mod-regul-demarrage-sans-minuterie', f: R, de: '    $.clock.every(PERIODE_MS, () => enFond(depiler($)))\n', vers: '' },
  { nom: 'mod-regul-minuterie-inerte', f: R, de: '$.clock.every(PERIODE_MS, () => enFond(depiler($)))', vers: '$.clock.every(PERIODE_MS, () => {})' },
  { nom: 'mod-regul-periode-longue', f: R, de: 'const PERIODE_MS = 30_000', vers: 'const PERIODE_MS = 60_000' },
  { nom: 'mod-regul-periode-courte', f: R, de: 'const PERIODE_MS = 30_000', vers: 'const PERIODE_MS = 15_000' },
  { nom: 'mod-regul-demarrage-sans-statut', f: R, de: '    try {\n      await dire($, await lireFile($))\n    } catch {\n      // le script de la file est introuvable ou en panne : pas de ligne de statut, le dépilage réessaie à chaque minuterie\n    }\n    enFond(depiler($))\n', vers: '    enFond(depiler($))\n' },
  { nom: 'mod-regul-demarrage-sans-depilage', f: R, de: '    enFond(depiler($))\n\n    return next(e)', vers: '\n    return next(e)' },
  // fichiers et statut
  { nom: 'mod-regul-file-fichier-faux', f: R, de: "const NOM_CLI_FILE = 'regulateur-file.js'", vers: "const NOM_CLI_FILE = 'regulateur-file2.js'" },
  { nom: 'mod-regul-agent-faux', f: R, de: "const AGENT = 'claude'", vers: "const AGENT = 'codex'" },
  { nom: 'mod-regul-file-bom-non-retire', f: R, de: 'if (r.exitCode !== 0 || r.isStdoutTruncated) throw', vers: 'if (r.exitCode !== 0) throw' },
  { nom: 'mod-regul-file-non-normalisee', f: R, de: 'return JSON.parse(r.stdout).value as T', vers: 'return JSON.parse(r.stdout) as T' },
  { nom: 'mod-regul-file-absente-bloque', f: R, de: '], { timeoutMs: 10_000 })', vers: '])' },
  { nom: 'mod-regul-ecriture-sans-heure', f: R, de: 'JSON.stringify({ operation, args })', vers: 'JSON.stringify({ args })' },
  { nom: 'mod-regul-ecriture-sans-heure-champ', f: R, de: 'JSON.stringify({ operation, args })', vers: 'JSON.stringify({ operation, args: [] })' },
  { nom: 'mod-regul-ecriture-reussie-dite-ratee', f: R, de: 'if (r.exitCode !== 0 || r.isStdoutTruncated) throw', vers: 'if (r.exitCode === 0 || r.isStdoutTruncated) throw' },
  { nom: 'mod-regul-ecriture-ratee-dite-reussie', f: R, de: "  if (r.exitCode !== 0 || r.isStdoutTruncated) throw new Error('Transaction de file impossible')\n", vers: '' },
  { nom: 'mod-regul-statut-agent', f: R, de: '$.ui.status(texteStatut(etat, AGENT, await $.session.id()))', vers: "$.ui.status(texteStatut(etat, 'codex', await $.session.id()))" },
  { nom: 'mod-regul-statut-session', f: R, de: '$.ui.status(texteStatut(etat, AGENT, await $.session.id()))', vers: "$.ui.status(texteStatut(etat, AGENT, 'autre'))" },
  { nom: 'mod-regul-statut-perdu', f: R, de: '$.ui.status(texteStatut(etat, AGENT, await $.session.id()))', vers: '$.ui.status(undefined)' },
  { nom: 'mod-regul-enfond-sans-catch', f: R, de: '  travail.catch(() => {})\n', vers: '  void travail\n' },
  { nom: 'mod-regul-informer-perdu', f: R, de: '  enFond($.prompt.submit({ text: texte }))', vers: '  void texte' },
  // La copie de la logique est exercée de bout en bout par le banc de la mod.
  { nom: 'mod-regul-logique-plafond-atteint', f: L, de: 'if (p.max !== null && n >= p.max) {', vers: 'if (p.max !== null && n > p.max) {' },
  { nom: 'mod-regul-logique-waiting-libre', f: L, de: "const STATUTS_OCCUPES = new Set(['pending', 'running', 'waiting']);", vers: "const STATUTS_OCCUPES = new Set(['pending', 'running']);" },
  { nom: 'mod-regul-logique-idle-occupe', f: L, de: "const STATUTS_OCCUPES = new Set(['pending', 'running', 'waiting']);", vers: "const STATUTS_OCCUPES = new Set(['pending', 'running', 'waiting', 'idle']);" },
  { nom: 'mod-regul-logique-rappel-stable', f: L, de: "Dès qu'un agent finit, lance le suivant de ta liste sans attendre ; si le maximum est atteint", vers: "Dès qu'un agent finit, lance le suivant ; si le maximum est atteint" },
  { nom: 'mod-regul-logique-file-en-file', f: L, de: 'mettreEnFile: p.file };', vers: 'mettreEnFile: false };' },
  // dossier d'état (emplacements-logique.mjs), script de la file (cheminScript) : le module les trouve, et leur absence est dite sans rien bloquer
  { nom: 'mod-regul-dossier-fichier-relatif', f: R, de: 'return `${await dossierEtat($)}/${nom}`', vers: 'return nom' },
  { nom: 'mod-regul-modeles-fichier-faux', f: R, de: "const NOM_MODELES = 'modeles-agents.json'", vers: "const NOM_MODELES = 'modeles-agents2.json'" },
  { nom: 'mod-regul-script-chemin-relatif', f: R, de: 'await cheminScript($, NOM_CLI_FILE)', vers: 'NOM_CLI_FILE' },
  { nom: 'mod-regul-dossier-commande-erreur-propagee', f: R, de: "    try {\n      fichierPolitique = await fichier($, NOM_FICHIER)\n    } catch (erreur) {\n      return { text: erreur instanceof Error ? erreur.message : String(erreur) }\n    }", vers: '    fichierPolitique = await fichier($, NOM_FICHIER)' },
  { nom: 'mod-regul-dossier-commande-message-perdu', f: R, de: 'return { text: erreur instanceof Error ? erreur.message : String(erreur) }', vers: "return { text: 'erreur' }" },
  { nom: 'mod-regul-demarrage-script-introuvable-propage', f: R, de: '    try {\n      await dire($, await lireFile($))\n    } catch {\n      // le script de la file est introuvable ou en panne : pas de ligne de statut, le dépilage réessaie à chaque minuterie\n    }', vers: '    await dire($, await lireFile($))' },
  { nom: 'mod-regul-vider-erreur-propagee', f: R, de: "      } catch (erreur) {\n        return { text: `Régulateur d'agents : la file n'a pas pu être vidée (${erreur instanceof Error ? erreur.message : String(erreur)}).` }\n      }", vers: '      } finally {\n      }' },
  { nom: 'mod-regul-vider-erreur-cause-perdue', f: R, de: "la file n'a pas pu être vidée (${erreur instanceof Error ? erreur.message : String(erreur)}).", vers: "la file n'a pas pu être vidée." },
];

executer({ mod: MOD, mutations: MUTATIONS, argv: process.argv.slice(2), concurrence: 4 })
  .then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
