'use strict';
// Preuve par mutation du banc nuit-core.test.js (noyau d'entrées-sorties de la Nuit).
//   node tests/mutations/mutations-nuit-core.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-nuit-core.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-nuit-core.js --liste         affiche les noms
//   node tests/mutations/mutations-nuit-core.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutations équivalentes écartées (la sortie observable ne change pas) : dans continuer, évaluer la pause et le quota aussi quand le
// tour n'est pas terminé ou que la nuit est inactive (la décision rend d'abord « inactive » puis « interrompu » : ils sont lus pour rien) ;
// lire le ledger sans filtre d'agent dans lignesDe (la lecture vise ensuite `.agents[agent]`) ; relire l'état au lieu de prendre celui qui
// vient d'être écrit, et omettre l'instant, dans le récap du réveil (la nuit est finie : sa fin est datée) ; l'attente d'une entrée
// refusée par la boîte (sans objet quand l'id est nul, le code ne la calcule plus) ; rendre {} au lieu de null quand la sortie du garde n'est
// pas du JSON (aucun des deux ne refuse rien) ; ne pas filtrer le chemin du rollout qui n'est pas un texte (fs le refuse et la mesure
// gardée prend le relais) ; tester la sortie vide du garde avant de l'analyser (JSON.parse la refuse déjà).

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib');
const m = (nom, suite, de, vers) => ({ nom: `ncore-${nom}`, suite, de, vers });

