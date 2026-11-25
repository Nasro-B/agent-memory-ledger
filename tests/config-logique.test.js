'use strict';
// Bancs de la logique des réglages du Cockpit (worktrees mesurés, dossier des plans) : scripts/lib/config-logique.mjs
// Module ES sans aucune dépendance : le même fichier est destiné à l'adaptateur Claude Code et au module des Consignes, et chargé par require() par le noyau et Codex.
// Lancement : node --test tests/config-logique.test.js
// Variable interne (preuves par mutation) : CONFIG_LOGIQUE_TESTE = fichier à tester (défaut : ../scripts/lib/config-logique.mjs)

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, describe } = require('node:test');

const K = require(process.env.CONFIG_LOGIQUE_TESTE || path.join(__dirname, '..', 'scripts', 'lib', 'config-logique.mjs'));

const sansTiretLong = t => !/\u{2014}/u.test(t);
const APP = { nom: 'APP', chemin: 'C:/travail/depot-app' };
const API = { nom: 'API', chemin: 'C:/travail/depot-api' };
const PLANS = { dossier: 'C:/travail/plans', exclure: ['Anciens'], profondeur: 3 };
// Les défauts du dépôt : aucun worktree, aucun dossier de plans, profondeur 3.
const DEFAUT = { worktrees: [], plans: { dossier: '', exclure: [], profondeur: 3 } };
const config = (worktrees = [APP, API], plans = PLANS) => ({ worktrees, plans: { ...plans } });
const ok = { dossierExiste: () => true, estDepot: () => true };

describe('valeurs par défaut', () => {
  test('les réglages par défaut ne portent aucun worktree ni dossier de plans, et une profondeur de 3', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(K.DEFAUTS)), DEFAUT);
    assert.deepEqual(K.normaliserConfig(null), DEFAUT);
    assert.deepEqual(K.normaliserConfig(undefined), DEFAUT);
  });

  test('les défauts sont figés, et ce que rend normaliserConfig n est jamais une référence partagée avec eux', () => {
    assert.ok(Object.isFrozen(K.DEFAUTS));
    assert.ok(Object.isFrozen(K.DEFAUTS.worktrees));
    assert.ok(Object.isFrozen(K.DEFAUTS.plans));
    const c = K.normaliserConfig(null);
    c.worktrees.push({ nom: 'Z', chemin: 'C:/travail/z' });
    c.worktrees[0].chemin = 'C:/travail/autre';
    c.plans.exclure.push('Autre');
    c.plans.dossier = 'C:/travail/plans';
    assert.deepEqual(K.normaliserConfig(null), DEFAUT, 'une modification du résultat ne touche pas les défauts');
  });
});

