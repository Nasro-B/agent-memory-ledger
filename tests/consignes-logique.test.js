'use strict';
// Bancs de la logique des Consignes en vigueur : scripts/lib/consignes-logique.mjs
// Module ES sans aucune dépendance : le même fichier est destiné à l'adaptateur Claude Code et chargé par require() par Codex.
// Lancement : node --test tests/consignes-logique.test.js
// Variable interne (preuves par mutation) : CONSIGNES_LOGIQUE_TESTE = fichier à tester (défaut : ../scripts/lib/consignes-logique.mjs)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, describe } = require('node:test');

const C = require(process.env.CONSIGNES_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'consignes-logique.mjs'));

const sansTiretLong = t => !/\u{2014}/u.test(t);
const cons = (id, texte, verrou = null, actif = true) => ({ id, texte, actif, verrou });
const etat = (...consignes) => ({ prochain: Math.max(0, ...consignes.map(c => c.id)) + 1, consignes });
const PUSH = etat(cons(1, 'Pas de push sans mon ordre', 'push'));
const TOUS = etat(cons(1, 'Pas de push', 'push'), cons(2, 'Pas de déploiement', 'deploiement'), cons(3, 'Pas de rebuild APK', 'rebuild'), cons(4, 'Aucun nouvel agent', 'agent'), cons(5, 'Français'));

