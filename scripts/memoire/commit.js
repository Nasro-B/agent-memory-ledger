#!/usr/bin/env node
'use strict';
// Hook PostToolUse (commande shell) : après un `git commit` réussi, écrit une entrée signée dans le journal de
// l'agent et une ligne dans le résumé commun, puis retire le marqueur « travail non documenté » du projet.
//   node commit.js --agent claude|codex [--dry]
//
// Le sujet, le SHA, le dépôt et les fichiers viennent TOUJOURS de HEAD dans le dépôt réellement visé
// (git -C <chemin>, sinon `cd <chemin> &&` en tête de commande, sinon le dossier de travail de l'outil, sinon
// le cwd du hook), jamais de la ligne de commande seule. Le commit doit dater de moins de 90 secondes.
// Un `git commit` cité entre guillemets (rg "git commit") n'est pas un commit.

const path = require('path');
const config = require('../lib/config.js');
const memoire = require('../lib/memoire.js');
const { resolveCommitTarget } = require('../lib/commande-git.js');

const AGENT = config.agentDepuisArgs(process.argv);
const DRY = process.argv.includes('--dry');
const FRAICHEUR_S = 90;
// Délai accordé à git pour lire HEAD. Sur une machine très chargée, git peut mettre plusieurs secondes à
// répondre : avec un délai trop court, le commit n'était pas journalisé, en silence (cas mesuré à 2,5 s).
// AML_DELAI_GIT_MS ne sert qu'aux bancs.
const DELAI_GIT_MS = Number(process.env.AML_DELAI_GIT_MS) || 6000;
const DELAI_DETAILS_MS = 3000;

// Commandes shell d'un appel d'outil, avec leur dossier de travail. Claude Code : tool_input.command.
// Codex : la forme varie (commande directe, tableau, code qui appelle exec_command) : même analyse que la garde.
function commandes(input) {
  const ti = input.tool_input || {};
  if (AGENT === 'codex') {
    const a = require('../codex/context-ledger.js').analyser(String(input.tool_name || ''), ti);
    return a.commandes.map(c => ({ cmd: c, dossier: a.dossiers[0] || null }));
  }
  const cmd = typeof ti.command === 'string' ? ti.command : (typeof ti.cmd === 'string' ? ti.cmd : '');
  const dossier = typeof ti.workdir === 'string' && ti.workdir ? ti.workdir : (typeof ti.cwd === 'string' && ti.cwd ? ti.cwd : null);
  return cmd ? [{ cmd, dossier }] : [];
}

