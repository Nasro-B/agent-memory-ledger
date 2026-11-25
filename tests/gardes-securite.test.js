'use strict';
// Banc de la garde de sécurité des commandes (scripts/gardes/securite.js, scripts/lib/commande-securite.js,
// scripts/lib/gardes-config.js). Sans modèle : les appels d'outils sont simulés, les maisons et les dépôts sont
// jetables. Chaque règle de refus, de confirmation et d'avertissement a un cas qui la déclenche et un cas voisin qui
// passe ; chaque protection a sa mutation (dernier test).
// Lancement : node --test tests/gardes-securite.test.js
// Les deux commandes dangereuses (suppression récursive forcée, saut des vérifications de git) sont construites par
// morceaux : ce fichier ne les contient jamais en clair.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { creerMonde } = require('./aide-gardes.js');
const { erreursSortieCodex } = require('./schema.js');

const m = creerMonde('securite');
const securite = require(m.scripts('gardes', 'securite.js'));
const gardesConfig = require(m.scripts('lib', 'gardes-config.js'));
const cs = require(m.scripts('lib', 'commande-securite.js'));
const core = require(m.scripts('lib', 'context-ledger-core.js'));

const RM = 'r' + 'm';
const RF = '-' + 'r' + 'f';
const SAUT_HOOKS = '--no-' + 'verify';
const DEPOT = 'C:/travail/depot';
const MAISON_VIDE = m.maison();

// Appelle la garde comme le moteur le ferait : { decision, texte, stdout, stderr, code }.
//   o.agent : 'claude' (défaut), 'codex', null (agent non nommé) ; o.maison / o.gardes : réglage ; o.session, o.enfant ;
//   o.outil ; o.entree : tool_input complet ; o.brut : entrée brute.
function appeler(commande, o = {}) {
  const agent = o.agent === undefined ? 'claude' : o.agent;
  const maison = o.maison || (o.gardes !== undefined ? m.maison(o.gardes) : MAISON_VIDE);
  const charge = {
    hook_event_name: 'PreToolUse', session_id: o.session, agent_id: o.enfant ? 'enfant' : undefined,
    tool_name: o.outil || (agent === 'claude' ? 'Bash' : 'exec_command'), cwd: 'C:/travail/essai',
    tool_input: o.entree || { command: commande, cmd: commande },
  };
  const r = m.avecMaison(maison, () => securite.executer(o.brut !== undefined ? o.brut : JSON.stringify(charge), { agent }));
  const sortie = r.stdout ? JSON.parse(r.stdout) : {};
  const h = sortie.hookSpecificOutput || {};
  assert.deepEqual(erreursSortieCodex('PreToolUse', r.stdout), [], 'sortie conforme au schéma des hooks : ' + r.stdout);
  return { decision: h.permissionDecision || 'allow', texte: h.permissionDecisionReason || h.additionalContext || '', contexte: h.additionalContext || '', message: sortie.systemMessage || '', stdout: r.stdout, stderr: r.stderr, code: r.code };
}
const decision = (c, o) => appeler(c, o).decision;

// Session d'un agent dont le message du tour est `texte` (la liste de travail l'enregistre mot pour mot).
let numeroSession = 0;
function sessionAvec(agent, texte, gardes) {
  const maison = m.maison(gardes);
  const session = 'session-' + (++numeroSession);
  const messages = Array.isArray(texte) ? texte : [texte];
  messages.forEach((t, i) => m.avecMaison(maison, () => core.enregistrerMessage({ agent, sessionId: session, promptId: 'p' + i, cwd: maison, texte: t })));
  return { maison, session };
}

// ------------------------------------------------------------------ règles de refus

test('securite : suppression récursive forcée refusée sous toutes ses formes, voisins permis', () => {
  for (const c of [`${RM} ${RF} dossier`, `${RM} -fr dossier`, `${RM} -r -f dossier`, `${RM} -f -r dossier`, `${RM} --recursive --force dossier`, `${RM} -Rf dossier`, `cd x && ${RM} ${RF} y`, `ls | ${RM} ${RF} y`]) {
    assert.equal(decision(c), 'deny', c);
  }
  for (const c of [`${RM} -r dossier`, `${RM} -f fichier`, `${RM} fichier`, `${RM} -r a; ls -f`, `echo ${RM}`]) assert.equal(decision(c), 'allow', c);
});

test('securite : nettoyage forcé des fichiers non suivis refusé, simulation permise', () => {
  for (const c of ['git clean -f', 'git clean -fd', 'git clean -fdx', 'git clean -x -f', 'git clean --force', 'git -C x clean -fd']) assert.equal(decision(c), 'deny', c);
  for (const c of ['git clean -n', 'git clean -nd', 'git clean --dry-run', 'git status']) assert.equal(decision(c), 'allow', c);
});

test('securite : suppression récursive Windows refusée, voisins permis', () => {
  for (const c of ['Remove-Item x -Recurse -Force', 'Remove-Item -Force -Recurse x', 'ri -Recurse -Force x', 'rd /s /q x', 'rmdir /s x', 'del /s x', 'erase /s x']) assert.equal(decision(c), 'deny', c);
  for (const c of ['Remove-Item x', 'Remove-Item -Recurse x', 'Remove-Item -Force x', 'rmdir x', 'del x']) assert.equal(decision(c), 'allow', c);
});

