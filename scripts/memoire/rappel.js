#!/usr/bin/env node
'use strict';
// Rappel de la mémoire récente : après un compactage (ou un /clear), le modèle reçoit les entrées de
// l'historique et du résumé commun écrites depuis moins de 12 heures, projet courant d'abord.
//   node rappel.js --agent claude|codex
//
// Claude Code : à brancher sur SessionStart (startup|clear|compact).
//   compact, clear : tout ; startup : les AUTRES projets seulement (demarrage.js sert déjà le projet courant) ;
//   resume : rien (le contexte est déjà restauré).
// Codex : son événement PostCompact ne peut rien injecter (schéma de sortie strict). À brancher sur
//   PostCompact (pose un drapeau pour la session), UserPromptSubmit et PostToolUse (le premier qui passe prend
//   le drapeau sous verrou et injecte le rappel), et SessionStart (injection directe si source = compact|clear).
// Un sous-agent ne pose ni ne consomme le drapeau : chez Codex, son session_id est celui de l'orchestrateur.
// Léger : ne lit que les fichiers modifiés depuis moins de 12 heures.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');

const AGENT = config.agentDepuisArgs(process.argv);
const FENETRE_MS = 12 * 60 * 60 * 1000;
const PLAFOND_FICHIER = 2500, PLAFOND_RESUME = 2000, RESERVE_ENTETE = 600;
const DRAPEAU_PERIME_MS = 7 * 24 * 60 * 60 * 1000;

function dossierDrapeaux() { return config.chemins().etat; }
function drapeau(sessionId) {
  return path.join(dossierDrapeaux(), `rappel-${AGENT}-` + String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120));
}

// Texte du rappel (<= plafond). source : compact | clear | startup.
function construire(source, cwd) {
  const c = config.chemins();
  const projet = config.detecterProjet(cwd);
  const limite = Date.now() - FENETRE_MS;
  let fichiers = [];
  try {
    fichiers = fs.readdirSync(c.history)
      .filter(f => f.endsWith('.md') && !f.endsWith('.rules.md'))
      .map(f => { try { return { f, m: fs.statSync(path.join(c.history, f)).mtimeMs }; } catch (_) { return null; } })
      .filter(x => x && x.m >= limite);
  } catch (_) { fichiers = []; }
  const duProjet = f => !!projet && f.startsWith(projet + '.');
  if (source === 'startup' && projet) fichiers = fichiers.filter(x => !duProjet(x.f));
  fichiers.sort((a, b) => (duProjet(a.f) ? 0 : 1) - (duProjet(b.f) ? 0 : 1) || b.m - a.m);

  const items = [];
  let vues = 0;
  for (const { f } of fichiers) {
    let brut = '';
    try { brut = fs.readFileSync(path.join(c.history, f), 'utf8'); } catch (_) { continue; }
    const gardees = [];
    let garder = false, pris = 0, plein = false;
    // Après le plafond par fichier, on continue de COMPTER les entrées récentes : le total annoncé est le vrai.
    for (const ligne of brut.split(/\r?\n/)) {
      const h = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \|/.exec(ligne);
      if (h) { const t = memoire.lireHorodatage(h[1]); garder = t !== null && t >= limite; if (garder) vues++; }
      else if (/^## /.test(ligne)) garder = false;
      if (garder && !plein) {
        gardees.push(ligne); pris += ligne.length + 1;
        if (pris > PLAFOND_FICHIER) { gardees.push('[... tronqué à ' + PLAFOND_FICHIER + ' car. : suite dans ' + path.join(c.history, f) + ']'); plein = true; }
      }
    }
    if (gardees.length) items.push({ prio: duProjet(f) ? 1 : 2, path: path.join(c.history, f), text: '### history/' + f + '\n' + gardees.join('\n').trim() });
  }

  try {
    if (fs.statSync(c.resume).mtimeMs >= limite) {
      const out = [];
      let section = '?', pris = 0, plein = false;
      for (const ligne of fs.readFileSync(c.resume, 'utf8').split(/\r?\n/)) {
        if (ligne.startsWith('### ')) { section = ligne.slice(4).trim(); continue; }
        const h = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \|/.exec(ligne);
        if (!h) continue;
        const t = memoire.lireHorodatage(h[1]);
        if (t === null || t < limite) continue;
        vues++;
        if (plein) continue;
        out.push('[' + section + '] ' + ligne); pris += section.length + 3 + ligne.length + 1;
        if (pris > PLAFOND_RESUME) { out.push('[... tronqué : suite dans ' + c.resume + ']'); plein = true; }
      }
      if (out.length) items.push({ prio: 0, path: c.resume, text: '### Memory-Auto.md (lignes de moins de 12 h)\n' + out.join('\n') });
    }
  } catch (_) { /* pas encore de résumé */ }

  if (source === 'startup' && !items.length) return { texte: '', injectees: 0 };
  const titres = { compact: 'APRÈS COMPACTAGE', clear: 'APRÈS /clear (contexte vide)', startup: 'DÉMARRAGE : rappel des autres projets' };
  const entete = (titres[source] || titres.compact) + ' : consulte la mémoire et l\'historique des 12 dernières heures AVANT de continuer. ';
  if (!items.length) return { texte: entete + 'Aucune entrée datée de moins de 12 heures.', injectees: 0 };
  const corps = memoire.assembler(items, memoire.PLAFOND - RESERVE_ENTETE);
  const injectees = (corps.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/gm) || []).length
    + (corps.match(/^\[[^\]\n]*\] - \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/gm) || []).length;
  const partiel = injectees < vues ? ' (' + vues + ' au total : le reste est tronqué ou non injecté, lis les fichiers indiqués)' : '';
  return { texte: entete + injectees + ' entrée(s) réinjectée(s) ci-dessous' + partiel + ' : intègre-les à ton contexte de reprise.\n\n' + corps, injectees };
}

