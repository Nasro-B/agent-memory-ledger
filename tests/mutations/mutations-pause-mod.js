'use strict';
// Preuve par mutation du banc du module Pause (mods/pause/hooks/register.tsx et la copie de la logique).
//   node tests/mutations/mutations-pause-mod.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-pause-mod.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-pause-mod.js --liste         affiche les noms
//   node tests/mutations/mutations-pause-mod.js --ancres        vérifie sans lancer le moteur que chaque ancre existe une fois
// Variable : PAUSE_MOD (dossier du module, défaut : mods/pause du dépôt). Le moteur : voir tests/lib/mutations-mod.js (AML_MOTEUR_CLAUDE).
// Mutations équivalentes écartées (pour une cause établie en lisant le code) :
//   - retirer le `try ... finally` de `retenir` (`retenues -= 1` après la boucle) : aucune instruction de la boucle ne jette (`appeler` et
//     `lireJson` attrapent tout, `$.clock.now` et `$.ui.status` ne rejettent pas), le `finally` est une garde défensive ;
//   - remplacer `enFond(battre($))` par `void battre($)` (minuterie du battement, boucle d'attente) : `battre` ne rejette jamais (`fiche` et
//     `appeler` attrapent tout), aucun rejet n'est possible ;
//   - attendre le battement dans la boucle d'attente (`await battre($)`) : seul l'ordre des appels change, pas ce qui en sort ;
//   - la signature de redessin ne porte que le texte de la bande : l'état entier de l'atom ne se voit qu'à travers lui ;
//   - retirer la normalisation de l'état dans `rafraichir` (`normaliserEtat`) : la bande lit l'atom par `texteBande`, qui normalise elle-même ;
//     la normalisation de `rafraichir` ne sert qu'à garder l'atom conforme à son contrat (`PauseSuivi`).
// Mutations non observables par le banc (essayées, restées vertes pour une cause établie, À VÉRIFIER DANS LE VRAI MOTEUR) :
//   - faire jeter `lireJson` (ou `idSession`) au lieu de rendre `null` (ou `''`) : un hook qui jette est écarté par le moteur, qui exécute
//     l'étape ou l'outil à sa place, et le moteur de test n'en dit rien (l'échec n'est que « rapporté par son nom » dans une vraie session) ;
//     le résultat est donc identique. Effet réel : une ligne d'échec à chaque étape quand pause.json n'existe pas (le cas ordinaire) ;
//     un essai dans une vraie session doit donc chercher dans le journal de débogage du moteur qu'aucun hook du module n'a jeté ;
//   - retirer `!signal.aborted` de la boucle d'attente, ou ne plus passer `next.signal` à `retenir` (turn.step, tool.call) : le moteur de test
//     ne lève jamais `next.signal` (essayé : ni à la fermeture du flux, ni dix secondes plus tard, le hook est simplement
//     lâché et ses appels suivants n'aboutissent plus). Effet réel attendu : un processus du noyau par tranche de vingt secondes continue
//     après un Stop jusqu'à la fin de la pause. Non vérifié.
// Mutation équivalente par contrat du moteur (doc de StreamHookBody : « Returning nothing lets its last next(e)'s result stand ») :
//   - `return yield* next(e)` devenu `yield* next(e)` suivi d'un retour vide dans turn.step : le résultat de next(e) reste celui du hook.

const path = require('node:path');
const { executer } = require('../lib/mutations-mod.js');

const MOD = process.env.PAUSE_MOD || path.join(__dirname, '..', '..', 'mods', 'pause');
const R = 'hooks/register.tsx';
// L'échappement \uFEFF ne s'écrit pas tel quel dans un fichier passé par l'outil d'écriture (il y devient un caractère invisible).
const BOM = `${String.fromCharCode(92)}uFEFF`;
const m = (nom, de, vers) => ({ nom: `pm-${nom}`, f: R, de, vers });