test('securite : retour forcé de l\'arbre refusé, retours doux permis', () => {
  for (const c of ['git reset --hard', 'git reset --hard HEAD~1', 'git -C x reset --hard', 'git -c "alias.cleanup=reset --hard" cleanup']) assert.equal(decision(c), 'deny', c);
  for (const c of ['git reset --soft HEAD~1', 'git reset HEAD fichier', 'git reset --mixed']) assert.equal(decision(c), 'allow', c);
});

test('securite : contournement des hooks de git refusé, commit normal permis', () => {
  assert.equal(decision(`git commit ${SAUT_HOOKS} -m x`), 'deny');
  assert.equal(decision(`git -C x commit -m x ${SAUT_HOOKS.toUpperCase()}`), 'deny');
  assert.equal(decision('git commit -m "x"'), 'allow');
  assert.equal(decision('git commit -m "no verify"'), 'allow');
});

test('securite : poussée forcée refusée sous toutes ses formes, poussée simple seulement soumise à confirmation', () => {
  for (const c of ['git push --force', 'git push -f', 'git push --force-with-lease origin main', 'git push origin +main', 'git push origin +HEAD:main', 'git -C x push --force',
    'git -c alias.p=push p --force', 'bash -c "git push --force"', 'git status && git push -f origin x']) {
    assert.equal(decision(c), 'deny', c);
    assert.equal(decision(c, { agent: 'codex' }), 'deny', c);
  }
  for (const c of ['git push', 'git push origin feat+x', 'git push -u origin main', 'git push --follow-tags']) assert.equal(decision(c), 'ask', c);
  assert.equal(decision('git pull --force'), 'allow');
  assert.equal(decision('git fetch --force'), 'allow');
});

test('securite : branche protégée : suppression et renommage refusés selon gardes.json, aucun motif par défaut', () => {
  const gardes = { securite: { branchesProtegees: ['^sauvegarde-', { motif: '\\bPROD\\b', casse: true }, '[abc'] } };
  for (const c of ['git branch -D sauvegarde-v1', 'git branch -d sauvegarde-v1', 'git branch -m sauvegarde-v1 autre', 'git branch --delete sauvegarde-v1', 'git branch --move sauvegarde-v1 autre',
    'git push origin --delete sauvegarde-v1', 'git push origin :sauvegarde-v1', 'git -C x branch -D sauvegarde-v1', 'git branch -D PROD', 'git branch -D "[abc"']) {
    assert.equal(decision(c, { gardes }), 'deny', c);
  }
  for (const c of ['git branch -D feature-x', 'git branch --list sauvegarde-v1', 'git branch sauvegarde-nouvelle', 'git branch -D prod', 'git status']) assert.equal(decision(c, { gardes }), 'allow', c);
  assert.equal(decision('git push origin sauvegarde-v1', { gardes }), 'ask', 'pousser une branche protégée sans la forcer reste une simple poussée');
  // Sans motif : seules la poussée forcée et les règles générales jouent.
  for (const c of ['git branch -D sauvegarde-v1', 'git push origin --delete sauvegarde-v1', 'git push origin :sauvegarde-v1']) {
    assert.notEqual(decision(c, { gardes: {} }), 'deny', c + ' sans motif configuré');
  }
  assert.equal(decision('git branch -D sauvegarde-v1'), 'allow');
});

test('securite : wrangler deploy sans keep-vars refusé, règle d\'outil désactivable', () => {
  for (const c of ['wrangler deploy', 'npx wrangler deploy', 'npx wrangler.cmd deploy --env prod', 'wrangler.exe deploy']) assert.equal(decision(c), 'deny', c);
  for (const c of ['wrangler deploy --keep-vars', 'wrangler dev', 'wrangler deployments list']) assert.equal(decision(c), 'allow', c);
  assert.equal(decision('wrangler deploy', { gardes: { securite: { reglesDesactivees: ['wrangler-keep-vars'] } } }), 'allow');
  assert.equal(decision(`${RM} ${RF} x`, { gardes: { securite: { reglesDesactivees: ['wrangler-keep-vars'] } } }), 'deny', 'les autres règles restent');
});

// ------------------------------------------------------------------ confirmations

test('securite : poussée et déploiement de production demandent confirmation (Claude Code)', () => {
  for (const c of ['git push', 'git push origin main', 'GIT PUSH', 'Git Push', 'git.exe push', 'GIT.EXE -C x push', 'env GIT_TRACE=1 git push', 'bash -c "git push"', 'git -c alias.p=push p']) {
    const r = appeler(c);
    assert.equal(r.decision, 'ask', c);
    assert.equal(r.code, 0, c);
  }
  for (const c of ['vercel --prod', 'vercel deploy --prod', 'npx vercel --prod', 'vercel.cmd deploy --prod --yes', 'VERCEL DEPLOY --PROD']) assert.equal(decision(c), 'ask', c);
  for (const c of ['vercel deploy', 'vercel env ls', 'vercel --version', 'git status', 'git pull', 'git fetch origin']) assert.equal(decision(c), 'allow', c);
  assert.equal(decision('git push', { gardes: { securite: { confirmer: ['deploiement-production'] } } }), 'allow', 'poussée retirée de la liste');
  assert.equal(decision('vercel --prod', { gardes: { securite: { confirmer: ['poussee'] } } }), 'allow', 'déploiement retiré de la liste');
  assert.equal(decision('git push', { gardes: { securite: { confirmer: [] } } }), 'allow');
});