describe('normaliserConfig', () => {
  test('une configuration valide est gardée telle quelle, sans clé en trop', () => {
    const brute = { worktrees: [{ nom: 'A', chemin: 'C:/travail/a', extra: 1 }], plans: { dossier: 'C:/travail/p', exclure: ['E1', 'E2'], profondeur: 5, autre: 1 }, maj: 'x', autre: 2 };
    assert.deepEqual(K.normaliserConfig(brute), { worktrees: [{ nom: 'A', chemin: 'C:/travail/a' }], plans: { dossier: 'C:/travail/p', exclure: ['E1', 'E2'], profondeur: 5 } });
  });

  test('tout ce qui n est pas un objet donne les défauts', () => {
    for (const brut of [[], 'x', 5, true, () => 1]) assert.deepEqual(K.normaliserConfig(brut), DEFAUT, String(brut));
  });

  test('chaque champ retombe sur son défaut séparément', () => {
    const c = K.normaliserConfig({ worktrees: 'pas un tableau', plans: { dossier: 42, exclure: 'Anciens', profondeur: 0 } });
    assert.deepEqual(c, DEFAUT);
    assert.deepEqual(K.normaliserConfig({ plans: { dossier: 'C:/travail/autre' } }), { worktrees: [], plans: { ...DEFAUT.plans, dossier: 'C:/travail/autre' } });
    assert.deepEqual(K.normaliserConfig({ worktrees: [{ nom: 'Z', chemin: 'C:/travail/z' }] }), { worktrees: [{ nom: 'Z', chemin: 'C:/travail/z' }], plans: DEFAUT.plans });
    for (const plans of [null, [], 'x', 5]) assert.deepEqual(K.normaliserConfig({ plans }).plans, DEFAUT.plans, JSON.stringify(plans));
  });

  test('seules les entrées de worktree complètes sont gardées, et une liste vide reste vide', () => {
    assert.deepEqual(K.normaliserConfig({ worktrees: [{ nom: 'OK', chemin: 'C:/travail/a' }, { nom: 3 }, null, { chemin: 'C:/travail/b' }, { nom: ' ', chemin: 'C:/travail/c' }, { nom: 'D', chemin: '' }, 'x'] }).worktrees, [{ nom: 'OK', chemin: 'C:/travail/a' }]);
    assert.deepEqual(K.normaliserConfig({ worktrees: [] }).worktrees, []);
  });

  test('la profondeur est un entier de 1 au moins, les dossiers exclus des textes non vides', () => {
    for (const profondeur of [0, -1, 1.5, '3', null, NaN]) assert.equal(K.normaliserConfig({ plans: { profondeur } }).plans.profondeur, 3, JSON.stringify(profondeur));
    assert.equal(K.normaliserConfig({ plans: { profondeur: 1 } }).plans.profondeur, 1);
    assert.deepEqual(K.normaliserConfig({ plans: { exclure: [] } }).plans.exclure, []);
    for (const exclure of [['a', ''], ['a', 3], 'a', null]) assert.deepEqual(K.normaliserConfig({ plans: { exclure } }).plans.exclure, [], JSON.stringify(exclure));
  });

  test('ne modifie pas son argument', () => {
    const brute = { worktrees: [{ nom: 'A', chemin: 'C:/travail/a' }], plans: { dossier: 'C:/travail/p', exclure: ['E'], profondeur: 2 } };
    const copie = JSON.parse(JSON.stringify(brute));
    const c = K.normaliserConfig(brute);
    c.worktrees[0].nom = 'B';
    c.plans.exclure.push('F');
    assert.deepEqual(brute, copie);
  });
});

describe('valeurs des jetons des consignes', () => {
  test('worktrees et plans, tels que les consignes les citent', () => {
    assert.deepEqual(K.valeursJetons(config()), { worktrees: `APP (${APP.chemin}), API (${API.chemin})`, plans: PLANS.dossier });
  });

  test('sans worktree, la valeur le dit ; la valeur reste bornée', () => {
    assert.equal(K.valeursJetons(config([])).worktrees, '(aucun)');
    const beaucoup = Array.from({ length: 8 }, (_, i) => ({ nom: `W${i}`, chemin: `C:/travail/${'dossier-long/'.repeat(8)}${i}` }));
    const v = K.valeursJetons(config(beaucoup)).worktrees;
    assert.equal(v.length, 300);
    assert.ok(v.endsWith('...'));
    assert.ok(v.startsWith('W0 (C:/travail/'));
  });

  test('une valeur de exactement 300 caractères n est pas tronquée, une de 301 l est', () => {
    const exacte = { nom: 'N', chemin: `C:/travail/${'c'.repeat(300 - 'N (C:/travail/)'.length)}` };
    assert.equal(`${exacte.nom} (${exacte.chemin})`.length, 300);
    assert.equal(K.valeursJetons(config([exacte])).worktrees, `${exacte.nom} (${exacte.chemin})`);
    const trop = { nom: 'N', chemin: `${exacte.chemin}c` };
    const v = K.valeursJetons(config([trop])).worktrees;
    assert.equal(v.length, 300);
    assert.ok(v.endsWith('...'));
  });

  test('un état invalide donne les valeurs des défauts', () => {
    assert.deepEqual(K.valeursJetons(null), K.valeursJetons(DEFAUT));
    assert.deepEqual(K.valeursJetons('x'), K.valeursJetons(DEFAUT));
    assert.deepEqual(K.valeursJetons(null), { worktrees: '(aucun)', plans: '' });
  });
});

