'use strict';
// Aides communes aux bancs des gardes (gardes-securite, gardes-checklist, gardes-caracteres) : dossiers de travail
// jetables, maisons de test, dépôts git temporaires, et la mécanique des mutations.
//
// Variables internes (tests de mutation, qui relancent un banc sur une copie des scripts) :
//   AML_GARDES_SCRIPTS         dossier scripts/ à tester (défaut : ../scripts)
//   AML_GARDES_EN_MUTATION     '1' = exécution sur une copie mutée (pas de récursion)
//   AML_GARDES_BASE_TESTS      dossier de travail des bancs (défaut : <dossier temporaire>/aml-tests/gardes)
//
// Jamais dans la vraie maison (~/.agent-memory-ledger) ni dans un vrai dépôt : chaque banc a son dossier sous le
// dossier temporaire, ses maisons de test et ses dépôts jetables.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPTS = process.env.AML_GARDES_SCRIPTS ? path.resolve(process.env.AML_GARDES_SCRIPTS) : path.join(__dirname, '..', 'scripts');
const EN_MUTATION = process.env.AML_GARDES_EN_MUTATION === '1';
const DELAI_RELANCE_MS = 1200000;

const norm = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const VRAIE_MAISON = path.join(os.homedir(), '.agent-memory-ledger');