test('securite : confirmation ajoutée par gardes.json : commande nommée, message propre, ordre attendu', () => {
  const gardes = { securite: { confirmer: ['poussee', { nom: 'publication', motif: '\\bmon-outil\\s+publier\\b', message: 'Publication détectée : à confirmer.' }] } };
  const r = appeler('mon-outil publier --tout', { gardes });
  assert.equal(r.decision, 'ask');
  assert.match(r.texte, /Publication détectée : à confirmer\./);
  assert.equal(decision('mon-outil lister', { gardes }), 'allow');
  assert.equal(decision('git push', { gardes }), 'ask');
  // Chez un agent sans confirmation, l'ordre attendu est celui de la commande (déploiement par défaut).
  const s = sessionAvec('codex', 'déploie');
  assert.equal(decision('mon-outil publier', { gardes, agent: 'codex', maison: s.maison, session: s.session }), 'allow');
  assert.equal(decision('mon-outil publier', { gardes: Object.assign({}, gardes), agent: 'codex' }), 'deny');
});

test('securite : avertissement vercel env add sans printf, règle d\'outil désactivable', () => {
  for (const agent of ['claude', 'codex']) {
    const r = appeler('vercel env add MA_VARIABLE production', { agent });
    assert.equal(r.decision, 'allow');
    assert.match(r.contexte, /printf valeur \| vercel env add/, agent);
    assert.match(r.message, /ATTENTION/, agent);
    assert.equal(appeler('printf valeur | vercel env add MA_VARIABLE production', { agent }).stdout, '', agent);
    assert.equal(appeler('vercel env ls', { agent }).stdout, '', agent);
  }
  assert.equal(appeler('vercel env add X production', { gardes: { securite: { reglesDesactivees: ['vercel-env-sans-printf'] } } }).stdout, '');
});

test('securite : toutes les règles trouvées sont rapportées d\'un coup', () => {
  const r = appeler(`${RM} ${RF} x; git reset --hard; git clean -fd; git push --force; Remove-Item y -Recurse -Force; git commit ${SAUT_HOOKS} -m x; wrangler deploy; vercel env add A production`);
  assert.equal(r.decision, 'deny');
  for (const motif of [/Suppression récursive forcée/, /git reset --hard/, /git clean/, /Poussée forcée/, /récursive Windows/, /contourne les hooks/, /wrangler deploy/, /printf valeur/]) assert.match(r.texte, motif);
  assert.equal(r.code, 2, 'Claude Code : code 2 et raison sur la sortie d\'erreur');
  assert.match(r.stderr, /Suppression récursive forcée/);
  // Un refus et une confirmation ensemble : tout est dit dans le refus.
  assert.match(appeler(`git reset --hard && git push`).texte, /git push détecté/);
});

// ------------------------------------------------------------------ options globales de git, alias, casse

const prefixes = [
  'git -C C:/travail/depot', 'git -C "C:/travail/avec espaces" -c color.ui=false', 'git -c core.hooksPath=.git/hooks',
  'git --git-dir=C:/travail/depot.git --work-tree=C:/travail/arbre', 'git --no-pager -c color.ui=false -C C:/travail/depot',
  '& "C:/Program Files/Git/cmd/git.exe" -C C:/travail/depot', 'GIT.EXE -C C:/travail/depot',
];

test('securite : les options globales de git ne cachent ni la poussée ni les commandes destructrices', () => {
  for (const agent of ['claude', 'codex']) {
    for (const p of prefixes) {
      assert.notEqual(decision(p + ' push origin main', { agent }), 'allow', agent + ' ' + p);
      for (const suffixe of ['reset --hard', 'push --force origin main', 'push origin +main', 'clean -fdx']) assert.equal(decision(p + ' ' + suffixe, { agent }), 'deny', agent + ' ' + p + ' ' + suffixe);
      assert.equal(decision(p + ' status --short', { agent }), 'allow', agent + ' ' + p);
    }
    assert.equal(decision('git status; git -C C:/travail/depot reset --hard', { agent }), 'deny', agent);
    assert.notEqual(decision('git -c alias.publish=push publish origin main', { agent }), 'allow', agent);
    assert.equal(decision('git -c "alias.cleanup=reset --hard" cleanup', { agent }), 'deny', agent);
  }
});

const poussees = [
  'git push', 'git -C x push', 'git push --force', 'git push origin HEAD:refs/heads/x', 'git status && git push', 'git status; git push', 'git status | git push',
  'bash -c "git push"', 'pwsh -Command "git push"', 'cmd /c "git push"', 'GIT_TRACE=1 git push', 'env GIT_TRACE=1 git push', 'git.exe push', 'GIT PUSH', 'Git Push',
  'git -c alias.p=push p', 'FOO=bar git push', 'FOO=bar bash -c "git push"', 'git --git-dir=x push', 'git -C x -c color.ui=false push',
  'pwsh -Command "Write-Output ready; git push"', 'cmd /c "echo ready && git push"', 'bash -lc "git status | git push"', '& "C:/Program Files/Git/cmd/git.exe" push',
  'git status && pwsh -Command "git.exe push"', 'env -u GIT_CONFIG git push', 'sudo git push', 'time git push', 'sh -c \'git push\'', 'git -C x push --force-with-lease',
  'git push origin +main', 'git push --delete origin une-branche', 'pwsh -Command \'Write-Output "$(git push)"\'', 'bash -c \'echo "$(git push)"\'',
];
const citees = ['rg -n "vrai git push" .', 'Set-Content -LiteralPath rapport.md -Value \'git push\'', 'Write-Output \'ne fais pas de git push\'', "Write-Output '$(git push)'",
  'echo "git -C C:/travail/depot push origin main"', 'echo git -C C:/travail/depot push origin main'];
