'use strict';
/**
 * Entrées-sorties du Garde-quota : les réglages de l'utilisateur, la lecture du quota de Codex dans son rollout et par son serveur
 * d'application (quota-native.cjs), la mémoire des annonces et la décision de lancement d'un agent. La logique (seuils, alertes,
 * consigne, commande /quota) est dans quota-logique.mjs.
 *
 * Fichiers (dans COCKPIT_DIR, écrits de façon atomique) :
 *   garde-quota.json             réglages de l'utilisateur (seuils, blocage des agents, consigne, son)
 *   quota-<agent>.json           dernière mesure d'un agent (fenêtres), lue par le Cockpit ; celle de Claude Code est écrite par son
 *                                adaptateur (cockpit-core.js, ecrireQuota), celle de Codex depuis son rollout (mesurerCodex) ou son
 *                                serveur d'application (rafraichirNatif)
 *   quota-native-<agent>.json    l'heure de la dernière lecture par le serveur d'application (au plus une par minute)
 *   garde-quota-alertes-<agent>.json   ce qui a déjà été annoncé (suivreCodex)
 *   relais-<agent>.md            le prompt de relais que l'agent écrit quand son quota est presque épuisé (il n'est pas lu ici)
 *
 * Les noms de fichiers n'acceptent que des clés d'agent (minuscules, chiffres et tirets : agents-noms.js) ; un nom d'agent du dépôt
 * (deepseek_H) est converti à l'entrée de chaque fonction.
 *
 * API : lireConfig, ecrireConfig, appliquerCommande, dernierQuotaRollout, mesurerCodex, rafraichirNatif, fenetresCourantes,
 *       suivreCodex, decisionAgentCodex.
 */

const fs = require('node:fs');
const path = require('node:path');
const cockpit = require('./cockpit-core.js');
const logique = require('./quota-logique.mjs');
const { cleAgent } = require('./agents-noms.js');

// Octets lus à la fin du rollout (il pèse des dizaines de Mo) : le dernier token_count y est, sauf si une réponse énorme le
// sépare de la fin ; l'appelant garde alors sa dernière mesure.
const LECTURE = 2 * 1024 * 1024;

const fichier = nom => path.join(cockpit.racine(), nom);
const objet = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// La clé d'état de l'agent (un nom du dépôt comme deepseek_H est converti), ou une erreur : jamais un chemin construit sur un nom libre.
function validerAgent(agent) {
  const cle = cleAgent(agent);
  if (cle === null) throw new Error(`agent invalide : ${JSON.stringify(agent)}`);
  return cle;
}

function lireConfig() {
  return logique.normaliserConfig(cockpit.lireJson(fichier('garde-quota.json'), null));
}

function ecrireConfig(config) {
  cockpit.ecrireJson(fichier('garde-quota.json'), { ...logique.normaliserConfig(config), maj: new Date().toISOString() });
}

// `/quota <args>` : rend { message, config } ou { erreur }. N'écrit que si les réglages changent.
function appliquerCommande(args) {
  const avant = lireConfig();
  const r = logique.analyserCommande(args, avant);
  if (r.erreur) return { erreur: r.erreur };
  if (JSON.stringify(r.config) !== JSON.stringify(avant)) ecrireConfig(r.config);
  return { message: r.message, config: r.config };
}

// rate_limits du dernier événement token_count du rollout de Codex, lu par la fin du fichier ; null si introuvable.
function dernierQuotaRollout(chemin, options = {}) {
  let fd;
  try {
    fd = fs.openSync(chemin, 'r');
    const taille = fs.fstatSync(fd).size;
    const debut = Math.max(0, taille - LECTURE);
    const tampon = Buffer.alloc(taille - debut);
    fs.readSync(fd, tampon, 0, tampon.length, debut);
    const lignes = tampon.toString('utf8').split('\n'); // la première ligne lue est sans doute coupée en deux : elle ne s'analyse pas, c'est tout
    for (let i = lignes.length - 1; i >= 0; i--) {
      const l = lignes[i];
      if (!l.includes('"token_count"') || !l.includes('"rate_limits"')) continue;
      try {
        const j = JSON.parse(l);
        const r = j && j.payload && j.payload.type === 'token_count' ? j.payload.rate_limits : null;
        if (objet(r) && (!r.limit_id || r.limit_id === 'codex')) {
          if (!options.metadata) return r;
          return { rateLimits: r, sourceAt: typeof j.timestamp === 'string' && Number.isFinite(Date.parse(j.timestamp)) ? j.timestamp : null };
        }
      } catch (_) { /* ligne coupée ou autre chose qu'un événement */ }
    }
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* déjà fermé */ } }
  }
  return null;
}