// Variables du moteur ou de l'utilisateur qui changeraient le comportement des gardes ou de git.
const VARIABLES_RETIREES = ['AGENT_MEMORY_LEDGER_HOME', 'CONTEXT_LEDGER_DIR', 'CONTEXT_LEDGER_SECOURS_DIR', 'CONTEXT_LEDGER_PREUVES_DIR',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

function creerMonde(nomBanc) {
  const base = process.env.AML_GARDES_BASE_TESTS || path.join(os.tmpdir(), 'aml-tests', 'gardes');
  const run = path.join(base, `${nomBanc}-${EN_MUTATION ? 'mut' : 'run'}-${Date.now()}-${process.pid}`);
  assert.ok(!norm(run).startsWith(norm(VRAIE_MAISON)), 'les tests ne doivent jamais viser la vraie maison');
  fs.mkdirSync(run, { recursive: true });
  for (const k of VARIABLES_RETIREES) delete process.env[k];
  let n = 0;

  const monde = {
    run,
    SCRIPTS,
    EN_MUTATION,
    scripts: (...parties) => path.join(SCRIPTS, ...parties),

    // Maison de test, avec un gardes.json si `gardes` est donné : un objet (écrit en JSON) ou un texte brut.
    maison(gardes) {
      const m = path.join(run, `maison-${++n}`);
      fs.mkdirSync(m, { recursive: true });
      if (gardes !== undefined) fs.writeFileSync(path.join(m, 'gardes.json'), typeof gardes === 'string' ? gardes : JSON.stringify(gardes, null, 2));
      assert.ok(!norm(m).startsWith(norm(VRAIE_MAISON)));
      return m;
    },

    // Exécute fn dans ce processus avec cette maison.
    avecMaison(dir, fn) {
      const avant = process.env.AGENT_MEMORY_LEDGER_HOME;
      process.env.AGENT_MEMORY_LEDGER_HOME = dir;
      try { return fn(); } finally {
        if (avant === undefined) delete process.env.AGENT_MEMORY_LEDGER_HOME; else process.env.AGENT_MEMORY_LEDGER_HOME = avant;
      }
    },

    // Environnement d'un processus lancé par un banc : maison de test, rien de la vraie.
    env(dir, plus = {}) {
      const e = Object.assign({}, process.env, { AGENT_MEMORY_LEDGER_HOME: dir }, plus);
      for (const k of VARIABLES_RETIREES) if (!(k in plus) && k !== 'AGENT_MEMORY_LEDGER_HOME') delete e[k];
      return e;
    },

    git(depot, ...args) {
      return execFileSync('git', args, { cwd: depot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    },

    // Dépôt neuf avec un premier commit ; les hooks globaux de la machine ne s'y appliquent pas.
    depot(nom) {
      const d = path.join(run, `depot-${nom}-${++n}`);
      fs.mkdirSync(d, { recursive: true });
      const sansHooks = path.join(run, `sans-hooks-${n}`);
      fs.mkdirSync(sansHooks, { recursive: true });
      monde.git(d, 'init', '-q');
      for (const [k, v] of [['user.name', 'banc'], ['user.email', 'banc@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', sansHooks]]) monde.git(d, 'config', k, v);
      fs.writeFileSync(path.join(d, 'a.txt'), 'depart\n');
      monde.git(d, 'add', 'a.txt');
      monde.git(d, 'commit', '-q', '-m', 'depart');
      return d;
    },

    // Écrit un fichier dans le dépôt et le prépare (index).
    preparer(depot, relatif, contenu) {
      const f = path.join(depot, relatif);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, contenu);
      monde.git(depot, 'add', '--', relatif);
    },

    // Copie du dossier scripts/ ; si `ancre` est donnée, la ligne qui porte « ancre-mutation:<ancre> » est remplacée
    // par `remplacement`. Rend le dossier scripts/ de la copie.
    copie(nom, fichierRel, ancre, remplacement) {
      const dest = path.join(run, nom, 'scripts');
      fs.cpSync(SCRIPTS, dest, { recursive: true });
      // L'installateur et les bancs de branchement lisent ../codex et ../hooks : même place relative dans la copie.
      for (const d of ['codex', 'hooks']) fs.cpSync(path.join(SCRIPTS, '..', d), path.join(run, nom, d), { recursive: true });
      if (ancre) {
        const cible = path.join(dest, fichierRel);
        const avant = fs.readFileSync(cible, 'utf8');
        const lignes = avant.split('\n');
        // Ancre entière et unique : « x » ne doit jamais désigner la ligne de « x-suite ».
        const marque = 'ancre-mutation:' + ancre;
        const porte = l => { const k = l.indexOf(marque); return k >= 0 && !/[\w-]/.test(l[k + marque.length] || ''); };
        const i = lignes.findIndex(porte);
        assert.ok(i >= 0, `ancre ${ancre} introuvable dans ${fichierRel}`);
        assert.equal(lignes.filter(porte).length, 1, `ancre ${ancre} présente plusieurs fois dans ${fichierRel}`);
        lignes[i] = remplacement;
        fs.writeFileSync(cible, lignes.join('\n'));
        assert.notEqual(fs.readFileSync(cible, 'utf8'), avant);
      }
      return dest;
    },

    // Relance un banc sur une copie des scripts, pour les seuls tests dont le nom correspond à `motif`.
    relancer(fichierTest, dossierScripts, motif) {
      const env = Object.assign({}, process.env, { AML_GARDES_SCRIPTS: dossierScripts, AML_GARDES_EN_MUTATION: '1' });
      delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${motif}`, fichierTest], {
        env, encoding: 'utf8', timeout: DELAI_RELANCE_MS, windowsHide: true,
      });
    },

    // Jeu de mutations : la copie non mutée doit rester verte (témoin), chaque mutation doit rendre un banc rouge, et
    // le test rouge doit être celui qu'on attend. mutations : [ancre, remplacement, rouge (regex), fichier, motif].
    mutations(fichierTest, motifTemoin, mutations) {
      const temoin = monde.relancer(fichierTest, monde.copie('temoin'), motifTemoin);
      assert.equal(temoin.status, 0, 'la copie non mutée doit être verte :\n' + temoin.stdout);
      for (const [ancre, remplacement, rouge, fichier, motif] of mutations) {
        const r = monde.relancer(fichierTest, monde.copie('mutation-' + ancre, fichier, ancre, remplacement), motif);
        assert.notEqual(r.status, 0, `la mutation ${ancre} doit rendre un banc rouge :\n` + r.stdout);
        assert.match(r.stdout, rouge, ancre);
      }
    },
  };
  return monde;
}

module.exports = { creerMonde, SCRIPTS, EN_MUTATION };