describe('commande : afficher', () => {
  test('sans argument, afficher, liste ou etat : les réglages, sans rien changer', () => {
    for (const args of ['', '  ', 'afficher', 'AFFICHER', 'liste', 'etat', 'état', undefined, null]) {
      const r = K.analyserCommande(args, config(), ok);
      assert.equal(r.erreur, undefined, String(args));
      assert.deepEqual(r.config, config(), String(args));
      assert.equal(r.message, K.texteReglages(config()));
    }
  });

  test('le texte des réglages cite chaque worktree, le dossier des plans, la profondeur et les exclus', () => {
    const t = K.texteReglages(config());
    assert.match(t, /^Réglages du Cockpit\./);
    assert.match(t, new RegExp(`Worktrees mesurés \\(2\\) : APP ${APP.chemin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ; API `));
    assert.match(t, /Dossier des plans : C:\/travail\/plans \(profondeur 3, exclus : Anciens\)/);
    assert.match(K.texteReglages(config([], { ...PLANS, dossier: '' })), /Dossier des plans : aucun \(profondeur 3/);
    assert.match(K.texteReglages(config([])), /Worktrees mesurés \(0\) : aucun/);
    assert.match(K.texteReglages(config([APP], { ...PLANS, exclure: [] })), /exclus : aucun\)/);
    assert.match(K.texteReglages(config([APP])), /Worktrees mesurés \(1\) : APP /);
    assert.match(K.texteReglages(config([APP], { ...PLANS, exclure: ['A', 'B'] })), /exclus : A, B\)/);
    assert.equal(K.texteReglages(config()).split('\n').length, 3);
    assert.ok(sansTiretLong(t), t);
  });

  test('afficher rend les réglages tels qu ils sont, pas les défauts', () => {
    const autre = config([{ nom: 'Z', chemin: 'C:/travail/z' }], { dossier: 'C:/travail/p', exclure: [], profondeur: 7 });
    assert.deepEqual(K.analyserCommande('', autre, ok).config, autre);
  });

  test('afficher, liste, etat ou defaut avec un argument de trop est refusé', () => {
    for (const args of ['afficher x', 'liste x', 'etat 1', 'defaut x', 'worktrees defaut x', 'plans defaut x']) assert.match(K.analyserCommande(args, config(), ok).erreur, /^Usage : /, args);
  });
});