describe('état', () => {
  test('l état par défaut est inerte : rien à rappeler, rien à refuser', () => {
    assert.deepEqual(C.etatParDefaut(), { prochain: 1, consignes: [] });
    assert.equal(C.texteInjection(C.etatParDefaut()), null);
    assert.deepEqual(C.decisionCommande(C.etatParDefaut(), 'git push origin main'), { autorise: true });
    assert.deepEqual(C.decisionAgent(C.etatParDefaut()), { autorise: true });
    assert.equal(C.texteStatut(C.etatParDefaut()), undefined);
  });

  test('les bornes et les noms de verrous annoncés', () => {
    assert.equal(C.MAX_CONSIGNES, 20);
    assert.equal(C.MAX_TEXTE, 240);
    assert.deepEqual([...C.VERROUS], ['push', 'deploiement', 'rebuild', 'agent']);
  });

  test('normaliserEtat garde une consigne valide telle quelle', () => {
    assert.deepEqual(C.normaliserEtat({ prochain: 4, consignes: [{ id: 3, texte: 'Pas de push', actif: true, verrou: 'push' }] }), { prochain: 4, consignes: [cons(3, 'Pas de push', 'push')] });
    for (const verrou of C.VERROUS) assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte: 'x', verrou }] }).consignes[0].verrou, verrou);
  });

  test('normaliserEtat retombe sur l état par défaut pour tout ce qui n est pas un objet', () => {
    for (const brut of [null, undefined, [], 'x', 5, true, { consignes: 'x' }, { consignes: {} }, { consignes: null }]) assert.deepEqual(C.normaliserEtat(brut), C.etatParDefaut(), JSON.stringify(brut));
  });

  test('normaliserEtat écarte les entrées invalides une par une, sans toucher aux autres', () => {
    const r = C.normaliserEtat({
      consignes: [
        null, 5, 'x', [], {},
        { id: 0, texte: 'id nul' }, { id: -2, texte: 'id négatif' }, { id: 1.5, texte: 'id décimal' }, { id: '2', texte: 'id texte' },
        { id: 7, texte: '' }, { id: 8, texte: '   ' }, { id: 9, texte: 42 }, { id: 10 },
        { id: 11, texte: 'valide' },
      ],
    });
    assert.deepEqual(r.consignes, [cons(11, 'valide')]);
    assert.equal(r.prochain, 12);
  });

  test('normaliserEtat : un identifiant en double garde la première consigne', () => {
    const r = C.normaliserEtat({ consignes: [{ id: 1, texte: 'première' }, { id: 1, texte: 'seconde' }, { id: 2, texte: 'autre' }] });
    assert.deepEqual(r.consignes.map(c => [c.id, c.texte]), [[1, 'première'], [2, 'autre']]);
  });

  test('normaliserEtat : seul actif:false met en pause, un verrou inconnu devient aucun verrou', () => {
    for (const actif of [true, undefined, null, 0, 1, 'non', 'false', {}]) assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte: 'x', actif }] }).consignes[0].actif, true, `actif ${JSON.stringify(actif)}`);
    assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte: 'x', actif: false }] }).consignes[0].actif, false);
    for (const verrou of ['', 'PUSH', 'git', 'agents', 7, null, undefined, {}, []]) assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte: 'x', verrou }] }).consignes[0].verrou, null, `verrou ${JSON.stringify(verrou)}`);
  });

  test('normaliserEtat compresse les espaces du texte et le tronque à la limite', () => {
    assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte: '  Pas   de\n push \t ici ' }] }).consignes[0].texte, 'Pas de push ici');
    const long = C.normaliserEtat({ consignes: [{ id: 1, texte: 'a'.repeat(C.MAX_TEXTE + 100) }] }).consignes[0].texte;
    assert.equal(long.length, C.MAX_TEXTE);
    assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte: 'b'.repeat(C.MAX_TEXTE) }] }).consignes[0].texte.length, C.MAX_TEXTE);
  });

  test('normaliserEtat : un texte coupé juste après un mot ne garde pas l espace qui le suivait', () => {
    const texte = `${'a'.repeat(C.MAX_TEXTE - 1)} ${'b'.repeat(50)}`;
    assert.equal(C.normaliserEtat({ consignes: [{ id: 1, texte }] }).consignes[0].texte, 'a'.repeat(C.MAX_TEXTE - 1));
  });

  test('normaliserEtat garde les vingt premières consignes valides', () => {
    const consignes = Array.from({ length: C.MAX_CONSIGNES + 5 }, (_, i) => ({ id: i + 1, texte: `c${i + 1}` }));
    const r = C.normaliserEtat({ consignes });
    assert.equal(r.consignes.length, C.MAX_CONSIGNES);
    assert.equal(r.consignes[0].id, 1);
    assert.equal(r.consignes[C.MAX_CONSIGNES - 1].id, C.MAX_CONSIGNES);
    assert.equal(r.prochain, C.MAX_CONSIGNES + 1);
  });

  test('prochain ne descend jamais sous le plus grand identifiant + 1 ni sous 1, et garde un identifiant retiré inutilisable', () => {
    assert.equal(C.normaliserEtat({ prochain: 50, consignes: [{ id: 3, texte: 'x' }] }).prochain, 50);
    assert.equal(C.normaliserEtat({ prochain: 2, consignes: [{ id: 3, texte: 'x' }] }).prochain, 4);
    for (const prochain of [0, -3, 2.5, '9', NaN, null, undefined]) assert.equal(C.normaliserEtat({ prochain, consignes: [] }).prochain, 1, `prochain ${JSON.stringify(prochain)}`);
  });

  test('normaliserEtat ne garde que prochain et consignes, et ne modifie pas son argument', () => {
    const brut = { prochain: 2, maj: 'x', autre: 1, consignes: [{ id: 1, texte: ' a ', actif: true, verrou: 'push', extra: 1 }] };
    const copie = JSON.parse(JSON.stringify(brut));
    const r = C.normaliserEtat(brut);
    assert.deepEqual(Object.keys(r).sort(), ['consignes', 'prochain']);
    assert.deepEqual(Object.keys(r.consignes[0]).sort(), ['actif', 'id', 'texte', 'verrou']);
    assert.deepEqual(brut, copie);
  });

  test('consignesActives écarte les consignes en pause et garde l ordre', () => {
    const e = etat(cons(1, 'a'), cons(2, 'b', null, false), cons(3, 'c'));
    assert.deepEqual(C.consignesActives(e).map(c => c.id), [1, 3]);
    assert.deepEqual(C.consignesActives(C.etatParDefaut()), []);
  });
});

describe('injection dans le prompt', () => {
  test('la liste est numérotée par identifiant stable, avec le verrou affiché', () => {
    const t = C.texteInjection(etat(cons(2, 'Pas de push', 'push'), cons(5, 'Réponds en français')));
    assert.match(t, /^CONSIGNES EN VIGUEUR DE L'UTILISATEUR/);
    assert.match(t, /valables après compactage/);
    assert.match(t, /\n2\. Pas de push \[verrou : push\]\n/);
    assert.match(t, /\n5\. Réponds en français$/);
  });

  test('une consigne en pause n apparaît pas, et sans consigne active il n y a aucun texte', () => {
    const e = etat(cons(1, 'visible'), cons(2, 'cachée', 'push', false));
    assert.doesNotMatch(C.texteInjection(e), /cachée/);
    assert.match(C.texteInjection(e), /1\. visible/);
    assert.equal(C.texteInjection(etat(cons(1, 'x', null, false))), null);
  });

  test('le texte ne dépend que des consignes : deux appels identiques donnent le même texte (cache du prompt)', () => {
    assert.equal(C.texteInjection(TOUS), C.texteInjection(JSON.parse(JSON.stringify(TOUS))));
  });

  test('le texte reste borné même avec vingt consignes au maximum de longueur', () => {
    const e = C.normaliserEtat({ consignes: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, texte: 'x'.repeat(500), verrou: 'push' })) });
    assert.ok(C.texteInjection(e).length < 6000, String(C.texteInjection(e).length));
  });

  test('aucun tiret long dans les textes produits', () => {
    for (const t of [C.texteInjection(TOUS), C.texteListe(TOUS), C.texteStatut(TOUS)]) assert.ok(sansTiretLong(t), t);
  });
});

