'use strict';
// Preuve par mutation du banc regulateur-codex.test.js (adaptateur Codex du Régulateur d'agents : refus de lancement, file d'attente, ordres du Stop).
// Le retrait d'une demande lancée est devenu une réservation (au lancement) puis un acquittement (au résultat) : les mutations `regul-codex-retrait-*`
// visent la ligne de réservation, et `regul-codex-acquittement-*` l'acquittement.
//   node tests/mutations/mutations-regulateur-codex.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-regulateur-codex.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-regulateur-codex.js --liste         affiche les noms
//   node tests/mutations/mutations-regulateur-codex.js --ancres        vérifie que chaque ancre existe une seule fois dans le fichier source
// Mutations équivalentes écartées (aucun comportement observable ne change) :
//   - ne pas lire la politique inerte avant la décision (`decisionLancement` autorise déjà tout quand la politique est inerte : seule la
//     lecture inutile du ledger change, pas la sortie) ;
//   - ne pas passer `maintenant` à etatAgents ou à echouesRecents (leur valeur par défaut est Date.now()) ;
//   - passer file.MAX_PAR_ORDRE au lieu de file.MAX_FILE à entreesLancables (choisirPourOrdre coupe déjà à MAX_PAR_ORDRE) ;
//   - remplacer SANS_PLAFOND par un autre très grand nombre (sans plafond, `libres - n` reste très supérieur à trois) ;
//   - `libres < 0` à la place de `libres < 1` (à zéro créneau libre, relances, demandes et ordre sont déjà vides ; seuls les créneaux
//     NÉGATIFS, plafond baissé sous le nombre d'agents en cours, comptent : voir `creneau-zero-seul` et `creneau-sans-garde`).
// Code simplifié plutôt que muté : plus de test `reste >= 1` avant choisirPourOrdre (qui rend [] sous un créneau), plus de
// `try` autour du retrait de la file (une panne remonte au silence du processus : même sortie), plus de calcul séparé de `reste` sans plafond.

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

// La réservation d'une demande lancée, aux deux endroits où un lancement est autorisé (politique inerte, puis sous le maximum).
const LIGNE_RETRAIT = '    if (politique.file) regulateur.reserverReconnue(agent, entree.session_id, entree.tool_input, entree.tool_use_id);\n';
const SITES_RETRAIT = [
  { site: 'inerte', suite: '    return null;\n  }\n  const decision' },
  { site: 'autorise', suite: '    return null;\n  }\n  return refus(' },
];
const VARIANTES_RETRAIT = [
  ['jamais', ''],
  ['sans-condition', '    regulateur.reserverReconnue(agent, entree.session_id, entree.tool_input, entree.tool_use_id);\n'],
  ['agent-fige', LIGNE_RETRAIT.replace('(agent,', "('codex',")],
  ['session-figee', LIGNE_RETRAIT.replace('entree.session_id', "'S1'")],
  ['demande-perdue', LIGNE_RETRAIT.replace('entree.tool_input', 'undefined')],
  ['jeton-perdu', LIGNE_RETRAIT.replace('entree.tool_use_id', 'undefined')],
];
const MUTATIONS_RETRAIT = SITES_RETRAIT.flatMap(({ site, suite }) => VARIANTES_RETRAIT.map(([variante, ligne]) => (
  { nom: `regul-codex-retrait-${site}-${variante}`, suite: 'file d attente', de: LIGNE_RETRAIT + suite, vers: ligne + suite }
)));

