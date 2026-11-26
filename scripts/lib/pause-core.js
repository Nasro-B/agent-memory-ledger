'use strict';
/**
 * Entrées-sorties de la Pause : l'état (sessions ouvertes, pauses de sessions et d'agents) vit dans COCKPIT_DIR/pause.json, lu et écrit
 * par l'adaptateur de chaque session, par la ligne de commande (cockpit.js pause, reprendre, pause-hook) et par le Cockpit.
 * La logique (décision d'attente, commandes /pause et /reprendre, textes) est dans pause-logique.mjs.
 *
 * Chaque opération lit, modifie, puis écrit seulement si l'état change, sous un verrou entre processus (avecVerrou : un fichier créé en
 * exclusivité à côté de l'état) pour que deux sessions qui battent en même temps, ou un battement qui croise un clic sur Pause, ne s'écrasent pas.
 * Le verrou ne retient jamais une pause : tenu plus de deux secondes, ou impossible à créer, il est ignoré (la dernière écriture gagne).
 * Une panne de lecture ne bloque jamais personne : un fichier absent ou abîmé se lit comme « aucune pause ».
 *
 * `attendre` est ce que l'adaptateur appelle pour retenir une session ou un agent en pause : il rend la main dès que la pause est levée,
 * ou au bout d'une durée bornée (l'adaptateur le rappelle tant que la pause dure). Un appel d'outil ne peut pas durer plus de dix minutes.
 *
 * Opérations des hooks (cockpit.js pause-hook <opération>, JSON sur l'entrée standard, JSON sur une ligne en sortie) :
 *   battre   { session, titre, agents: [{ id, nom, statut }] }                      le battement de l'adaptateur d'une session
 *   commande { sens: 'pause' | 'reprendre', args, session, fiche?, sessionRef? }    /pause et /reprendre (et leurs boutons)
 *   attendre { session, agentId?, dureeMs? }                                          rend { enPause } quand la pause est levée ou la durée écoulée
 *
 * API : avecVerrou, lireEtat, ecrireEtat, battre, appliquerCommande, doitAttendre, dureeBornee, attendre, executerHook.
 * Le résumé de la pause pour le Cockpit (instantané, ligne, panneau) est calculé par cockpit-core.js, qui lit pause.json sans passer par ici.
 */

const fs = require('node:fs');
const path = require('node:path');
const cockpit = require('./cockpit-core.js');
const logique = require('./pause-logique.mjs');

const VERROU_PERIME_MS = 5000;
const ATTENTE_VERROU_MS = 2000;
const PAS_VERROU_MS = 10;
const DUREE_ATTENTE_DEFAUT_MS = 20_000;
// Un appel d'outil dure dix minutes au plus : l'attente se tient bien en deçà.
const DUREE_ATTENTE_MAX_MS = 9 * 60 * 1000;
const PERIODE_ATTENTE_MS = 500;
const SENS = new Set(['pause', 'reprendre']);

const fichier = () => path.join(cockpit.racine(), 'pause.json');
const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const dormir = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = e => (e && e.message) || String(e);

const dormirSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Un verrou est un fichier créé en exclusivité à côté de l'état ; au-delà de cinq secondes il est réputé abandonné (processus mort).
function verrouPerime(verrou) {
  try { return Date.now() - fs.statSync(verrou).mtimeMs > VERROU_PERIME_MS; } catch (_) { return false; }
}

function retirer(verrou) {
  try { fs.unlinkSync(verrou); return true; } catch (_) { return false; }
}

// Les refus qui disent « pris par un autre » : le fichier existe (EEXIST), ou Windows refuse de créer un fichier dont la suppression est en
// cours (EPERM, EACCES, EBUSY), ce qui est un verrou en train de se libérer. Toute autre erreur (disque plein...) : pas de verrou possible.
const VERROU_OCCUPE = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

// true quand le verrou est à nous ; false après deux secondes d'attente, ou quand il ne peut pas être créé.
function prendreVerrou(verrou) {
  const fin = Date.now() + ATTENTE_VERROU_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(verrou, 'wx'));
      return true;
    } catch (e) {
      if (!VERROU_OCCUPE.has(e.code)) return false;
    }
    if (verrouPerime(verrou) && retirer(verrou)) continue;
    if (Date.now() >= fin) return false;
    dormirSync(PAS_VERROU_MS);
  }
}

// Exclusion entre processus pour toute lecture suivie d'une écriture de pause.json : deux sessions qui battent en même temps, ou un battement qui
// croise une commande, ne s'écrasent pas. Le verrou ne doit jamais empêcher une pause de s'écrire : s'il reste tenu plus de deux secondes, ou
// s'il ne peut pas être créé, la section s'exécute sans lui (la dernière écriture gagne) et le verrou d'un autre n'est pas touché.
function avecVerrou(section) {
  const verrou = `${fichier()}.verrou`;
  let pris = false;
  try {
    fs.mkdirSync(path.dirname(verrou), { recursive: true });
    pris = prendreVerrou(verrou);
  } catch (_) { /* sans verrou */ }
  try {
    return section();
  } finally {
    if (pris) retirer(verrou);
  }
}