describe('commande : worktrees', () => {
  test('worktree ajouter crée un worktree avec le chemin donné, espaces compris', () => {
    const r = K.analyserCommande('worktree ajouter DEPOT C:/travail/depot c', config(), ok);
    assert.equal(r.erreur, undefined);
    assert.deepEqual(r.config.worktrees.at(-1), { nom: 'DEPOT', chemin: 'C:/travail/depot c' });
    assert.equal(r.config.worktrees.length, 3);
    assert.equal(r.message, 'Worktree DEPOT ajouté : C:/travail/depot c.');
    assert.deepEqual(r.config.plans, PLANS);
  });

  test('ajouter un nom qui existe déjà change son chemin, sans doublon', () => {
    const r = K.analyserCommande('worktree ajouter APP C:/travail/autre/site', config(), ok);
    assert.deepEqual(r.config.worktrees, [{ nom: 'APP', chemin: 'C:/travail/autre/site' }, API]);
    assert.equal(r.message, 'Worktree APP modifié : C:/travail/autre/site.');
  });

  test('un chemin deja attribue a un autre nom est refuse, meme avec une autre casse Windows', () => {
    const r = K.analyserCommande('worktree ajouter AUTRE c:\\TRAVAIL\\depot-app\\', config(), ok);
    assert.match(r.erreur, /déjà suivi/);
    assert.deepEqual(r.config, undefined);
    const modif = K.analyserCommande('worktree ajouter APP C:/TRAVAIL/depot-app', config(), ok);
    assert.equal(modif.erreur, undefined);
    const conflit = K.analyserCommande('worktree ajouter APP C:/travail/depot-api', config(), ok);
    assert.match(conflit.erreur, /déjà suivi/);
  });

  test('les antislashs du chemin deviennent des barres obliques, une barre finale est retirée', () => {
    const r = K.analyserCommande('worktree ajouter T C:\\travail\\x\\', config(), ok);
    assert.equal(r.config.worktrees.at(-1).chemin, 'C:/travail/x');
    assert.equal(K.analyserCommande('worktree ajouter T C:/', config(), ok).config.worktrees.at(-1).chemin, 'C:/', 'la racine d un lecteur garde sa barre');
    assert.equal(K.analyserCommande('worktree ajouter T /', config(), ok).config.worktrees.at(-1).chemin, '/', 'la racine de l arborescence aussi');
    assert.equal(K.analyserCommande('worktree ajouter T c:/', config(), ok).config.worktrees.at(-1).chemin, 'c:/', 'un lecteur en minuscule aussi');
    assert.equal(K.analyserCommande('worktree ajouter T C:\\travail\\x\\', config(), ok).message, 'Worktree T ajouté : C:/travail/x.', 'le message cite le chemin rangé');
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/x//', config(), ok).config.worktrees.at(-1).chemin, 'C:/travail/x', 'toutes les barres finales partent');
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/x', config(), ok).config.worktrees.at(-1).chemin, 'C:/travail/x');
  });

  test('worktree retirer enlève le worktree nommé, et un nom inconnu est une erreur', () => {
    const r = K.analyserCommande('worktree retirer API', config(), ok);
    assert.deepEqual(r.config.worktrees, [APP]);
    assert.equal(r.message, 'Worktree API retiré.');
    assert.equal(K.analyserCommande('worktree retirer Z', config(), ok).erreur, 'Worktree Z introuvable (noms : APP, API).');
    assert.match(K.analyserCommande('worktree retirer Z', config([]), ok).erreur, /noms : aucun/);
    assert.deepEqual(K.analyserCommande('worktree retirer APP', config([APP]), ok).config.worktrees, [], 'on peut tout retirer');
  });

  test('ajouter ou retirer un worktree garde les réglages des plans tels qu ils sont', () => {
    const plans = { dossier: 'C:/travail/mes-plans', exclure: ['A', 'B'], profondeur: 6 };
    const base = config([APP], plans);
    assert.deepEqual(K.analyserCommande('worktree ajouter T C:/travail/t', base, ok).config.plans, plans);
    assert.deepEqual(K.analyserCommande('worktree retirer APP', base, ok).config.plans, plans);
    assert.deepEqual(K.analyserCommande('worktrees defaut', base, ok).config.plans, plans);
  });

  test('worktrees defaut rend des worktrees que l on peut modifier sans toucher aux défauts', () => {
    const r = K.analyserCommande('worktrees defaut', config([]), ok);
    r.config.worktrees.push({ nom: 'Z', chemin: 'C:/travail/z' });
    r.config.worktrees[0].chemin = 'C:/travail/modifie';
    assert.deepEqual(JSON.parse(JSON.stringify(K.DEFAUTS)), DEFAUT);
  });

  test('worktrees defaut vide la liste des worktrees et garde les plans', () => {
    const r = K.analyserCommande('worktrees defaut', config([{ nom: 'X', chemin: 'C:/travail/x' }], { ...PLANS, dossier: 'C:/travail/p' }), ok);
    assert.deepEqual(r.config, { worktrees: [], plans: { ...PLANS, dossier: 'C:/travail/p' } });
    assert.match(r.message, /Worktrees remis aux valeurs par défaut/);
  });

  test('un nom invalide, un chemin absent ou une saisie trop courte est refusé avec l usage', () => {
    for (const args of ['worktree ajouter', 'worktree ajouter DEPOT', 'worktree ajouter DEPOT   ', 'worktree retirer', 'worktree retirer A B', 'worktree', 'worktree inconnu x']) {
      assert.match(K.analyserCommande(args, config(), ok).erreur, /^Usage : /, args);
    }
    for (const nom of ['x'.repeat(21), 'é', 'a/b', 'a:b', 'a*b']) {
      assert.match(K.analyserCommande(`worktree ajouter ${nom} C:/travail/a`, config(), ok).erreur, /^Nom de worktree invalide/, nom);
    }
    assert.equal(K.analyserCommande('worktree ajouter a.b_c-1 C:/travail/a', config(), ok).erreur, undefined);
    assert.equal(K.analyserCommande(`worktree ajouter ${'x'.repeat(20)} C:/travail/a`, config(), ok).erreur, undefined);
  });

  test('au plus huit worktrees', () => {
    const huit = Array.from({ length: K.MAX_WORKTREES }, (_, i) => ({ nom: `W${i}`, chemin: `C:/travail/${i}` }));
    assert.equal(K.MAX_WORKTREES, 8);
    assert.equal(K.analyserCommande('worktree ajouter NEUF C:/travail/9', config(huit), ok).erreur, 'Déjà 8 worktrees, le maximum. Retire-en un avec worktree retirer <nom>.');
    assert.equal(K.analyserCommande('worktree ajouter W0 C:/travail/zero', config(huit), ok).erreur, undefined, 'modifier un existant reste permis');
  });

  test('un chemin qui n existe pas ou qui n est pas un dépôt git est refusé', () => {
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/nulle/part', config(), { dossierExiste: () => false, estDepot: () => false }).erreur, 'Le dossier C:/travail/nulle/part n\'existe pas.');
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/dossier', config(), { dossierExiste: () => true, estDepot: () => false }).erreur, 'Le dossier C:/travail/dossier n\'est pas une racine de dépôt git utilisable.');
  });

  test('les vérifications reçoivent le chemin normalisé, et seulement quand il y a quelque chose à vérifier', () => {
    const vus = [];
    const verif = { dossierExiste: c => { vus.push(['existe', c]); return true; }, estDepot: c => { vus.push(['depot', c]); return true; } };
    K.analyserCommande('worktree ajouter T C:\\travail\\a\\b\\', config(), verif);
    assert.deepEqual(vus, [['existe', 'C:/travail/a/b'], ['depot', 'C:/travail/a/b']]);
    vus.length = 0;
    K.analyserCommande('worktree retirer API', config(), verif);
    K.analyserCommande('', config(), verif);
    K.analyserCommande('worktrees defaut', config(), verif);
    assert.deepEqual(vus, []);
  });

  test('sans vérification fournie, rien n est vérifié', () => {
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/nulle/part', config()).erreur, undefined);
    assert.equal(K.analyserCommande('plans C:/travail/nulle/part', config()).erreur, undefined);
    for (const verif of [null, undefined, {}, 'x', 5]) {
      assert.equal(K.analyserCommande('worktree ajouter T C:/travail/nulle/part', config(), verif).erreur, undefined, String(verif));
    }
  });

  test('une vérification partielle ne fait que ce qu elle sait faire', () => {
    assert.match(K.analyserCommande('worktree ajouter T C:/travail/a', config(), { dossierExiste: () => false }).erreur, /n'existe pas/);
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/a', config(), { dossierExiste: () => true }).erreur, undefined, 'sans estDepot, aucun contrôle du dépôt');
    assert.match(K.analyserCommande('worktree ajouter T C:/travail/a', config(), { estDepot: () => false }).erreur, /racine de dépôt git utilisable/);
    assert.equal(K.analyserCommande('worktree ajouter T C:/travail/a', config(), { estDepot: () => true }).erreur, undefined, 'sans dossierExiste, aucun contrôle d existence');
  });

  test('un dossier de plans n a pas à être un dépôt git : seule son existence est vérifiée', () => {
    const vus = [];
    const verif = { dossierExiste: c => { vus.push(['existe', c]); return true; }, estDepot: c => { vus.push(['depot', c]); return false; } };
    assert.equal(K.analyserCommande('plans C:\\travail\\plans\\', config(), verif).erreur, undefined);
    assert.deepEqual(vus, [['existe', 'C:/travail/plans']]);
  });
});