const MUTATIONS_ACQUITTEMENT = [
  { nom: 'regul-codex-acquittement-jamais', suite: 'file d attente', de: '    regulateur.acquitter(agent, entree.session_id, entree.tool_input, Boolean(success), entree.tool_use_id);\n', vers: '' },
  { nom: 'regul-codex-acquittement-toujours-reussi', suite: 'file d attente', de: 'Boolean(success), entree.tool_use_id);', vers: 'true, entree.tool_use_id);' },
  { nom: 'regul-codex-acquittement-jamais-reussi', suite: 'file d attente', de: 'Boolean(success), entree.tool_use_id);', vers: 'false, entree.tool_use_id);' },
  { nom: 'regul-codex-acquittement-agent-fige', suite: 'file d attente', de: 'regulateur.acquitter(agent, entree.session_id,', vers: "regulateur.acquitter('codex', entree.session_id," },
  { nom: 'regul-codex-acquittement-session-figee', suite: 'file d attente', de: 'regulateur.acquitter(agent, entree.session_id,', vers: "regulateur.acquitter(agent, 'S1'," },
  { nom: 'regul-codex-acquittement-demande-perdue', suite: 'file d attente', de: 'entree.session_id, entree.tool_input, Boolean(success)', vers: 'entree.session_id, undefined, Boolean(success)' },
  { nom: 'regul-codex-acquittement-jeton-perdu', suite: 'file d attente', de: 'Boolean(success), entree.tool_use_id);', vers: 'Boolean(success), undefined);' },
  { nom: 'regul-codex-acquittement-echec-pris-pour-succes', suite: 'file d attente', de: "const success = entree.hook_event_name === 'PostToolUse' && response", vers: 'const success = response' },
  { nom: 'regul-codex-acquittement-sans-identifiant-d-agent', suite: 'file d attente', de: " && typeof response.agent_id === 'string' && response.agent_id.length > 0;", vers: ';' },
  { nom: 'regul-codex-acquittement-code-de-sortie-ignore', suite: 'file d attente', de: ' && (response.exit_code === undefined || response.exit_code === 0)', vers: '' },
  { nom: 'regul-codex-acquittement-erreur-ignoree', suite: 'file d attente', de: ' && !response.error && !response.isError', vers: '' },
  { nom: 'regul-codex-acquittement-autre-outil', suite: 'file d attente', de: "&& /spawn_agent$/.test(entree.tool_name || '')) {", vers: ') {' },
  { nom: 'regul-codex-acquittement-echec-de-l-outil-ignore', suite: 'file d attente', de: "['PostToolUse', 'PostToolUseFailure'].includes(entree.hook_event_name)", vers: "['PostToolUse'].includes(entree.hook_event_name)" },
];