const MUTATIONS = [
  // fichiers d'état et de boîte
  m('fichier-etat', 'fichiers', "path.join(cockpit.racine(), 'nuit.json')", "path.join(cockpit.racine(), 'nuit-etat.json')"),
  m('fichier-boite', 'fichiers', "path.join(cockpit.racine(), 'nuit-boite.json')", "path.join(cockpit.racine(), 'boite.json')"),
  m('lire-etat-normalise', 'fichiers', 'const lireEtat = () => logique.normaliserEtat(cockpit.lireJson(fichierEtat(), null));', 'const lireEtat = () => cockpit.lireJson(fichierEtat(), logique.etatParDefaut());'),
  m('lire-etat-defaut', 'fichiers', 'const lireEtat = () => logique.normaliserEtat(cockpit.lireJson(fichierEtat(), null));', 'const lireEtat = () => logique.normaliserEtat(cockpit.lireJson(fichierEtat(), { actif: true }));'),
  m('ecrire-etat-normalise', 'fichiers', "cockpit.ecrireJson(fichierEtat(), { ...logique.normaliserEtat(etat), maj: new Date().toISOString() });", "cockpit.ecrireJson(fichierEtat(), { ...etat, maj: new Date().toISOString() });"),
  m('ecrire-etat-maj', 'fichiers', "cockpit.ecrireJson(fichierEtat(), { ...logique.normaliserEtat(etat), maj: new Date().toISOString() });", "cockpit.ecrireJson(fichierEtat(), { ...logique.normaliserEtat(etat) });"),
  m('lire-boite-normalise', 'fichiers', 'const lireBoite = () => logique.normaliserBoite(cockpit.lireJson(fichierBoite(), null));', 'const lireBoite = () => cockpit.lireJson(fichierBoite(), logique.boiteParDefaut());'),
  m('ecrire-boite-normalise', 'fichiers', "cockpit.ecrireJson(fichierBoite(), { ...logique.normaliserBoite(boite), maj: new Date().toISOString() });", "cockpit.ecrireJson(fichierBoite(), { ...boite, maj: new Date().toISOString() });"),
  m('ecrire-boite-maj', 'fichiers', "cockpit.ecrireJson(fichierBoite(), { ...logique.normaliserBoite(boite), maj: new Date().toISOString() });", "cockpit.ecrireJson(fichierBoite(), { ...logique.normaliserBoite(boite) });"),

  // lignes de la liste de travail
  m('lignes-agent', 'lignes de la liste de travail', 'Object.values(agents[nom] || {})', 'Object.values(agents.claude || {})'),
  m('lignes-defaut', 'lignes de la liste de travail', 'Object.values(agents[nom] || {})', 'Object.values(agents[nom])'),
  m('lignes-bloquees', 'lignes de la liste de travail', 'projets.flatMap(p => p.lignesOuvertes)', 'projets.flatMap(p => [...p.lignesOuvertes, ...p.lignesBloquees])'),
  m('lignes-premier-projet', 'lignes de la liste de travail', 'projets.flatMap(p => p.lignesOuvertes)', 'projets.slice(0, 1).flatMap(p => p.lignesOuvertes)'),
  m('lignes-session', 'commande', 'logique.lignesCandidates(lignesDe(agent), session).length : null);', 'lignesDe(agent).length : null);'),
  m('lignes-compte', 'commande', 'logique.lignesCandidates(lignesDe(agent), session).length : null);', 'logique.lignesCandidates(lignesDe(agent), session).length + 1 : null);'),

  // commande
  m('commande-erreur', 'commande', '  if (r.erreur) return { erreur: r.erreur };\n  const ecritures', '  const ecritures'),
  m('commande-lignes', 'commande', 'lignesOuvertes: nbLignes(agent, session) });\n  if (r.erreur)', 'lignesOuvertes: 0 });\n  if (r.erreur)'),
  m('commande-instant', 'commande', 'logique.analyserCommande(args, etat, boite, { maintenant, lignesOuvertes:', 'logique.analyserCommande(args, etat, boite, { lignesOuvertes:'),
  m('commande-etat-lu', 'commande', 'const r = logique.analyserCommande(args, etat, boite,', 'const r = logique.analyserCommande(args, logique.etatParDefaut(), boite,'),
  m('commande-boite-lue', 'commande', 'const r = logique.analyserCommande(args, etat, boite,', 'const r = logique.analyserCommande(args, etat, logique.boiteParDefaut(),'),
  m('commande-boite-toujours', 'commande', '[JSON.stringify(r.boite) !== JSON.stringify(boite), fichierBoite,', '[true, fichierBoite,'),
  m('commande-boite-jamais', 'commande', '[JSON.stringify(r.boite) !== JSON.stringify(boite), fichierBoite,', '[false, fichierBoite,'),
  m('commande-etat-toujours', 'commande', '[JSON.stringify(r.etat) !== JSON.stringify(etat), fichierEtat,', '[true, fichierEtat,'),
  m('commande-etat-jamais', 'commande', '[JSON.stringify(r.etat) !== JSON.stringify(etat), fichierEtat,', '[false, fichierEtat,'),
  m('commande-boite-ecrite-etat', 'commande', '() => ecrireBoite(r.boite)]', '() => ecrireBoite(boite)]'),
  m('commande-etat-ecrit-ancien', 'commande', '() => ecrireEtat(r.etat)]', '() => ecrireEtat(etat)]'),
  m('commande-ecriture-continue', 'commande', "    if (!change) continue;\n", ''),
  m('commande-ecriture-erreur', 'commande', "try { ecrire(); } catch (e) { return { erreur: `Écriture impossible dans ${fichier()} (${message(e)}) : rien n'a changé.` }; }", 'ecrire();'),
  m('commande-ecriture-fichier', 'commande', 'Écriture impossible dans ${fichier()} (${message(e)})', 'Écriture impossible dans ${cockpit.racine()} (${message(e)})'),
  m('commande-ecriture-cause', 'commande', 'Écriture impossible dans ${fichier()} (${message(e)})', 'Écriture impossible dans ${fichier()}'),
  m('commande-retour-effet', 'commande', 'if (r.reponse === undefined) return { message: r.message, effet: r.effet };', 'if (r.reponse === undefined) return { message: r.message };'),
  m('commande-retour-message', 'commande', 'if (r.reponse === undefined) return { message: r.message, effet: r.effet };', 'if (r.reponse === undefined) return { effet: r.effet };'),
  m('commande-reponse-sans-prompt', 'commande', 'if (r.reponse === undefined) return', 'if (true) return'),
  m('commande-reponse-prompt', 'commande', 'prompt: logique.texteReponse(r.reponse.entree) };', 'prompt: r.reponse.texte };'),
  m('commande-reponse-objet', 'commande', 'return { message: r.message, effet: r.effet, reponse: r.reponse, prompt:', 'return { message: r.message, effet: r.effet, prompt:'),

  // activité et réveil
  m('activite-etat', 'activité de l\'utilisateur et réveil', '  const r = logique.noterActivite(lireEtat(), maintenant);\n  ecrireEtat(r.etat);', '  const r = logique.noterActivite(lireEtat(), maintenant);'),
  m('activite-instant', 'activité de l\'utilisateur et réveil', 'logique.noterActivite(lireEtat(), maintenant);', 'logique.noterActivite(lireEtat(), Date.now());'),
  m('activite-reveil', 'activité de l\'utilisateur et réveil', '  if (!r.reveil) return { reveil: false };', '  if (r.reveil) return { reveil: false };'),
  m('activite-sans-reveil', 'activité de l\'utilisateur et réveil', '  if (!r.reveil) return { reveil: false };', '  if (false) return { reveil: false };'),
  m('activite-recap-boite', 'activité de l\'utilisateur et réveil', 'logique.texteRecap(r.etat, lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) }) };', 'logique.texteRecap(r.etat, logique.boiteParDefaut(), { maintenant, lignesMaintenant: nbLignes(agent, session) }) };'),
  m('activite-recap-lignes', 'activité de l\'utilisateur et réveil', 'logique.texteRecap(r.etat, lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) }) };', 'logique.texteRecap(r.etat, lireBoite(), { maintenant, lignesMaintenant: null }) };'),
  m('activite-recap-champ', 'activité de l\'utilisateur et réveil', 'return { reveil: true, recap:', 'return { reveil: true, texte:'),

  // absence
  m('actif-vrai', 'absence détectée', '  if (etat.actif) return true;\n  if (!logique.absenceAtteinte', '  if (!logique.absenceAtteinte'),
  m('actif-retour', 'absence détectée', '  if (etat.actif) return true;', '  if (etat.actif) return false;'),
  m('absence-garde', 'absence détectée', '  if (!logique.absenceAtteinte(etat, maintenant)) return false;\n  const r', '  const r'),
  m('absence-garde-sens', 'absence détectée', 'if (!logique.absenceAtteinte(etat, maintenant)) return false;', 'if (logique.absenceAtteinte(etat, maintenant)) return false;'),
  m('absence-lignes', 'absence détectée', 'logique.activerSiAbsent(etat, maintenant, nbLignes(agent, session));', 'logique.activerSiAbsent(etat, maintenant);'),
  m('absence-instant', 'absence détectée', 'logique.activerSiAbsent(etat, maintenant, nbLignes(agent, session));', 'logique.activerSiAbsent(etat, Date.now(), nbLignes(agent, session));'),
  m('absence-ecriture', 'absence détectée', '  const r = logique.activerSiAbsent(etat, maintenant, nbLignes(agent, session));\n  ecrireEtat(r.etat);', '  const r = logique.activerSiAbsent(etat, maintenant, nbLignes(agent, session));'),
  m('absence-retour', 'absence détectée', '  return r.active;', '  return false;'),

  // question refusée
  m('question-garde', 'question refusée', '  if (!nuitActive({ agent, session, maintenant })) return { refuser: false };\n  const q', '  const q'),
  m('question-garde-sens', 'question refusée', '  if (!nuitActive({ agent, session, maintenant })) return { refuser: false };\n  const q', '  if (nuitActive({ agent, session, maintenant })) return { refuser: false };\n  const q'),
  m('question-lecture', 'question refusée', 'const q = logique.questionsDeOutil(entreeOutil);', 'const q = logique.questionsDeOutil(undefined);'),
  m('question-type', 'question refusée', "mettreEnBoite({ agent, session, type: 'question', titre: q.titre,", "mettreEnBoite({ agent, session, type: 'action', titre: q.titre,"),
  m('question-details', 'question refusée', 'titre: q.titre, details: q.details, options: q.options, maintenant });', 'titre: q.titre, options: q.options, maintenant });'),
  m('question-options', 'question refusée', 'titre: q.titre, details: q.details, options: q.options, maintenant });', 'titre: q.titre, details: q.details, maintenant });'),
  m('question-instant', 'question refusée', 'titre: q.titre, details: q.details, options: q.options, maintenant });', 'titre: q.titre, details: q.details, options: q.options, maintenant: Date.now() });'),
  m('question-session', 'question refusée', "mettreEnBoite({ agent, session, type: 'question'", "mettreEnBoite({ agent, session: 'S1', type: 'question'"),
  m('question-agent', 'question refusée', "mettreEnBoite({ agent, session, type: 'question'", "mettreEnBoite({ agent: 'claude', session, type: 'question'"),
  m('question-compte', 'question refusée', "  compter('question');", ''),
  m('question-compte-genre', 'question refusée', "  compter('question');", "  compter('garde');"),
  m('question-retour-refus', 'question refusée', 'return { refuser: true, id: mise.id, texte: logique.texteRefusQuestion(', 'return { refuser: false, id: mise.id, texte: logique.texteRefusQuestion('),
  m('question-retour-id', 'question refusée', 'return { refuser: true, id: mise.id, texte: logique.texteRefusQuestion({ id: mise.id, enAttente: mise.enAttente, options: q.options }) };', 'return { refuser: true, id: mise.id, texte: logique.texteRefusQuestion({ id: null, enAttente: mise.enAttente, options: q.options }) };'),
  m('question-retour-attente', 'question refusée', 'texteRefusQuestion({ id: mise.id, enAttente: mise.enAttente, options: q.options })', 'texteRefusQuestion({ id: mise.id, enAttente: 0, options: q.options })'),
  m('question-retour-options', 'question refusée', 'texteRefusQuestion({ id: mise.id, enAttente: mise.enAttente, options: q.options })', 'texteRefusQuestion({ id: mise.id, enAttente: mise.enAttente, options: [] })'),

  // mise en boîte
  m('boite-refus', 'question refusée', '    if (r.refus !== undefined) return { id: null, enAttente: 0 };\n', ''),
  m('boite-deja', 'question refusée', '    if (!r.deja) ecrireBoite(r.boite);', '    ecrireBoite(r.boite);'),
  m('boite-jamais-ecrite', 'question refusée', '    if (!r.deja) ecrireBoite(r.boite);', ''),
  m('boite-id', 'question refusée', 'return { id: r.entree.id, enAttente: logique.enAttente(r.boite).length };', 'return { id: r.entree.id + 1, enAttente: logique.enAttente(r.boite).length };'),
  m('boite-attente-avant', 'question refusée', 'return { id: r.entree.id, enAttente: logique.enAttente(r.boite).length };', 'return { id: r.entree.id, enAttente: logique.enAttente(boite).length };'),
  m('boite-panne', 'question refusée', '  } catch (_) {\n    return { id: null, enAttente: 0 };', '  } catch (_) {\n    return { id: 1, enAttente: 0 };'),
  m('boite-panne-relancee', 'question refusée', '  } catch (_) {\n    return { id: null, enAttente: 0 };\n  }\n}', '  } finally {\n  }\n}'),
  m('compter-panne', 'question refusée', "  try { ecrireEtat(logique.compterRefus(lireEtat(), genre)); } catch (_) { /* le refus est dit quand même */ }", '  ecrireEtat(logique.compterRefus(lireEtat(), genre));'),
  m('compter-ajout', 'question refusée', 'ecrireEtat(logique.compterRefus(lireEtat(), genre)); }', 'ecrireEtat(lireEtat()); }'),

  // arrêt de garde
  m('garde-analyse', 'arrêt de garde', '  if (analyse === null || !nuitActive({ agent, session, maintenant })) return { refuser: false };', '  if (!nuitActive({ agent, session, maintenant })) return { refuser: false };'),
  m('garde-nuit', 'arrêt de garde', '  if (analyse === null || !nuitActive({ agent, session, maintenant })) return { refuser: false };', '  if (analyse === null) return { refuser: false };'),
  m('garde-nuit-sens', 'arrêt de garde', '  if (analyse === null || !nuitActive({ agent, session, maintenant })) return { refuser: false };', '  if (analyse === null || nuitActive({ agent, session, maintenant })) return { refuser: false };'),
  m('garde-sortie', 'arrêt de garde', 'const analyse = logique.analyserSortieGarde(sortie);', 'const analyse = logique.analyserSortieGarde(undefined);'),
  m('garde-ask', 'arrêt de garde', "  if (analyse.genre === 'ask') id = mettreEnBoite(", "  if (analyse.genre !== 'ask') id = mettreEnBoite("),
  m('garde-ask-toujours', 'arrêt de garde', "  if (analyse.genre === 'ask') id = mettreEnBoite(", '  id = mettreEnBoite('),
  m('garde-type', 'arrêt de garde', "mettreEnBoite({ agent, session, type: 'action', ...logique.actionDeGarde(", "mettreEnBoite({ agent, session, type: 'question', ...logique.actionDeGarde("),
  m('garde-commande', 'arrêt de garde', 'logique.actionDeGarde({ commande, raison: analyse.raison })', 'logique.actionDeGarde({ raison: analyse.raison })'),
  m('garde-raison', 'arrêt de garde', 'logique.actionDeGarde({ commande, raison: analyse.raison })', 'logique.actionDeGarde({ commande })'),
  m('garde-instant', 'arrêt de garde', '...logique.actionDeGarde({ commande, raison: analyse.raison }), maintenant }).id;', '...logique.actionDeGarde({ commande, raison: analyse.raison }), maintenant: Date.now() }).id;'),
  m('garde-compte', 'arrêt de garde', "  compter(analyse.genre === 'ask' ? 'action' : 'garde');", ''),
  m('garde-compte-genre', 'arrêt de garde', "  compter(analyse.genre === 'ask' ? 'action' : 'garde');", "  compter(analyse.genre === 'ask' ? 'garde' : 'action');"),
  m('garde-compte-toujours', 'arrêt de garde', "  compter(analyse.genre === 'ask' ? 'action' : 'garde');", "  compter('garde');"),
  m('garde-retour-genre', 'arrêt de garde', 'return { refuser: true, genre: analyse.genre, id, texte:', 'return { refuser: true, id, texte:'),
  m('garde-retour-id', 'arrêt de garde', 'raison: analyse.raison, id }) };', 'raison: analyse.raison }) };'),
  m('garde-retour-raison', 'arrêt de garde', 'texteRefusGarde({ genre: analyse.genre, raison: analyse.raison, id }) };', 'texteRefusGarde({ genre: analyse.genre, raison: undefined, id }) };'),
  m('garde-retour-genre-texte', 'arrêt de garde', 'texteRefusGarde({ genre: analyse.genre, raison: analyse.raison, id }) };', "texteRefusGarde({ genre: 'bloc', raison: analyse.raison, id }) };"),

  // quota
  m('quota-sens', 'enchaînement', 'return !quota.decisionAgentCodex({ agent, chemin, maintenant }).autorise; }', 'return quota.decisionAgentCodex({ agent, chemin, maintenant }).autorise; }'),
  m('quota-panne', 'enchaînement', 'catch (_) { return false; }', 'catch (_) { return true; }'),
  m('quota-panne-propagee', 'enchaînement', 'try { return !quota.decisionAgentCodex({ agent, chemin, maintenant }).autorise; } catch (_) { return false; }', 'return !quota.decisionAgentCodex({ agent, chemin, maintenant }).autorise;'),
  m('quota-chemin', 'enchaînement', 'quota.decisionAgentCodex({ agent, chemin, maintenant })', 'quota.decisionAgentCodex({ agent, maintenant })'),
  m('quota-agent', 'enchaînement', 'quota.decisionAgentCodex({ agent, chemin, maintenant })', "quota.decisionAgentCodex({ agent: 'claude', chemin, maintenant })"),
  m('quota-instant', 'enchaînement', 'quota.decisionAgentCodex({ agent, chemin, maintenant })', 'quota.decisionAgentCodex({ agent, chemin })'),

  // enchaînement
  m('continuer-absence', 'enchaînement', '  nuitActive({ agent, session, maintenant });\n  const etat = lireEtat();', '  const etat = lireEtat();'),
  m('continuer-etat', 'enchaînement', 'logique.decisionContinuation({\n    etat,\n    reason,', 'logique.decisionContinuation({\n    etat: logique.etatParDefaut(),\n    reason,'),
  m('continuer-reason', 'enchaînement', '    etat,\n    reason,\n    lignes', '    etat,\n    reason: \'answer\',\n    lignes'),
  m('continuer-lignes', 'enchaînement', '    lignes: lignesDe(agent),', '    lignes: [],'),
  m('continuer-lignes-agent', 'enchaînement', '    lignes: lignesDe(agent),', "    lignes: lignesDe('claude'),"),
  m('continuer-session', 'enchaînement', '    lignes: lignesDe(agent),\n    session,', "    lignes: lignesDe(agent),\n    session: 'S1',"),
  m('continuer-pause', 'enchaînement', '    pause: evalue && regulateur.lirePolitique().pause,', '    pause: false,'),
  m('continuer-pause-sens', 'enchaînement', '    pause: evalue && regulateur.lirePolitique().pause,', '    pause: evalue && !regulateur.lirePolitique().pause,'),
  m('continuer-quota', 'enchaînement', '    quotaCritique: evalue && quotaCritique({ agent, chemin, maintenant }),', '    quotaCritique: false,'),
  m('continuer-quota-chemin', 'enchaînement', '    quotaCritique: evalue && quotaCritique({ agent, chemin, maintenant }),', '    quotaCritique: evalue && quotaCritique({ agent, maintenant }),'),
  m('continuer-quota-instant', 'enchaînement', '    quotaCritique: evalue && quotaCritique({ agent, chemin, maintenant }),', '    quotaCritique: evalue && quotaCritique({ agent, chemin }),'),
  m('continuer-ecriture', 'enchaînement', '  if (JSON.stringify(d.etat) !== JSON.stringify(etat)) ecrireEtat(d.etat);\n  return d;', '  return d;'),
  m('continuer-ecriture-toujours', 'enchaînement', 'if (JSON.stringify(d.etat) !== JSON.stringify(etat)) ecrireEtat(d.etat);', 'ecrireEtat(d.etat);'),
  m('continuer-ecriture-ancien', 'enchaînement', 'ecrireEtat(d.etat);\n  return d;', 'ecrireEtat(etat);\n  return d;'),
  m('continuer-retour', 'enchaînement', '  return d;\n}', '  return { continuer: d.continuer };\n}'),

  // conversation inconnue
  m('lignes-session-vide', 'sans conversation connue', "typeof session === 'string' && session !== '' ?", "typeof session === 'string' ?"),
  m('lignes-session-type', 'sans conversation connue', "typeof session === 'string' && session !== '' ?", "session !== '' ?"),
  m('lignes-session-inconnue', 'sans conversation connue', ".length : null);", ".length : 0);"),

  // opérations des hooks : commande, garde, entrée
  m('hook-delai', 'opérations des hooks', 'const DELAI_GARDE_MS = 5000;', 'const DELAI_GARDE_MS = 5;'),
  m('hook-delai-env', 'opérations des hooks', 'timeout: Number(process.env.NUIT_GARDE_DELAI_MS) || DELAI_GARDE_MS,', 'timeout: DELAI_GARDE_MS,'),
  m('hook-delai-aucun', 'opérations des hooks', '    timeout: Number(process.env.NUIT_GARDE_DELAI_MS) || DELAI_GARDE_MS,\n', ''),
  m('hook-commande-objet', 'opérations des hooks', '  if (!objet(entreeOutil)) return null;\n  for (const cle of', '  for (const cle of'),
  m('hook-commande-command', 'opérations des hooks', "for (const cle of ['command', 'cmd', 'script', 'input']) {", "for (const cle of ['cmd', 'script', 'input']) {"),
  m('hook-commande-script', 'opérations des hooks', "for (const cle of ['command', 'cmd', 'script', 'input']) {", "for (const cle of ['command', 'cmd', 'input']) {"),
  m('hook-commande-input', 'opérations des hooks', "for (const cle of ['command', 'cmd', 'script', 'input']) {", "for (const cle of ['command', 'cmd', 'script']) {"),
  m('hook-commande-ordre', 'opérations des hooks', "for (const cle of ['command', 'cmd', 'script', 'input']) {", "for (const cle of ['input', 'script', 'cmd', 'command']) {"),
  m('hook-commande-type', 'opérations des hooks', "if (typeof entreeOutil[cle] === 'string' && entreeOutil[cle].trim() !== '') return entreeOutil[cle];", "if (entreeOutil[cle]) return String(entreeOutil[cle]);"),
  m('hook-commande-vide', 'opérations des hooks', "if (typeof entreeOutil[cle] === 'string' && entreeOutil[cle].trim() !== '') return entreeOutil[cle];", "if (typeof entreeOutil[cle] === 'string') return entreeOutil[cle];"),
  m('hook-garde-chemin-env', 'opérations des hooks', "process.env.NUIT_GARDE || path.join(__dirname, '..', 'gardes', 'securite.js')", "path.join(__dirname, '..', 'gardes', 'securite.js')"),
  m('hook-garde-chemin', 'opérations des hooks', "path.join(__dirname, '..', 'gardes', 'securite.js')", "path.join(__dirname, '..', 'gardes', 'securite-autre.js')"),
  m('hook-garde-evenement', 'opérations des hooks', "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })", "JSON.stringify({ tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })"),
  m('hook-garde-outil', 'opérations des hooks', "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })", "JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })"),
  m('hook-garde-entree', 'opérations des hooks', "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })", "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, cwd: entree.cwd, session_id: entree.session })"),
  m('hook-garde-cwd', 'opérations des hooks', "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })", "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, session_id: entree.session })"),
  m('hook-garde-session', 'opérations des hooks', "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd, session_id: entree.session })", "JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: entree.tool_name, tool_input: entree.tool_input, cwd: entree.cwd })"),
  m('hook-garde-erreur', 'opérations des hooks', '  if (r.error) return null;\n', ''),
  m('hook-garde-json', 'opérations des hooks', "try { return JSON.parse(r.stdout); } catch (_) { return null; }", 'return JSON.parse(r.stdout);'),
  m('hook-refus-commande', 'opérations des hooks', "if (commande === null || !nuitActive(ctx)) return { refuser: false };", "if (!nuitActive(ctx)) return { refuser: false };"),
  m('hook-refus-nuit', 'opérations des hooks', "if (commande === null || !nuitActive(ctx)) return { refuser: false };", "if (commande === null) return { refuser: false };"),
  m('hook-refus-sortie', 'opérations des hooks', 'return refuserGarde({ ...ctx, sortie: executerGarde(entree), commande });', 'return refuserGarde({ ...ctx, sortie: null, commande });'),
  m('hook-refus-commande-transmise', 'opérations des hooks', 'return refuserGarde({ ...ctx, sortie: executerGarde(entree), commande });', 'return refuserGarde({ ...ctx, sortie: executerGarde(entree) });'),
  m('hook-entree-objet', 'opérations des hooks', "if (!objet(entree) || !agentValide(entree.agent) ||", "if (!agentValide(entree.agent) ||"),
  m('hook-entree-agent', 'opérations des hooks', "if (!objet(entree) || !agentValide(entree.agent) ||", "if (!objet(entree) ||"),
  m('hook-entree-session-type', 'opérations des hooks', "typeof entree.session !== 'string' || entree.session === '') return { erreur: 'entrée invalide' };", "entree.session === '') return { erreur: 'entrée invalide' };"),
  m('hook-entree-session-vide', 'opérations des hooks', "typeof entree.session !== 'string' || entree.session === '') return { erreur: 'entrée invalide' };", "typeof entree.session !== 'string') return { erreur: 'entrée invalide' };"),
  m('hook-entree-message', 'opérations des hooks', "return { erreur: 'entrée invalide' };", "return { erreur: 'invalide' };"),
  m('hook-instant', 'opérations des hooks', 'maintenant: Number.isFinite(entree.maintenant) ? entree.maintenant : Date.now() };', 'maintenant: Date.now() };'),
  m('hook-instant-defaut', 'opérations des hooks', 'maintenant: Number.isFinite(entree.maintenant) ? entree.maintenant : Date.now() };', 'maintenant: entree.maintenant };'),
  m('hook-question', 'opérations des hooks', 'case \'question\': return refuserQuestion({ ...ctx, entreeOutil: entree.tool_input });', 'case \'question\': return refuserQuestion({ ...ctx });'),
  m('hook-question-op', 'opérations des hooks', "case 'question': return refuserQuestion(", "case 'questions': return refuserQuestion("),
  m('hook-garde-op', 'opérations des hooks', "case 'garde': return refuserCommande(ctx, entree);", "case 'gardes': return refuserCommande(ctx, entree);"),
  m('hook-continuer-reason', 'opérations des hooks', "return continuer({ ...ctx, reason: entree.reason, chemin:", "return continuer({ ...ctx, reason: 'answer', chemin:"),
  m('hook-continuer-chemin-perdu', 'opérations des hooks', "chemin: typeof entree.chemin === 'string' ? entree.chemin : undefined });", 'chemin: undefined });'),
  m('hook-continuer-op', 'opérations des hooks', "case 'continuer': return continuer(", "case 'continuers': return continuer("),
  m('hook-activite-op', 'opérations des hooks', "case 'activite': return noterActivite(ctx);", "case 'activites': return noterActivite(ctx);"),
  m('hook-defaut', 'opérations des hooks', 'default: return { erreur: `opération inconnue : ${operation}` };', 'default: return { erreur: `opération inconnue` };'),
  m('hook-panne', 'opérations des hooks', "  } catch (e) {\n    return { erreur: message(e) };\n  }\n}\n\nmodule.exports", "  } catch (e) {\n    throw e;\n  }\n}\n\nmodule.exports"),
  m('hook-panne-message', 'opérations des hooks', 'return { erreur: message(e) };', "return { erreur: 'panne' };"),
  m('hook-commande-op', 'opérations des hooks', "case 'commande': return appliquerCommande(", "case 'commandes': return appliquerCommande("),
  m('hook-commande-args', 'opérations des hooks', "appliquerCommande(typeof entree.args === 'string' ? entree.args : '', ctx);", 'appliquerCommande(entree.args, ctx);'),
  m('hook-commande-args-perdus', 'opérations des hooks', "appliquerCommande(typeof entree.args === 'string' ? entree.args : '', ctx);", "appliquerCommande('', ctx);"),
  m('hook-commande-contexte', 'opérations des hooks', "appliquerCommande(typeof entree.args === 'string' ? entree.args : '', ctx);", "appliquerCommande(typeof entree.args === 'string' ? entree.args : '', { agent: ctx.agent, session: ctx.session });"),
  m('hook-commande-session', 'opérations des hooks', "appliquerCommande(typeof entree.args === 'string' ? entree.args : '', ctx);", "appliquerCommande(typeof entree.args === 'string' ? entree.args : '', { ...ctx, session: 'S1' });"),

  // récap
  m('recap-etat', 'récap', 'logique.texteRecap(lireEtat(), lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) });', 'logique.texteRecap(logique.etatParDefaut(), lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) });'),
  m('recap-boite', 'récap', 'logique.texteRecap(lireEtat(), lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) });', 'logique.texteRecap(lireEtat(), logique.boiteParDefaut(), { maintenant, lignesMaintenant: nbLignes(agent, session) });'),
  m('recap-lignes', 'récap', 'logique.texteRecap(lireEtat(), lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) });', 'logique.texteRecap(lireEtat(), lireBoite(), { maintenant, lignesMaintenant: 0 });'),
  m('recap-instant', 'récap', 'logique.texteRecap(lireEtat(), lireBoite(), { maintenant, lignesMaintenant: nbLignes(agent, session) });', 'logique.texteRecap(lireEtat(), lireBoite(), { lignesMaintenant: nbLignes(agent, session) });'),
];