function lireEtat() {
  return logique.normaliserEtat(cockpit.lireJson(fichier(), null));
}

function ecrireEtat(etat) {
  cockpit.ecrireJson(fichier(), { ...logique.normaliserEtat(etat), maj: new Date().toISOString() });
}

// N'écrit que si l'état change : une lecture ou une commande sans effet ne touche pas au fichier.
function enregistrer(avant, apres) {
  if (JSON.stringify(avant) !== JSON.stringify(apres)) ecrireEtat(apres);
}

// Le battement de l'adaptateur d'une session : rend { ok } (faux quand la fiche est illisible ou que l'état est plein de sessions vivantes).
function battre({ session, titre, agents, maintenant = Date.now() }) {
  return avecVerrou(() => {
    const avant = lireEtat();
    const apres = logique.inscrire(avant, { session, titre, agents }, maintenant);
    enregistrer(avant, apres);
    return { ok: typeof session === 'string' && Object.hasOwn(apres.sessions, session) };
  });
}

// `/pause <args>` et `/reprendre <args>` : rend { message } ou { erreur }. contexte : { session (celle qui reçoit la commande), fiche?,
// maintenant?, cible? (la session visée quand les arguments n'en nomment aucune), sessionRef? (une référence à résoudre en cible : la ligne
// de commande et les boutons du panneau n'ont pas de session courante) }.
function appliquerCommande(sens, args, contexte = {}) {
  if (!SENS.has(sens)) return { erreur: `Sens inconnu : ${String(sens)} (pause ou reprendre).` };
  return avecVerrou(() => {
    const avant = lireEtat();
    let cible = contexte.cible;
    if (contexte.sessionRef !== undefined) {
      const r = logique.trouverSession(avant, contexte.sessionRef);
      if (r.erreur) return { erreur: r.erreur };
      cible = r.id;
    }
    const r = logique.appliquerCommande(sens, args, avant, { maintenant: Date.now(), ...contexte, cible });
    if (r.erreur) return { erreur: r.erreur };
    try {
      enregistrer(avant, r.etat);
    } catch (e) {
      return { erreur: `Écriture impossible dans ${fichier()} (${message(e)}) : rien n'a changé.` };
    }
    return { message: r.message };
  });
}

const doitAttendre = (session, agentId) => logique.doitAttendre(lireEtat(), session, agentId);

// La durée d'une attente : celle qu'on demande, bornée ; une durée illisible ou négative vaut la durée par défaut.
const dureeBornee = ms => (Number.isFinite(ms) && ms >= 0 ? Math.min(ms, DUREE_ATTENTE_MAX_MS) : DUREE_ATTENTE_DEFAUT_MS);

// Rend { enPause: false } dès que la boucle n'a plus à attendre (pause levée, session sortie de l'état), sinon { enPause: true, cible,
// depuis } au bout de dureeMaxMs.
async function attendre({ session, agentId, dureeMaxMs, periodeMs = PERIODE_ATTENTE_MS }) {
  const fin = Date.now() + dureeBornee(dureeMaxMs);
  for (;;) {
    const d = doitAttendre(session, agentId);
    if (!d.attendre) return { enPause: false };
    const reste = fin - Date.now();
    if (reste <= 0) return { enPause: true, cible: d.cible, depuis: d.depuis };
    await dormir(Math.min(periodeMs, reste));
  }
}

// Les opérations que les hooks demandent au noyau. Une entrée invalide ou une panne rend { erreur } : le hook laisse passer.
async function executerHook(operation, entree) {
  try {
    if (!estObjet(entree)) return { erreur: 'entrée invalide' };
    switch (operation) {
      case 'battre':
        return battre({ session: entree.session, titre: entree.titre, agents: entree.agents, maintenant: Number.isFinite(entree.maintenant) ? entree.maintenant : Date.now() });
      case 'commande':
        return appliquerCommande(entree.sens, typeof entree.args === 'string' ? entree.args : '', {
          session: entree.session,
          sessionRef: typeof entree.sessionRef === 'string' ? entree.sessionRef : undefined,
          fiche: estObjet(entree.fiche) ? entree.fiche : undefined,
        });
      case 'attendre':
        if (typeof entree.session !== 'string' || entree.session === '') return { erreur: 'entrée invalide' };
        return await attendre({ session: entree.session, agentId: typeof entree.agentId === 'string' ? entree.agentId : undefined, dureeMaxMs: entree.dureeMs });
      default:
        return { erreur: `opération inconnue : ${operation}` };
    }
  } catch (e) {
    return { erreur: message(e) };
  }
}

module.exports = { avecVerrou, lireEtat, ecrireEtat, battre, appliquerCommande, doitAttendre, dureeBornee, attendre, executerHook };