const opaques = ['xargs git push', 'echo origin | xargs git push', 'find . -maxdepth 1 -exec git push {} ;', 'Invoke-Expression "git push"', 'iex "git push"', 'eval "git push"',
  'python -c "import os; os.system(\'git push\')"', 'node -e "require(\'child_process\').execSync(\'git push\')"', 'Invoke-Command -ScriptBlock { git push }', 'xargs git push --force',
  'timeout 10 git push', 'wsl git push', 'wsl.exe -e git push origin HEAD', 'nice git push', 'start git push', 'xargs -n1 git -C x push'];

test('securite : poussées directes ou enveloppées toujours reconnues, texte cité jamais pris pour une commande', () => {
  for (const agent of ['claude', 'codex']) {
    for (const c of poussees) assert.notEqual(decision(c, { agent }), 'allow', agent + ' : ' + c);
    for (const c of citees) assert.equal(decision(c, { agent }), 'allow', agent + ' : ' + c);
  }
  assert.equal(poussees.length, 34);
  assert.equal(citees.length, 6);
});

test('securite : enveloppes d\'exécution opaques refusées d\'après le texte, enveloppes sans git permises', () => {
  for (const agent of ['claude', 'codex']) {
    for (const c of opaques) assert.notEqual(decision(c, { agent }), 'allow', agent + ' : ' + c);
    for (const c of ['xargs echo ready', 'Invoke-Expression "Get-Date"', 'python -c "print(1)"', 'timeout 10 git status', 'wsl git log -1', 'xargs git status']) assert.equal(decision(c, { agent }), 'allow', agent + ' : ' + c);
  }
  assert.equal(opaques.length, 16);
});

test('securite : here-documents et here-strings : un message de commit à apostrophe passe, un corps exécuté est lu', () => {
  const message = 'git commit -m "$(cat <<\'EOF\'\nfix(garde): l\'ordre du message\nEOF\n)"';
  const messageCRLF = message.replace(/\n/g, '\r\n');
  const pwsh = 'git commit -m @\'\nl\'ordre du message\n\'@';
  const apresCorps = 'git commit -F - <<\'FIN\'\nl\'ordre\nFIN\ngit push\n';
  for (const agent of ['claude', 'codex']) {
    assert.equal(decision(message, { agent }), 'allow', agent + ' : substitution et here-document');
    assert.equal(decision(messageCRLF, { agent }), 'allow', agent + ' : fins de ligne Windows');
    assert.equal(decision(pwsh, { agent }), 'allow', agent + ' : here-string PowerShell');
    assert.equal(decision('git commit -F - <<\'FIN\'\nl\'ordre\nFIN\n', { agent }), 'allow', agent + ' : here-document de tête, apostrophe isolée');
    assert.notEqual(decision(apresCorps, { agent }), 'allow', agent + ' : une commande après le corps est lue');
    for (const c of ['bash <<\'EOF\'\ngit push\nEOF\n', 'cat <<\'EOF\' | bash\ngit push\nEOF\n', 'sh <<EOF\ngit push\nEOF\n', 'iex @\'\ngit push\n\'@', `bash <<'EOF'\n${RM} ${RF} x\nEOF\n`]) {
      assert.notEqual(decision(c, { agent }), 'allow', agent + ' : ' + JSON.stringify(c));
    }
    // Sans terminateur, rien n'est sauté : la ligne qui suit reste une commande.
    assert.notEqual(decision('x=$((1<<3))\ngit push\n', { agent }), 'allow', agent + ' : décalage de bits, pas un here-document');
    assert.notEqual(decision('cat <<EOF\ngit push\n', { agent }), 'allow', agent + ' : here-document sans terminateur');
  }
  assert.deepEqual(cs.commandesGitExecutees('git commit -m "x"\n'), ['git commit -m "x"']);
});

// ------------------------------------------------------------------ Codex : l'ordre de l'utilisateur