// RÉALIGNEMENTS : le verrou sur les fichiers de la nuit, les questions mises en boîte par lot et la commande autorisée par empreinte ont
// réécrit les lignes que ces mutations visaient. Aucune n'est supprimée : la définition d'origine reste plus haut, avec son nom, sa suite et
// son intention ; ici, seule sa cible (fragment visé, altération) est réécrite sur le code actuel. Forme : nom -> [fragment visé, altération].
const ANALYSER = 'logique.analyserCommande(args, etat, boite, { maintenant, lignesOuvertes });';
const ECRIRE = "try { ecrire(); } catch (e) { return `Écriture impossible dans ${fichier()} (${message(e)}) : rien n'a changé.`; }";
const ACTIVER = 'logique.activerSiAbsent(relu, maintenant, lignes);';
const QUESTION = "mettreEnBoite(questions.map(q => ({ agent, session, type: 'question', titre: q.titre,";
const QUESTION_FIN = 'titre: q.titre, details: q.details, options: q.options, maintenant })));';
const NOUVELLE = 'resultats.push({ id: r.entree.id, cause: undefined, nouvelle: !r.deja });';
const RENDU = 'return { resultats: resultats.map(r => ({ id: r.id, cause: r.cause })), enAttente: logique.enAttente(boite).length, lot };';
const PANNE = "  } catch (e) {\n    return toutes(e instanceof VerrouOccupe ? 'verrou' : 'ecriture');\n  }\n}";
const ASK = "  if (analyse.genre === 'ask') {\n    const empreinte";
const TEXTE_GARDE = 'texteRefusGarde({ genre: analyse.genre, raison: analyse.raison, id, cause }) };';
const MESURE = 'return { evalue, lignes: lignesDe(agent), pause: evalue && regulateur.lirePolitique().pause, quotaCritique: evalue && quotaCritique({ agent, chemin, maintenant }) };';
const DECISION = 'logique.decisionContinuation({ etat, reason, lignes: m.lignes, session, pause: m.pause, quotaCritique: m.quotaCritique });';
const REFUS_COMMANDE = 'return refuserGarde({ ...ctx, sortie: executerGarde(entree, ctx.agent), commande, attestees: entree.autorisees });';
const REALIGNEMENTS = {
  // commande : l'analyse est maintenant rejouée sous le verrou, les écritures sont une liste filtrée
  'ncore-commande-erreur': ['    if (r.erreur) return { r, ecritures: [] };\n', ''],
  'ncore-commande-lignes': ['  const lignesOuvertes = nbLignes(agent, session);\n  const analyser', '  const lignesOuvertes = 0;\n  const analyser'],
  'ncore-commande-instant': [ANALYSER, ANALYSER.replace('{ maintenant, lignesOuvertes }', '{ lignesOuvertes }')],
  'ncore-commande-ecriture-continue': ['    ].filter(([change]) => change) };', '    ] };'],
  'ncore-commande-ecriture-erreur': [ECRIRE, 'ecrire();'],
  // activité de l'utilisateur et réveil
  'ncore-activite-etat': ['    const note = logique.noterActivite(lireEtat(), maintenant);\n    ecrireEtat(note.etat);', '    const note = logique.noterActivite(lireEtat(), maintenant);'],
  // absence détectée : l'activation se fait maintenant sous le verrou, sur l'état relu
  'ncore-absence-garde': ['  if (!logique.absenceAtteinte(etat, maintenant)) return false;\n  const lignes', '  const lignes'],
  'ncore-absence-lignes': [ACTIVER, 'logique.activerSiAbsent(relu, maintenant);'],
  'ncore-absence-instant': [ACTIVER, 'logique.activerSiAbsent(relu, Date.now(), lignes);'],
  'ncore-absence-ecriture': ['      if (r.active) ecrireEtat(r.etat);\n', ''],
  // question refusée : une entrée de boîte par question de l'appel
  'ncore-question-lecture': ['const questions = logique.entreesDeQuestions(entreeOutil);', 'const questions = logique.entreesDeQuestions(undefined);'],
  'ncore-question-type': [QUESTION, QUESTION.replace("type: 'question'", "type: 'action'")],
  'ncore-question-details': [QUESTION_FIN, QUESTION_FIN.replace('details: q.details, ', '')],
  'ncore-question-options': [QUESTION_FIN, QUESTION_FIN.replace(', options: q.options', '')],
  'ncore-question-instant': [QUESTION_FIN, QUESTION_FIN.replace('maintenant })));', 'maintenant: Date.now() })));')],
  'ncore-question-session': [QUESTION, QUESTION.replace('{ agent, session, type', "{ agent, session: 'S1', type")],
  'ncore-question-agent': [QUESTION, QUESTION.replace('{ agent, session, type', "{ agent: 'claude', session, type")],
  'ncore-question-compte': ["  compter('question', questions.length);\n", ''],
  'ncore-question-compte-genre': ["  compter('question', questions.length);", "  compter('garde', questions.length);"],
  'ncore-question-retour-refus': ['return { refuser: true, id: mise.resultats[0].id, ids:', 'return { refuser: false, id: mise.resultats[0].id, ids:'],
  'ncore-question-retour-id': ['    id: mise.resultats[0].id,\n    cause: mise.resultats[0].cause,', '    id: null,\n    cause: mise.resultats[0].cause,'],
  'ncore-question-retour-attente': ['    enAttente: mise.enAttente,\n', '    enAttente: 0,\n'],
  'ncore-question-retour-options': ['    options: questions[0].options,\n', '    options: [],\n'],
  // mise en boîte : plusieurs entrées en une écriture, sous le verrou
  'ncore-boite-refus': ['        if (r.refus !== undefined) { resultats.push({ id: null, cause: r.refus }); continue; }\n', ''],
  'ncore-boite-deja': [NOUVELLE, NOUVELLE.replace('nouvelle: !r.deja', 'nouvelle: true')],
  'ncore-boite-jamais-ecrite': [NOUVELLE, NOUVELLE.replace('nouvelle: !r.deja', 'nouvelle: false')],
  'ncore-boite-id': [RENDU, RENDU.replace('({ id: r.id, cause: r.cause })', '({ id: r.id + 1, cause: r.cause })')],
  'ncore-boite-attente-avant': [RENDU, RENDU.replace('logique.enAttente(boite).length', 'logique.enAttente(boite).length - resultats.filter(x => x.nouvelle).length')],
  'ncore-boite-panne': ['const toutes = cause => ({ resultats: entrees.map(() => ({ id: null, cause })), enAttente: 0, lot: null });', 'const toutes = cause => ({ resultats: entrees.map(() => ({ id: 1, cause })), enAttente: 0, lot: null });'],
  'ncore-boite-panne-relancee': [PANNE, '  } finally {\n  }\n}'],
  'ncore-compter-panne': ['  } catch (_) { /* le refus est dit quand même */ }', '  } finally { /* la panne remonte */ }'],
  'ncore-compter-ajout': ['      for (let i = 0; i < n; i++) etat = logique.compterRefus(etat, genre);\n', ''],
  // arrêt de garde : la demande d'accord porte maintenant l'empreinte de la commande
  'ncore-garde-ask': [ASK, ASK.replace("=== 'ask'", "!== 'ask'")],
  'ncore-garde-ask-toujours': [ASK, ASK.replace("analyse.genre === 'ask'", 'true')],
  'ncore-garde-type': ["mettreEnBoite([{ agent, session, type: 'action', ...logique.actionDeGarde(", "mettreEnBoite([{ agent, session, type: 'question', ...logique.actionDeGarde("],
  'ncore-garde-instant': ['...logique.actionDeGarde({ commande, raison: analyse.raison }), empreinte, maintenant }]).resultats[0]);', '...logique.actionDeGarde({ commande, raison: analyse.raison }), empreinte, maintenant: Date.now() }]).resultats[0]);'],
  'ncore-garde-retour-id': ['raison: analyse.raison, id, cause }) };', 'raison: analyse.raison, cause }) };'],
  'ncore-garde-retour-raison': [TEXTE_GARDE, TEXTE_GARDE.replace('raison: analyse.raison', 'raison: undefined')],
  'ncore-garde-retour-genre-texte': [TEXTE_GARDE, TEXTE_GARDE.replace('genre: analyse.genre', "genre: 'bloc'")],
  // enchaînement : les mesures lentes sont prises avant le verrou, la décision et son écriture sous lui
  'ncore-continuer-absence': ['  nuitActive({ agent, session, maintenant });\n  // Les mesures lentes', '  // Les mesures lentes'],
  'ncore-continuer-etat': [DECISION, DECISION.replace('{ etat, reason,', '{ etat: logique.etatParDefaut(), reason,')],
  'ncore-continuer-reason': [DECISION, DECISION.replace('{ etat, reason,', "{ etat, reason: 'answer',")],
  'ncore-continuer-lignes': [MESURE, MESURE.replace('lignes: lignesDe(agent)', 'lignes: []')],
  'ncore-continuer-lignes-agent': [MESURE, MESURE.replace('lignes: lignesDe(agent)', "lignes: lignesDe('claude')")],
  'ncore-continuer-session': [DECISION, DECISION.replace('lignes: m.lignes, session,', "lignes: m.lignes, session: 'S1',")],
  'ncore-continuer-pause': [MESURE, MESURE.replace('pause: evalue && regulateur.lirePolitique().pause', 'pause: false')],
  'ncore-continuer-pause-sens': [MESURE, MESURE.replace('evalue && regulateur.lirePolitique().pause', 'evalue && !regulateur.lirePolitique().pause')],
  'ncore-continuer-quota': [MESURE, MESURE.replace('quotaCritique: evalue && quotaCritique({ agent, chemin, maintenant })', 'quotaCritique: false')],
  'ncore-continuer-quota-chemin': [MESURE, MESURE.replace('quotaCritique({ agent, chemin, maintenant })', 'quotaCritique({ agent, maintenant })')],
  'ncore-continuer-quota-instant': [MESURE, MESURE.replace('quotaCritique({ agent, chemin, maintenant })', 'quotaCritique({ agent, chemin })')],
  'ncore-continuer-ecriture': ['    if (JSON.stringify(d.etat) !== JSON.stringify(etat)) ecrireEtat(d.etat);\n    return d;', '    return d;'],
  'ncore-continuer-ecriture-ancien': ['ecrireEtat(d.etat);\n    return d;', 'ecrireEtat(etat);\n    return d;'],
  'ncore-continuer-retour': ['    return d;\n  });\n}\n\nconst recap', '    return { continuer: d.continuer };\n  });\n}\n\nconst recap'],
  // opérations des hooks : les accords attestés par l'adaptateur sont transmis avec la commande
  'ncore-hook-refus-sortie': [REFUS_COMMANDE, REFUS_COMMANDE.replace('sortie: executerGarde(entree, ctx.agent)', 'sortie: null')],
  'ncore-hook-refus-commande-transmise': [REFUS_COMMANDE, REFUS_COMMANDE.replace(', commande, attestees', ', attestees')],
};
for (const mutation of MUTATIONS) {
  const cible = REALIGNEMENTS[mutation.nom];
  if (cible) [mutation.de, mutation.vers] = cible;
}