describe('jetons {worktrees} et {plans}', () => {
  const VALEURS = { worktrees: 'APP (C:/travail/a), API (C:/travail/b)', plans: 'C:/travail/plans' };
  const AVEC = etat(cons(1, 'Travailler uniquement dans {worktrees}.'), cons(2, 'Les plans sont dans {plans}.'), cons(3, 'Pas de push', 'push'));

  test('le texte rappelé cite les valeurs courantes à la place des jetons, le texte enregistré ne change pas', () => {
    const t = C.texteInjection(AVEC, VALEURS);
    assert.match(t, /\n1\. Travailler uniquement dans APP \(C:\/travail\/a\), API \(C:\/travail\/b\)\.\n/);
    assert.match(t, /\n2\. Les plans sont dans C:\/travail\/plans\.\n/);
    assert.ok(!t.includes('{worktrees}') && !t.includes('{plans}'));
    assert.equal(AVEC.consignes[0].texte, 'Travailler uniquement dans {worktrees}.');
  });

  test('sans valeurs, un jeton dit qu il n est pas configuré ; un jeton inconnu reste tel quel', () => {
    assert.match(C.texteInjection(AVEC), /\n1\. Travailler uniquement dans \(non configuré\)\.\n/);
    assert.match(C.texteInjection(AVEC, {}), /\n2\. Les plans sont dans \(non configuré\)\.\n/);
    assert.match(C.texteInjection(AVEC, { worktrees: 'W' }), /\n1\. Travailler uniquement dans W\.\n2\. Les plans sont dans \(non configuré\)\./);
    assert.match(C.texteInjection(etat(cons(1, 'Voir {autre} et {plans}')), VALEURS), /1\. Voir \{autre\} et C:\/travail\/plans$/);
    assert.match(C.texteInjection(AVEC, { worktrees: '', plans: '' }), /\n1\. Travailler uniquement dans \(non configuré\)\.\n2\. Les plans sont dans \(non configuré\)\./, 'une valeur vide se lit comme une valeur absente');
    assert.match(C.texteInjection(AVEC, Object.assign(['x'], { worktrees: 'W' })), /\n1\. Travailler uniquement dans \(non configuré\)\./, 'un tableau n est pas un objet de valeurs, même avec des propriétés');
    for (const mauvaises of [null, 'x', 5, [], { worktrees: 5, plans: null }]) {
      assert.match(C.texteInjection(AVEC, mauvaises), /\n1\. Travailler uniquement dans \(non configuré\)\./, JSON.stringify(mauvaises));
    }
  });

  test('un jeton répété est remplacé partout, et une valeur qui contient un jeton n est pas remplacée une seconde fois', () => {
    const t = C.texteInjection(etat(cons(1, '{plans} puis {plans}')), VALEURS);
    assert.match(t, /1\. C:\/travail\/plans puis C:\/travail\/plans$/);
    const piege = C.texteInjection(etat(cons(1, '{plans}')), { plans: '{worktrees}', worktrees: 'W' });
    assert.match(piege, /1\. \{worktrees\}$/);
  });

  test('la liste de /consignes cite aussi les valeurs courantes', () => {
    assert.match(C.texteListe(AVEC, VALEURS), /1\. \[actif\] Travailler uniquement dans APP \(C:\/travail\/a\), API \(C:\/travail\/b\)\./);
    assert.match(C.texteListe(AVEC), /\(non configuré\)/);
    const r = C.analyserCommande('liste', AVEC, VALEURS);
    assert.match(r.message, /APP \(C:\/travail\/a\), API \(C:\/travail\/b\)/);
    assert.deepEqual(r.etat, AVEC, 'l état enregistré garde ses jetons');
  });

  test('la raison d un refus cite le texte avec les valeurs courantes', () => {
    const e = etat(cons(1, 'Pas de push dans {worktrees}', 'push'), cons(2, 'Aucun agent hors de {plans}', 'agent'));
    assert.match(C.decisionCommande(e, 'git push', VALEURS).raison, /« Pas de push dans APP \(C:\/travail\/a\), API \(C:\/travail\/b\) »/);
    assert.match(C.decisionAgent(e, VALEURS).raison, /« Aucun agent hors de C:\/travail\/plans »/);
    assert.match(C.decisionCommande(e, 'git push').raison, /« Pas de push dans \(non configuré\) »/);
    assert.match(C.decisionAgent(e).raison, /« Aucun agent hors de \(non configuré\) »/);
  });

  test('ajouter une consigne avec un jeton la range telle quelle, la longueur compte le texte enregistré', () => {
    const r = C.analyserCommande('ajouter Les plans sont dans {plans}', C.etatParDefaut(), VALEURS);
    assert.equal(r.etat.consignes[0].texte, 'Les plans sont dans {plans}');
    const juste = `x{plans}${'y'.repeat(C.MAX_TEXTE - 8)}`;
    assert.equal(juste.length, C.MAX_TEXTE);
    assert.equal(C.analyserCommande(`ajouter ${juste}`, C.etatParDefaut(), { plans: 'z'.repeat(500) }).erreur, undefined);
  });

  test('les textes produits avec des valeurs restent sans tiret long', () => {
    for (const t of [C.texteInjection(AVEC, VALEURS), C.texteListe(AVEC, VALEURS), C.decisionCommande(AVEC, 'git push', VALEURS).raison]) assert.ok(sansTiretLong(t), t);
  });
});