const LIRE_BOM = `JSON.parse((await $.fs.read(chemin)).replace(/^${BOM}/, ''))`;
const DOSSIER_FIN = String.raw`chemin.replace(/[\\/]+$/, '')`;
const DOSSIER_SEP = String.raw`.split(/[\\/]/).pop() ?? ''`;
const COURT_ESPACES = String.raw`texte.replace(/\s+/g, ' ').trim()`;
const APPEL_NOYAU = "r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'pause-hook', operation], { stdin: JSON.stringify({ session: await idSession($), ...entree }), timeoutMs: delai })";
const REJET_NOYAU = '  } catch (e) {\n    return { valeur: {}, echec: `Pause : le noyau ne répond pas (${court(e instanceof Error ? e.message : String(e))}).` }\n  }';
const RETOUR_ECHEC_CODE = 'return { valeur: {}, echec: stderr === ';
const RETENIR_DEBUT = 'let attente = doitAttendre(await lireEtat($), session, agentId)\n  if (!attente.attendre) return';
const RELIRE_ATTENTE = '      attente = doitAttendre(await lireEtat($), session, agentId)\n    }';
const ATTENDRE_APPEL = "const r = await appeler($, 'attendre', { agentId, dureeMs: TRANCHE_MS }, DELAI_TRANCHE_MS)";
const STATUT_ATTENTE = '      $.ui.status(texteAttente(attente.cible, attente.depuis, await $.clock.now()))\n';
const DEM_PAUSE = "    await $.command.register({\n      name: 'pause',\n      description: \"Pause : retient cette session (ou une autre, un agent, toutes) avant sa prochaine étape ; Stop reste l'arrêt immédiat (/pause tout, session <id>, agent <nom>, agents, statut)\",\n      argumentHint: '[tout | session [id] | agent <nom> | agents | statut]',\n    })\n";
const DEM_REPRENDRE = "    await $.command.register({\n      name: 'reprendre',\n      description: \"Reprise : relance ce que /pause a retenu (/reprendre tout, session <id>, agent <nom>, agents, statut)\",\n      argumentHint: '[tout | session [id] | agent <nom> | agents | statut]',\n    })\n";
const MINUTERIE_LECTURE = '$.clock.every(PERIODE_LECTURE_MS, () => enFond(rafraichir($)))';
const MINUTERIE_BATTEMENT = '$.clock.every(PERIODE_BATTEMENT_MS, () => enFond(battre($)))';
const DEMARRAGE_BATTEMENT = 'enFond(battre($).then(() => rafraichir($)))';
const ETAPE = '    await retenir($, e.agentId, next.signal)\n\n    return yield* next(e)';
const OUTIL = '    await retenir($, e.agentId, next.signal)\n\n    return next(e)';
const BOUTON_PAUSE = '<Button key="pause" label="Pause" onPress={() => agir(\'pause\')} />';
const BOUTON_REPRENDRE = '<Button key="reprendre" label="Reprendre" onPress={() => agir(\'reprendre\')} />';
const TEXTE_BANDE = '{texte !== undefined && (\n            <Text dimColor wrap="truncate-end">\n              {texte}\n            </Text>\n          )}';