executer({
  source: path.join(LIB, 'nuit-core.js'),
  banc: path.join(__dirname, '..', 'nuit-core.test.js'),
  variable: 'NUIT_CORE_TESTE',
  mutations: MUTATIONS.concat([
    // Archive des décisions sorties de la boîte, réponse à une question d'une autre conversation.
    m('archive-ecrite', 'archive de la boîte', 'try { archiver(evincees); ecrireBoite(boite); } catch (_) {', 'try { ecrireBoite(boite); } catch (_) {'),
    m('archive-apres-boite', 'archive de la boîte', 'try { archiver(evincees); ecrireBoite(boite); } catch (_) {', 'try { ecrireBoite(boite); archiver(evincees); } catch (_) {'),
    m('archive-collecte', 'archive de la boîte', 'if (r.evincee !== undefined) evincees.push(r.evincee);', '// entrée évincée oubliée'),
    m('archive-vide', 'archive de la boîte', 'if (entrees.length === 0) return;\n  const archiveLe', 'const archiveLe'),
    m('archive-date', 'archive de la boîte', 'entrees.map(e => `${JSON.stringify({ ...e, archiveLe })}\\n`)', 'entrees.map(e => `${JSON.stringify({ ...e })}\\n`)'),
    m('archive-lecture-forme', 'archive de la boîte', 'if (objet(e) && Number.isInteger(e.id)) out.push(e);', 'out.push(e);'),
    m('reponse-autre-conversation', 'archive de la boîte', "typeof origine === 'string' && origine !== session;", "typeof origine === 'string' && false;"),
    m('reponse-conversation-inconnue', 'archive de la boîte', "const ailleurs = typeof session === 'string' && session !== '' &&", 'const ailleurs ='),
    m('reponse-autre-message', 'archive de la boîte', "message: `${r.message} Attention :", 'message: `Attention :'),
    // Réglages refusés pendant une nuit active, réponses de la boîte dites sans attendre la fin du tour.
    m('reglage-refuse', 'réglages pendant une nuit active', 'if (REGLAGES.includes(premier) && lireEtat().actif) return { erreur: REFUS_REGLAGE };', '// réglages permis pendant la nuit'),
    m('reglage-hors-nuit', 'réglages pendant une nuit active', 'if (REGLAGES.includes(premier) && lireEtat().actif) return { erreur: REFUS_REGLAGE };', 'if (REGLAGES.includes(premier)) return { erreur: REFUS_REGLAGE };'),
    m('reglage-lesquels', 'réglages pendant une nuit active', "const REGLAGES = ['tours', 'absence', 'defaut'];", "const REGLAGES = ['tours'];"),
    m('reglage-casse', 'réglages pendant une nuit active', "const premier = String(args == null ? '' : args).trim().split(/\\s+/)[0].toLowerCase();", "const premier = String(args == null ? '' : args).trim().split(/\\s+/)[0];"),
    m('livraison-une-fois', 'réglages pendant une nuit active', 'const pretes = lireBoite().entrees.filter(e => aDire(e) && livrees[e.id] === undefined);', 'const pretes = lireBoite().entrees.filter(e => aDire(e));'),
    m('livraison-conversation', 'réglages pendant une nuit active', "const aDire = e => e.agent === agent && e.session === session && e.statut === 'repondue' && Date.parse(e.traite) > depuis;", "const aDire = e => e.agent === agent && e.statut === 'repondue' && Date.parse(e.traite) > depuis;"),
    m('livraison-depuis', 'réglages pendant une nuit active', "e.statut === 'repondue' && Date.parse(e.traite) > depuis;", "e.statut === 'repondue';"),
    m('livraison-repondue', 'réglages pendant une nuit active', "e.session === session && e.statut === 'repondue' && Date.parse(e.traite) > depuis;", 'e.session === session && Date.parse(e.traite) > depuis;'),
    m('livraison-nuit-finie', 'réglages pendant une nuit active', "const finie = !actif && e.type === 'action' && e.reponse === logique.REPONSE_AUTORISER ? NUIT_FINIE : '';", "const finie = '';"),
    m('livraison-nuit-active', 'réglages pendant une nuit active', "const finie = !actif && e.type === 'action'", "const finie = e.type === 'action'"),
    // Les noms d'agents du dépôt (deepseek_H) : convertis en clé d'état, lus sous les deux formes dans la liste de travail, donnés à la garde.
    m('cle-question', 'agents du dépôt', 'function refuserQuestion({ agent, session, entreeOutil, maintenant = Date.now() }) {\n  agent = cleDe(agent);', 'function refuserQuestion({ agent, session, entreeOutil, maintenant = Date.now() }) {'),
    m('cle-garde', 'agents du dépôt', 'function refuserGarde({ agent, session, sortie, commande, attestees, maintenant = Date.now() }) {\n  agent = cleDe(agent);', 'function refuserGarde({ agent, session, sortie, commande, attestees, maintenant = Date.now() }) {'),
    m('cle-livraisons', 'agents du dépôt', 'function reponsesALivrer({ agent, session, depuis, maintenant = Date.now() }) {\n  agent = cleDe(agent);', 'function reponsesALivrer({ agent, session, depuis, maintenant = Date.now() }) {'),
    m('cle-empreinte', 'agents du dépôt', 'JSON.stringify([cleDe(agent), session, commande])', 'JSON.stringify([agent, session, commande])'),
    m('cle-sans-agent', 'agents du dépôt', 'const cleDe = agent => cleAgent(agent) ?? agent;', 'const cleDe = agent => agent;'),
    m('cle-liste', 'agents du dépôt', 'const noms = nomsListe(agent);', 'const noms = [agent];'),
    m('cle-liste-sans-cle', 'agents du dépôt', 'const noms = nomsListe(agent);', 'const noms = nomsListe(agent).filter(nom => nom === agent);'),
    m('cle-valide', 'agents du dépôt', 'const agentValide = v => cleAgent(v) !== null;', "const agentValide = v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v);"),
    m('cle-valide-tout', 'agents du dépôt', 'const agentValide = v => cleAgent(v) !== null;', "const agentValide = v => typeof v === 'string' && v !== '';"),
    m('garde-agent-nom', 'agents du dépôt', 'AGENTS.find(a => cleAgent(a) === cleDe(agent))', 'AGENTS.find(a => a === agent)'),
    m('garde-agent-casse', 'agents du dépôt', 'AGENTS.find(a => cleAgent(a) === cleDe(agent))', 'AGENTS.find(a => a.toLowerCase() === String(agent).toLowerCase())'),
    m('garde-args-perdus', 'opérations des hooks', ", ...(nom === undefined ? [] : ['--agent', nom])", ''),
    m('garde-args-nom', 'opérations des hooks', "['--agent', nom]", "['--agent', agent]"),
    m('hook-commande-cmd', 'opérations des hooks', "for (const cle of ['command', 'cmd', 'script', 'input']) {", "for (const cle of ['command', 'script', 'input']) {"),
    m('hook-commande-cmd-apres-script', 'opérations des hooks', "for (const cle of ['command', 'cmd', 'script', 'input']) {", "for (const cle of ['command', 'script', 'cmd', 'input']) {"),
    m('hook-garde-agent-transmis', 'opérations des hooks', 'sortie: executerGarde(entree, ctx.agent)', 'sortie: executerGarde(entree)'),
  ]),
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    // La garde de sécurité se cherche à côté du noyau (__dirname) : dans la copie mutée, il faut le chemin de la vraie. Sans cette réécriture,
    // le test de la vraie garde échouait pour toute mutation de sa suite, et des mutations équivalentes passaient pour tuées.
    ["path.join(__dirname, '..', 'gardes', 'securite.js')", JSON.stringify(path.join(LIB, '..', 'gardes', 'securite.js'))],
    ["require('./cockpit-core.js')", `require(${JSON.stringify(path.join(LIB, 'cockpit-core.js'))})`],
    ["require('./regulateur-core.js')", `require(${JSON.stringify(path.join(LIB, 'regulateur-core.js'))})`],
    ["require('./quota-core.js')", `require(${JSON.stringify(path.join(LIB, 'quota-core.js'))})`],
    ["require('./nuit-logique.mjs')", `require(${JSON.stringify(path.join(LIB, 'nuit-logique.mjs'))})`],
    ["require('./config.js')", `require(${JSON.stringify(path.join(LIB, 'config.js'))})`],
    ["require('./agents-noms.js')", `require(${JSON.stringify(path.join(LIB, 'agents-noms.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