memoire.avecEntree(input => {
  if (!AGENT) return;
  const hookCwd = input.cwd || process.cwd();
  const reponse = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const texte = v => (typeof v === 'string' ? v : '');
  const resultat = [texte(reponse.stderr), texte(reponse.stdout), texte(reponse.output)].filter(Boolean).join('\n');
  const code = reponse.exit_code ?? reponse.exitCode;
  if (code !== undefined && code !== null && Number(code) !== 0) return;
  if (/(^|\n)\s*(error|fatal|rejected|aborted)\b/im.test(resultat)) return;
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(resultat)) return;

  for (const { cmd, dossier } of commandes(input)) {
    const cible = resolveCommitTarget(cmd, dossier || hookCwd);
    if (!cible.isCommit) continue;

    let racine = '', sha = '', sujet = '', date = NaN;
    try {
      racine = memoire.git(['rev-parse', '--show-toplevel'], cible.gitCwd, DELAI_GIT_MS).trim();
      const parts = memoire.git(['log', '-1', '--format=%ct%x00%h%x00%s'], cible.gitCwd, DELAI_GIT_MS).trim().split('\0');
      date = Number(parts.shift());
      sha = (parts.shift() || '').trim();
      sujet = parts.join('\0').replace(/\uFEFF/g, '').trim();
    } catch (e) {
      // git n'a pas répondu à temps : le dire au modèle, pour que le commit ne reste pas sans trace.
      if (e && (e.code === 'ETIMEDOUT' || e.killed || e.signal)) { // ancre-mutation:commit-delai
        const projet = config.detecterProjet(cible.gitCwd);
        if (projet && !DRY) {
          memoire.injecter(AGENT, 'PostToolUse', `Mémoire : ce commit n'a pas pu être journalisé (git n'a pas répondu en ${Math.round(DELAI_GIT_MS / 1000)} s). Écris toi-même son entrée dans ${memoire.fichierHistorique(projet, AGENT)} et sa ligne dans le résumé commun.`);
          return;
        }
      }
      continue;
    }
    const age = Date.now() / 1000 - date;
    if (!Number.isFinite(date) || age > FRAICHEUR_S || age < -5 || !racine || !sha || !sujet) continue;

    // Le SHA annoncé par git dans la sortie de la commande, s'il y en a un, doit être celui de HEAD ; sans
    // lui ni code de sortie, le message passé par -m doit être le sujet de HEAD (sinon ce commit frais vient
    // d'une autre commande ou d'un autre agent).
    const annonce = (/\[[^\]]*\s([a-f0-9]{7,40})\]/i.exec(resultat) || [])[1];
    if (annonce && !sha.toLowerCase().startsWith(annonce.toLowerCase()) && !annonce.toLowerCase().startsWith(sha.toLowerCase())) continue;
    const dq = /-m\s+"((?:[^"\\]|\\.)+)"/.exec(cmd);
    const sq = /-m\s+'([^']+)'/.exec(cmd);
    const declare = (dq ? dq[1].replace(/\\"/g, '"') : (sq ? sq[1] : '')).split(/\r?\n/)[0].trim();
    if ((code === undefined || code === null) && !annonce && declare && declare !== sujet) continue;

    const projet = config.detecterProjet(racine);
    if (!projet) continue;

    let type = 'commit', titre = sujet;
    const conv = /^(\w+)(?:\([^)]+\))?:\s*(.+)/.exec(sujet);
    if (conv) { type = conv[1]; titre = conv[2].trim(); }

    const details = [];
    try {
      const stat = memoire.git(['diff', '--stat', 'HEAD~1', 'HEAD'], cible.gitCwd, DELAI_DETAILS_MS).trim();
      if (stat) {
        const lignes = stat.split('\n');
        for (const l of lignes.slice(0, -1).slice(0, 8)) details.push('- ' + l.trim());
        details.push('- ' + lignes[lignes.length - 1].trim());
      }
      const corps = memoire.git(['log', '-1', '--format=%B'], cible.gitCwd, DELAI_DETAILS_MS).trim().split('\n').slice(2)
        .filter(l => l.trim() && !/^Co-Authored-By:/i.test(l)).slice(0, 4);
      for (const l of corps) details.push('- ' + l.trim());
    } catch (_) { /* premier commit du dépôt, ou git trop lent : l'entrée reste écrite */ }
    if (!details.length) details.push('- Écrit par le hook de mémoire après le commit');

    const horo = memoire.horodatage();
    const signature = config.SIGNATURES[AGENT];
    const marque = `(commit ${sha})`;
    const entree = `## ${horo} | ${type} | ${titre} ${marque} | ${signature}\n\n${details.join('\n')}\n`;
    const ligne = `- ${horo} | ${type} | ${titre} ${marque} | ${signature}`;
    if (DRY) { process.stdout.write('[dry] ' + memoire.fichierHistorique(projet, AGENT) + ' <-\n' + entree + '[dry] résumé <- ' + ligne + '\n'); continue; }
    memoire.ajouterAuJournal(projet, AGENT, entree, contenu => contenu.includes(marque));
    memoire.ajouterAuResume(projet, ligne, l => l.includes(marque));
    memoire.retirerMarqueur(projet); // ancre-mutation:commit-marqueur
    if (AGENT === 'claude') {
      process.stdout.write(JSON.stringify({ systemMessage: `[mémoire] Entrée signée ${signature} : ${path.basename(memoire.fichierHistorique(projet, AGENT))} et Memory-Auto.md : ${horo} | ${type} | ${titre}` }));
    }
    return;
  }
});
