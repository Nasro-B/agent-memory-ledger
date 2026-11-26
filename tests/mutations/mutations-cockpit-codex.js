'use strict';
// Preuve par mutation du banc cockpit-codex.test.js (adaptateur Codex du Cockpit).
//   node tests/mutations/mutations-cockpit-codex.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-cockpit-codex.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-cockpit-codex.js --liste         affiche les noms
// Limite connue, non couverte par mutation : le détachement du processus de mesure git (`detached`, `unref`) ne se
// prouve que par le temps de réponse, trop dépendant de la charge ; l'essai réel des tests « mesure git en arrière-plan »
// vérifie en revanche que la mesure arrive bien après la réponse.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const MUTATIONS = [
  { nom: 'codex-delai-injection-trop-court', suite: 'injection', de: 'const DELAI_INJECTION_MS = 10 * 60 * 1000;', vers: 'const DELAI_INJECTION_MS = 1 * 60 * 1000;' },
  { nom: 'codex-age-git-trop-tolerant', suite: 'mesure git', de: 'const AGE_GIT_MAX_S = 10 * 60;', vers: 'const AGE_GIT_MAX_S = 60 * 60;' },
  { nom: 'codex-purge-trop-lente', suite: 'entretien', de: 'const PURGE_MS = 3 * 24 * 3600 * 1000;', vers: 'const PURGE_MS = 30 * 24 * 3600 * 1000;' },
  { nom: 'codex-empreinte-avec-horodatage', suite: 'injection', de: ".update(String(bloc).replace(ENTETE, ''))", vers: '.update(String(bloc))' },
  { nom: 'codex-empreinte-partielle', suite: 'injection', de: ".update(String(bloc).replace(ENTETE, ''))", vers: ".update(String(bloc).replace(ENTETE, '').slice(0, 30))" },
  { nom: 'codex-sous-agent-par-id-seul', suite: 'sortie', de: 'if (entree.agent_id || entree.agent_type) return null;', vers: 'if (entree.agent_id) return null;' },
  { nom: 'codex-sous-agent-servi', suite: 'sortie', de: 'if (entree.agent_id || entree.agent_type) return null;', vers: '' },
  { nom: 'codex-tous-evenements', suite: 'sortie', de: "if (evenement !== 'SessionStart' && evenement !== 'UserPromptSubmit' && evenement !== 'PostCompact' && evenement !== 'PostToolUse') return null;", vers: '' },
  { nom: 'codex-session-non-assainie', suite: 'injection', de: ".replace(/[^A-Za-z0-9_-]/g, '_')", vers: '' },
  { nom: 'codex-session-non-coupee', suite: 'injection', de: '.slice(0, 64)', vers: '' },
  { nom: 'codex-agent-non-valide', suite: 'sortie', de: '  return cleAgent(i >= 0 ? argv[i + 1] : undefined);', vers: "  const a = i >= 0 ? argv[i + 1] : undefined;\n  return typeof a === 'string' && /^.{0,31}$/.test(a) ? a : null;" },
  { nom: 'codex-agent-non-converti', suite: 'injection', de: '  return cleAgent(i >= 0 ? argv[i + 1] : undefined);', vers: "  const a = i >= 0 ? argv[i + 1] : undefined;\n  return typeof a === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(a) ? a : null;" },
  { nom: 'codex-session-ou-agent-absent', suite: 'sortie', de: 'if (!agent || !session) return null;', vers: 'if (!agent) return null;' },
  { nom: 'codex-agent-absent-servi', suite: 'sortie', de: 'if (!agent || !session) return null;', vers: 'if (!session) return null;' },
  { nom: 'codex-sans-purge', suite: 'entretien', de: "if (evenement === 'SessionStart') purger(core.racine());", vers: '' },
  { nom: 'codex-purge-tout-fichier', suite: 'entretien', de: 'if (!/^inj-.*\\.(?:json|compacte)$/.test(nom)) continue;', vers: '' },
  { nom: 'codex-git-sans-worktree', suite: 'mesure git', de: 'if (!config.worktrees.length) return;', vers: '' },
  { nom: 'codex-git-toujours-relance', suite: 'mesure git', de: 'if (g && g.ageS !== null && g.ageS <= AGE_GIT_MAX_S) return;', vers: '' },
  { nom: 'codex-git-jamais-lance', suite: 'mesure git', de: "spawn(process.execPath, [path.join(__dirname, '..', 'cockpit.js'), 'rafraichir-git']", vers: "spawn(process.execPath, [path.join(__dirname, '..', 'cockpit.js'), 'ligne']" },
  { nom: 'codex-nom-evenement-fixe', suite: 'sortie', de: 'hookEventName: evenement', vers: "hookEventName: 'SessionStart'" },
  { nom: "codex-etat-sans-heure", suite: "injection", de: "core.ecrireJson(fichier, { empreinte: emp, ts: Date.now(), consignes: empConsignes, quota: empQuota });", vers: "core.ecrireJson(fichier, { empreinte: emp, consignes: empConsignes, quota: empQuota });" },
  { nom: "codex-etat-sans-empreinte", suite: "injection", de: "core.ecrireJson(fichier, { empreinte: emp, ts: Date.now(), consignes: empConsignes, quota: empQuota });", vers: "core.ecrireJson(fichier, { ts: Date.now(), consignes: empConsignes, quota: empQuota });" },
  { nom: "codex-inchange-reinjecte", suite: "injection", de: "    if (avant && avant.empreinte === emp) return null;\n", vers: "" },
  { nom: "codex-delai-ignore", suite: "injection", de: "if (avant && Date.now() - avant.ts < DELAI_INJECTION_MS && !(parQuota && parQuota.urgent) && empConsignes === consignesAvant && empQuota === avant.quota) return null;", vers: "" },
  { nom: 'codex-prompt-sans-controle', suite: 'injection', de: "if (evenement === 'UserPromptSubmit') {", vers: 'if (false) {' },
  { nom: 'codex-fichier-par-agent', suite: 'injection', de: 'inj-${agent}-${session}.json', vers: 'inj-${session}.json' },
  { nom: 'codex-erreur-bruyante', suite: 'sortie', de: '} catch (_) { /* silence */ }\n  process.exitCode = 0;', vers: '} catch (e) { process.stderr.write(String(e)); process.exitCode = 1; return; }\n  process.exitCode = 0;' },
  { nom: 'codex-entree-non-json', suite: 'sortie', de: 'try { entree = JSON.parse(texte); } catch (_) { return null; }', vers: 'entree = JSON.parse(texte);' },
  { nom: 'codex-entree-nulle', suite: 'sortie', de: 'if (!entree) return null;', vers: '' },
  // quota de Codex (Garde-quota)
  { nom: 'codex-quota-jamais', suite: 'quota de Codex', de: 'const parQuota = quotaDeCodex(agent, entree.transcript_path);', vers: 'const parQuota = null;' },
  { nom: 'codex-quota-apres-bloc', suite: 'quota de Codex', de: 'const parQuota = quotaDeCodex(agent, entree.transcript_path); // avant le bloc : il montre la mesure du moment\n  const instantane = core.instantane(config);\n  const bloc = core.blocCockpit(instantane);', vers: 'const instantane = core.instantane(config);\n  const bloc = core.blocCockpit(instantane);\n  const parQuota = quotaDeCodex(agent, entree.transcript_path);' },
  { nom: 'codex-quota-chemin-perdu', suite: 'quota de Codex', de: 'quotaDeCodex(agent, entree.transcript_path)', vers: 'quotaDeCodex(agent, undefined)' },
  { nom: 'codex-quota-lignes-perdues', suite: 'quota de Codex', de: '...(parQuota ? parQuota.lignes : [])', vers: '' },
  { nom: "codex-quota-avant-rappel", suite: "quota de Codex", de: "[bloc, rappel, ...(parQuota ? parQuota.lignes : []), parConsignes]", vers: "[bloc, ...(parQuota ? parQuota.lignes : []), rappel, parConsignes]" },
  { nom: "codex-quota-urgence-ignoree", suite: "quota de Codex", de: " && !(parQuota && parQuota.urgent) && empConsignes", vers: " && empConsignes" },
  { nom: "codex-quota-toujours-urgent", suite: "quota de Codex", de: " && !(parQuota && parQuota.urgent) && empConsignes", vers: " && !parQuota && empConsignes" },
  { nom: 'codex-quota-jamais-memorise', suite: 'quota de Codex', de: "if (parQuota) parQuota.persister(); // les annonces ne sont mémorisées que lorsqu'elles sont réellement remises\n", vers: '' },
  { nom: "codex-quota-memorise-avant-remise", suite: "quota de Codex", de: "if (evenement === 'UserPromptSubmit') {\n    if (avant && avant.empreinte === emp) return null;", vers: "if (parQuota) parQuota.persister();\n  if (evenement === 'UserPromptSubmit') {\n    if (avant && avant.empreinte === emp) return null;" },
  { nom: 'codex-quota-panne-propagee', suite: 'quota de Codex', de: '  try {\n    const fenetres = quota.fenetresCourantes({ agent, chemin });\n    return fenetres.length ? quota.suivreCodex({ agent, fenetres }) : null;\n  } catch (_) {\n    return null;\n  }', vers: '  const fenetres = quota.fenetresCourantes({ agent, chemin });\n  return fenetres.length ? quota.suivreCodex({ agent, fenetres }) : null;' },
  { nom: 'codex-quota-sans-fenetre-ecrit', suite: 'quota de Codex', de: 'return fenetres.length ? quota.suivreCodex({ agent, fenetres }) : null;', vers: 'return quota.suivreCodex({ agent, fenetres });' },
  { nom: 'codex-quota-agent-fige', suite: 'quota de Codex', de: 'quota.fenetresCourantes({ agent, chemin })', vers: "quota.fenetresCourantes({ agent: 'codex', chemin })" },
  { nom: 'codex-quota-suivi-agent-fige', suite: 'quota de Codex', de: 'quota.suivreCodex({ agent, fenetres })', vers: "quota.suivreCodex({ agent: 'codex', fenetres })" },
  // après un compactage
  { nom: 'codex-compactage-ignore', suite: 'après un compactage', de: " && evenement !== 'PostCompact' && evenement !== 'PostToolUse') return null;", vers: " && evenement !== 'PostToolUse') return null;" },
  { nom: 'codex-compactage-injecte', suite: 'après un compactage', de: "if (evenement === 'PostCompact') {", vers: 'if (false) {' },
  { nom: 'codex-compactage-sans-effacement', suite: 'après un compactage', de: 'try { fs.unlinkSync(fichier); oublie = true; } catch (_) { /* rien à oublier */ }', vers: '' },
  { nom: 'codex-compactage-efface-tout', suite: 'après un compactage', de: 'try { fs.unlinkSync(fichier); oublie = true; } catch (_) { /* rien à oublier */ }', vers: "for (const n of fs.readdirSync(core.racine())) { if (/^inj-/.test(n)) fs.unlinkSync(path.join(core.racine(), n)); }" },
  { nom: 'codex-compactage-erreur-bruyante', suite: 'après un compactage', de: 'try { fs.unlinkSync(fichier); oublie = true; } catch (_) { /* rien à oublier */ }', vers: 'fs.unlinkSync(fichier); oublie = true;' },
  // rappel du Régulateur d'agents
  { nom: "codex-rappel-jamais-injecte", suite: "rappel du Régulateur", de: "[bloc, rappel, ...(parQuota ? parQuota.lignes : []), parConsignes]", vers: "[bloc, ...(parQuota ? parQuota.lignes : []), parConsignes]" },
  { nom: 'codex-rappel-sans-saut-de-ligne', suite: 'rappel du Régulateur', de: ".filter(Boolean).join('\\n');", vers: ".filter(Boolean).join(' ');" },
  { nom: 'codex-rappel-sans-filtre', suite: 'rappel du Régulateur', de: '.filter(Boolean).join(', vers: '.join(' },
  { nom: 'codex-rappel-hors-empreinte', suite: 'rappel du Régulateur', de: 'const emp = empreinte(contexte);', vers: 'const emp = empreinte(bloc);' },
  { nom: "codex-rappel-hors-sortie", suite: "rappel du Régulateur", de: " : contexte } };", vers: " : bloc } };" },
  { nom: 'codex-rappel-politique-inerte-comptee', suite: 'rappel du Régulateur', de: 'if (!politique.pause && politique.max === null && !politique.relance) return null;', vers: '' },
  { nom: 'codex-rappel-garde-sans-pause', suite: 'rappel du Régulateur', de: 'if (!politique.pause && politique.max === null && !politique.relance) return null;', vers: 'if (politique.max === null && !politique.relance) return null;' },
  { nom: 'codex-rappel-garde-sans-plafond', suite: 'rappel du Régulateur', de: 'if (!politique.pause && politique.max === null && !politique.relance) return null;', vers: 'if (!politique.pause && !politique.relance) return null;' },
  { nom: 'codex-rappel-garde-sans-relance', suite: 'rappel du Régulateur', de: 'if (!politique.pause && politique.max === null && !politique.relance) return null;', vers: 'if (!politique.pause && politique.max === null) return null;' },
  { nom: 'codex-rappel-agent-fixe', suite: 'rappel du Régulateur', de: 'regulateur.etatAgents({ agent, session })', vers: "regulateur.etatAgents({ agent: 'codex', session })" },
  { nom: 'codex-rappel-sans-comptage', suite: 'rappel du Régulateur', de: 'regulateur.etatAgents({ agent, session })', vers: 'null' },
  { nom: 'codex-rappel-fil-assaini', suite: 'rappel du Régulateur', de: 'rappelRegulateur(agent, entree.session_id)', vers: 'rappelRegulateur(agent, session)' },
  { nom: 'codex-rappel-version-stable', suite: 'rappel du Régulateur', de: 'return logique.rappel(politique, regulateur.etatAgents({ agent, session }));', vers: 'return logique.rappelStable(politique);' },
  { nom: 'codex-rappel-panne-bloquante', suite: 'rappel du Régulateur', de: 'regulateur.etatAgents({ agent, session }));\n  } catch (_) {\n    return null;\n  }', vers: 'regulateur.etatAgents({ agent, session }));\n  } catch (e) {\n    throw e;\n  }' },
  // consignes en vigueur
  { nom: "codex-consignes-non-lues", suite: "consignes en vigueur", de: "const parConsignes = texteConsignes();", vers: "const parConsignes = null;" },
  { nom: "codex-consignes-hors-sortie", suite: "consignes en vigueur", de: "[bloc, rappel, ...(parQuota ? parQuota.lignes : []), parConsignes]", vers: "[bloc, rappel, ...(parQuota ? parQuota.lignes : [])]" },
  { nom: "codex-consignes-avant-le-rappel", suite: "consignes en vigueur", de: "[bloc, rappel, ...(parQuota ? parQuota.lignes : []), parConsignes]", vers: "[bloc, parConsignes, rappel, ...(parQuota ? parQuota.lignes : [])]" },
  { nom: "codex-consignes-panne-propagee", suite: "consignes en vigueur", de: "  try {\n    return consignes.texteInjection();\n  } catch (_) {\n    return null;\n  }", vers: "  return consignes.texteInjection();" },
  { nom: "codex-consignes-empreinte-ignoree", suite: "consignes en vigueur", de: "const empConsignes = parConsignes === null ? null : empreinte(parConsignes);", vers: "const empConsignes = null;" },
  { nom: "codex-consignes-empreinte-brute", suite: "consignes en vigueur", de: "parConsignes === null ? null : empreinte(parConsignes)", vers: "parConsignes" },
  { nom: "codex-consignes-etat-non-lu", suite: "consignes en vigueur", de: "avant && typeof avant.consignes === 'string' ? avant.consignes : null", vers: "null" },
  { nom: "codex-consignes-ancien-etat-mal-lu", suite: "consignes en vigueur", de: "avant && typeof avant.consignes === 'string' ? avant.consignes : null", vers: "avant ? avant.consignes : null" },
  { nom: "codex-consignes-etat-perdu", suite: "consignes en vigueur", de: ", ts: Date.now(), consignes: empConsignes, quota: empQuota }", vers: ", ts: Date.now(), quota: empQuota }" },
  { nom: "codex-levee-jamais", suite: "consignes en vigueur", de: "const levee = parConsignes === null && consignesAvant !== null;", vers: "const levee = false;" },
  { nom: "codex-levee-toujours", suite: "consignes en vigueur", de: "const levee = parConsignes === null && consignesAvant !== null;", vers: "const levee = parConsignes === null;" },
  { nom: "codex-levee-avec-consignes", suite: "consignes en vigueur", de: "const levee = parConsignes === null && consignesAvant !== null;", vers: "const levee = consignesAvant !== null;" },
  { nom: "codex-levee-texte-perdu", suite: "consignes en vigueur", de: "levee ? `${contexte}\\n${LEVEE_CONSIGNES}` : contexte", vers: "contexte" },
  { nom: "codex-levee-texte-change", suite: "consignes en vigueur", de: "const LEVEE_CONSIGNES = 'CONSIGNES EN VIGUEUR DE L\\'UTILISATEUR : aucune. Les consignes données avant sont levées.';", vers: "const LEVEE_CONSIGNES = 'Consignes levées.';" },
  { nom: "codex-levee-sans-saut-de-ligne", suite: "consignes en vigueur", de: "`${contexte}\\n${LEVEE_CONSIGNES}`", vers: "`${contexte}${LEVEE_CONSIGNES}`" },
  { nom: "codex-consignes-attendent-le-delai", suite: "consignes en vigueur", de: " && empConsignes === consignesAvant && empQuota === avant.quota) return null;", vers: " && empQuota === avant.quota) return null;" },
  { nom: "codex-consignes-jamais-inchangees", suite: "consignes en vigueur", de: " && empConsignes === consignesAvant && empQuota === avant.quota) return null;", vers: " && false && empQuota === avant.quota) return null;" },
  { nom: "codex-quota-attend-le-delai", suite: "quota de Codex", de: " && empConsignes === consignesAvant && empQuota === avant.quota) return null;", vers: " && empConsignes === consignesAvant) return null;" },
  { nom: "codex-quota-empreinte-sans-fenetres", suite: "quota de Codex", de: "{ fenetres: mesure.fenetres, source: mesure.source }", vers: "{ source: mesure.source }" },
  { nom: 'codex-outil-sans-marque', suite: 'compactage puis outil', de: 'try { fs.unlinkSync(marque); } catch (_) { return null; }', vers: 'try { fs.unlinkSync(marque); } catch (_) { /* continue */ }' },
  { nom: 'codex-outil-marque-non-prise', suite: 'compactage puis outil', de: 'try { fs.unlinkSync(marque); } catch (_) { return null; }', vers: 'if (!fs.existsSync(marque)) return null;' },
  { nom: 'codex-marque-posee-toujours', suite: 'compactage puis outil', de: "if (oublie) { try { fs.writeFileSync(marque, ''); } catch (_) { /* le message suivant réinjectera */ } }", vers: "try { fs.writeFileSync(marque, ''); } catch (_) { /* le message suivant réinjectera */ }" },
  { nom: 'codex-marque-jamais-posee', suite: 'compactage puis outil', de: "if (oublie) { try { fs.writeFileSync(marque, ''); } catch (_) { /* le message suivant réinjectera */ } }", vers: '' },
  { nom: 'codex-marque-par-agent', suite: 'compactage puis outil', de: '`inj-${agent}-${session}.compacte`', vers: '`inj-${session}.compacte`' },
  { nom: 'codex-message-garde-la-marque', suite: 'compactage puis outil', de: "    try { fs.unlinkSync(marque); } catch (_) { /* pas de compactage en attente */ }", vers: '' },
];

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

executer({
  source: path.join(SCRIPTS, 'codex', 'cockpit.js'),
  banc: path.join(__dirname, '..', 'cockpit-codex.test.js'),
  variable: 'COCKPIT_CODEX_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses chemins relatifs deviennent absolus.
  reecritures: [
    ["require('../lib/cockpit-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'cockpit-core.js'))})`],
    ["require('../lib/agents-noms.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'agents-noms.js'))})`],
    ["require('../lib/regulateur-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'regulateur-core.js'))})`],
    ["require('../lib/regulateur-logique.mjs')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'regulateur-logique.mjs'))})`],
    ["require('../lib/quota-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'quota-core.js'))})`],
    ["require('../lib/consignes-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'consignes-core.js'))})`],
    ["path.join(__dirname, '..', 'cockpit.js')", `path.join(${JSON.stringify(SCRIPTS)}, 'cockpit.js')`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
