'use strict';
// Preuve par mutation du banc du module Nuit (mods/nuit/hooks/register.tsx et la copie de la logique).
//   node tests/mutations/mutations-nuit-mod.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-nuit-mod.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-nuit-mod.js --liste         affiche les noms
//   node tests/mutations/mutations-nuit-mod.js --ancres        vérifie sans lancer le moteur que chaque ancre existe une fois
// Variable : NUIT_MOD (dossier du module, défaut : mods/nuit du dépôt). Le moteur : voir tests/lib/mutations-mod.js (AML_MOTEUR_CLAUDE).
// Mutations équivalentes écartées (essayées, restées vertes pour une cause établie) :
//   - le moteur écarte un texte qui n'en est pas un (résultat `deny`, prompt, `text` de type nombre) : retirer `typeof ... !== 'string'`
//     de `refus`, `enchainer` ou `executer` ne change rien d'observable ; le contrôle reste dans la mod, qui ne s'appuie pas sur le moteur ;
//   - le moteur écarte un prompt vide (`$.prompt.submit({ text: '' })` n'arrive pas au bas de la chaîne) : retirer `!== ''` d'`enchainer`
//     ou d'`executer` ne change rien d'observable ;
//   - le moteur écarte une section de prompt dont le texte est nul (déjà noté pour la mod Consignes) : `return false ? composition : ...` ;
//   - aucune autre ligne du récap ne commence par « À » : le préfixe `À décider (` pourrait être plus court sans effet ;
//   - la boîte n'a aucun effet sur les lignes du récap que le panneau dessine (il en retire la liste « À décider » et la ligne « Rien à décider ») :
//     `texteRecap(lu.etat, normaliserBoite(null), ...)` ne change rien d'observable (mutation nm-pane-recap-boite-ignoree de la source, essayée et verte) ;
// Protection contre un rejet après le déchargement (`enFond` sans `.catch`) : observable par un test
// qui refuse l'écriture de l'état PENDANT le test (« no hooks module of that name is loaded ») ; le rejet réel d'une action encore en vol
// à la fin du fichier n'est pas déterministe (il dépend de la vitesse du runner), il ne sert donc pas de preuve.
// Supprimées par simplification du code : tout test de `ok` (l'appel du noyau rend toujours un objet, vide en cas d'échec) et la
// validation d'objet de la réponse (tout ce qui n'est pas un objet se lit comme un objet sans les clés cherchées).

const path = require('node:path');
const { executer } = require('../lib/mutations-mod.js');

const MOD = process.env.NUIT_MOD || path.join(__dirname, '..', '..', 'mods', 'nuit');
const R = 'hooks/register.tsx';
// L'échappement \uFEFF ne s'écrit pas tel quel dans un fichier passé par l'outil d'écriture (il y devient un caractère invisible).
const BOM = `${String.fromCharCode(92)}uFEFF`;

const LIRE_BOM = `JSON.parse((await $.fs.read(chemin)).replace(/^${BOM}/, ''))`;
const SOUMETTRE = '$.clock.after(0, () => enFond($.prompt.submit({ text })))';
const OUVRIR_REVEIL = "    await $.ui.open({ id: PANNEAU, title: 'Nuit' })\n\n    return next({ ...e";
const OUVRIR_CMD = "if (ouvrir) await $.ui.open({ id: PANNEAU, title: 'Nuit' })";
const QUESTION_FIN = "    const texte = await refus($, 'question', { tool_input: { questions: e.questions } })\n\n    return texte === undefined ? next(e) : { deny: texte }";
const garde = tool => `on('tool.call', { tool: '${tool}' }, async ($, e, next) => {\n    const texte = await refusGarde($, '${tool}', e.command)\n\n    return texte === undefined ? next(e) : { deny: texte }`;
const BASH = garde('Bash');
const PS = garde('PowerShell');
const RETOUR_REFUS = 'return texte === undefined ? next(e) : { deny: texte }';
const BOUTON_OPTION = "<Button key={`rep-${active.id}-${i}`} label={option.label} onPress={() => decider(active.id, option.label, '')} />";
const BOUTON_ECARTER = '<Button key={`ecarter-${active.id}`} label="Écarter" onPress={() => ecarter(active.id)} />';
const TITRE_QUESTION = '<Text bold>{`${active.id}. [${active.type}${lotDe(active)}] ${active.titre}`}</Text>';
const ENTETE_ATTENTE = '{comptes && <Text bold>{`${comptes.attente} à traiter, ${comptes.traitees} en historique`}</Text>}';
const DEMARRAGE_COMMANDE = "    await $.command.register({\n      name: 'nuit',\n      description: \"Nuit : questions en boîte, arrêts de garde en refus avec alternative, enchaînement des lignes du ledger, récap au réveil (/nuit on, off, statut, recap, boite, ...)\",\n      argumentHint: '[on | off | statut | recap | boite | ...]',\n    })\n";

