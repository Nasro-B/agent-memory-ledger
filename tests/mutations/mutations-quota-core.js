'use strict';
// Preuve par mutation du banc quota-core.test.js (entrées-sorties du Garde-quota).
//   node tests/mutations/mutations-quota-core.js                 toutes les mutations (témoin non muté d'abord)
//   node tests/mutations/mutations-quota-core.js nom1 nom2       seulement celles nommées
//   node tests/mutations/mutations-quota-core.js --liste         affiche les noms
//   node tests/mutations/mutations-quota-core.js --ancres        vérifie sans lancer le banc que chaque ancre existe une fois
// Mutations équivalentes écartées (la sortie observable ne change pas) : le filtre des lignes qui citent token_count avant de les
// analyser (il ne sert qu'à lire moins vite), la fermeture du fichier, la première ligne lue qui est sans doute coupée (elle ne
// s'analyse pas, quoi qu'on fasse), et les gardes `j && j.payload &&` (une ligne d'une autre forme lève, et la capture l'ignore).

const path = require('node:path');
const { executer } = require('../lib/mutations-fichier.js');

const LIB = path.join(__dirname, '..', '..', 'scripts', 'lib');

const MUTATIONS = [
  // réglages
  { nom: 'qcore-config-fichier-lu', suite: 'réglages', de: "cockpit.lireJson(fichier('garde-quota.json'), null)", vers: "cockpit.lireJson(fichier('quota.json'), null)" },
  { nom: 'qcore-config-fichier-ecrit', suite: 'réglages', de: "cockpit.ecrireJson(fichier('garde-quota.json'), {", vers: "cockpit.ecrireJson(fichier('quota.json'), {" },
  { nom: 'qcore-config-non-normalisee', suite: 'réglages', de: "return logique.normaliserConfig(cockpit.lireJson(fichier('garde-quota.json'), null));", vers: "return cockpit.lireJson(fichier('garde-quota.json'), logique.configParDefaut());" },
  { nom: 'qcore-ecrire-non-normalisee', suite: 'réglages', de: '{ ...logique.normaliserConfig(config), maj:', vers: '{ ...config, maj:' },
  { nom: 'qcore-ecrire-sans-heure', suite: 'réglages', de: ', maj: new Date().toISOString() });', vers: ' });' },
  { nom: 'qcore-commande-erreur-ignoree', suite: 'réglages', de: 'if (r.erreur) return { erreur: r.erreur };', vers: '' },
  { nom: 'qcore-commande-toujours-ecrire', suite: 'réglages', de: 'if (JSON.stringify(r.config) !== JSON.stringify(avant)) ecrireConfig(r.config);', vers: 'ecrireConfig(r.config);' },
  { nom: 'qcore-commande-jamais-ecrire', suite: 'réglages', de: 'if (JSON.stringify(r.config) !== JSON.stringify(avant)) ecrireConfig(r.config);', vers: '' },
  // rollout
  { nom: 'qcore-lecture-entiere', suite: 'rollout', de: 'const debut = Math.max(0, taille - LECTURE);', vers: 'const debut = 0;' },
  { nom: 'qcore-lecture-courte', suite: 'rollout', de: 'const LECTURE = 2 * 1024 * 1024;', vers: 'const LECTURE = 256 * 1024;' },
  { nom: 'qcore-lecture-longue', suite: 'rollout', de: 'const LECTURE = 2 * 1024 * 1024;', vers: 'const LECTURE = 8 * 1024 * 1024;' },
  { nom: 'qcore-parcours-du-debut', suite: 'rollout', de: 'for (let i = lignes.length - 1; i >= 0; i--) {', vers: 'for (let i = 0; i < lignes.length; i++) {' },
  { nom: 'qcore-type-evenement', suite: 'rollout', de: "j.payload.type === 'token_count' ? j.payload.rate_limits : null", vers: 'j.payload.rate_limits' },
  { nom: 'qcore-rate-limits-objet', suite: 'rollout', de: "if (objet(r) && (!r.limit_id || r.limit_id === 'codex')) {", vers: "if (r && (!r.limit_id || r.limit_id === 'codex')) {" },
  { nom: 'qcore-rollout-erreur-propagee', suite: 'rollout', de: '  } catch (_) {\n    return null;\n  } finally {', vers: '  } catch (e) {\n    throw e;\n  } finally {' },
  // mesure de Codex
  { nom: 'qcore-mesure-non-ecrite', suite: 'mesure de Codex', de: "if (fenetres.length) cockpit.ecrireQuota(agent, { fenetres, source: 'rollout', sourceAt: brut.sourceAt, limitId: brut.rateLimits.limit_id || 'codex' });", vers: '' },
  { nom: 'qcore-mesure-vide-ecrasante', suite: 'mesure de Codex', de: "if (fenetres.length) cockpit.ecrireQuota(agent, { fenetres, source: 'rollout', sourceAt: brut.sourceAt, limitId: brut.rateLimits.limit_id || 'codex' });", vers: "cockpit.ecrireQuota(agent, { fenetres, source: 'rollout', sourceAt: null, limitId: 'codex' });" },
  { nom: 'qcore-mesure-source', suite: 'mesure de Codex', de: "source: 'rollout'", vers: "source: 'autre'" },
  { nom: 'qcore-mesure-non-normalisee', suite: 'mesure de Codex', de: 'brut === null ? [] : logique.normaliserFenetresCodex(brut.rateLimits)', vers: 'brut === null ? [] : brut.rateLimits' },
  { nom: 'qcore-courantes-sans-repli', suite: 'mesure de Codex', de: "const gardee = cockpit.lireQuota(agent);\n  return logique.assainirFenetres(objet(gardee) ? gardee.fenetres : undefined);", vers: 'return [];' },
  { nom: 'qcore-courantes-rollout-ignore', suite: 'mesure de Codex', de: 'const mesurees = mesurerCodex({ agent, chemin });\n  if (mesurees.length) return mesurees;', vers: 'const mesurees = [];' },
  { nom: 'qcore-courantes-non-assainies', suite: 'mesure de Codex', de: 'logique.assainirFenetres(objet(gardee) ? gardee.fenetres : undefined)', vers: '(objet(gardee) && Array.isArray(gardee.fenetres) ? gardee.fenetres : [])' },
  { nom: 'qcore-courantes-etat-non-objet', suite: 'mesure de Codex', de: 'objet(gardee) ? gardee.fenetres : undefined', vers: 'gardee.fenetres' },
  // annonces de Codex
  { nom: 'qcore-suivre-agent-libre', suite: 'annonces de Codex', de: '  agent = validerAgent(agent);\n  const config = lireConfig();', vers: '  const config = lireConfig();' },
  { nom: 'qcore-suivre-fichier-commun', suite: 'annonces de Codex', de: 'fichier(`garde-quota-alertes-${agent}.json`)', vers: 'fichier(`garde-quota-alertes.json`)' },
  { nom: 'qcore-suivre-etat-non-objet', suite: 'annonces de Codex', de: 'const etat = objet(lu) ? lu : {};', vers: 'const etat = lu;' },
  { nom: 'qcore-suivre-deja-ignore', suite: 'annonces de Codex', de: 'logique.alertes(fenetres, config, maintenant, etat.deja)', vers: 'logique.alertes(fenetres, config, maintenant, [])' },
  { nom: 'qcore-suivre-hauts-ignores', suite: 'annonces de Codex', de: 'logique.suivreHauts(etat.hauts, fenetres, config, maintenant)', vers: 'logique.suivreHauts([], fenetres, config, maintenant)' },
  { nom: 'qcore-suivre-remise-oubliee', suite: 'annonces de Codex', de: 'logique.remiseRecente(etat.remise, maintenant) ? etat.remise : null', vers: 'null' },
  { nom: 'qcore-suivre-remise-sans-date', suite: 'annonces de Codex', de: '{ noms: suivi.remises, ts: maintenant }', vers: '{ noms: suivi.remises, ts: 0 }' },
  { nom: 'qcore-suivre-prefixe', suite: 'annonces de Codex', de: '`GARDE-QUOTA : ${logique.texteAlerte(a, maintenant, config)}`', vers: '`${logique.texteAlerte(a, maintenant, config)}`' },
  { nom: 'qcore-suivre-relais-agent', suite: 'annonces de Codex', de: "{ autre: 'Claude', fichier:", vers: "{ autre: 'Codex', fichier:" },
  { nom: 'qcore-suivre-relais-fichier', suite: 'annonces de Codex', de: "fichier('relais-claude.md')", vers: "fichier('relais-codex.md')" },
  { nom: 'qcore-suivre-relais-barres', suite: 'annonces de Codex', de: ".split(path.sep).join('/') });", vers: ' });' },
  { nom: 'qcore-suivre-consigne-oubliee', suite: 'annonces de Codex', de: 'if (critique !== null) lignes.push(critique);', vers: '' },
  { nom: 'qcore-suivre-retour-sans-reglage', suite: 'annonces de Codex', de: 'config.consigne && remise !== null ?', vers: 'remise !== null ?' },
  { nom: 'qcore-suivre-retour-oublie', suite: 'annonces de Codex', de: 'if (retour !== null) lignes.push(retour);', vers: '' },
  { nom: 'qcore-suivre-urgent-critique', suite: 'annonces de Codex', de: "annonces.nouvelles.some(a => a.niveau === 'critique') ||", vers: 'false ||' },
  { nom: 'qcore-suivre-urgent-attention', suite: 'annonces de Codex', de: "annonces.nouvelles.some(a => a.niveau === 'critique')", vers: 'annonces.nouvelles.length > 0' },
  { nom: 'qcore-suivre-urgent-remise', suite: 'annonces de Codex', de: ' || suivi.remises.length > 0,', vers: ',' },
  { nom: 'qcore-persister-deja-oublie', suite: 'annonces de Codex', de: '{ deja: annonces.deja, hauts: suivi.hauts, remise }', vers: '{ hauts: suivi.hauts, remise }' },
  { nom: 'qcore-persister-hauts-oublies', suite: 'annonces de Codex', de: '{ deja: annonces.deja, hauts: suivi.hauts, remise }', vers: '{ deja: annonces.deja, remise }' },
  { nom: 'qcore-persister-remise-oubliee', suite: 'annonces de Codex', de: '{ deja: annonces.deja, hauts: suivi.hauts, remise }', vers: '{ deja: annonces.deja, hauts: suivi.hauts }' },
  // décision de lancement
  { nom: 'qcore-decision-reglages-ignores', suite: 'décision de lancement', de: 'fenetresCourantes({ agent, chemin }), lireConfig(), maintenant', vers: 'fenetresCourantes({ agent, chemin }), logique.configParDefaut(), maintenant' },
  { nom: 'qcore-decision-fenetres-ignorees', suite: 'décision de lancement', de: 'logique.decisionAgent(fenetresCourantes({ agent, chemin }),', vers: 'logique.decisionAgent([],' },
  { nom: 'qcore-decision-instant-defaut', suite: 'décision de lancement', de: 'decisionAgentCodex({ agent, chemin, maintenant = Date.now() })', vers: 'decisionAgentCodex({ agent, chemin, maintenant = 0 })' },
  // les noms d'agents du dépôt (deepseek_H) : convertis en clé d'état, jamais un chemin construit sur un nom libre
  { nom: 'qcore-cle-non-rendue', suite: 'mesure de Codex', de: '  return cle;\n}', vers: '  return agent;\n}' },
  { nom: 'qcore-cle-non-validee', suite: 'mesure de Codex', de: '  if (cle === null) throw new Error(', vers: '  if (false) throw new Error(' },
  { nom: 'qcore-cle-mesure', suite: 'mesure de Codex', de: 'function mesurerCodex({ agent, chemin }) {\n  agent = validerAgent(agent);', vers: 'function mesurerCodex({ agent, chemin }) {\n  validerAgent(agent);' },
  { nom: 'qcore-cle-courantes', suite: 'mesure de Codex', de: 'function fenetresCourantes({ agent, chemin }) {\n  agent = validerAgent(agent);', vers: 'function fenetresCourantes({ agent, chemin }) {\n  validerAgent(agent);' },
  // la lecture native : une par minute et par agent, seul codex en a une, la variable des bancs la coupe
  { nom: 'qcore-natif-tous-agents', suite: 'lecture native', de: "|| agent !== 'codex') return;", vers: '|| false) return;' },
  { nom: 'qcore-natif-aucun-agent', suite: 'lecture native', de: "|| agent !== 'codex') return;", vers: '|| true) return;' },
  { nom: 'qcore-natif-coupure', suite: 'lecture native', de: "process.env.COCKPIT_QUOTA_NATIVE === '0' ||", vers: 'false ||' },
  { nom: 'qcore-natif-coupure-valeur', suite: 'lecture native', de: "process.env.COCKPIT_QUOTA_NATIVE === '0'", vers: "process.env.COCKPIT_QUOTA_NATIVE === '1'" },
  { nom: 'qcore-natif-minute', suite: 'lecture native', de: 'Date.now() - avant.ts < 60000', vers: 'Date.now() - avant.ts < 1000' },
  { nom: 'qcore-natif-minute-longue', suite: 'lecture native', de: 'Date.now() - avant.ts < 60000', vers: 'Date.now() - avant.ts < 600000' },
  { nom: 'qcore-natif-sans-reserve', suite: 'lecture native', de: '  if (avant && Date.now() - avant.ts < 60000) return;\n', vers: '' },
  { nom: 'qcore-natif-heure-non-ecrite', suite: 'lecture native', de: '  cockpit.ecrireJson(etat, { ts: Date.now() });\n', vers: '' },
  { nom: 'qcore-natif-fichier', suite: 'lecture native', de: 'fichier(`quota-native-${agent}.json`)', vers: 'fichier(`quota-native.json`)' },
  { nom: 'qcore-natif-agent-passe', suite: 'lecture native', de: "'quota-native.cjs'), agent], {", vers: "'quota-native.cjs'), 'codex-autre'], {" },
  { nom: 'qcore-natif-source', suite: 'lecture native', de: "if (mesure?.source === 'app-server' &&", vers: 'if (mesure &&' },
  { nom: 'qcore-natif-fenetres-vides', suite: 'lecture native', de: "&& logique.assainirFenetres(mesure.fenetres).length) cockpit.ecrireQuota(agent, mesure);", vers: ') cockpit.ecrireQuota(agent, mesure);' },
  { nom: 'qcore-natif-statut', suite: 'lecture native', de: 'r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null', vers: 'r.stdout ? JSON.parse(r.stdout) : null' },
  { nom: 'qcore-natif-indisponible-ecrase', suite: 'lecture native', de: '    else if (!cockpit.lireQuota(agent)) cockpit.ecrireQuota(agent', vers: '    else if (true) cockpit.ecrireQuota(agent' },
  { nom: 'qcore-natif-indisponible-jamais', suite: 'lecture native', de: '    else if (!cockpit.lireQuota(agent)) cockpit.ecrireQuota(agent', vers: '    else if (false) cockpit.ecrireQuota(agent' },
  { nom: 'qcore-natif-indisponible-source', suite: 'lecture native', de: "source: 'app-server-indisponible'", vers: "source: 'indisponible'" },
  { nom: 'qcore-natif-recule', suite: 'lecture native', de: "if (gardee?.source === 'app-server' &&", vers: 'if (false &&' },
  { nom: 'qcore-natif-recule-date', suite: 'lecture native', de: "(!brut?.sourceAt || Date.parse(gardee.mesureA) >= Date.parse(brut.sourceAt))", vers: '!brut?.sourceAt' },
  { nom: 'qcore-natif-recule-sens', suite: 'lecture native', de: 'Date.parse(gardee.mesureA) >= Date.parse(brut.sourceAt)', vers: 'Date.parse(gardee.mesureA) < Date.parse(brut.sourceAt)' },
  { nom: 'qcore-rollout-date', suite: 'lecture native', de: "sourceAt: typeof j.timestamp === 'string' && Number.isFinite(Date.parse(j.timestamp)) ? j.timestamp : null", vers: 'sourceAt: null' },
  { nom: 'qcore-rollout-limite', suite: 'lecture native', de: "(!r.limit_id || r.limit_id === 'codex')", vers: '(!r.limit_id || true)' },
  { nom: 'qcore-rollout-limite-absente', suite: 'lecture native', de: "(!r.limit_id || r.limit_id === 'codex')", vers: "(r.limit_id === 'codex')" },
];

executer({
  source: path.join(LIB, 'quota-core.js'),
  banc: path.join(__dirname, '..', 'quota-core.test.js'),
  variable: 'QUOTA_CORE_TESTE',
  mutations: MUTATIONS,
  // La copie mutée vit dans un dossier temporaire : ses require relatifs deviennent absolus.
  reecritures: [
    ["require('./cockpit-core.js')", `require(${JSON.stringify(path.join(LIB, 'cockpit-core.js'))})`],
    ["require('./quota-logique.mjs')", `require(${JSON.stringify(path.join(LIB, 'quota-logique.mjs'))})`],
    ["require('./agents-noms.js')", `require(${JSON.stringify(path.join(LIB, 'agents-noms.js'))})`],
    // la lecture native est lancée depuis le dossier du noyau : dans la copie mutée, il faut le chemin du vrai
    ["path.join(__dirname, 'quota-native.cjs')", JSON.stringify(path.join(LIB, 'quota-native.cjs'))],
  ],
  argv: process.argv.slice(2),
  concurrence: 4,
}).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 2; });