// Prend le drapeau pour UN seul processus, même si dix hooks tournent en parallèle : verrou par création
// exclusive ('wx'), périmé au-delà de 10 s. Retourne le contenu du drapeau, ou null.
function prendreDrapeau(f) {
  const verrou = f + '.lock';
  let fd;
  try { fd = fs.openSync(verrou, 'wx'); } catch (e) {
    if (e.code !== 'EEXIST') return null;
    try {
      if (Date.now() - fs.statSync(verrou).mtimeMs <= 10000) return null;
      fs.unlinkSync(verrou);
      fd = fs.openSync(verrou, 'wx');
    } catch (_) { return null; }
  }
  try {
    fs.closeSync(fd);
    let brut;
    try { brut = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    try { fs.unlinkSync(f); } catch (_) { return null; }
    try { return JSON.parse(brut) || {}; } catch (_) { return {}; }
  } finally {
    try { fs.unlinkSync(verrou); } catch (_) { /* rien */ }
  }
}

function menage() {
  try {
    for (const n of fs.readdirSync(dossierDrapeaux())) {
      if (!n.startsWith('rappel-')) continue;
      const p = path.join(dossierDrapeaux(), n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > DRAPEAU_PERIME_MS) fs.unlinkSync(p); } catch (_) { /* rien */ }
    }
  } catch (_) { /* dossier absent */ }
}

memoire.avecEntree(input => {
  if (!AGENT || input.agent_id || input.agent_type) return;
  const evt = String(input.hook_event_name || '');
  const sid = input.session_id;
  const cwd = input.cwd || process.cwd();

  if (evt === 'PostCompact') {
    if (!sid) return;
    fs.mkdirSync(dossierDrapeaux(), { recursive: true });
    menage();
    const f = drapeau(sid);
    const tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ session_id: sid, cwd, ts: new Date().toISOString() }));
    fs.renameSync(tmp, f);
    return;
  }

  if (evt === 'SessionStart') {
    const source = String(input.source || 'compact');
    if (source === 'resume') return;
    if (AGENT === 'codex' && source !== 'compact' && source !== 'clear') return;
    if (sid) { try { fs.unlinkSync(drapeau(sid)); } catch (_) { /* pas de drapeau */ } }
    const r = construire(source, cwd);
    memoire.injecter(AGENT, 'SessionStart', r.texte, 'Historique des 12 dernières heures consulté : ' + r.injectees + ' entrée(s) réinjectée(s)');
    return;
  }

  if (evt === 'UserPromptSubmit' || evt === 'PostToolUse') {
    if (!sid) return;
    if (evt === 'UserPromptSubmit' && /^\s*Message Type:/.test(String(input.prompt || ''))) return; // tâche d'un sous-agent Codex
    const d = prendreDrapeau(drapeau(sid)); // ancre-mutation:rappel-drapeau
    if (!d) return;
    memoire.injecter(AGENT, evt, construire('compact', cwd || d.cwd).texte);
  }
});