const MUTATIONS = [
  // Entrée et aiguillage
  { nom: 'regul-codex-agent-non-converti', suite: 'refus du lancement', de: '  return cleAgent(i >= 0 ? argv[i + 1] : undefined);', vers: "  const a = i >= 0 ? argv[i + 1] : undefined;\n  return typeof a === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(a) ? a : null;" },
  { nom: 'regul-codex-evenement-ignore', suite: 'ne touche pas', de: "if (entree.hook_event_name !== 'PreToolUse') return null;", vers: '' },
  { nom: 'regul-codex-tous-les-outils', suite: 'ne touche pas', de: "if (typeof entree.tool_name !== 'string' || !/spawn_agent$/.test(entree.tool_name)) return null;", vers: "if (typeof entree.tool_name !== 'string') return null;" },
  { nom: 'regul-codex-outil-sans-ancre', suite: 'ne touche pas', de: '!/spawn_agent$/.test(entree.tool_name)', vers: '!/spawn_agent/.test(entree.tool_name)' },
  { nom: 'regul-codex-outil-nom-exact', suite: 'ne touche pas', de: '!/spawn_agent$/.test(entree.tool_name)', vers: '!/^spawn_agent$/.test(entree.tool_name)' },
  { nom: 'regul-codex-session-absente-acceptee', suite: 'ne touche pas', de: "if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;", vers: 'if (!agent) return null;' },
  { nom: 'regul-codex-agent-absent-accepte', suite: 'ne touche pas', de: "if (!agent || typeof entree.session_id !== 'string' || !entree.session_id) return null;", vers: "if (typeof entree.session_id !== 'string' || !entree.session_id) return null;" },
  { nom: 'regul-codex-erreur-bruyante', suite: 'ne touche pas', de: '} catch (_) { /* silence */ }\n    process.exitCode = 0;', vers: '} catch (e) { process.stderr.write(String(e)); process.exitCode = 1; return; }\n    process.exitCode = 0;' },
  { nom: 'regul-codex-erreur-bloque', suite: 'ne touche pas', de: '} catch (_) { /* silence */ }\n    process.exitCode = 0;', vers: "} catch (_) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'panne' } })); }\n    process.exitCode = 0;" },
  { nom: 'regul-codex-json-invalide-leve', suite: 'ne touche pas', de: 'try { entree = JSON.parse(texte); } catch (_) { return null; }', vers: 'entree = JSON.parse(texte);' },
  { nom: 'regul-codex-entree-nulle-leve', suite: 'ne touche pas', de: 'if (!entree) return null;', vers: '' },
  { nom: 'regul-codex-agent-invalide', suite: 'ne touche pas', de: '  return cleAgent(i >= 0 ? argv[i + 1] : undefined);', vers: "  const a = i >= 0 ? argv[i + 1] : undefined;\n  return typeof a === 'string' && /^.{0,31}$/.test(a) ? a : null;" },
  { nom: 'regul-codex-stop-ignore', suite: 'Stop', de: "if (entree.hook_event_name === 'Stop') return surStop(entree, agent);", vers: '' },
  { nom: 'regul-codex-stop-pour-tout', suite: 'refus du lancement', de: "if (entree.hook_event_name === 'Stop') return surStop(entree, agent);", vers: 'return surStop(entree, agent);' },

  // PreToolUse : refus par la politique
  { nom: 'regul-codex-pause-ignoree', suite: 'refus du lancement', de: 'if (!politique.pause && politique.max === null) {', vers: 'if (politique.max === null) {' },
  { nom: 'regul-codex-plafond-ignore', suite: 'refus du lancement', de: 'if (!politique.pause && politique.max === null) {', vers: 'if (!politique.pause) {' },
  { nom: 'regul-codex-jamais-de-refus', suite: 'refus du lancement', de: 'if (decision.autorise) {', vers: 'if (true) {' },
  { nom: 'regul-codex-refus-toujours', suite: 'refus du lancement', de: 'if (decision.autorise) {', vers: 'if (false) {' },
  { nom: 'regul-codex-champ-en-trop', suite: 'refus du lancement', de: "permissionDecision: 'deny', permissionDecisionReason: raison }", vers: "permissionDecision: 'deny', permissionDecisionReason: raison, extra: 1 }" },
  { nom: 'regul-codex-decision-ask', suite: 'refus du lancement', de: "permissionDecision: 'deny'", vers: "permissionDecision: 'ask'" },
  { nom: 'regul-codex-raison-perdue', suite: 'refus du lancement', de: 'permissionDecisionReason: raison', vers: "permissionDecisionReason: 'non'" },
  { nom: 'regul-codex-raison-politique-perdue', suite: 'refus du lancement', de: ': decision.raison);', vers: ": 'non');" },
  { nom: 'regul-codex-fil-fige', suite: 'refus du lancement', de: 'etatAgents({ agent, session: entree.session_id })', vers: "etatAgents({ agent, session: 'S1' })" },
  { nom: 'regul-codex-agent-fige', suite: 'refus du lancement', de: 'etatAgents({ agent, session: entree.session_id })', vers: "etatAgents({ agent: 'codex', session: entree.session_id })" },

  // PreToolUse : mise en file de ce qui est refusé au maximum
  { nom: 'regul-codex-file-jamais', suite: 'file d attente', de: 'decision.mettreEnFile ? refusEnFile(', vers: 'false ? refusEnFile(' },
  { nom: 'regul-codex-file-toujours', suite: 'file d attente', de: 'decision.mettreEnFile ? refusEnFile(', vers: 'true ? refusEnFile(' },
  { nom: 'regul-codex-file-agent-fige', suite: 'file d attente', de: 'refusEnFile(agent, entree.session_id, entree.tool_input)', vers: "refusEnFile('codex', entree.session_id, entree.tool_input)" },
  { nom: 'regul-codex-file-session-figee', suite: 'file d attente', de: 'refusEnFile(agent, entree.session_id, entree.tool_input)', vers: "refusEnFile(agent, 'S1', entree.tool_input)" },
  { nom: 'regul-codex-file-demande-perdue', suite: 'file d attente', de: 'refusEnFile(agent, entree.session_id, entree.tool_input)', vers: 'refusEnFile(agent, entree.session_id, undefined)' },
  { nom: 'regul-codex-file-sans-garde-objet', suite: 'file d attente', de: "if (!estObjet(arguments_)) return file.texteRefusSansFile('invalide');", vers: '' },
  { nom: 'regul-codex-file-description-perdue', suite: 'file d attente', de: 'description: descriptionDe(arguments_)', vers: 'description: undefined' },
  { nom: 'regul-codex-file-maintenant-fige', suite: 'Stop', de: 'demande: arguments_, maintenant: Date.now() }', vers: 'demande: arguments_, maintenant: 0 }' },
  { nom: 'regul-codex-file-position-perdue', suite: 'file d attente', de: 'position: r.position, total: r.total', vers: 'position: 0, total: r.total' },
  { nom: 'regul-codex-file-total-perdu', suite: 'file d attente', de: "total: r.total, mode: 'modele'", vers: "total: 0, mode: 'modele'" },
  { nom: 'regul-codex-file-mode-code', suite: 'file d attente', de: "mode: 'modele'", vers: "mode: 'code'" },
  { nom: 'regul-codex-file-refus-ignore', suite: 'file d attente', de: 'if (r.refus !== undefined) return file.texteRefusSansFile(r.refus);', vers: '' },
  { nom: 'regul-codex-file-cause-perdue', suite: 'file d attente', de: 'file.texteRefusSansFile(r.refus)', vers: "file.texteRefusSansFile('invalide')" },
  { nom: 'regul-codex-file-panne-propagee', suite: 'file d attente', de: "} catch (_) {\n    return file.texteRefusSansFile('ecriture');", vers: '} catch (e) {\n    throw e;' },
  { nom: 'regul-codex-file-panne-cause-perdue', suite: 'file d attente', de: "return file.texteRefusSansFile('ecriture');", vers: "return file.texteRefusSansFile('invalide');" },

  // PreToolUse : retrait de la file quand le modèle lance ce qu'on lui avait ordonné
  ...MUTATIONS_RETRAIT,
  ...MUTATIONS_ACQUITTEMENT,

  // PreToolUse : Garde-quota (refus au seuil critique)
  { nom: 'regul-codex-quota-ignore', suite: 'seuil critique du quota', de: 'if (!parQuota.autorise) return refus(parQuota.raison);', vers: '' },
  { nom: 'regul-codex-quota-sens-inverse', suite: 'seuil critique du quota', de: 'if (!parQuota.autorise) return refus(parQuota.raison);', vers: 'if (parQuota.autorise) return refus(parQuota.raison);' },
  { nom: 'regul-codex-quota-raison-perdue', suite: 'seuil critique du quota', de: 'if (!parQuota.autorise) return refus(parQuota.raison);', vers: "if (!parQuota.autorise) return refus('non');" },
  {
    nom: 'regul-codex-quota-apres-politique',
    suite: 'seuil critique du quota',
    de: [
      '  const parQuota = decisionQuota(agent, entree.transcript_path);',
      '  if (!parQuota.autorise) return refus(parQuota.raison);',
      '  const politique = regulateur.lirePolitique();',
      '  if (!politique.pause && politique.max === null) {',
      '    if (politique.file) regulateur.reserverReconnue(agent, entree.session_id, entree.tool_input, entree.tool_use_id);',
      '    return null;',
      '  }',
    ].join('\n'),
    vers: [
      '  const politique = regulateur.lirePolitique();',
      '  if (!politique.pause && politique.max === null) {',
      '    if (politique.file) regulateur.reserverReconnue(agent, entree.session_id, entree.tool_input, entree.tool_use_id);',
      '    return null;',
      '  }',
      '  const parQuota = decisionQuota(agent, entree.transcript_path);',
      '  if (!parQuota.autorise) return refus(parQuota.raison);',
    ].join('\n'),
  },
  { nom: 'regul-codex-quota-chemin-perdu', suite: 'seuil critique du quota', de: 'const parQuota = decisionQuota(agent, entree.transcript_path);', vers: 'const parQuota = decisionQuota(agent, undefined);' },
  { nom: 'regul-codex-quota-agent-fige', suite: 'seuil critique du quota', de: 'quota.decisionAgentCodex({ agent, chemin })', vers: "quota.decisionAgentCodex({ agent: 'codex', chemin })" },
  { nom: 'regul-codex-quota-panne-bloque', suite: 'seuil critique du quota', de: 'catch (_) { return { autorise: true }; }', vers: "catch (_) { return { autorise: false, raison: 'panne' }; }" },
  { nom: 'regul-codex-quota-panne-propagee', suite: 'seuil critique du quota', de: 'try { return quota.decisionAgentCodex({ agent, chemin }); } catch (_) { return { autorise: true }; }', vers: 'return quota.decisionAgentCodex({ agent, chemin });' },

  // Stop : conditions pour parler
  { nom: 'regul-codex-stop-actif-ignore', suite: 'Stop', de: 'if (entree.stop_hook_active === true) return null;', vers: '' },
  { nom: 'regul-codex-stop-actif-tout-vrai', suite: 'Stop', de: 'if (entree.stop_hook_active === true) return null;', vers: 'if (entree.stop_hook_active) return null;' },
  { nom: 'regul-codex-stop-actif-pas-faux', suite: 'Stop', de: 'if (entree.stop_hook_active === true) return null;', vers: 'if (entree.stop_hook_active !== false) return null;' },
  { nom: 'regul-codex-stop-file-ignoree', suite: 'Stop', de: 'if (!politique.file || politique.pause) return null;', vers: 'if (politique.pause) return null;' },
  { nom: 'regul-codex-stop-pause-ignoree', suite: 'Stop', de: 'if (!politique.file || politique.pause) return null;', vers: 'if (!politique.file) return null;' },
  { nom: 'regul-codex-stop-file-et-pause', suite: 'Stop', de: 'if (!politique.file || politique.pause) return null;', vers: 'if (!politique.file && politique.pause) return null;' },
  { nom: 'regul-codex-stop-quota-ignore', suite: 'Stop', de: 'if (!decisionQuota(agent, entree.transcript_path).autorise) return null;', vers: '' },
  { nom: 'regul-codex-stop-quota-sens-inverse', suite: 'Stop', de: 'if (!decisionQuota(agent, entree.transcript_path).autorise) return null;', vers: 'if (decisionQuota(agent, entree.transcript_path).autorise) return null;' },
  { nom: 'regul-codex-stop-quota-chemin-perdu', suite: 'Stop', de: 'if (!decisionQuota(agent, entree.transcript_path).autorise) return null;', vers: 'if (!decisionQuota(agent, undefined).autorise) return null;' },
  { nom: 'regul-codex-stop-quota-agent-fige', suite: 'Stop', de: 'if (!decisionQuota(agent, entree.transcript_path).autorise) return null;', vers: "if (!decisionQuota('codex', entree.transcript_path).autorise) return null;" },
  { nom: 'regul-codex-stop-purge-perdue', suite: 'Stop', de: '  regulateur.purgerFile(maintenant);\n', vers: '' },
  {
    nom: 'regul-codex-stop-purge-apres-creneaux',
    suite: 'Stop',
    de: [
      '  regulateur.purgerFile(maintenant);',
      '  const sansPlafond = politique.max === null;',
      '  const libres = sansPlafond ? SANS_PLAFOND : politique.max - regulateur.etatAgents({ agent, session, maintenant }).occupes;',
      '  if (libres < 1) return null;',
      '',
    ].join('\n'),
    vers: [
      '  const sansPlafond = politique.max === null;',
      '  const libres = sansPlafond ? SANS_PLAFOND : politique.max - regulateur.etatAgents({ agent, session, maintenant }).occupes;',
      '  if (libres < 1) return null;',
      '  regulateur.purgerFile(maintenant);',
      '',
    ].join('\n'),
  },

  // Stop : créneaux libres
  { nom: 'regul-codex-stop-sans-plafond-inverse', suite: 'Stop', de: 'const sansPlafond = politique.max === null;', vers: 'const sansPlafond = politique.max !== null;' },
  { nom: 'regul-codex-stop-sans-plafond-nul', suite: 'Stop', de: 'sansPlafond ? SANS_PLAFOND :', vers: 'sansPlafond ? 0 :' },
  { nom: 'regul-codex-stop-creneaux-ajoutes', suite: 'Stop', de: 'politique.max - regulateur.etatAgents(', vers: 'politique.max + regulateur.etatAgents(' },
  { nom: 'regul-codex-stop-occupes-agent-fige', suite: 'Stop', de: 'regulateur.etatAgents({ agent, session, maintenant })', vers: "regulateur.etatAgents({ agent: 'codex', session, maintenant })" },
  { nom: 'regul-codex-stop-occupes-session-figee', suite: 'Stop', de: 'regulateur.etatAgents({ agent, session, maintenant })', vers: "regulateur.etatAgents({ agent, session: 'S1', maintenant })" },
  { nom: 'regul-codex-stop-creneau-zero-seul', suite: 'Stop', de: 'if (libres < 1) return null;', vers: 'if (libres === 0) return null;' },
  { nom: 'regul-codex-stop-creneau-sans-garde', suite: 'Stop', de: '  if (libres < 1) return null;\n', vers: '' },
  { nom: 'regul-codex-stop-un-creneau-insuffisant', suite: 'Stop', de: 'if (libres < 1) return null;', vers: 'if (libres < 2) return null;' },

  // Stop : relance des échoués
  { nom: 'regul-codex-stop-relance-toujours', suite: 'Stop', de: 'const echoues = politique.relance', vers: 'const echoues = true' },
  { nom: 'regul-codex-stop-relance-jamais', suite: 'Stop', de: 'const echoues = politique.relance', vers: 'const echoues = false' },
  { nom: 'regul-codex-stop-echoues-agent-fige', suite: 'Stop', de: 'regulateur.echouesRecents({ agent, session, maintenant, ageMax: AGE_MAX_ECHEC_MS })', vers: "regulateur.echouesRecents({ agent: 'codex', session, maintenant, ageMax: AGE_MAX_ECHEC_MS })" },
  { nom: 'regul-codex-stop-echoues-session-figee', suite: 'Stop', de: 'regulateur.echouesRecents({ agent, session, maintenant, ageMax: AGE_MAX_ECHEC_MS })', vers: "regulateur.echouesRecents({ agent, session: 'S1', maintenant, ageMax: AGE_MAX_ECHEC_MS })" },
  { nom: 'regul-codex-stop-echoues-maintenant-nul', suite: 'Stop', de: 'regulateur.echouesRecents({ agent, session, maintenant, ageMax: AGE_MAX_ECHEC_MS })', vers: 'regulateur.echouesRecents({ agent, session, maintenant: 0, ageMax: AGE_MAX_ECHEC_MS })' },
  { nom: 'regul-codex-stop-echoues-sans-age', suite: 'Stop', de: 'ageMax: AGE_MAX_ECHEC_MS', vers: 'ageMax: Infinity' },
  { nom: 'regul-codex-age-echec-une-heure', suite: 'Stop', de: 'const AGE_MAX_ECHEC_MS = 2 * HEURE;', vers: 'const AGE_MAX_ECHEC_MS = HEURE;' },
  { nom: 'regul-codex-age-echec-trois-heures', suite: 'Stop', de: 'const AGE_MAX_ECHEC_MS = 2 * HEURE;', vers: 'const AGE_MAX_ECHEC_MS = 3 * HEURE;' },
  { nom: 'regul-codex-stop-filtre-relances-perdu', suite: 'Stop', de: '.filter(x => regulateur.peutRelancer(cleRelance(agent, session, x.nom)))', vers: '.filter(x => true)' },
  { nom: 'regul-codex-stop-filtre-relances-inverse', suite: 'Stop', de: '.filter(x => regulateur.peutRelancer(cleRelance(agent, session, x.nom)))', vers: '.filter(x => !regulateur.peutRelancer(cleRelance(agent, session, x.nom)))' },
  { nom: 'regul-codex-stop-relances-sans-borne-ordre', suite: 'Stop', de: '.slice(0, Math.min(libres, file.MAX_PAR_ORDRE))', vers: '.slice(0, libres)' },
  { nom: 'regul-codex-stop-relances-sans-creneaux', suite: 'Stop', de: '.slice(0, Math.min(libres, file.MAX_PAR_ORDRE))', vers: '.slice(0, file.MAX_PAR_ORDRE)' },
  { nom: 'regul-codex-stop-relances-une-seule', suite: 'Stop', de: '.slice(0, Math.min(libres, file.MAX_PAR_ORDRE))', vers: '.slice(0, 1)' },
  { nom: 'regul-codex-stop-essai-non-incremente', suite: 'Stop', de: 'essai: regulateur.relancesFaites(cleRelance(agent, session, x.nom)) + 1', vers: 'essai: regulateur.relancesFaites(cleRelance(agent, session, x.nom))' },
  { nom: 'regul-codex-stop-relance-non-comptee', suite: 'Stop', de: 'for (const x of echoues) regulateur.compterRelance(cleRelance(agent, session, x.nom));', vers: '' },
  { nom: 'regul-codex-stop-relance-comptee-pour-codex', suite: 'Stop', de: 'for (const x of echoues) regulateur.compterRelance(cleRelance(agent, session, x.nom));', vers: "for (const x of echoues) regulateur.compterRelance(cleRelance('codex', session, x.nom));" },
  { nom: 'regul-codex-cle-relance-fil-entier', suite: 'Stop', de: '`${agent}:${session.slice(0, 8)}:${nom}`', vers: '`${agent}:${session}:${nom}`' },
  { nom: 'regul-codex-cle-relance-fil-sept', suite: 'Stop', de: '`${agent}:${session.slice(0, 8)}:${nom}`', vers: '`${agent}:${session.slice(0, 7)}:${nom}`' },
  { nom: 'regul-codex-cle-relance-fil-neuf', suite: 'Stop', de: '`${agent}:${session.slice(0, 8)}:${nom}`', vers: '`${agent}:${session.slice(0, 9)}:${nom}`' },
  { nom: 'regul-codex-cle-relance-sans-agent', suite: 'Stop', de: '`${agent}:${session.slice(0, 8)}:${nom}`', vers: '`${session.slice(0, 8)}:${nom}`' },
  { nom: 'regul-codex-cle-relance-sans-nom', suite: 'Stop', de: '`${agent}:${session.slice(0, 8)}:${nom}`', vers: '`${agent}:${session.slice(0, 8)}:`' },

  // Stop : demandes de la file
  { nom: 'regul-codex-stop-reste-sans-relances', suite: 'Stop', de: 'const reste = libres - echoues.length;', vers: 'const reste = libres;' },
  { nom: 'regul-codex-stop-reste-plus-relances', suite: 'Stop', de: 'const reste = libres - echoues.length;', vers: 'const reste = libres + echoues.length;' },
  { nom: 'regul-codex-stop-file-agent-fige', suite: 'Stop', de: 'regulateur.entreesLancables(agent, session, file.MAX_FILE, maintenant)', vers: "regulateur.entreesLancables('codex', session, file.MAX_FILE, maintenant)" },
  { nom: 'regul-codex-stop-file-session-figee', suite: 'Stop', de: 'regulateur.entreesLancables(agent, session, file.MAX_FILE, maintenant)', vers: "regulateur.entreesLancables(agent, 'S1', file.MAX_FILE, maintenant)" },
  { nom: 'regul-codex-stop-file-une-entree', suite: 'Stop', de: 'regulateur.entreesLancables(agent, session, file.MAX_FILE, maintenant)', vers: 'regulateur.entreesLancables(agent, session, 1, maintenant)' },
  { nom: 'regul-codex-stop-file-deux-entrees', suite: 'Stop', de: 'regulateur.entreesLancables(agent, session, file.MAX_FILE, maintenant)', vers: 'regulateur.entreesLancables(agent, session, 2, maintenant)' },
  { nom: 'regul-codex-stop-file-sans-date', suite: 'Stop', de: 'regulateur.entreesLancables(agent, session, file.MAX_FILE, maintenant)', vers: 'regulateur.entreesLancables(agent, session, file.MAX_FILE)' },

  // Stop : l'ordre donné au modèle
  { nom: 'regul-codex-stop-ordre-dit-les-creneaux-toujours', suite: 'Stop', de: 'file.texteOrdre(choisies, sansPlafond ? null : reste)', vers: 'file.texteOrdre(choisies, reste)' },
  { nom: 'regul-codex-stop-ordre-ne-dit-jamais-les-creneaux', suite: 'Stop', de: 'file.texteOrdre(choisies, sansPlafond ? null : reste)', vers: 'file.texteOrdre(choisies, null)' },
  { nom: 'regul-codex-stop-textes-vides-gardes', suite: 'Stop', de: '].filter(t => t !== null);', vers: '];' },
  { nom: 'regul-codex-stop-rien-a-dire-bloque', suite: 'Stop', de: 'if (textes.length === 0) return null;', vers: '' },
  { nom: 'regul-codex-stop-non-ordonne', suite: 'Stop', de: 'regulateur.ordonner(choisies.map(e => e.id), maintenant);', vers: '' },
  { nom: 'regul-codex-stop-ordonne-sans-date', suite: 'Stop', de: 'regulateur.ordonner(choisies.map(e => e.id), maintenant);', vers: 'regulateur.ordonner(choisies.map(e => e.id));' },
  { nom: 'regul-codex-stop-decision-approuve', suite: 'Stop', de: "return { decision: 'block', reason: textes.join('\\n\\n') };", vers: "return { decision: 'approve', reason: textes.join('\\n\\n') };" },
  { nom: 'regul-codex-stop-champ-en-trop', suite: 'Stop', de: "return { decision: 'block', reason: textes.join('\\n\\n') };", vers: "return { decision: 'block', reason: textes.join('\\n\\n'), extra: 1 };" },
  { nom: 'regul-codex-stop-textes-colles', suite: 'Stop', de: "return { decision: 'block', reason: textes.join('\\n\\n') };", vers: "return { decision: 'block', reason: textes.join('\\n') };" },
  { nom: 'regul-codex-stop-raison-incomplete', suite: 'Stop', de: "return { decision: 'block', reason: textes.join('\\n\\n') };", vers: "return { decision: 'block', reason: textes[0] };" },
];

executer({
  source: path.join(SCRIPTS, 'codex', 'regulateur.js'),
  banc: path.join(__dirname, '..', 'regulateur-codex.test.js'),
  variable: 'REGULATEUR_CODEX_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('../lib/regulateur-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'regulateur-core.js'))})`],
    ["require('../lib/regulateur-logique.mjs')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'regulateur-logique.mjs'))})`],
    ["require('../lib/quota-core.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'quota-core.js'))})`],
    ["require('../lib/file-logique.mjs')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'file-logique.mjs'))})`],
    ["require('../lib/agents-noms.js')", `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'agents-noms.js'))})`],
  ],
  argv: process.argv.slice(2),
  concurrence: 3,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