describe('commande : plans', () => {
  test('plans <dossier> change le dossier, espaces compris, antislashs convertis', () => {
    const r = K.analyserCommande('plans C:\\travail\\Mes Plans', config(), ok);
    assert.equal(r.config.plans.dossier, 'C:/travail/Mes Plans');
    assert.equal(r.message, 'Dossier des plans : C:/travail/Mes Plans.');
    assert.deepEqual(r.config.worktrees, [APP, API]);
    assert.deepEqual([r.config.plans.exclure, r.config.plans.profondeur], [['Anciens'], 3]);
  });

  test('un dossier de plans qui n existe pas est refusé', () => {
    assert.equal(K.analyserCommande('plans C:/travail/nulle/part', config(), { dossierExiste: () => false, estDepot: () => true }).erreur, 'Le dossier C:/travail/nulle/part n\'existe pas.');
  });

  test('plans exclure et plans inclure gèrent la liste des dossiers laissés de côté', () => {
    const a = K.analyserCommande('plans exclure Archives', config(), ok);
    assert.deepEqual(a.config.plans.exclure, ['Anciens', 'Archives']);
    assert.equal(a.message, 'Dossier de plans exclu : Archives.');
    assert.deepEqual(K.analyserCommande('plans exclure Anciens', config(), ok).config.plans.exclure, ['Anciens'], 'pas de doublon');
    const b = K.analyserCommande('plans inclure Anciens', config(), ok);
    assert.deepEqual(b.config.plans.exclure, []);
    assert.equal(b.message, 'Dossier de plans de nouveau pris en compte : Anciens.');
    assert.match(K.analyserCommande('plans inclure Autre', config(), ok).erreur, /Autre n'est pas exclu \(exclus : Anciens\)\./);
    assert.equal(K.analyserCommande('plans inclure Z', config(undefined, { ...PLANS, exclure: ['A', 'B'] }), ok).erreur, "Z n'est pas exclu (exclus : A, B).");
    assert.match(K.analyserCommande('plans inclure Autre', config(undefined, { ...PLANS, exclure: [] }), ok).erreur, /exclus : aucun/);
  });

  test('plans profondeur accepte un entier de 1 à 10', () => {
    for (const n of [1, 5, 10]) assert.equal(K.analyserCommande(`plans profondeur ${n}`, config(), ok).config.plans.profondeur, n);
    const r = K.analyserCommande('plans profondeur 4', config([APP], { dossier: 'C:/travail/p', exclure: ['A', 'B'], profondeur: 7 }), ok);
    assert.deepEqual(r.config, config([APP], { dossier: 'C:/travail/p', exclure: ['A', 'B'], profondeur: 4 }), 'seule la profondeur change');
    assert.equal(K.analyserCommande('plans profondeur 4', config(), ok).message, 'Profondeur de recherche des plans : 4.');
    for (const n of ['0', '11', '-1', '2.5', 'x', '', '3 4']) assert.match(K.analyserCommande(`plans profondeur ${n}`, config(), ok).erreur, /^Usage : /, n);
  });

  test('plans defaut remet le dossier, les exclus et la profondeur, sans toucher aux worktrees', () => {
    const r = K.analyserCommande('plans defaut', config([APP], { dossier: 'C:/travail/p', exclure: ['A'], profondeur: 7 }), ok);
    assert.deepEqual(r.config, { worktrees: [APP], plans: DEFAUT.plans });
    assert.match(r.message, /Plans remis aux valeurs par défaut/);
  });

  test('defaut remet tout', () => {
    const r = K.analyserCommande('defaut', config([{ nom: 'X', chemin: 'C:/travail/x' }], { dossier: 'C:/travail/p', exclure: [], profondeur: 7 }), ok);
    assert.deepEqual(r.config, DEFAUT);
    assert.match(r.message, /Tous les réglages remis aux valeurs par défaut/);
  });

  test('plans sans dossier, exclure sans nom ou avec deux mots est refusé avec l usage', () => {
    for (const args of ['plans', 'plans exclure', 'plans exclure A B', 'plans inclure', 'plans inclure A B', 'plans profondeur']) assert.match(K.analyserCommande(args, config(), ok).erreur, /^Usage : /, args);
  });
});

describe('commande : généralités', () => {
  test('la casse et les espaces multiples de la sous-commande sont tolérés, ceux du chemin sont gardés tels quels', () => {
    const r = K.analyserCommande('  WORKTREE   Ajouter   T   C:/travail/a  b ', config(), ok);
    assert.equal(r.erreur, undefined);
    assert.deepEqual(r.config.worktrees.at(-1), { nom: 'T', chemin: 'C:/travail/a b' });
  });

  test('une sous-commande inconnue rend l usage complet, sans rien changer', () => {
    for (const args of ['xyz', 'ajouter', '1', 'worktrees', 'plan C:/travail/p']) {
      const r = K.analyserCommande(args, config(), ok);
      assert.match(r.erreur, /^Usage : /, args);
      assert.equal(r.config, undefined, args);
    }
    const u = K.analyserCommande('xyz', config(), ok).erreur;
    for (const mot of ['afficher', 'worktree ajouter', 'worktree retirer', 'worktrees defaut', 'plans <dossier>', 'plans exclure', 'plans inclure', 'plans profondeur', 'plans defaut', 'defaut']) assert.ok(u.includes(mot), mot);
    assert.equal(u, 'Usage : cockpit config [afficher | worktree ajouter <nom> <chemin> | worktree retirer <nom> | worktrees defaut | plans <dossier> | plans exclure <nom> | plans inclure <nom> | plans profondeur <1 à 10> | plans defaut | defaut]');
    assert.ok(sansTiretLong(u));
  });

  test('un état brut invalide est normalisé avant la commande, et l argument n est jamais modifié', () => {
    const brute = { worktrees: [{ nom: 'A', chemin: 'C:/travail/a' }, null], plans: { dossier: 5 } };
    const copie = JSON.parse(JSON.stringify(brute));
    const r = K.analyserCommande('worktree ajouter B C:/travail/b', brute, ok);
    assert.deepEqual(r.config.worktrees, [{ nom: 'A', chemin: 'C:/travail/a' }, { nom: 'B', chemin: 'C:/travail/b' }]);
    assert.equal(r.config.plans.dossier, DEFAUT.plans.dossier);
    assert.deepEqual(brute, copie);
    const avant = config();
    const copieAvant = JSON.parse(JSON.stringify(avant));
    for (const args of ['worktree ajouter T C:/travail/t', 'worktree retirer APP', 'plans C:/travail/p', 'plans exclure Z', 'plans profondeur 2', 'defaut']) K.analyserCommande(args, avant, ok);
    assert.deepEqual(avant, copieAvant);
  });

  test('tous les messages sont sans tiret long', () => {
    for (const args of ['', 'worktree ajouter T C:/travail/t', 'worktree retirer API', 'worktrees defaut', 'plans C:/travail/p', 'plans exclure Z', 'plans inclure Anciens', 'plans profondeur 2', 'plans defaut', 'defaut', 'worktree retirer Q', 'xyz']) {
      const r = K.analyserCommande(args, config(), ok);
      assert.ok(sansTiretLong(r.message || r.erreur), args);
    }
  });
});