const MUTATIONS = [
  // constantes
  m('cli-chemin-faux', "const NOM_CLI = 'cockpit.js'", "const NOM_CLI = 'cockpit2.js'"),
  m('etat-chemin-faux', "const NOM_ETAT = 'pause.json'", "const NOM_ETAT = 'pause2.json'"),
  m('lecture-periode-longue', 'const PERIODE_LECTURE_MS = 10_000', 'const PERIODE_LECTURE_MS = 20_000'),
  m('lecture-periode-courte', 'const PERIODE_LECTURE_MS = 10_000', 'const PERIODE_LECTURE_MS = 5_000'),
  m('battement-periode-longue', 'const PERIODE_BATTEMENT_MS = 30_000', 'const PERIODE_BATTEMENT_MS = 60_000'),
  m('battement-periode-courte', 'const PERIODE_BATTEMENT_MS = 30_000', 'const PERIODE_BATTEMENT_MS = 15_000'),
  m('tranche-longue', 'const TRANCHE_MS = 20_000', 'const TRANCHE_MS = 25_000'),
  m('tranche-courte', 'const TRANCHE_MS = 20_000', 'const TRANCHE_MS = 15_000'),
  m('delai-tranche-court', 'const DELAI_TRANCHE_MS = TRANCHE_MS + 10_000', 'const DELAI_TRANCHE_MS = TRANCHE_MS + 5_000'),
  m('delai-tranche-long', 'const DELAI_TRANCHE_MS = TRANCHE_MS + 10_000', 'const DELAI_TRANCHE_MS = TRANCHE_MS + 20_000'),
  m('delai-noyau-court', 'const DELAI_NOYAU_MS = 20_000', 'const DELAI_NOYAU_MS = 10_000'),
  m('delai-noyau-long', 'const DELAI_NOYAU_MS = 20_000', 'const DELAI_NOYAU_MS = 30_000'),
  m('largeur-erreur-large', 'const LARGEUR_ERREUR = 160', 'const LARGEUR_ERREUR = 161'),
  m('largeur-erreur-etroite', 'const LARGEUR_ERREUR = 160', 'const LARGEUR_ERREUR = 159'),
  m('illisible-texte', "const ILLISIBLE = 'Pause : réponse illisible du noyau.'", "const ILLISIBLE = 'illisible'"),
  // enFond
  m('enfond-sans-catch', 'travail.catch(() => {})', 'void travail'),
  // court
  m('court-espaces-gardes', COURT_ESPACES, "texte.replace(/\\s+/g, '').trim()"),
  m('court-lignes-gardees', COURT_ESPACES, "texte.replace(/[ \\t]+/g, ' ').trim()"),
  m('court-trim-omis', COURT_ESPACES, "texte.replace(/\\s+/g, ' ')"),
  m('court-limite-inclusive', 't.length > LARGEUR_ERREUR ?', 't.length >= LARGEUR_ERREUR ?'),
  m('court-limite-jamais', 't.length > LARGEUR_ERREUR ?', 'false ?'),
  m('court-coupe-large', 't.slice(0, LARGEUR_ERREUR - 3)', 't.slice(0, LARGEUR_ERREUR - 2)'),
  m('court-coupe-courte', 't.slice(0, LARGEUR_ERREUR - 3)', 't.slice(0, LARGEUR_ERREUR - 4)'),
  m('court-sans-points', '`${t.slice(0, LARGEUR_ERREUR - 3)}...`', '`${t.slice(0, LARGEUR_ERREUR - 3)}`'),
  // lecture de la réponse du noyau
  m('lire-objet-null-non-gere', 'return (JSON.parse(texte) ?? {}) as Record<string, unknown>', 'return JSON.parse(texte) as Record<string, unknown>'),
  m('lire-objet-illisible-leve', '  } catch {\n    return {}\n  }\n}', '  } catch (e) {\n    throw e\n  }\n}'),
  m('lire-objet-illisible-faux', '  } catch {\n    return {}\n  }\n}', '  } catch {\n    return { enPause: true, message: \'x\' }\n  }\n}'),
  // identifiant de la session
  m('session-panne-inventee', "    return await $.session.id()\n  } catch {\n    return ''\n  }", "    return await $.session.id()\n  } catch {\n    return 'inconnue'\n  }"),
  m('session-panne-leve', "    return await $.session.id()\n  } catch {\n    return ''\n  }", '    return await $.session.id()\n  } catch (e) {\n    throw e\n  }'),
  // appel du noyau
  m('appeler-operation-fausse', "['node', await cheminScript($, NOM_CLI), 'pause-hook', operation]", "['node', await cheminScript($, NOM_CLI), 'pause-hook', 'battre']"),
  m('appeler-commande-fausse', "['node', await cheminScript($, NOM_CLI), 'pause-hook', operation]", "['node', await cheminScript($, NOM_CLI), 'pause', operation]"),
  m('appeler-session-perdue', '{ session: await idSession($), ...entree }', '{ ...entree }'),
  m('appeler-entree-perdue', '{ session: await idSession($), ...entree }', '{ session: await idSession($) }'),
  m('appeler-stdin-omis', APPEL_NOYAU, "r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'pause-hook', operation], { timeoutMs: delai })"),
  m('appeler-delai-omis', APPEL_NOYAU, "r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'pause-hook', operation], { stdin: JSON.stringify({ session: await idSession($), ...entree }) })"),
  m('appeler-delai-fixe', 'timeoutMs: delai })', 'timeoutMs: DELAI_NOYAU_MS })'),
  m('appeler-delai-defaut', 'delai = DELAI_NOYAU_MS', 'delai = DELAI_TRANCHE_MS'),
  m('appeler-rejet-propage', REJET_NOYAU, '  } catch (e) {\n    throw e\n  }'),
  m('appeler-rejet-sans-cause', '(${court(e instanceof Error ? e.message : String(e))}).', '().'),
  m('appeler-rejet-texte', 'Pause : le noyau ne répond pas (', 'Pause : panne ('),
  m('appeler-rejet-valeur', 'return { valeur: {}, echec: `Pause : le noyau ne répond pas (', "return { valeur: { enPause: true, message: 'x' }, echec: `Pause : le noyau ne répond pas ("),
  m('appeler-code-ignore', 'if (r.exitCode !== 0) {', 'if (false) {'),
  m('appeler-code-toujours', 'if (r.exitCode !== 0) {', 'if (true) {'),
  m('appeler-code-valeur', RETOUR_ECHEC_CODE, "return { valeur: { enPause: true, message: 'x' }, echec: stderr === "),
  m('appeler-stderr-brut', 'const stderr = court(r.stderr)', 'const stderr = r.stderr'),
  m('appeler-stderr-vide-ignore', "stderr === '' ? `Pause : code de sortie ${r.exitCode}.` : `Pause : ${stderr}`", '`Pause : ${stderr}`'),
  m('appeler-code-texte', '`Pause : code de sortie ${r.exitCode}.`', "'Pause : code de sortie.'"),
  m('appeler-stderr-prefixe-perdu', ': `Pause : ${stderr}` }', ': stderr }'),
  m('appeler-succes-echec', 'return { valeur: lireObjet(r.stdout), echec: null }', "return { valeur: lireObjet(r.stdout), echec: 'x' }"),
  // lecture du fichier du noyau
  m('lire-bom-non-retire', LIRE_BOM, 'JSON.parse(await $.fs.read(chemin))'),
  m('lire-abime-en-pause', '  } catch {\n    return null\n  }\n}', "  } catch {\n    return { sessions: { S1: { pause: true, depuis: '2026-03-04T04:57:00.000Z' } } }\n  }\n}"),
  // fiche de la session
  m('dossier-slash-final-garde', DOSSIER_FIN, 'chemin'),
  m('dossier-premier', DOSSIER_SEP, String.raw`.split(/[\\/]/).shift() ?? ''`),
  m('dossier-separateur-unique', DOSSIER_SEP, String.raw`.split(/\//).pop() ?? ''`),
  m('fiche-titre-omis', '    titre = dossierDe(await $.session.cwd())', "    titre = ''"),
  m('fiche-titre-panne-leve', "    // sans titre : le noyau garde celui qu'il connaît", "    throw new Error('titre')"),
  m('fiche-agents-panne-leve', '    // sans agents : la liste de la session se vide au prochain battement', "    throw new Error('agents')"),
  m('fiche-agent-nom-description', 'a.name ?? (a.description === \'\' ? a.type : a.description)', 'a.description'),
  m('fiche-agent-nom-type', 'a.name ?? (a.description === \'\' ? a.type : a.description)', 'a.type'),
  m('fiche-agent-nom-vide-ignore', "a.description === '' ? a.type : a.description", 'a.description'),
  m('fiche-agent-nom-name-ignore', 'a.name ?? (a.description === \'\' ? a.type : a.description)', "(a.description === '' ? a.type : a.description)"),
  m('fiche-agent-statut-perdu', 'statut: String(a.status)', "statut: ''"),
  m('fiche-agent-id-perdu', '({ id: a.id, nom:', '({ id: a.type, nom:'),
  m('fiche-agents-omis', 'return { titre, agents }', 'return { titre, agents: [] }'),
  m('fiche-titre-perdu', 'return { titre, agents }', "return { titre: '', agents }"),
  // battement
  m('battre-operation-fausse', "await appeler($, 'battre', await fiche($))", "await appeler($, 'commande', await fiche($))"),
  m('battre-fiche-perdue', "await appeler($, 'battre', await fiche($))", "await appeler($, 'battre', {})"),
  // relecture et ligne de statut
  m('rafraichir-session-perdue', '  const session = await idSession($)\n  const lu: PauseSuivi', "  const session = ''\n  const lu: PauseSuivi"),
  m('rafraichir-etat-ignore', 'texteBande(lu.etat, session,', 'texteBande(normaliserEtat(null), session,'),
  m('rafraichir-session-ignoree', 'texteBande(lu.etat, session,', "texteBande(lu.etat, 'autre',"),
  m('rafraichir-instant-faux', 'texteBande(lu.etat, session, await $.clock.now())', 'texteBande(lu.etat, session, 0)'),
  m('rafraichir-identique-ignore', "  if ((texte ?? '') === dernierTexte) return\n", ''),
  m('rafraichir-vide-distinct', "if ((texte ?? '') === dernierTexte) return", 'if (texte === dernierTexte) return'),
  m('rafraichir-dernier-omis', "  dernierTexte = texte ?? ''\n", ''),
  m('rafraichir-atom-omis', '  await update($, suivi, () => lu)\n', ''),
  m('rafraichir-atom-ancien', '  await update($, suivi, () => lu)\n', '  await update($, suivi, ancien => ancien ?? lu)\n'),
  m('rafraichir-statut-omis', '  if (retenues === 0) $.ui.status(texte)\n', ''),
  m('rafraichir-statut-pendant-attente', 'if (retenues === 0) $.ui.status(texte)', '$.ui.status(texte)'),
  m('rafraichir-statut-texte-perdu', 'if (retenues === 0) $.ui.status(texte)', 'if (retenues === 0) $.ui.status(undefined)'),
  // attente d'une boucle
  m('retenir-session-perdue', '  const session = await idSession($)\n  let attente', "  const session = ''\n  let attente"),
  m('retenir-fichier-faux', RETENIR_DEBUT, RETENIR_DEBUT.replace('await lireEtat($)', 'null')),
  m('retenir-agent-perdu', RETENIR_DEBUT, RETENIR_DEBUT.replace('session, agentId', 'session, undefined')),
  m('retenir-chemin-rapide-omis', '\n  if (!attente.attendre) return\n', '\n'),
  m('retenir-compteur-omis', '  retenues += 1\n', ''),
  m('retenir-compteur-fin-omis', '    retenues -= 1\n', ''),
  m('retenir-compteur-fin-double', 'retenues -= 1', 'retenues -= 2'),
  m('retenir-attente-ignoree', 'while (attente.attendre && !signal.aborted) {', 'while (!signal.aborted) {'),
  m('retenir-statut-omis', STATUT_ATTENTE, ''),
  m('retenir-statut-instant-faux', STATUT_ATTENTE, STATUT_ATTENTE.replace('await $.clock.now()', '0')),
  m('retenir-statut-depuis-perdu', STATUT_ATTENTE, STATUT_ATTENTE.replace('attente.depuis', 'null')),
  m('retenir-statut-cible-fausse', STATUT_ATTENTE, STATUT_ATTENTE.replace('attente.cible', "'session'")),
  m('retenir-operation-fausse', ATTENDRE_APPEL, ATTENDRE_APPEL.replace("'attendre'", "'battre'")),
  m('retenir-agent-non-transmis', ATTENDRE_APPEL, ATTENDRE_APPEL.replace('{ agentId, dureeMs', '{ dureeMs')),
  m('retenir-duree-omise', ATTENDRE_APPEL, ATTENDRE_APPEL.replace('{ agentId, dureeMs: TRANCHE_MS }', '{ agentId }')),
  m('retenir-duree-courte', ATTENDRE_APPEL, ATTENDRE_APPEL.replace('dureeMs: TRANCHE_MS', 'dureeMs: 1_000')),
  m('retenir-delai-omis', ATTENDRE_APPEL, ATTENDRE_APPEL.replace('{ agentId, dureeMs: TRANCHE_MS }, DELAI_TRANCHE_MS)', '{ agentId, dureeMs: TRANCHE_MS })')),
  m('retenir-sortie-non-true', 'if (r.valeur.enPause !== true) break', 'if (r.valeur.enPause === false) break'),
  m('retenir-sortie-omise', '      if (r.valeur.enPause !== true) break\n', ''),
  m('retenir-battement-omis', '      enFond(battre($))\n', ''),
  m('retenir-relecture-omise', RELIRE_ATTENTE, '    }'),
  m('retenir-relecture-agent-perdu', RELIRE_ATTENTE, RELIRE_ATTENTE.replace('session, agentId', 'session, undefined')),
  m('retenir-relecture-session-perdue', RELIRE_ATTENTE, RELIRE_ATTENTE.replace('session, agentId', "'', agentId")),
  m('retenir-texte-non-reinitialise', '  dernierTexte = null\n  enFond(rafraichir($))', '  enFond(rafraichir($))'),
  m('retenir-restauration-omise', '  dernierTexte = null\n  enFond(rafraichir($))\n}', '  dernierTexte = null\n}'),
  m('retenir-restauration-sans-enfond', '  dernierTexte = null\n  enFond(rafraichir($))', '  dernierTexte = null\n  void rafraichir($)'),
  // exécution d'une commande par le noyau
  m('exec-operation-fausse', "appeler($, 'commande', {", "appeler($, 'battre', {"),
  m('exec-sens-perdu', '{ sens, args: args.trim(), fiche: await fiche($) }', '{ args: args.trim(), fiche: await fiche($) }'),
  m('exec-sens-inverse', '{ sens, args: args.trim(), fiche: await fiche($) }', "{ sens: sens === 'pause' ? 'reprendre' : 'pause', args: args.trim(), fiche: await fiche($) }"),
  m('exec-args-perdus', 'args: args.trim()', "args: ''"),
  m('exec-args-non-rognes', 'args: args.trim()', 'args'),
  m('exec-fiche-perdue', 'fiche: await fiche($) }', 'fiche: {} }'),
  m('exec-echec-ignore', '  if (r.echec !== null) return r.echec\n', ''),
  m('exec-echec-texte-perdu', 'if (r.echec !== null) return r.echec', "if (r.echec !== null) return 'Pause : échec'"),
  m('exec-rafraichir-omis', '  await rafraichir($).catch(() => {})\n', ''),
  m('exec-rafraichir-sans-catch', 'await rafraichir($).catch(() => {})', 'await rafraichir($)'),
  m('exec-erreur-ignoree', "  if (typeof erreur === 'string') return erreur\n", ''),
  m('exec-erreur-texte-perdu', "if (typeof erreur === 'string') return erreur", "if (typeof erreur === 'string') return ILLISIBLE"),
  m('exec-message-non-string-ignore', "return typeof message === 'string' ? message : ILLISIBLE", 'return message as string'),
  m('exec-message-perdu', "return typeof message === 'string' ? message : ILLISIBLE", 'return ILLISIBLE'),
  // étape du modèle et outil
  m('etape-agent-perdu', ETAPE, ETAPE.replace('e.agentId', 'undefined')),
  m('etape-retenue-omise', ETAPE, '    return yield* next(e)'),
  m('etape-sans-next', ETAPE, "    await retenir($, e.agentId, next.signal)\n\n    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }"),
  m('outil-agent-perdu', OUTIL, OUTIL.replace('e.agentId', 'undefined')),
  m('outil-retenue-omise', OUTIL, '    return next(e)'),
  m('outil-sans-next', OUTIL, "    await retenir($, e.agentId, next.signal)\n\n    return { deny: 'pause' }"),
  // commandes
  m('cmd-pause-nom-faux', "on('command.run', { command: 'pause' }", "on('command.run', { command: 'pauses' }"),
  m('cmd-pause-args-perdus', "executer($, 'pause', e.args)", "executer($, 'pause', '')"),
  m('cmd-pause-sens-faux', "executer($, 'pause', e.args)", "executer($, 'reprendre', e.args)"),
  m('cmd-reprendre-nom-faux', "on('command.run', { command: 'reprendre' }", "on('command.run', { command: 'reprendres' }"),
  m('cmd-reprendre-args-perdus', "executer($, 'reprendre', e.args)", "executer($, 'reprendre', '')"),
  m('cmd-reprendre-sens-faux', "executer($, 'reprendre', e.args)", "executer($, 'pause', e.args)"),
  // bande au-dessus du prompt
  m('bande-composant-faux', "{ component: 'AbovePrompt' }", "{ component: 'PromptHint' }"),
  m('bande-dessous-perdu', '        {dessous}\n', ''),
  m('bande-sondage-ignore', '    if (e.props.hasSurvey) return dessous\n', ''),
  m('bande-sondage-inverse', 'if (e.props.hasSurvey) return dessous', 'if (!e.props.hasSurvey) return dessous'),
  m('bande-sondage-sans-dessous', 'if (e.props.hasSurvey) return dessous', "if (e.props.hasSurvey) return { type: 'Box', props: {}, children: [] }"),
  m('bande-atom-ignore', 'const lu = await read($, suivi)', 'const lu = null as PauseSuivi | null'),
  m('bande-instant-faux', 'texteBande(lu.etat, lu.session, await $.clock.now())', 'texteBande(lu.etat, lu.session, 0)'),
  m('bande-session-faux', 'texteBande(lu.etat, lu.session,', "texteBande(lu.etat, '',"),
  m('bande-texte-toujours', TEXTE_BANDE, TEXTE_BANDE.replace('{texte !== undefined && (', '{(')),
  m('bande-texte-jamais', TEXTE_BANDE, TEXTE_BANDE.replace('{texte !== undefined && (', '{false && (')),
  m('bande-texte-pas-discret', TEXTE_BANDE, TEXTE_BANDE.replace('<Text dimColor wrap', '<Text wrap')),
  m('bande-texte-sans-troncature', TEXTE_BANDE, TEXTE_BANDE.replace(' wrap="truncate-end"', '')),
  m('bande-colonne-omise', '<Box flexDirection="column">\n        {dessous}', '<Box>\n        {dessous}'),
  m('bande-pause-cle-fausse', BOUTON_PAUSE, BOUTON_PAUSE.replace('key="pause"', 'key="pause2"')),
  m('bande-pause-libelle-faux', BOUTON_PAUSE, BOUTON_PAUSE.replace('label="Pause"', 'label="Arrêter"')),
  m('bande-pause-sens-faux', BOUTON_PAUSE, BOUTON_PAUSE.replace("agir('pause')", "agir('reprendre')")),
  m('bande-pause-vide', BOUTON_PAUSE, BOUTON_PAUSE.replace("onPress={() => agir('pause')}", 'onPress={() => {}}')),
  m('bande-pause-omis', `          ${BOUTON_PAUSE}\n`, ''),
  m('bande-reprendre-cle-fausse', BOUTON_REPRENDRE, BOUTON_REPRENDRE.replace('key="reprendre"', 'key="reprendre2"')),
  m('bande-reprendre-libelle-faux', BOUTON_REPRENDRE, BOUTON_REPRENDRE.replace('label="Reprendre"', 'label="Relancer"')),
  m('bande-reprendre-sens-faux', BOUTON_REPRENDRE, BOUTON_REPRENDRE.replace("agir('reprendre')", "agir('pause')")),
  m('bande-reprendre-vide', BOUTON_REPRENDRE, BOUTON_REPRENDRE.replace("onPress={() => agir('reprendre')}", 'onPress={() => {}}')),
  m('bande-reprendre-omis', `          ${BOUTON_REPRENDRE}\n`, ''),
  m('bande-toast-omis', "      $.ui.toast(await executer($, sens, ''))", "      await executer($, sens, '')"),
  m('bande-agir-args', "executer($, sens, '')", "executer($, sens, 'tout')"),
  m('bande-agir-sens-fixe', "executer($, sens, '')", "executer($, 'pause', '')"),
  // démarrage
  m('demarrage-pause-omise', DEM_PAUSE, ''),
  m('demarrage-reprendre-omise', DEM_REPRENDRE, ''),
  m('demarrage-pause-nom-faux', "      name: 'pause',", "      name: 'pauses',"),
  m('demarrage-reprendre-nom-faux', "      name: 'reprendre',", "      name: 'reprendres',"),
  m('demarrage-pause-description-faux', 'description: "Pause : retient cette session', 'description: "Retient cette session'),
  m('demarrage-reprendre-description-faux', 'description: "Reprise : relance ce que', 'description: "Relance ce que'),
  m('demarrage-pause-hint-omis', DEM_PAUSE, DEM_PAUSE.replace("      argumentHint: '[tout | session [id] | agent <nom> | agents | statut]',\n", '')),
  m('demarrage-reprendre-hint-omis', DEM_REPRENDRE, DEM_REPRENDRE.replace("      argumentHint: '[tout | session [id] | agent <nom> | agents | statut]',\n", '')),
  m('demarrage-pause-hint-faux', DEM_PAUSE, DEM_PAUSE.replace("'[tout | session [id] | agent <nom> | agents | statut]'", "'[tout]'")),
  m('demarrage-reprendre-hint-faux', DEM_REPRENDRE, DEM_REPRENDRE.replace("'[tout | session [id] | agent <nom> | agents | statut]'", "'[tout]'")),
  m('demarrage-lecture-omise', `    ${MINUTERIE_LECTURE}\n`, ''),
  m('demarrage-lecture-vide', MINUTERIE_LECTURE, '$.clock.every(PERIODE_LECTURE_MS, () => {})'),
  m('demarrage-lecture-sans-enfond', MINUTERIE_LECTURE, '$.clock.every(PERIODE_LECTURE_MS, () => { void rafraichir($) })'),
  m('demarrage-battement-minuterie-omise', `    ${MINUTERIE_BATTEMENT}\n`, ''),
  m('demarrage-battement-minuterie-vide', MINUTERIE_BATTEMENT, '$.clock.every(PERIODE_BATTEMENT_MS, () => {})'),
  m('demarrage-battement-omis', `    ${DEMARRAGE_BATTEMENT}\n`, ''),
  m('demarrage-rafraichir-omis', DEMARRAGE_BATTEMENT, 'enFond(battre($))'),
  m('demarrage-sans-enfond', DEMARRAGE_BATTEMENT, 'void battre($).then(() => rafraichir($))'),
  m('demarrage-sans-next', '    return next(e)\n  })\n\n  // Avant chaque requête', '    return { cwd: e.cwd }\n  })\n\n  // Avant chaque requête'),
  // dossier d'état (emplacements-logique.mjs) et script du noyau (cheminScript) : le module les trouve, et leur absence ne retient personne
  m('dossier-etat-relatif', '`${await dossierEtat($)}/${NOM_ETAT}`', 'NOM_ETAT'),
  m('dossier-etat-panne-retient', '  } catch {\n    return undefined\n  }', "  } catch {\n    return { sessions: { S1: { pause: true, depuis: '2026-03-04T04:57:00.000Z' } } }\n  }"),
  m('script-chemin-relatif', 'await cheminScript($, NOM_CLI)', 'NOM_CLI'),
];

executer({ mod: MOD, mutations: MUTATIONS, argv: process.argv.slice(2), concurrence: 3 })
  .then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