test('securite : Codex refuse la poussée sans ordre, l\'accepte sur ordre du tour, jamais forcée', () => {
  const s = sessionAvec('codex', 'pousse');
  const o = { agent: 'codex', maison: s.maison, session: s.session };
  const r = appeler('git -C C:/travail/depot push origin main', o);
  assert.equal(r.decision, 'allow');
  assert.match(r.contexte, /autorisée sur ordre de l'utilisateur/);
  assert.equal(decision('git -C C:/travail/depot push --force origin main', o), 'deny', 'un ordre n\'autorise jamais la poussée forcée');
  assert.equal(decision(`${RM} ${RF} x`, o), 'deny', 'ni une suppression récursive');
  assert.equal(decision('vercel --prod', o), 'deny', 'ordre de poussée : pas de déploiement');
  const sans = appeler('git push origin main', { agent: 'codex' });
  assert.equal(sans.decision, 'deny');
  assert.match(sans.texte, /Pas d'ordre de l'utilisateur pour ce tour : session inconnue/);
  assert.match(sans.texte, /ne contourne pas ce refus/i);
  assert.equal(decision('git push origin main', { agent: 'codex', session: 'inconnue' }), 'deny', 'session sans message enregistré');
  assert.equal(sans.code, 0, 'Codex : JSON seul, code 0');
  assert.equal(sans.stderr, '');
});

test('securite : un sous-agent ne réutilise jamais l\'ordre de son parent', () => {
  const s = sessionAvec('codex', 'pousse');
  const r = appeler('git push origin main', { agent: 'codex', maison: s.maison, session: s.session, enfant: true });
  assert.equal(r.decision, 'deny');
  assert.match(r.texte, /un sous-agent ne pousse ni ne déploie jamais/);
});

test('securite : ordre de l\'utilisateur : mots reconnus, négations, questions, passé, anglais, tours précédents', () => {
  const pousse = texte => decision('git push origin main', Object.assign({ agent: 'codex' }, sessionAvec('codex', texte)));
  for (const t of ['pousse', 'Pousse ça sur main.', 'push', 'peux-tu pousser maintenant', 'push it please', 'pousse puis déploie']) assert.equal(pousse(t), 'allow', t);
  for (const t of ['ne pousse pas', 'as tu deja pousse ?', 'pousse ?', 'jamais de push', 'sans pousser', 'attends avant de pousser', 'do not push', 'did you push?', 'j ai déjà poussé hier, push', 'corrige le bug', 'bonjour']) assert.equal(pousse(t), 'deny', t);
  const s = sessionAvec('codex', ['pousse', 'continue le travail']);
  assert.equal(decision('git push origin main', { agent: 'codex', maison: s.maison, session: s.session }), 'deny', 'l\'ordre d\'un tour précédent ne vaut plus');
  const deploie = (texte, commande = 'vercel --prod') => decision(commande, Object.assign({ agent: 'codex' }, sessionAvec('codex', texte)));
  for (const t of ['déploie', 'deploy', 'mets en production', 'redéploie']) assert.equal(deploie(t), 'allow', t);
  for (const t of ['ne déploie pas', 'pousse', 'deploy ?']) assert.equal(deploie(t), 'deny', t);
  assert.equal(deploie('pousse puis déploie', 'git push && vercel --prod'), 'allow');
  assert.equal(deploie('pousse', 'git push && vercel --prod'), 'deny', 'les deux ordres sont exigés');
  assert.equal(securite.contientOrdre('pousse', /pousse/i), true);
});

test('securite : ordre de l\'utilisateur : mots réglables et fonction éteignable', () => {
  const mots = { securite: { ordreUtilisateur: { motsPoussee: ['vas-y'] } } };
  const s1 = sessionAvec('codex', 'vas-y', mots);
  assert.equal(decision('git push', { agent: 'codex', maison: s1.maison, session: s1.session }), 'allow');
  const s2 = sessionAvec('codex', 'pousse', mots);
  assert.equal(decision('git push', { agent: 'codex', maison: s2.maison, session: s2.session }), 'deny', 'les mots par défaut sont remplacés');
  const eteint = sessionAvec('codex', 'pousse', { securite: { ordreUtilisateur: false } });
  const r = appeler('git push', { agent: 'codex', maison: eteint.maison, session: eteint.session });
  assert.equal(r.decision, 'deny');
  assert.match(r.texte, /n'est pas accepté comme autorisation/);
  const eteint2 = sessionAvec('codex', 'pousse', { securite: { ordreUtilisateur: { actif: false } } });
  assert.equal(decision('git push', { agent: 'codex', maison: eteint2.maison, session: eteint2.session }), 'deny');
});

test('securite : un agent non nommé est traité comme un agent qui ne sait pas demander : refus, jamais « ask »', () => {
  assert.equal(decision('git push', { agent: null }), 'deny');
  assert.equal(decision('git push', { agent: 'deepseek_H' }), 'deny');
  assert.equal(decision('git status', { agent: null }), 'allow');
});

// ------------------------------------------------------------------ analyse impossible, outils exemptés

test('securite : une commande qui ne peut pas être analysée est refusée, explicitement', () => {
  for (const agent of ['claude', 'codex']) {
    for (const brut of ['{pas du json', '']) {
      const r = appeler('', { agent, brut });
      assert.equal(r.decision, 'deny', agent + ' : entrée illisible');
      assert.match(r.texte, /n'a pas pu analyser la commande/);
    }
    for (const c of ['echo "jamais fermé', 'echo "$(git status', 'git --option-inconnue status', 'git -C']) assert.equal(decision(c, { agent }), 'deny', agent + ' : ' + c);
  }
});

test('securite : apply_patch n\'est pas une commande, un shell qui l\'appelle reste analysé', () => {
  const patch = '*** Begin Patch\n+git reset --hard\n+git push --force\n*** End Patch';
  assert.equal(decision(patch, { agent: 'codex', outil: 'apply_patch' }), 'allow');
  assert.equal(decision(patch.replace(/\+/g, ''), { agent: 'codex', outil: 'apply_patch' }), 'allow');
  assert.equal(decision('*** Begin Patch\ngit reset --hard\n*** End Patch', { agent: 'codex', outil: 'exec_command' }), 'deny');
  assert.equal(decision('', { agent: 'codex' }), 'allow', 'pas de commande, rien à juger');
  assert.equal(decision('', { agent: 'codex', entree: { cmd: ['bash', '-lc', 'git push --force'] } }), 'deny', 'commande en tableau');
  assert.equal(decision('', { agent: 'codex', entree: { cmd: ['git', 'status'] } }), 'allow');
});

// ------------------------------------------------------------------ configuration

test('securite : configuration : sans fichier, défauts sûrs et neutres', () => {
  const cfg = m.avecMaison(MAISON_VIDE, () => gardesConfig.charger());
  assert.equal(cfg.present, false);
  assert.equal(cfg.illisible, false);
  assert.deepEqual(cfg.avertissements, []);
  assert.equal(cfg.securite.actif && cfg.checklist.actif && cfg.caracteres.actif, true);
  assert.equal(cfg.securite.branchesProtegees.length, 0);
  assert.deepEqual(cfg.securite.confirmer.map(c => c.nom), ['poussee', 'deploiement-production']);
  assert.equal(cfg.securite.ordreUtilisateur.actif, true);
  assert.deepEqual(cfg.checklist.categories.map(c => c.nom), ['migrations', 'fonctions', 'variables', 'taches']);
  assert.equal(cfg.caracteres.tiretLongFinDeTour, false);
  assert.equal(gardesConfig.dire(cfg), '');
});

test('securite : configuration : un gardes.json illisible ne désarme rien, et la garde le dit', () => {
  for (const contenu of ['{ pas du json', '[]', '"texte"', '']) {
    const maison = m.maison(contenu);
    const cfg = m.avecMaison(maison, () => gardesConfig.charger());
    assert.equal(cfg.illisible, true, JSON.stringify(contenu));
    assert.equal(cfg.securite.actif && cfg.checklist.actif && cfg.caracteres.actif, true, 'les trois gardes restent actives');
    const r = appeler('git push', { maison });
    assert.equal(r.decision, 'ask', 'les défauts s\'appliquent');
    assert.match(r.texte, /illisible/);
    assert.equal(appeler(`${RM} ${RF} x`, { maison }).decision, 'deny');
    assert.match(appeler('git status', { maison }).contexte, /illisible/, 'même une commande permise le dit');
  }
  assert.equal(m.avecMaison(m.maison('\u{FEFF}{ "securite": { "confirmer": [] } }'), () => gardesConfig.charger()).illisible, false, 'une marque d\'ordre des octets en tête est admise');
});

test('securite : configuration : une valeur mal formée retombe sur le défaut, seul un vrai false éteint', () => {
  const lire = gardes => m.avecMaison(m.maison(gardes), () => gardesConfig.charger());
  for (const mauvais of ['false', 0, null, 'non', []]) {
    const cfg = lire({ securite: { actif: mauvais }, checklist: { actif: mauvais }, caracteres: { actif: mauvais } });
    assert.equal(cfg.securite.actif && cfg.checklist.actif && cfg.caracteres.actif, true, JSON.stringify(mauvais));
    assert.ok(cfg.avertissements.length >= 3, JSON.stringify(mauvais));
  }
  const eteint = lire({ securite: { actif: false }, checklist: { actif: false }, caracteres: { actif: false } });
  assert.equal(eteint.securite.actif || eteint.checklist.actif || eteint.caracteres.actif, false);
  assert.deepEqual(eteint.avertissements, []);
  const cfg = lire({ securite: { confirmer: 'poussee', branchesProtegees: 'x', reglesDesactivees: ['rm-recursif', 'wrangler-keep-vars'], ordreUtilisateur: 'oui' }, inconnue: {} });
  assert.deepEqual(cfg.securite.confirmer.map(c => c.nom), ['poussee', 'deploiement-production'], 'une liste mal formée garde les défauts');
  assert.deepEqual([...cfg.securite.reglesDesactivees], ['wrangler-keep-vars']);
  const dit = gardesConfig.dire(cfg);
  for (const motif of [/securite\.confirmer/, /branchesProtegees/, /rm-recursif/, /ordreUtilisateur/, /clé inconnue « inconnue »/]) assert.match(dit, motif);
  assert.equal(decision(`${RM} ${RF} x`, { gardes: { securite: { reglesDesactivees: ['rm-recursif'] } } }), 'deny', 'une règle générale ne se désactive pas');
});

test('securite : configuration : la garde éteinte laisse passer ce qu\'elle refuse, rien d\'autre ne bouge', () => {
  const gardes = { securite: { actif: false } };
  for (const c of [`${RM} ${RF} x`, 'git reset --hard', 'git push --force', 'git push', 'vercel --prod', 'wrangler deploy']) assert.equal(decision(c, { gardes }), 'allow', c);
  assert.equal(decision('git push', { gardes, agent: 'codex' }), 'allow');
  assert.equal(decision('echo "jamais fermé', { gardes }), 'deny', 'une commande illisible reste refusée');
});

// ------------------------------------------------------------------ processus réels et branchement

function lancer(args, entree, maison) {
  return spawnSync(process.execPath, [m.scripts('gardes', 'securite.js'), ...args], { input: entree, encoding: 'utf8', env: m.env(maison), windowsHide: true, timeout: 60000 });
}

test('securite : processus : Claude Code refuse en code 2, Codex en JSON seul, la demande de confirmation sort en code 0', () => {
  const commande = c => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: 'C:/travail/essai', tool_input: { command: c } });
  const maison = m.maison();
  const refus = lancer(['--agent', 'claude'], commande('git reset --hard'), maison);
  assert.equal(refus.status, 2);
  assert.equal(JSON.parse(refus.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(refus.stderr, /git reset --hard/);
  const codex = lancer(['--agent', 'codex'], commande('git reset --hard'), maison);
  assert.equal(codex.status, 0);
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(codex.stderr, '');
  assert.deepEqual(erreursSortieCodex('PreToolUse', codex.stdout), []);
  const demande = lancer(['--agent', 'claude'], commande('git push'), maison);
  assert.equal(demande.status, 0);
  assert.equal(JSON.parse(demande.stdout).hookSpecificOutput.permissionDecision, 'ask');
  const passe = lancer(['--agent', 'claude'], commande('git status'), maison);
  assert.equal(passe.status, 0);
  assert.equal(passe.stdout, '');
  const casse = lancer(['--agent', 'claude'], '{casse', maison);
  assert.equal(casse.status, 2);
  assert.equal(JSON.parse(casse.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const sansAgent = lancer([], commande('git push'), maison);
  assert.equal(JSON.parse(sansAgent.stdout).hookSpecificOutput.permissionDecision, 'deny', 'sans --agent : refus strict');
});

test('securite : si la sortie du hook échoue, le code 2 reste bloquant', () => {
  const proc = { stdout: { write() { throw new Error('sortie indisponible'); } }, stderr: { write() {} } };
  securite.ecrire({ stdout: '{"x":1}', stderr: '', code: 0 }, proc);
  assert.equal(proc.exitCode, 2);
  const bon = { stdout: { write() {} }, stderr: { write() {} } };
  securite.ecrire({ stdout: '{"x":1}', stderr: 'raison', code: 0 }, bon);
  assert.equal(bon.exitCode, 0);
});

test('securite : branchement : les hooks de Claude Code et le modèle de Codex appellent les gardes, l\'installateur n\'ajoute que des groupes', () => {
  const racine = path.join(m.scripts(), '..');
  const claude = JSON.parse(fs.readFileSync(path.join(racine, 'hooks', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(racine, 'codex', 'hooks.modele.json'), 'utf8'));
  const trouver = (cfg, evenement, script) => (cfg.hooks[evenement] || []).flatMap(g => g.hooks.map(h => ({ g, h }))).filter(x => x.h.command.includes('/scripts/gardes/' + script));
  const s = trouver(claude, 'PreToolUse', 'securite.js');
  assert.equal(s.length, 1);
  assert.equal(s[0].g.matcher, 'Bash|PowerShell');
  assert.match(s[0].h.command, /securite\.js" --agent claude$/);
  const c = trouver(claude, 'PreToolUse', 'caracteres.js');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].g.matcher.split('|').sort(), ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'Write']);
  assert.equal(trouver(claude, 'Stop', 'caracteres.js').length, 1);
  assert.match(trouver(claude, 'Stop', 'caracteres.js')[0].h.command, /caracteres\.js" --stop --agent claude$/);
  assert.match(trouver(codex, 'PreToolUse', 'securite.js')[0].h.command, /securite\.js" --agent codex$/);
  assert.equal(trouver(codex, 'PreToolUse', 'caracteres.js').length, 1);
  assert.match(trouver(codex, 'Stop', 'caracteres.js')[0].h.command, /caracteres\.js" --stop --agent codex$/);
  for (const x of [...s, ...c, ...trouver(codex, 'PreToolUse', 'securite.js'), ...trouver(codex, 'Stop', 'caracteres.js')]) assert.ok(x.h.timeout >= 10, 'délai explicite : ' + x.h.command);
  // L'installateur de Codex ajoute ces gardes dans un groupe à part, sans toucher un hook déjà là.
  const home = path.join(m.run, 'config-codex');
  fs.mkdirSync(home, { recursive: true });
  const existant = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node C:/outils/garde.js', timeout: 10 }] }] } };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(existant, null, 2));
  const r = spawnSync(process.execPath, [m.scripts('installer-codex.js'), '--home', home, '--appliquer'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const apres = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
  assert.deepEqual(apres.hooks.PreToolUse[0], existant.hooks.PreToolUse[0]);
  const commandes = apres.hooks.PreToolUse.slice(1).flatMap(g => g.hooks.map(h => h.command));
  assert.ok(commandes.some(x => /scripts\/gardes\/securite\.js" --agent codex$/.test(x)));
  assert.ok(commandes.some(x => /scripts\/gardes\/caracteres\.js"$/.test(x)));
  assert.ok(apres.hooks.Stop.flatMap(g => g.hooks).some(h => /caracteres\.js" --stop --agent codex$/.test(h.command)));
});

// ------------------------------------------------------------------ mutations

test('mutation : chaque règle de la garde de sécurité, défaite dans une copie des scripts, rend son banc rouge', { skip: EN_MUTATION_OU_RAPIDE() }, () => {
  const SEC = 'gardes/securite.js';
  const LIB = 'lib/commande-securite.js';
  const CFG = 'lib/gardes-config.js';
  const rouge = nom => new RegExp('not ok \\d+ - securite : ' + nom);
  const si = (ancre, cond, nom, fichier = SEC, motif) => [ancre, '    if (' + cond + ') { // MUTATION : ' + ancre + ' défait', rouge(nom), fichier, motif || '^securite : ' + nom];
  m.mutations(__filename, '^securite', [
    si('rm-recursif', 'false', 'suppression récursive forcée'),
    si('git-clean', 'false', 'nettoyage forcé'),
    ['windows-recursif', '    if (false // MUTATION : la forme PowerShell n\'est plus lue', rouge('suppression récursive Windows'), SEC, '^securite : suppression récursive Windows'],
    ['windows-slash-s', '        || false) { // MUTATION : la forme cmd n\'est plus lue', rouge('suppression récursive Windows'), SEC, '^securite : suppression récursive Windows'],
    si('reset-hard', 'false', 'retour forcé'),
    si('contournement-hooks', 'false', 'contournement des hooks'),
    si('poussee-forcee', 'false', 'poussée forcée'),
    si('branche-protegee', 'false', 'branche protégée'),
    si('wrangler', 'false', 'wrangler deploy'),
    si('poussee', 'false', 'poussée et déploiement'),
    si('deploiement', 'false', 'poussée et déploiement'),
    ['confirmation-perso', '      continue; // MUTATION : aucune confirmation ajoutée n\'est lue', rouge('confirmation ajoutée'), SEC, '^securite : confirmation ajoutée'],
    si('vercel-env', 'false', 'avertissement vercel'),
    ['apply-patch', '  // MUTATION : apply_patch est analysé comme une commande', rouge('apply_patch'), SEC, '^securite : apply_patch'],
    ['sous-agent', '  // MUTATION : un sous-agent peut réutiliser l\'ordre', rouge('un sous-agent'), SEC, '^securite : un sous-agent'],
    ['ordre-utilisateur', '    const manquants = []; // MUTATION : tout message vaut ordre', rouge('ordre de l\'utilisateur : mots'), SEC, '^securite : ordre de l.utilisateur : mots'],
    ['ordre-desactive', '  // MUTATION : la fonction ne s\'éteint pas', rouge('ordre de l\'utilisateur : mots réglables'), SEC, '^securite : ordre de l.utilisateur : mots réglables'],
    ['ask-claude', '    if (false) return { verdict: \'ask\' }; // MUTATION : Claude Code ne demande plus', rouge('poussée et déploiement'), SEC, '^securite : poussée et déploiement'],
    ['ask-claude', '    if (agent !== \'codex\') return { verdict: \'ask\', raison: demandes.join(\' | \') }; // MUTATION : un agent non nommé obtient « ask »', rouge('un agent non nommé'), SEC, '^securite : un agent non nommé'],
    ['sortie-refus', '    return { stdout: refus(raison), stderr: \'\', code: 0 }; // MUTATION : Claude Code refuse en code 0', rouge('processus'), SEC, '^securite : processus'],
    ['sortie-en-panne', '  } catch (_) { proc.exitCode = 0; } // MUTATION : une sortie en panne laisse passer', rouge('si la sortie du hook échoue'), SEC, '^securite : si la sortie'],
    ['analyse-impossible', '    r = { verdict: \'allow\' }; // MUTATION : une commande illisible passe', rouge('une commande qui ne peut pas être analysée'), SEC, '^securite : une commande qui ne peut pas'],
    ['heredoc-saute', '          // MUTATION : le corps d\'un here-document n\'est jamais sauté', rouge('here-documents'), LIB, '^securite : here-documents'],
    ['heredoc-substitution', '      // MUTATION : le corps n\'est pas sauté dans une substitution', rouge('here-documents'), LIB, '^securite : here-documents'],
    ['heredoc-interprete', '      if (false) return -1; // MUTATION : un interpréteur ne fait plus lire le corps', rouge('here-documents'), LIB, '^securite : here-documents'],
    ['here-string', '        if (false) { // MUTATION : un here-string n\'est jamais sauté', rouge('here-documents'), LIB, '^securite : here-documents'],
    ['booleen-strict', '  if (typeof valeur === \'boolean\' || valeur === \'false\') return valeur === \'false\' ? false : valeur; // MUTATION : le texte « false » éteint une garde', rouge('configuration : une valeur mal formée'), CFG, '^securite : configuration : une valeur'],
    ['defaut-illisible', '    valeur = { securite: { actif: false }, checklist: { actif: false }, caracteres: { actif: false } }; // MUTATION : un fichier illisible éteint les gardes', rouge('configuration : un gardes.json illisible'), CFG, '^securite : configuration : un gardes.json'],
    ['motif-litteral', '    if (!re) { continue; } // MUTATION : un motif invalide n\'est plus gardé', rouge('branche protégée'), CFG, '^securite : branche protégée'],
    ['regle-inconnue', '    else { /* MUTATION : aucun avertissement */ }', rouge('configuration : une valeur mal formée'), CFG, '^securite : configuration : une valeur'],
  ]);
});

function EN_MUTATION_OU_RAPIDE() { return m.EN_MUTATION; }