describe('refus des commandes : push', () => {
  const refus = (e, cmd) => C.decisionCommande(e, cmd).autorise === false;

  test('les formes de git push sont refusées quand la consigne push est active', () => {
    for (const cmd of [
      'git push', 'git push origin main', 'git push -u origin feature', 'GIT PUSH', 'Git Push --force-with-lease', 'git.exe push', 'git.cmd push origin',
      'cd "C:/Users/demo/mon dossier" && git push', 'git status; git push origin main', 'git add . | git push', 'git add . & git push', '  git   push  ',
      'git -C "C:/Users/demo/un dossier" push origin main', 'git -C C:/x/repo push', 'git -c core.editor=true push', 'git --no-pager push', 'git --git-dir=.git --work-tree=. push',
      'git -C a -c b=c --no-pager push --tags', 'git\tpush', 'echo ok\ngit push', 'git --git-dir .git push', 'git --git-dir C:/x/r/meta push', 'git --work-tree C:/x/w --git-dir=C:/x/g push', 'git --namespace n --exec-path C:/x/e push', 'GIT.EXE push', 'git -C "a b" -c "user.name=x y" push',
      "git -C 'a b' push", 'git.exe status && git.exe push', 'git.bat push',
    ]) assert.ok(refus(PUSH, cmd), cmd);
  });

  test('les autres commandes git passent', () => {
    for (const cmd of [
      'git status', 'git commit -m "fix: x"', 'git pull origin main', 'git log --oneline', 'git fetch', 'git diff --stat', 'git branch -a', 'git stash push',
      'gitpush', 'git-push', 'digit push', 'git commit -m push', 'ls -la', 'npm run push', 'echo hello', 'git pushx', 'git pushed', 'git -C repo pushx',
    ]) assert.deepEqual(C.decisionCommande(PUSH, cmd), { autorise: true }, cmd);
  });

  test('git stash push n est pas un push distant', () => {
    assert.deepEqual(C.decisionCommande(PUSH, 'git stash push -m "x"'), { autorise: true });
    assert.deepEqual(C.decisionCommande(PUSH, 'git -C repo stash push'), { autorise: true });
  });

  test('rien n est refusé sans consigne active portant le verrou push', () => {
    assert.deepEqual(C.decisionCommande(etat(cons(1, 'Pas de push', 'push', false)), 'git push'), { autorise: true }, 'en pause');
    assert.deepEqual(C.decisionCommande(etat(cons(1, 'Pas de push')), 'git push'), { autorise: true }, 'sans verrou');
    assert.deepEqual(C.decisionCommande(etat(cons(1, 'Pas de déploiement', 'deploiement')), 'git push'), { autorise: true }, 'autre verrou');
  });

  test('la raison cite la consigne, son texte, et dit comment la lever', () => {
    const d = C.decisionCommande(etat(cons(7, 'Pas de push sans mon ordre', 'push')), 'git push origin main');
    assert.equal(d.autorise, false);
    assert.equal(d.id, 7);
    assert.equal(d.verrou, 'push');
    assert.match(d.raison, /Consigne 7 de l'utilisateur/);
    assert.match(d.raison, /« Pas de push sans mon ordre »/);
    assert.match(d.raison, /\), verrou push : cette commande est refusée, ne la lance pas\. Si l'utilisateur lève cet ordre/);
    assert.match(d.raison, /\/consignes pause 7/);
    assert.ok(sansTiretLong(d.raison), d.raison);
  });
});

describe('refus des commandes : déploiement et rebuild', () => {
  const DEP = etat(cons(2, 'Pas de déploiement', 'deploiement'));
  const BUILD = etat(cons(3, 'Pas de rebuild APK', 'rebuild'));
  const ok = (e, cmd) => assert.deepEqual(C.decisionCommande(e, cmd), { autorise: true }, cmd);
  const non = (e, cmd, verrou) => { const d = C.decisionCommande(e, cmd); assert.equal(d.autorise, false, cmd); assert.equal(d.verrou, verrou, cmd); };

  test('déploiement : vercel en production, wrangler deploy et publish', () => {
    for (const cmd of ['vercel --prod', 'vercel deploy --prod', 'npx vercel --prod', 'vercel.cmd deploy --prod --yes', 'VERCEL DEPLOY --PROD', 'vercel --scope x --prod', 'wrangler deploy', 'npx wrangler deploy --keep-vars', 'wrangler.cmd publish', 'WRANGLER DEPLOY', 'wrangler.exe deploy', 'wrangler.bat deploy', 'WRANGLER.EXE deploy']) non(DEP, cmd, 'deploiement');
    for (const cmd of ['vercel', 'vercel dev', 'vercel env ls', 'vercel deploy', 'vercel link; echo prod', 'wrangler dev', 'wrangler tail', 'wrangler deployments list', 'echo deploy', 'vercel env pull --production', 'xvercel --prod', 'xwrangler deploy', 'vercelx --prod', 'wranglerdeploy']) ok(DEP, cmd);
  });

  test('vercel --prod ne se déclenche pas à travers un séparateur de commandes ni un retour à la ligne', () => {
    ok(DEP, 'vercel env ls ; echo --prod');
    ok(DEP, 'vercel whoami | grep --prod');
    ok(DEP, 'vercel link\necho --prod');
    non(DEP, 'echo a ; vercel --prod', 'deploiement');
    non(DEP, 'echo a\nvercel --prod', 'deploiement');
  });

  test('rebuild : gradle assemble, bundle et build, eas build, expo prebuild', () => {
    for (const cmd of [
      './gradlew assembleRelease', 'gradlew.bat assembleDebug', 'cd android && ./gradlew :app:assembleRelease', 'gradlew bundleRelease', 'gradlew build', './gradlew :app:build', 'gradlew clean assembleRelease', 'GRADLEW ASSEMBLEDEBUG',
      'eas build --platform android --profile preview', 'npx eas build', 'eas.cmd build', 'eas.exe build', 'eas.bat build', 'EAS BUILD', 'expo prebuild --clean', 'npx expo prebuild', 'expo.cmd prebuild', 'expo.exe prebuild', 'expo.bat prebuild', 'EXPO PREBUILD',
      './gradlew assembleRelease --info', 'gradlew assembleDebug --stacktrace', './gradlew :app:assembleRelease -x test', 'gradlew build --no-daemon', 'gradlew bundleRelease\necho fini',
    ]) non(BUILD, cmd, 'rebuild');
    for (const cmd of [
      './gradlew test', 'gradlew testDebugUnitTest lintDebug', 'gradlew test --build-cache', './gradlew tasks', 'gradlew --version', 'gradlew :app:dependencies', 'gradlew :app:buildEnvironment', 'gradlew buildEnvironment', 'gradlew :app:preBuild', 'eas whoami', 'eas build:list', 'eas build:view x', 'eas update', 'expo start', 'expo install x',
      'ls build', 'npm run build', 'vite build', 'echo expo', 'xeas build', 'xexpo prebuild', 'xgradlew assembleRelease', 'gradlewx assembleRelease', 'expo prebuilder', 'eas buildx', 'expoprebuild',
    ]) ok(BUILD, cmd);
  });

  test('rebuild : le nom d une tâche gradle dans une autre commande ne compte pas', () => {
    for (const cmd of ['gradlew test ; echo assembleRelease', 'gradlew tasks | grep assembleRelease', 'gradlew test && echo build', 'gradlew test & echo assembleDebug', 'gradlew test\necho assembleRelease']) ok(BUILD, cmd);
  });

  test('rebuild : une tâche gradle doit être une tâche entière, pas un morceau d option', () => {
    ok(BUILD, 'gradlew test --build-cache');
    ok(BUILD, 'gradlew --build-cache test');
    non(BUILD, 'gradlew --build-cache assembleRelease', 'rebuild');
  });

  test('le verrou ne s applique qu aux commandes de sa famille', () => {
    ok(DEP, './gradlew assembleRelease');
    ok(BUILD, 'vercel --prod');
    ok(DEP, 'git push');
    ok(BUILD, 'git push');
  });

  test('plusieurs verrous actifs : la première consigne de la liste qui correspond répond', () => {
    const d = C.decisionCommande(TOUS, 'git push && ./gradlew assembleRelease');
    assert.equal(d.id, 1);
    assert.equal(d.verrou, 'push');
    const d2 = C.decisionCommande(etat(cons(1, 'Pas de rebuild', 'rebuild'), cons(2, 'Pas de push', 'push')), 'git push && ./gradlew assembleRelease');
    assert.equal(d2.id, 1);
    assert.equal(d2.verrou, 'rebuild');
  });

  test('une commande qui n est pas un texte ne casse rien', () => {
    for (const cmd of [undefined, null, 5, {}, [], '', '   ']) assert.deepEqual(C.decisionCommande(TOUS, cmd), { autorise: true }, JSON.stringify(cmd));
  });

  test('un état invalide ne casse rien non plus', () => {
    for (const brut of [null, undefined, 'x', 5, {}, { consignes: 'x' }]) assert.deepEqual(C.decisionCommande(brut, 'git push'), { autorise: true }, JSON.stringify(brut));
  });
});

describe('refus des nouveaux agents', () => {
  test('une consigne active avec le verrou agent refuse le lancement et dit pourquoi', () => {
    const d = C.decisionAgent(etat(cons(4, 'Aucun nouvel agent cette nuit', 'agent')));
    assert.equal(d.autorise, false);
    assert.equal(d.id, 4);
    assert.equal(d.verrou, 'agent');
    assert.match(d.raison, /Consigne 4 de l'utilisateur/);
    assert.match(d.raison, /« Aucun nouvel agent cette nuit »/);
    assert.match(d.raison, /\), verrou agent : aucun nouvel agent, ne lance pas celui-ci\. Si l'utilisateur lève cet ordre/);
    assert.match(d.raison, /\/consignes pause 4/);
    assert.ok(sansTiretLong(d.raison), d.raison);
  });

  test('en pause, sans verrou ou avec un autre verrou, le lancement est autorisé', () => {
    assert.deepEqual(C.decisionAgent(etat(cons(1, 'x', 'agent', false))), { autorise: true });
    assert.deepEqual(C.decisionAgent(etat(cons(1, 'x'))), { autorise: true });
    assert.deepEqual(C.decisionAgent(etat(cons(1, 'x', 'push'), cons(2, 'y', 'rebuild'))), { autorise: true });
  });

  test('le verrou agent ne refuse aucune commande, et inversement', () => {
    assert.deepEqual(C.decisionCommande(etat(cons(1, 'x', 'agent')), 'git push && ./gradlew assembleRelease && vercel --prod'), { autorise: true });
    assert.deepEqual(C.decisionAgent(TOUS).id, 4);
  });

  test('un état invalide ne casse rien', () => {
    for (const brut of [null, undefined, 'x', 5, {}]) assert.deepEqual(C.decisionAgent(brut), { autorise: true });
  });
});

describe('commande /consignes', () => {
  const E = C.etatParDefaut();
  const ajouter = (e, texte) => C.analyserCommande(`ajouter ${texte}`, e);

  test('sans argument, liste ou etat : la liste complète, sans rien changer', () => {
    for (const args of ['', '  ', 'liste', 'LISTE', 'etat', 'état', undefined, null]) {
      const r = C.analyserCommande(args, TOUS);
      assert.equal(r.erreur, undefined, String(args));
      assert.deepEqual(r.etat, TOUS, String(args));
      assert.equal(r.message, C.texteListe(TOUS));
    }
  });

  test('la liste montre l état, le texte et le verrou de chaque consigne', () => {
    const e = etat(cons(1, 'Pas de push', 'push'), cons(2, 'Français'), cons(3, 'Pas de rebuild', 'rebuild', false));
    const t = C.texteListe(e);
    assert.match(t, /Consignes en vigueur : 2 actives sur 3/);
    assert.match(t, /1\. \[actif\] Pas de push \[verrou : push\]/);
    assert.match(t, /2\. \[actif\] Français$/m);
    assert.match(t, /3\. \[pause\] Pas de rebuild \[verrou : rebuild\]/);
    assert.match(C.texteListe(C.etatParDefaut()), /Aucune consigne/);
    assert.match(C.texteListe(C.etatParDefaut()), /\/consignes ajouter/);
  });

  test('ajouter crée une consigne active sans verrou avec le prochain identifiant', () => {
    const r = ajouter(E, 'Réponds   toujours en français');
    assert.deepEqual(r.etat, { prochain: 2, consignes: [cons(1, 'Réponds toujours en français')] });
    assert.match(r.message, /Consigne 1 ajoutée/);
    const r2 = ajouter(r.etat, 'Pas de push');
    assert.deepEqual(r2.etat.consignes.map(c => c.id), [1, 2]);
    assert.equal(r2.etat.prochain, 3);
  });

  test('ajouter garde la casse et les accents du texte, mais la sous-commande se tape comme on veut', () => {
    assert.equal(C.analyserCommande('AJOUTER Uniquement les Worktrees listés', E).etat.consignes[0].texte, 'Uniquement les Worktrees listés');
    assert.equal(C.analyserCommande('  ajouter   x  ', E).etat.consignes[0].texte, 'x');
  });

  test('ajouter refuse un texte vide, un texte trop long et une liste pleine, sans rien changer', () => {
    assert.match(C.analyserCommande('ajouter', E).erreur, /texte/i);
    assert.match(C.analyserCommande('ajouter    ', E).erreur, /texte/i);
    const long = C.analyserCommande(`ajouter ${'a'.repeat(C.MAX_TEXTE + 1)}`, E);
    assert.match(long.erreur, new RegExp(String(C.MAX_TEXTE)));
    assert.equal(C.analyserCommande(`ajouter ${'a'.repeat(C.MAX_TEXTE)}`, E).erreur, undefined);
    const pleine = C.normaliserEtat({ consignes: Array.from({ length: C.MAX_CONSIGNES }, (_, i) => ({ id: i + 1, texte: `c${i + 1}` })) });
    assert.match(C.analyserCommande('ajouter une de plus', pleine).erreur, new RegExp(String(C.MAX_CONSIGNES)));
  });

  test('un identifiant retiré n est jamais réutilisé', () => {
    let e = ajouter(ajouter(E, 'a').etat, 'b').etat;
    e = C.analyserCommande('retirer 2', e).etat;
    e = ajouter(e, 'c').etat;
    assert.deepEqual(e.consignes.map(c => c.id), [1, 3]);
  });

  test('retirer supprime la consigne, et un identifiant inconnu est une erreur', () => {
    const r = C.analyserCommande('retirer 2', TOUS);
    assert.deepEqual(r.etat.consignes.map(c => c.id), [1, 3, 4, 5]);
    assert.equal(r.etat.prochain, TOUS.prochain);
    assert.match(r.message, /Consigne 2 retirée/);
    for (const args of ['retirer 99', 'retirer 0', 'retirer', 'retirer x', 'retirer 1.5', 'retirer -1', 'retirer 1 2', 'retirer 0x1', 'retirer 1e0', 'retirer 1.0', 'retirer +1', 'retirer 1,']) assert.ok(C.analyserCommande(args, TOUS).erreur, args);
    assert.equal(C.analyserCommande('retirer 01', TOUS).erreur, undefined, 'des zéros devant restent le nombre');
  });

  test('un identifiant inconnu rappelle les identifiants qui existent', () => {
    assert.match(C.analyserCommande('retirer 99', TOUS).erreur, /Consigne 99 introuvable \(identifiants : 1, 2, 3, 4, 5\)/);
    assert.match(C.analyserCommande('retirer x', TOUS).erreur, /Consigne x introuvable/, 'la saisie est citée telle quelle');
    assert.match(C.analyserCommande('pause 7', C.etatParDefaut()).erreur, /identifiants : aucun/);
  });

  test('liste n accepte aucun argument', () => {
    for (const args of ['liste x', 'etat 1', 'état tout']) assert.match(C.analyserCommande(args, TOUS).erreur, /^Usage/, args);
  });

  test('pause et reprendre basculent l état sans toucher au reste', () => {
    const p = C.analyserCommande('pause 1', TOUS);
    assert.equal(p.etat.consignes[0].actif, false);
    assert.equal(p.etat.consignes[0].verrou, 'push');
    assert.match(p.message, /Consigne 1 en pause \(elle n'est plus rappelée ni appliquée\)/);
    assert.deepEqual(p.etat.consignes.slice(1), TOUS.consignes.slice(1));
    const r = C.analyserCommande('reprendre 1', p.etat);
    assert.deepEqual(r.etat, TOUS);
    assert.match(r.message, /Consigne 1 reprise/);
    for (const args of ['pause', 'pause 99', 'pause x', 'reprendre', 'reprendre 99']) assert.ok(C.analyserCommande(args, TOUS).erreur, args);
  });

  test('verrou associe une règle vérifiable à une consigne, ou la retire avec aucun', () => {
    const e = ajouter(E, 'Pas de push').etat;
    for (const [saisie, attendu] of [['push', 'push'], ['PUSH', 'push'], ['deploiement', 'deploiement'], ['déploiement', 'deploiement'], ['rebuild', 'rebuild'], ['agent', 'agent'], ['agents', 'agent']]) {
      const r = C.analyserCommande(`verrou 1 ${saisie}`, e);
      assert.equal(r.erreur, undefined, saisie);
      assert.equal(r.etat.consignes[0].verrou, attendu, saisie);
    }
    assert.match(C.analyserCommande('verrou 1 push', e).message, /Consigne 1 : verrou push/);
    const retire = C.analyserCommande('verrou 1 aucun', C.analyserCommande('verrou 1 push', e).etat);
    assert.equal(retire.etat.consignes[0].verrou, null);
    assert.equal(retire.message, 'Consigne 1 : verrou retiré.');
    assert.equal(C.analyserCommande('verrou 1 aucune', C.analyserCommande('verrou 1 push', e).etat).etat.consignes[0].verrou, null);
    for (const args of ['verrou', 'verrou 1', 'verrou 1 inconnu', 'verrou 99 push', 'verrou x push', 'verrou 1 push deploiement', 'verrou 1 constructor', 'verrou 1 toString', 'verrou 1 __proto__', 'verrou 1 hasOwnProperty']) assert.ok(C.analyserCommande(args, e).erreur, args);
  });

  test('une sous-commande inconnue rend l aide, sans rien changer', () => {
    for (const args of ['xyz', 'supprimer 1', 'ajoute x', '1', 'push']) {
      const r = C.analyserCommande(args, TOUS);
      assert.match(r.erreur, /^Usage : \/consignes/, args);
      assert.equal(r.etat, undefined, args);
    }
  });

  test('l aide cite toutes les sous-commandes et tous les verrous', () => {
    const { erreur } = C.analyserCommande('xyz', TOUS);
    for (const mot of ['ajouter', 'retirer', 'pause', 'reprendre', 'verrou', 'push', 'deploiement', 'rebuild', 'agent', 'aucun']) assert.match(erreur, new RegExp(mot), mot);
    assert.ok(sansTiretLong(erreur), erreur);
  });

  test('la commande ne modifie jamais l état reçu', () => {
    const copie = JSON.parse(JSON.stringify(TOUS));
    for (const args of ['ajouter x', 'retirer 1', 'pause 1', 'reprendre 1', 'verrou 5 push', 'verrou 1 aucun', 'xyz', '']) C.analyserCommande(args, TOUS);
    assert.deepEqual(TOUS, copie);
  });

  test('un état brut invalide est normalisé avant la commande', () => {
    const r = C.analyserCommande('ajouter x', { prochain: 'x', consignes: [{ id: 'y', texte: 'z' }, { id: 4, texte: 'garde' }] });
    assert.deepEqual(r.etat.consignes.map(c => c.id), [4, 5]);
  });

  test('tous les messages sont sans tiret long', () => {
    for (const args of ['', 'ajouter x', 'retirer 1', 'pause 1', 'reprendre 1', 'verrou 1 push', 'verrou 1 aucun', 'retirer 99', 'xyz']) {
      const r = C.analyserCommande(args, TOUS);
      assert.ok(sansTiretLong(r.message || r.erreur), args);
    }
  });
});

describe('statut', () => {
  test('le statut compte les consignes actives et verrouillées', () => {
    assert.equal(C.texteStatut(TOUS), 'Consignes : 5 actives (4 verrouillées)');
    assert.equal(C.texteStatut(etat(cons(1, 'a'))), 'Consignes : 1 active (0 verrouillée)');
    assert.equal(C.texteStatut(etat(cons(1, 'a', 'push'), cons(2, 'b', 'agent', false))), 'Consignes : 1 active (1 verrouillée)');
  });

  test('sans consigne active, le statut est absent', () => {
    assert.equal(C.texteStatut(C.etatParDefaut()), undefined);
    assert.equal(C.texteStatut(etat(cons(1, 'a', 'push', false))), undefined);
  });
});