// Lit le quota dans le rollout de Codex et en garde la mesure pour le Cockpit (quota-<agent>.json) ; rend les fenêtres.
// Sans mesure dans le rollout, rien n'est écrit : la dernière mesure n'est pas remplacée par du vide.
function mesurerCodex({ agent, chemin }) {
  agent = validerAgent(agent);
  const brut = dernierQuotaRollout(chemin, { metadata: true });
  const fenetres = brut === null ? [] : logique.normaliserFenetresCodex(brut.rateLimits);
  const gardee = cockpit.lireQuota(agent);
  if (gardee?.source === 'app-server' && logique.assainirFenetres(gardee.fenetres).length &&
      (!brut?.sourceAt || Date.parse(gardee.mesureA) >= Date.parse(brut.sourceAt))) return logique.assainirFenetres(gardee.fenetres);
  if (fenetres.length) cockpit.ecrireQuota(agent, { fenetres, source: 'rollout', sourceAt: brut.sourceAt, limitId: brut.rateLimits.limit_id || 'codex' });
  return fenetres;
}

// Une lecture native au plus par minute et par agent. Les bancs peuvent couper cette entrée réseau sans couper le garde
// (COCKPIT_QUOTA_NATIVE=0). Seul l'agent codex a une lecture native.
function rafraichirNatif(agent) {
  validerAgent(agent);
  if (process.env.COCKPIT_QUOTA_NATIVE === '0' || agent !== 'codex') return;
  const etat = fichier(`quota-native-${agent}.json`);
  const avant = cockpit.lireJson(etat, null);
  if (avant && Date.now() - avant.ts < 60000) return;
  cockpit.ecrireJson(etat, { ts: Date.now() });
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'quota-native.cjs'), agent], {
      env: process.env, encoding: 'utf8', windowsHide: true, timeout: 4500, maxBuffer: 65536,
    });
    const mesure = r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null;
    if (mesure?.source === 'app-server' && logique.assainirFenetres(mesure.fenetres).length) cockpit.ecrireQuota(agent, mesure);
    else if (!cockpit.lireQuota(agent)) cockpit.ecrireQuota(agent, { fenetres: [], source: 'app-server-indisponible', sourceAt: null });
  } catch (_) { /* le rollout et le cache restent disponibles, avec leur vraie date */ }
}

// Le rollout d'abord ; à défaut, la dernière mesure gardée (le quota ne fait que monter jusqu'à la remise à zéro : une mesure
// ancienne sous-estime l'usage, elle ne l'exagère jamais, et logique.actives écarte une fenêtre dont la date est passée).
function fenetresCourantes({ agent, chemin }) {
  agent = validerAgent(agent);
  const mesurees = mesurerCodex({ agent, chemin });
  if (mesurees.length) return mesurees;
  const gardee = cockpit.lireQuota(agent);
  return logique.assainirFenetres(objet(gardee) ? gardee.fenetres : undefined);
}

// Ce que Codex doit entendre du quota à cet instant. Les annonces (alertes, remise à zéro) ne sont mémorisées que par
// `persister()`, que l'appelant n'appelle qu'une fois le texte réellement remis au modèle : une annonce non remise reste à dire.
function suivreCodex({ agent, fenetres, maintenant = Date.now() }) {
  agent = validerAgent(agent);
  const config = lireConfig();
  const chemin = fichier(`garde-quota-alertes-${agent}.json`);
  const lu = cockpit.lireJson(chemin, null);
  const etat = objet(lu) ? lu : {};
  const annonces = logique.alertes(fenetres, config, maintenant, etat.deja);
  const suivi = logique.suivreHauts(etat.hauts, fenetres, config, maintenant);
  const remise = suivi.remises.length > 0 ? { noms: suivi.remises, ts: maintenant } : logique.remiseRecente(etat.remise, maintenant) ? etat.remise : null;

  const lignes = annonces.nouvelles.map(a => `GARDE-QUOTA : ${logique.texteAlerte(a, maintenant, config)}`);
  const critique = logique.consigne(fenetres, config, maintenant, { autre: 'Claude', fichier: fichier('relais-claude.md').split(path.sep).join('/') });
  if (critique !== null) lignes.push(critique);
  const retour = config.consigne && remise !== null ? logique.consigneRemise(remise.noms) : null;
  if (retour !== null) lignes.push(retour);

  return {
    lignes,
    urgent: annonces.nouvelles.some(a => a.niveau === 'critique') || suivi.remises.length > 0,
    persister: () => cockpit.ecrireJson(chemin, { deja: annonces.deja, hauts: suivi.hauts, remise }),
  };
}

// Lancer un agent est refusé quand une fenêtre de ce Codex est au seuil critique (voir logique.decisionAgent).
function decisionAgentCodex({ agent, chemin, maintenant = Date.now() }) {
  return logique.decisionAgent(fenetresCourantes({ agent, chemin }), lireConfig(), maintenant);
}

module.exports = { lireConfig, ecrireConfig, appliquerCommande, dernierQuotaRollout, mesurerCodex, rafraichirNatif, fenetresCourantes, suivreCodex, decisionAgentCodex };