const MUTATIONS = [
  // constantes
  { nom: 'nm-cli-chemin-faux', f: R, de: "const NOM_CLI = 'cockpit.js'", vers: "const NOM_CLI = 'cockpit2.js'" },
  { nom: 'nm-etat-chemin-faux', f: R, de: "const NOM_ETAT = 'nuit.json'", vers: "const NOM_ETAT = 'nuit2.json'" },
  { nom: 'nm-boite-chemin-faux', f: R, de: "const NOM_BOITE = 'nuit-boite.json'", vers: "const NOM_BOITE = 'nuit-boite2.json'" },
  { nom: 'nm-agent-faux', f: R, de: "const AGENT = 'claude'", vers: "const AGENT = 'codex'" },
  { nom: 'nm-panneau-id-faux', f: R, de: "const PANNEAU = 'nuit'", vers: "const PANNEAU = 'nuit2'" },
  { nom: 'nm-periode-faux', f: R, de: 'const PERIODE_MS = 60_000', vers: 'const PERIODE_MS = 120_000' },
  { nom: 'nm-delai-noyau-faux', f: R, de: 'const DELAI_NOYAU_MS = 20_000', vers: 'const DELAI_NOYAU_MS = 10_000' },
  { nom: 'nm-largeur-erreur-faux', f: R, de: 'const LARGEUR_ERREUR = 160', vers: 'const LARGEUR_ERREUR = 161' },
  { nom: 'nm-origine-bridge-omise', f: R, de: "= ['composer', 'bridge']", vers: "= ['composer']" },
  { nom: 'nm-origine-composer-omise', f: R, de: "= ['composer', 'bridge']", vers: "= ['bridge']" },
  { nom: 'nm-origine-plugin-ajoutee', f: R, de: "= ['composer', 'bridge']", vers: "= ['composer', 'bridge', 'plugin']" },
  { nom: 'nm-origine-notification-ajoutee', f: R, de: "= ['composer', 'bridge']", vers: "= ['composer', 'bridge', 'task-notification']" },
  { nom: 'nm-panneau-recap-omis', f: R, de: "= ['boite', 'recap']", vers: "= ['boite']" },
  { nom: 'nm-panneau-boite-omis', f: R, de: "= ['boite', 'recap']", vers: "= ['recap']" },
  { nom: 'nm-panneau-statut-ajoute', f: R, de: "= ['boite', 'recap']", vers: "= ['boite', 'recap', 'statut']" },
  { nom: 'nm-regex-espaces-omis', f: R, de: 'const COMMANDE_NUIT = /^\\s*\\/nuit(\\s|$)/i', vers: 'const COMMANDE_NUIT = /^\\/nuit(\\s|$)/i' },
  { nom: 'nm-regex-casse', f: R, de: 'const COMMANDE_NUIT = /^\\s*\\/nuit(\\s|$)/i', vers: 'const COMMANDE_NUIT = /^\\s*\\/nuit(\\s|$)/' },
  { nom: 'nm-regex-fin-omise', f: R, de: 'const COMMANDE_NUIT = /^\\s*\\/nuit(\\s|$)/i', vers: 'const COMMANDE_NUIT = /^\\s*\\/nuit/i' },
  { nom: 'nm-regex-debut-omis', f: R, de: 'const COMMANDE_NUIT = /^\\s*\\/nuit(\\s|$)/i', vers: 'const COMMANDE_NUIT = /\\/nuit(\\s|$)/i' },
  { nom: 'nm-illisible-texte', f: R, de: "const ILLISIBLE = 'Nuit : réponse illisible du noyau.'", vers: "const ILLISIBLE = 'illisible'" },
  // enFond et soumettre
  { nom: 'nm-enfond-sans-catch', f: R, de: 'travail.catch(() => {})', vers: 'void travail' },
  { nom: 'nm-soumettre-sans-enfond', f: R, de: '$.clock.after(0, () => enFond($.prompt.submit({ text })))', vers: '$.clock.after(0, () => { void $.prompt.submit({ text }) })' },
  { nom: 'nm-soumettre-direct', f: R, de: SOUMETTRE, vers: '{ enFond($.prompt.submit({ text })) }' },
  { nom: 'nm-soumettre-delai-long', f: R, de: '$.clock.after(0, ', vers: '$.clock.after(3_600_000, ' },
  { nom: 'nm-soumettre-texte-perdu', f: R, de: '$.prompt.submit({ text })', vers: "$.prompt.submit({ text: '' })" },
  { nom: 'nm-soumettre-comme-utilisateur', f: R, de: '$.prompt.submit({ text })', vers: '$.prompt.submit({ text, asUser: true })' },
  // court
  { nom: 'nm-court-espaces-gardes', f: R, de: "texte.replace(/\\s+/g, ' ').trim()", vers: "texte.replace(/\\s+/g, '').trim()" },
  { nom: 'nm-court-lignes-gardees', f: R, de: "texte.replace(/\\s+/g, ' ').trim()", vers: "texte.replace(/[ \\t]+/g, ' ').trim()" },
  { nom: 'nm-court-trim-omis', f: R, de: "texte.replace(/\\s+/g, ' ').trim()", vers: "texte.replace(/\\s+/g, ' ')" },
  { nom: 'nm-court-limite-inclusive', f: R, de: 't.length > LARGEUR_ERREUR ?', vers: 't.length >= LARGEUR_ERREUR ?' },
  { nom: 'nm-court-limite-jamais', f: R, de: 't.length > LARGEUR_ERREUR ?', vers: 'false ?' },
  { nom: 'nm-court-coupe-large', f: R, de: 't.slice(0, LARGEUR_ERREUR - 3)', vers: 't.slice(0, LARGEUR_ERREUR - 2)' },
  { nom: 'nm-court-coupe-courte', f: R, de: 't.slice(0, LARGEUR_ERREUR - 3)', vers: 't.slice(0, LARGEUR_ERREUR - 4)' },
  { nom: 'nm-court-sans-points', f: R, de: '`${t.slice(0, LARGEUR_ERREUR - 3)}...`', vers: '`${t.slice(0, LARGEUR_ERREUR - 3)}`' },
  // appel du noyau
  { nom: 'nm-appeler-operation-fausse', f: R, de: "['node', await cheminScript($, NOM_CLI), 'nuit-hook', operation]", vers: "['node', await cheminScript($, NOM_CLI), 'nuit-hook', 'activite']" },
  { nom: 'nm-appeler-commande-fausse', f: R, de: "['node', await cheminScript($, NOM_CLI), 'nuit-hook', operation]", vers: "['node', await cheminScript($, NOM_CLI), 'nuit', operation]" },
  { nom: 'nm-appeler-agent-perdu', f: R, de: '{ agent: AGENT, session: await $.session.id(), ...entree }', vers: '{ session: await $.session.id(), ...entree }' },
  { nom: 'nm-appeler-session-perdue', f: R, de: '{ agent: AGENT, session: await $.session.id(), ...entree }', vers: '{ agent: AGENT, ...entree }' },
  { nom: 'nm-appeler-entree-perdue', f: R, de: '{ agent: AGENT, session: await $.session.id(), ...entree }', vers: '{ agent: AGENT, session: await $.session.id() }' },
  { nom: 'nm-appeler-stdin-omis', f: R, de: '{ stdin: JSON.stringify({ agent: AGENT, session: await $.session.id(), ...entree }), timeoutMs: DELAI_NOYAU_MS }', vers: '{ timeoutMs: DELAI_NOYAU_MS }' },
  { nom: 'nm-appeler-delai-omis', f: R, de: '...entree }), timeoutMs: DELAI_NOYAU_MS })', vers: '...entree }) })' },
  { nom: 'nm-appeler-rejet-propage', f: R, de: '  } catch (e) {\n    return { valeur: {}, echec: `Nuit : le noyau ne répond pas (${court(e instanceof Error ? e.message : String(e))}).` }\n  }', vers: '  } catch (e) {\n    throw e\n  }' },
  { nom: 'nm-appeler-rejet-sans-cause', f: R, de: '(${court(e instanceof Error ? e.message : String(e))}).', vers: '().' },
  { nom: 'nm-appeler-rejet-texte', f: R, de: 'Nuit : le noyau ne répond pas (', vers: 'Nuit : panne (' },
  { nom: 'nm-appeler-code-ignore', f: R, de: 'if (r.exitCode !== 0) {', vers: 'if (false) {' },
  { nom: 'nm-appeler-code-toujours', f: R, de: 'if (r.exitCode !== 0) {', vers: 'if (true) {' },
  { nom: 'nm-appeler-stderr-brut', f: R, de: 'const stderr = court(r.stderr)', vers: 'const stderr = r.stderr' },
  { nom: 'nm-appeler-stderr-vide-ignore', f: R, de: "stderr === '' ? `Nuit : code de sortie ${r.exitCode}.` : `Nuit : ${stderr}`", vers: '`Nuit : ${stderr}`' },
  { nom: 'nm-appeler-code-texte', f: R, de: '`Nuit : code de sortie ${r.exitCode}.`', vers: "'Nuit : code de sortie.'" },
  { nom: 'nm-appeler-stderr-prefixe-perdu', f: R, de: ': `Nuit : ${stderr}` }', vers: ': stderr }' },
  // lecture des fichiers
  { nom: 'nm-lire-bom-non-retire', f: R, de: LIRE_BOM, vers: 'JSON.parse(await $.fs.read(chemin))' },
  { nom: 'nm-lire-abime-leve', f: R, de: '  } catch {\n    return null\n  }\n}\n\nasync function nuitActive', vers: '  } catch (e) {\n    throw e\n  }\n}\n\nasync function nuitActive' },
  { nom: 'nm-active-flag-seul', f: R, de: 'return estActive(await lireNuit($, NOM_ETAT), await $.clock.now())', vers: 'return normaliserEtat(await lireNuit($, NOM_ETAT)).actif' },
  { nom: 'nm-active-instant-faux', f: R, de: 'estActive(await lireNuit($, NOM_ETAT), await $.clock.now())', vers: 'estActive(await lireNuit($, NOM_ETAT), 0)' },
  { nom: 'nm-active-toujours', f: R, de: 'return estActive(await lireNuit($, NOM_ETAT), await $.clock.now())', vers: 'return true' },
  { nom: 'nm-active-jamais', f: R, de: 'return estActive(await lireNuit($, NOM_ETAT), await $.clock.now())', vers: 'return false' },
  { nom: 'nm-active-chemin-faux', f: R, de: 'estActive(await lireNuit($, NOM_ETAT)', vers: 'estActive(await lireNuit($, NOM_BOITE)' },
  // relecture et ligne de statut
  { nom: 'nm-rafraichir-etat-chemin-faux', f: R, de: 'etat: normaliserEtat(await lireNuit($, NOM_ETAT))', vers: 'etat: normaliserEtat(await lireNuit($, NOM_BOITE))' },
  { nom: 'nm-rafraichir-boite-chemin-faux', f: R, de: 'boite: normaliserBoite(await lireNuit($, NOM_BOITE))', vers: 'boite: normaliserBoite(await lireNuit($, NOM_ETAT))' },
  { nom: 'nm-rafraichir-etat-brut', f: R, de: 'etat: normaliserEtat(await lireNuit($, NOM_ETAT))', vers: "etat: (await lireNuit($, NOM_ETAT)) as NuitSuivi['etat']" },
  { nom: 'nm-rafraichir-boite-brute', f: R, de: 'boite: normaliserBoite(await lireNuit($, NOM_BOITE))', vers: "boite: (await lireNuit($, NOM_BOITE)) as NuitSuivi['boite']" },
  { nom: 'nm-rafraichir-atom-omis', f: R, de: '  await update($, suivi, () => lu)\n', vers: '' },
  { nom: 'nm-rafraichir-atom-ancien', f: R, de: '  await update($, suivi, () => lu)\n', vers: '  await update($, suivi, ancien => ancien ?? lu)\n' },
  { nom: 'nm-rafraichir-statut-omis', f: R, de: '  $.ui.status(texteBande(lu.etat, lu.boite, await $.clock.now()))\n', vers: '' },
  { nom: 'nm-rafraichir-statut-instant-faux', f: R, de: 'texteBande(lu.etat, lu.boite, await $.clock.now())', vers: 'texteBande(lu.etat, lu.boite, 0)' },
  { nom: 'nm-rafraichir-statut-sans-boite', f: R, de: '$.ui.status(texteBande(lu.etat, lu.boite, ', vers: '$.ui.status(texteBande(lu.etat, normaliserBoite(null), ' },
  { nom: 'nm-rafraichir-statut-sans-etat', f: R, de: '$.ui.status(texteBande(lu.etat, lu.boite, ', vers: '$.ui.status(texteBande(normaliserEtat(null), lu.boite, ' },
  // refus silencieux (question, garde)
  { nom: 'nm-refus-operation-perdue', f: R, de: 'const r = await appeler($, operation, entree)', vers: "const r = await appeler($, 'activite', entree)" },
  { nom: 'nm-refus-entree-perdue', f: R, de: 'const r = await appeler($, operation, entree)', vers: 'const r = await appeler($, operation, {})' },
  { nom: 'nm-refus-non-true', f: R, de: 'const r = await appeler($, operation, entree)\n  if (r.valeur.refuser !== true || ', vers: 'const r = await appeler($, operation, entree)\n  if (' },
  { nom: 'nm-refus-texte-vide', f: R, de: "const r = await appeler($, operation, entree)\n  if (r.valeur.refuser !== true || typeof r.valeur.texte !== 'string' || r.valeur.texte === ''", vers: "const r = await appeler($, operation, entree)\n  if (r.valeur.refuser !== true || typeof r.valeur.texte !== 'string'" },
  { nom: 'nm-refus-rafraichir-omis', f: R, de: 'return undefined\n  await rafraichir($)\n\n  return r.valeur.texte\n}\n\nasync function refusGarde', vers: 'return undefined\n\n  return r.valeur.texte\n}\n\nasync function refusGarde' },
  { nom: 'nm-refus-texte-perdu', f: R, de: '  return r.valeur.texte\n}\n\nasync function refusGarde', vers: "  return 'refus'\n}\n\nasync function refusGarde" },
  // garde de sécurité (Bash, PowerShell)
  { nom: 'nm-garde-chemin-rapide-omis', f: R, de: '  if (!(await nuitActive($))) return undefined\n', vers: '' },
  { nom: 'nm-garde-operation-fausse', f: R, de: "appeler($, 'garde', {", vers: "appeler($, 'question', {" },
  { nom: 'nm-garde-outil-perdu', f: R, de: '{ tool_name: tool, tool_input: { command: commande }, ...(', vers: "{ tool_name: 'Bash', tool_input: { command: commande }, ...(" },
  { nom: 'nm-garde-commande-perdue', f: R, de: '{ tool_name: tool, tool_input: { command: commande }, ...(', vers: "{ tool_name: tool, tool_input: { command: '' }, ...(" },
  { nom: 'nm-garde-commande-cle-fausse', f: R, de: 'tool_input: { command: commande }', vers: 'tool_input: { cmd: commande }' },
  { nom: 'nm-garde-outil-cle-fausse', f: R, de: 'tool_name: tool,', vers: 'tool: tool,' },
  { nom: 'nm-garde-tool-nom-cle-fausse', f: R, de: 'tool_input: { command: commande }', vers: 'input: { command: commande }' },
  { nom: 'nm-bash-non-garde', f: R, de: BASH, vers: BASH.replace("{ tool: 'Bash' }", "{ tool: 'Bash2' }") },
  { nom: 'nm-bash-outil-faux', f: R, de: BASH, vers: BASH.replace("refusGarde($, 'Bash'", "refusGarde($, 'PowerShell'") },
  { nom: 'nm-bash-commande-perdue', f: R, de: BASH, vers: BASH.replace('e.command', "''") },
  { nom: 'nm-bash-refus-ignore', f: R, de: BASH, vers: BASH.replace(RETOUR_REFUS, 'return next(e)') },
  { nom: 'nm-bash-tout-refuse', f: R, de: BASH, vers: BASH.replace(RETOUR_REFUS, "return { deny: texte ?? 'non' }") },
  { nom: 'nm-bash-texte-perdu', f: R, de: BASH, vers: BASH.replace(RETOUR_REFUS, "return texte === undefined ? next(e) : { deny: 'refus' }") },
  { nom: 'nm-powershell-non-garde', f: R, de: PS, vers: PS.replace("{ tool: 'PowerShell' }", "{ tool: 'PowerShell2' }") },
  { nom: 'nm-powershell-outil-faux', f: R, de: PS, vers: PS.replace("refusGarde($, 'PowerShell'", "refusGarde($, 'Bash'") },
  { nom: 'nm-powershell-commande-perdue', f: R, de: PS, vers: PS.replace('e.command', "''") },
  { nom: 'nm-powershell-refus-ignore', f: R, de: PS, vers: PS.replace(RETOUR_REFUS, 'return next(e)') },
  { nom: 'nm-powershell-tout-refuse', f: R, de: PS, vers: PS.replace(RETOUR_REFUS, "return { deny: texte ?? 'non' }") },
  { nom: 'nm-powershell-texte-perdu', f: R, de: PS, vers: PS.replace(RETOUR_REFUS, "return texte === undefined ? next(e) : { deny: 'refus' }") },
  // question refusée (AskUserQuestion)
  { nom: 'nm-question-non-gardee', f: R, de: "on('tool.call', { tool: 'AskUserQuestion' }", vers: "on('tool.call', { tool: 'AskUserQuestion2' }" },
  { nom: 'nm-question-chemin-rapide-omis', f: R, de: "    if (!(await nuitActive($))) return next(e)\n    const texte = await refus($, 'question'", vers: "    const texte = await refus($, 'question'" },
  { nom: 'nm-question-operation-fausse', f: R, de: "refus($, 'question', ", vers: "refus($, 'garde', " },
  { nom: 'nm-question-questions-perdues', f: R, de: '{ tool_input: { questions: e.questions } }', vers: '{ tool_input: { questions: [] } }' },
  { nom: 'nm-question-entree-cle-fausse', f: R, de: '{ tool_input: { questions: e.questions } }', vers: '{ tool_input: e.questions }' },
  { nom: 'nm-question-refus-ignore', f: R, de: QUESTION_FIN, vers: QUESTION_FIN.replace(RETOUR_REFUS, 'return next(e)') },
  { nom: 'nm-question-tout-refuse', f: R, de: QUESTION_FIN, vers: QUESTION_FIN.replace(RETOUR_REFUS, "return { deny: texte ?? 'non' }") },
  { nom: 'nm-question-texte-perdu', f: R, de: QUESTION_FIN, vers: QUESTION_FIN.replace(RETOUR_REFUS, "return texte === undefined ? next(e) : { deny: 'refus' }") },
  // message de l'utilisateur et réveil
  { nom: 'nm-submit-origine-ignoree', f: R, de: '!ORIGINES_UTILISATEUR.includes(e.origin.kind) || ', vers: '' },
  { nom: 'nm-submit-origine-inversee', f: R, de: '!ORIGINES_UTILISATEUR.includes(e.origin.kind)', vers: 'ORIGINES_UTILISATEUR.includes(e.origin.kind)' },
  { nom: 'nm-submit-commande-ignoree', f: R, de: ' || COMMANDE_NUIT.test(e.text)', vers: '' },
  { nom: 'nm-submit-operation-fausse', f: R, de: "appeler($, 'activite', {})", vers: "appeler($, 'continuer', {})" },
  { nom: 'nm-submit-reveil-non-true', f: R, de: 'r.valeur.reveil !== true || ', vers: '' },
  { nom: 'nm-submit-recap-non-string', f: R, de: "typeof r.valeur.recap !== 'string' || r.valeur.recap === ''", vers: "r.valeur.recap === ''" },
  { nom: 'nm-submit-recap-vide', f: R, de: "typeof r.valeur.recap !== 'string' || r.valeur.recap === ''", vers: "typeof r.valeur.recap !== 'string'" },
  { nom: 'nm-submit-toast-omis', f: R, de: "    $.ui.toast('Nuit terminée : le récap est dans le panneau Nuit (/nuit recap).')\n", vers: '' },
  { nom: 'nm-submit-toast-texte', f: R, de: "$.ui.toast('Nuit terminée : le récap est dans le panneau Nuit (/nuit recap).')", vers: "$.ui.toast('Nuit terminée.')" },
  { nom: 'nm-submit-rafraichir-omis', f: R, de: "    await rafraichir($)\n    await $.ui.open({ id: PANNEAU, title: 'Nuit' })\n\n    return next({ ...e", vers: "    await $.ui.open({ id: PANNEAU, title: 'Nuit' })\n\n    return next({ ...e" },
  { nom: 'nm-submit-ouverture-omise', f: R, de: OUVRIR_REVEIL, vers: '\n    return next({ ...e' },
  { nom: 'nm-submit-titre-faux', f: R, de: OUVRIR_REVEIL, vers: OUVRIR_REVEIL.replace("title: 'Nuit'", "title: 'Autre'") },
  { nom: 'nm-submit-panneau-faux', f: R, de: OUVRIR_REVEIL, vers: OUVRIR_REVEIL.replace('id: PANNEAU', "id: 'autre'") },
  { nom: 'nm-submit-context-perdu', f: R, de: 'context: [...(e.context ?? []), recap]', vers: 'context: [recap]' },
  { nom: 'nm-submit-context-ordre', f: R, de: 'context: [...(e.context ?? []), recap]', vers: 'context: [recap, ...(e.context ?? [])]' },
  { nom: 'nm-submit-recap-omis', f: R, de: 'context: [...(e.context ?? []), recap]', vers: 'context: [...(e.context ?? [])]' },
  { nom: 'nm-submit-recap-fixe', f: R, de: 'context: [...(e.context ?? []), recap]', vers: "context: [...(e.context ?? []), 'recap']" },
  { nom: 'nm-submit-reveil-sans-next', f: R, de: 'return next({ ...e, context: [...(e.context ?? []), recap] })', vers: 'return { text: e.text }' },
  { nom: 'nm-submit-reveil-texte-perdu', f: R, de: 'return next({ ...e, context: [...(e.context ?? []), recap] })', vers: "return next({ ...e, text: '', context: [...(e.context ?? []), recap] })" },
  { nom: 'nm-submit-passage-sans-next', f: R, de: 'COMMANDE_NUIT.test(e.text)) return next(e)', vers: 'COMMANDE_NUIT.test(e.text)) return { text: e.text }' },
  { nom: 'nm-submit-echec-sans-next', f: R, de: "r.valeur.recap === '') return next(e)", vers: "r.valeur.recap === '') return { text: e.text }" },
  // fin de tour
  { nom: 'nm-fin-sans-next', f: R, de: '    const resultat = await next(e)\n    if (e.agentId === undefined)', vers: '    const resultat = { text: e.answer }\n    if (e.agentId === undefined)' },
  { nom: 'nm-fin-sous-agent-non-ignore', f: R, de: 'if (e.agentId === undefined) await enchainer($, e.reason)', vers: 'await enchainer($, e.reason)' },
  { nom: 'nm-fin-agent-seul', f: R, de: 'if (e.agentId === undefined) await enchainer($, e.reason)', vers: 'if (e.agentId !== undefined) await enchainer($, e.reason)' },
  { nom: 'nm-fin-raison-perdue', f: R, de: 'await enchainer($, e.reason)', vers: "await enchainer($, 'answer')" },
  { nom: 'nm-fin-resultat-perdu', f: R, de: '    return resultat\n  })', vers: "    return { text: 'x' }\n  })" },
  { nom: 'nm-enchainer-chemin-rapide-omis', f: R, de: "  if (!(await nuitActive($))) return\n  const r = await appeler($, 'continuer'", vers: "  const r = await appeler($, 'continuer'" },
  { nom: 'nm-enchainer-operation-fausse', f: R, de: "appeler($, 'continuer', { reason })", vers: "appeler($, 'activite', { reason })" },
  { nom: 'nm-enchainer-raison-perdue', f: R, de: "appeler($, 'continuer', { reason })", vers: "appeler($, 'continuer', {})" },
  { nom: 'nm-enchainer-rafraichir-omis', f: R, de: "  const r = await appeler($, 'continuer', { reason })\n  await rafraichir($)\n", vers: "  const r = await appeler($, 'continuer', { reason })\n" },
  { nom: 'nm-enchainer-continuer-non-true', f: R, de: 'r.valeur.continuer === true && ', vers: '' },
  { nom: 'nm-enchainer-texte-perdu', f: R, de: 'soumettre($, r.valeur.texte)', vers: "soumettre($, 'NUIT : continue')" },
  // rappel dans le prompt
  { nom: 'nm-compose-texte-omis', f: R, de: 'return texte === null ? composition :', vers: 'return true ? composition :' },
  { nom: 'nm-compose-id-faux', f: R, de: "id: 'nuit:rappel'", vers: "id: 'nuit'" },
  { nom: 'nm-compose-section-partagee', f: R, de: "scope: 'session' as const }] }", vers: "scope: 'shared' as const }] }" },
  { nom: 'nm-compose-texte-perdu', f: R, de: "{ id: 'nuit:rappel', text: texte, scope", vers: "{ id: 'nuit:rappel', text: 'x', scope" },
  { nom: 'nm-compose-base-perdue', f: R, de: "sections: [...composition.sections, { id: 'nuit:rappel'", vers: "sections: [{ id: 'nuit:rappel'" },
  { nom: 'nm-compose-en-tete', f: R, de: "{ sections: [...composition.sections, { id: 'nuit:rappel', text: texte, scope: 'session' as const }] }", vers: "{ sections: [{ id: 'nuit:rappel', text: texte, scope: 'session' as const }, ...composition.sections] }" },
  { nom: 'nm-compose-chemin-faux', f: R, de: 'texteRappel(await lireNuit($, NOM_ETAT))', vers: 'texteRappel(await lireNuit($, NOM_BOITE))' },
  { nom: 'nm-compose-composition-ignoree', f: R, de: '    const composition = await next(e)\n    const texte = texteRappel', vers: '    const composition = { sections: [] as never[] }\n    const texte = texteRappel' },
  // commande /nuit
  { nom: 'nm-cmd-nom-faux', f: R, de: "on('command.run', { command: 'nuit' }", vers: "on('command.run', { command: 'nuits' }" },
  { nom: 'nm-cmd-args-perdus', f: R, de: 'executer($, e.args)', vers: "executer($, '')" },
  { nom: 'nm-cmd-ouverture-omise', f: R, de: `    ${OUVRIR_CMD}\n`, vers: '' },
  { nom: 'nm-cmd-ouverture-toujours', f: R, de: OUVRIR_CMD, vers: "await $.ui.open({ id: PANNEAU, title: 'Nuit' })" },
  { nom: 'nm-cmd-titre-faux', f: R, de: OUVRIR_CMD, vers: OUVRIR_CMD.replace("title: 'Nuit'", "title: 'Autre'") },
  { nom: 'nm-cmd-panneau-faux', f: R, de: OUVRIR_CMD, vers: OUVRIR_CMD.replace('id: PANNEAU', "id: 'autre'") },
  { nom: 'nm-cmd-texte-perdu', f: R, de: 'return { text: texte }', vers: "return { text: '' }" },
  // exécution d'une commande par le noyau
  { nom: 'nm-exec-operation-fausse', f: R, de: "appeler($, 'commande', { args })", vers: "appeler($, 'activite', { args })" },
  { nom: 'nm-exec-args-perdus', f: R, de: "appeler($, 'commande', { args })", vers: "appeler($, 'commande', {})" },
  { nom: 'nm-exec-echec-ignore', f: R, de: '  if (r.echec !== null) return { texte: r.echec, ouvrir: false, accord: null }\n', vers: '' },
  { nom: 'nm-exec-echec-texte-perdu', f: R, de: 'if (r.echec !== null) return { texte: r.echec, ouvrir: false, accord: null }', vers: "if (r.echec !== null) return { texte: 'Nuit : échec', ouvrir: false, accord: null }" },
  { nom: 'nm-exec-echec-ouvre', f: R, de: 'if (r.echec !== null) return { texte: r.echec, ouvrir: false, accord: null }', vers: 'if (r.echec !== null) return { texte: r.echec, ouvrir: true, accord: null }' },
  { nom: 'nm-exec-rafraichir-omis', f: R, de: '  await rafraichir($)\n  const { message, erreur, effet, prompt } = r.valeur', vers: '  const { message, erreur, effet, prompt } = r.valeur' },
  { nom: 'nm-exec-erreur-ignoree', f: R, de: "  if (typeof erreur === 'string') return { texte: erreur, ouvrir: false, accord: null }\n", vers: '' },
  { nom: 'nm-exec-erreur-texte-perdu', f: R, de: 'return { texte: erreur, ouvrir: false, accord: null }', vers: 'return { texte: ILLISIBLE, ouvrir: false, accord: null }' },
  { nom: 'nm-exec-erreur-ouvre', f: R, de: 'return { texte: erreur, ouvrir: false, accord: null }', vers: 'return { texte: erreur, ouvrir: true, accord: null }' },
  { nom: 'nm-exec-message-non-string-ignore', f: R, de: "  if (typeof message !== 'string') return { texte: ILLISIBLE, ouvrir: false, accord: null }\n", vers: '' },
  { nom: 'nm-exec-message-texte-perdu', f: R, de: "if (typeof message !== 'string') return { texte: ILLISIBLE, ouvrir: false, accord: null }", vers: "if (typeof message !== 'string') return { texte: 'x', ouvrir: false, accord: null }" },
  { nom: 'nm-exec-effet-ignore', f: R, de: "if (effet === 'reponse' && typeof prompt === 'string'", vers: "if (typeof prompt === 'string'" },
  { nom: 'nm-exec-effet-autre', f: R, de: "if (effet === 'reponse' && typeof prompt", vers: "if (effet === 'active' && typeof prompt" },
  { nom: 'nm-exec-prompt-texte-perdu', f: R, de: 'soumettre($, prompt)', vers: 'soumettre($, message)' },
  { nom: 'nm-exec-reveil-omis', f: R, de: "ouvrir: effet === 'reveil' || COMMANDES_DU_PANNEAU", vers: 'ouvrir: COMMANDES_DU_PANNEAU' },
  { nom: 'nm-exec-panneau-omis', f: R, de: "ouvrir: effet === 'reveil' || COMMANDES_DU_PANNEAU.includes(premierMot(args))", vers: "ouvrir: effet === 'reveil'" },
  { nom: 'nm-exec-toujours-ouvrir', f: R, de: "ouvrir: effet === 'reveil' || COMMANDES_DU_PANNEAU.includes(premierMot(args))", vers: 'ouvrir: true' },
  { nom: 'nm-exec-message-perdu', f: R, de: 'return { texte: message, ouvrir', vers: "return { texte: '', ouvrir" },
  // premier mot d'une commande
  { nom: 'nm-mot-casse', f: R, de: "/^\\S+/.exec(args)?.[0].toLowerCase() ?? ''", vers: "/^\\S+/.exec(args)?.[0] ?? ''" },
  { nom: 'nm-mot-dernier', f: R, de: '/^\\S+/.exec(args)', vers: '/\\S+$/.exec(args)' },
  { nom: 'nm-mot-vide-ouvre', f: R, de: "/^\\S+/.exec(args)?.[0].toLowerCase() ?? ''", vers: "/^\\S+/.exec(args)?.[0].toLowerCase() ?? 'boite'" },
  { nom: 'nm-exec-args-non-rognes', f: R, de: 'const args = brut.trim()', vers: 'const args = brut' },
  // lecture de la réponse du noyau
  { nom: 'nm-lire-objet-null-non-gere', f: R, de: 'return (JSON.parse(texte) ?? {}) as Record<string, unknown>', vers: 'return JSON.parse(texte) as Record<string, unknown>' },
  { nom: 'nm-lire-objet-illisible-leve', f: R, de: '  } catch {\n    return {}\n  }\n}', vers: '  } catch (e) {\n    throw e\n  }\n}' },
  { nom: 'nm-lire-objet-illisible-faux', f: R, de: '  } catch {\n    return {}\n  }\n}', vers: "  } catch {\n    return { refuser: true, texte: 'x', reveil: true, recap: 'x', continuer: true }\n  }\n}" },
  { nom: 'nm-appeler-echec-code-valeur', f: R, de: 'return { valeur: {}, echec: stderr === ', vers: "return { valeur: { refuser: true, texte: 'x' }, echec: stderr === " },
  { nom: 'nm-appeler-echec-rejet-valeur', f: R, de: 'return { valeur: {}, echec: `Nuit : le noyau ne répond pas (', vers: "return { valeur: { refuser: true, texte: 'x' }, echec: `Nuit : le noyau ne répond pas (" },
  { nom: 'nm-appeler-succes-echec', f: R, de: 'return { valeur: lireObjet(r.stdout), echec: null }', vers: "return { valeur: lireObjet(r.stdout), echec: 'x' }" },
  // récap du panneau
  { nom: 'nm-recap-coupe-omise', f: R, de: 'return i < 0 ? lignes : lignes.slice(0, i)', vers: 'return lignes' },
  { nom: 'nm-recap-coupe-courte', f: R, de: 'lignes.slice(0, i)', vers: 'lignes.slice(0, i - 1)' },
  { nom: 'nm-recap-coupe-longue', f: R, de: 'lignes.slice(0, i)', vers: 'lignes.slice(0, i + 1)' },
  { nom: 'nm-recap-absent-vide', f: R, de: 'return i < 0 ? lignes : lignes.slice(0, i)', vers: 'return i < 0 ? [] : lignes.slice(0, i)' },
  { nom: 'nm-recap-prefixe-faux', f: R, de: "l.startsWith('À décider (')", vers: "l.startsWith('A decider (')" },
  // démarrage
  { nom: 'nm-demarrage-commande-omise', f: R, de: DEMARRAGE_COMMANDE, vers: '' },
  { nom: 'nm-demarrage-nom-faux', f: R, de: "      name: 'nuit',", vers: "      name: 'nuits'," },
  { nom: 'nm-demarrage-description-faux', f: R, de: 'description: "Nuit : questions en boîte', vers: 'description: "Questions en boîte' },
  { nom: 'nm-demarrage-hint-omis', f: R, de: "      argumentHint: '[on | off | statut | recap | boite | ...]',\n", vers: '' },
  { nom: 'nm-demarrage-hint-faux', f: R, de: "argumentHint: '[on | off | statut | recap | boite | ...]'", vers: "argumentHint: '[on | off]'" },
  { nom: 'nm-demarrage-minuterie-omise', f: R, de: '    $.clock.every(PERIODE_MS, () => enFond(rafraichir($)))\n', vers: '' },
  { nom: 'nm-demarrage-minuterie-vide', f: R, de: '$.clock.every(PERIODE_MS, () => enFond(rafraichir($)))', vers: '$.clock.every(PERIODE_MS, () => {})' },
  { nom: 'nm-demarrage-rafraichir-omis', f: R, de: '    await rafraichir($)\n\n    return next(e)', vers: '    return next(e)' },
  { nom: 'nm-demarrage-sans-next', f: R, de: '    await rafraichir($)\n\n    return next(e)', vers: '    await rafraichir($)\n\n    return { cwd: e.cwd }' },
  // panneau
  { nom: 'nm-pane-id-faux', f: R, de: "requestId: PANNEAU }", vers: "requestId: 'autre' }" },
  { nom: 'nm-pane-atom-ignore', f: R, de: 'const lu = await read($, suivi)', vers: 'const lu = null as NuitSuivi | null' },
  { nom: 'nm-pane-instant-faux', f: R, de: 'const maintenant = await $.clock.now()\n    if (e.surface', vers: 'const maintenant = 0\n    if (e.surface' },
  { nom: 'nm-pane-attente-ignoree', f: R, de: 'const visibles = lu === null ? [] : filtrerBoite(lu.boite, filtreCourant)', vers: 'const visibles: ReturnType<typeof filtrerBoite> = []' },
  { nom: 'nm-pane-attente-toutes', f: R, de: 'const visibles = lu === null ? [] : filtrerBoite(lu.boite, filtreCourant)', vers: "const visibles = lu === null ? [] : filtrerBoite(lu.boite, 'toutes')" },
  { nom: 'nm-pane-decider-toast-omis', f: R, de: '      $.ui.toast(fait.texte)\n', vers: '' },
  { nom: 'nm-pane-decider-toast-texte', f: R, de: '$.ui.toast(fait.texte)', vers: "$.ui.toast('fait')" },
  { nom: 'nm-pane-rafraichir-cle', f: R, de: '<Box flexDirection="column">\n        <Button key="rafraichir"', vers: '<Box flexDirection="column">\n        <Button key="rafraichir2"' },
  { nom: 'nm-pane-rafraichir-libelle', f: R, de: '<Box flexDirection="column">\n        <Button key="rafraichir" label="Rafraîchir"', vers: '<Box flexDirection="column">\n        <Button key="rafraichir" label="Actualiser"' },
  { nom: 'nm-pane-rafraichir-vide', f: R, de: '<Box flexDirection="column">\n        <Button key="rafraichir" label="Rafraîchir" onPress={() => rafraichir($)}', vers: '<Box flexDirection="column">\n        <Button key="rafraichir" label="Rafraîchir" onPress={() => {}}' },
  { nom: 'nm-pane-lecture-omise', f: R, de: '        {lu === null && <Text>Nuit : lecture en cours</Text>}\n', vers: '' },
  { nom: 'nm-pane-lecture-toujours', f: R, de: '{lu === null && <Text>Nuit : lecture en cours</Text>}', vers: '{<Text>Nuit : lecture en cours</Text>}' },
  { nom: 'nm-pane-lecture-texte', f: R, de: '<Text>Nuit : lecture en cours</Text>', vers: '<Text>Nuit</Text>' },
  { nom: 'nm-pane-recap-omis', f: R, de: '{lu !== null &&\n          lignesDuRecap(', vers: '{false &&\n          lignesDuRecap(' },
  { nom: 'nm-pane-recap-instant-faux', f: R, de: '{ maintenant, lignesMaintenant: null }', vers: '{ maintenant: 0, lignesMaintenant: null }' },
  { nom: 'nm-pane-recap-lignes-ouvertes', f: R, de: 'lignesMaintenant: null', vers: 'lignesMaintenant: 5' },
  { nom: 'nm-pane-recap-etat-ignore', f: R, de: 'texteRecap(lu.etat, lu.boite,', vers: 'texteRecap(normaliserEtat(null), lu.boite,' },
  { nom: 'nm-pane-entete-omise', f: R, de: `        ${ENTETE_ATTENTE}\n`, vers: '' },
  { nom: 'nm-pane-entete-toujours', f: R, de: ENTETE_ATTENTE, vers: '{<Text bold>{`${comptes?.attente} à traiter, ${comptes?.traitees} en historique`}</Text>}' },
  { nom: 'nm-pane-entete-pas-gras', f: R, de: '<Text bold>{`${comptes.attente} à traiter', vers: '<Text>{`${comptes.attente} à traiter' },
  { nom: 'nm-pane-titre-question-faux', f: R, de: TITRE_QUESTION, vers: '<Text bold>{`${active.id}. ${active.titre}`}</Text>' },
  { nom: 'nm-pane-titre-question-omis', f: R, de: `          ${TITRE_QUESTION}\n`, vers: '' },
  { nom: 'nm-pane-details-toujours', f: R, de: '{active.details !== \'\' && <Text dimColor>{active.details}</Text>}', vers: '{<Text dimColor>{active.details}</Text>}' },
  { nom: 'nm-pane-details-omis', f: R, de: '          {active.details !== \'\' && <Text dimColor>{active.details}</Text>}\n', vers: '' },
  { nom: 'nm-pane-details-pas-sourds', f: R, de: '<Text dimColor>{active.details}</Text>', vers: '<Text>{active.details}</Text>' },
  { nom: 'nm-pane-options-omises', f: R, de: '{active.options.map((option, i) =>', vers: '{([] as typeof active.options).map((option, i) =>' },
  { nom: 'nm-pane-option-cle-faux', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace('key={`rep-${active.id}-${i}`}', 'key={`rep-${active.id}`}') },
  { nom: 'nm-pane-option-cle-sans-id', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace('key={`rep-${active.id}-${i}`}', 'key={`rep-${i}`}') },
  { nom: 'nm-pane-option-libelle-faux', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace('label={option.label}', 'label={option.description}') },
  { nom: 'nm-pane-option-args-ecarter', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace("decider(active.id, option.label, '')", 'ecarter(active.id)') },
  { nom: 'nm-pane-option-args-libelle-perdu', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace("decider(active.id, option.label, '')", "decider(active.id, null, '')") },
  { nom: 'nm-pane-option-args-id-perdu', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace("decider(active.id, option.label, '')", "decider(-1, option.label, '')") },
  { nom: 'nm-pane-option-args-autre-id', f: R, de: BOUTON_OPTION, vers: BOUTON_OPTION.replace("decider(active.id, option.label, '')", "decider(i, option.label, '')") },
  { nom: 'nm-pane-ecarter-cle-faux', f: R, de: BOUTON_ECARTER, vers: BOUTON_ECARTER.replace('key={`ecarter-${active.id}`}', 'key={`ecarter`}') },
  { nom: 'nm-pane-ecarter-libelle-faux', f: R, de: BOUTON_ECARTER, vers: BOUTON_ECARTER.replace('label="Écarter"', 'label="Supprimer"') },
  { nom: 'nm-pane-ecarter-args-faux', f: R, de: BOUTON_ECARTER, vers: BOUTON_ECARTER.replace('ecarter(active.id)', "decider(active.id, null, '')") },
  { nom: 'nm-pane-ecarter-args-id-perdu', f: R, de: BOUTON_ECARTER, vers: BOUTON_ECARTER.replace('ecarter(active.id)', 'ecarter(-1)') },
  { nom: 'nm-pane-ecarter-omis', f: R, de: `            ${BOUTON_ECARTER}\n`, vers: '' },
  // dossier d'état (emplacements-logique.mjs) et script du noyau (cheminScript) : le module les trouve, et leur absence ne retient rien
  { nom: 'nm-dossier-fichier-relatif', f: R, de: 'return lireJson($, `${dossier}/${nom}`)', vers: 'return lireJson($, nom)' },
  { nom: 'nm-dossier-panne-active', f: R, de: '  } catch {\n    return undefined\n  }', vers: "  } catch {\n    return { actif: true, mode: 'nuit', depuis: '2026-03-04T00:00:00.000Z', tours: 0, maxTours: 60 }\n  }" },
  { nom: 'nm-script-chemin-relatif', f: R, de: 'await cheminScript($, NOM_CLI)', vers: 'NOM_CLI' },
  // les accords de l'utilisateur (retenus en mémoire du module, jamais dans un fichier) et le lot des questions
  { nom: 'nm-accord-origine-ignoree', f: R, de: 'if (accord !== null && ORIGINES_UTILISATEUR.includes(e.origin.kind)) retenirAccord(accord)', vers: 'if (accord !== null) retenirAccord(accord)' },
  { nom: 'nm-accord-origine-inversee', f: R, de: 'ORIGINES_UTILISATEUR.includes(e.origin.kind)) retenirAccord(accord)', vers: '!ORIGINES_UTILISATEUR.includes(e.origin.kind)) retenirAccord(accord)' },
  { nom: 'nm-accord-commande-non-retenu', f: R, de: 'if (accord !== null && ORIGINES_UTILISATEUR.includes(e.origin.kind)) retenirAccord(accord)', vers: '' },
  { nom: 'nm-accord-panneau-non-retenu', f: R, de: '      if (fait.accord !== null) retenirAccord(fait.accord)\n', vers: '' },
  { nom: 'nm-accord-effet-ignore', f: R, de: "valeur.effet !== 'reponse' || ", vers: '' },
  { nom: 'nm-accord-texte-ignore', f: R, de: 'reponse.texte !== REPONSE_AUTORISER || ', vers: '' },
  { nom: 'nm-accord-type-ignore', f: R, de: "entree.type === 'action' && typeof entree.empreinte === 'string'", vers: "typeof entree.empreinte === 'string'" },
  { nom: 'nm-accord-empreinte-ignoree', f: R, de: "entree.type === 'action' && typeof entree.empreinte === 'string' ? { id: reponse.id, empreinte: entree.empreinte } : null", vers: "entree.type === 'action' ? { id: reponse.id, empreinte: String(entree.empreinte) } : null" },
  { nom: 'nm-accord-joint-omis', f: R, de: '...(autorisees.length === 0 ? {} : { autorisees })', vers: '...{}' },
  { nom: 'nm-accord-toujours-joint', f: R, de: '...(autorisees.length === 0 ? {} : { autorisees })', vers: '...{ autorisees }' },
  { nom: 'nm-accord-consomme-omis', f: R, de: "  if (typeof r.valeur.autorisee === 'number') accords.delete(r.valeur.autorisee)\n", vers: '' },
  { nom: 'nm-accord-limite-large', f: R, de: 'const MAX_ACCORDS = 50', vers: 'const MAX_ACCORDS = 51' },
  { nom: 'nm-accord-sans-eviction', f: R, de: '    if (accords.size <= MAX_ACCORDS) break\n', vers: '    break\n' },
  { nom: 'nm-lot-omis', f: R, de: "return typeof lot === 'number' ? `, lot ${lot}` : ''", vers: "return ''" },
  { nom: 'nm-lot-toujours', f: R, de: "return typeof lot === 'number' ? `, lot ${lot}` : ''", vers: 'return `, lot ${String(lot)}`' },
];

executer({ mod: MOD, mutations: MUTATIONS, argv: process.argv.slice(2), concurrence: 3 })
  .then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
