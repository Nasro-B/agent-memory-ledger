// emplacements-logique.mjs : où un module d'interface de Claude Code trouve l'état du Cockpit et les scripts du plugin, sans rien supposer de la machine.
// Reçoit `$`, l'interface du moteur (le moteur n'en donne ni le dossier de l'utilisateur ni le chemin d'un script : il donne les variables d'environnement
// et le dossier du module). Aucun import. Le MÊME fichier est copié, octet pour octet, dans le dossier hooks/ de chaque module (scripts/synchroniser-mods.js) :
// un module ne peut importer que des fichiers de son propre dossier.
// Le moteur exige que le nom d'une variable soit écrit en toutes lettres dans l'appel `$.env.get('NOM')` : pas de nom calculé ici.
//
// dossierEtat($)      le dossier d'état du Cockpit, celui des noyaux et de la ligne de commande (scripts/lib/cockpit-core.js : racine ; scripts/lib/config.js : maison) :
//                     COCKPIT_DIR ; sinon <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME ; sinon <dossier de l'utilisateur>/.agent-memory-ledger.
//                     Le dossier de l'utilisateur : USERPROFILE sous Windows, HOME ailleurs (ce que Node rend pour os.homedir()). Sans dossier : une erreur.
// cheminScript($, nom) un script du plugin principal (scripts/<nom>) : AML_PLUGIN_DIR (le dossier du plugin, qui contient scripts/) ; sinon le dépôt qui contient
//                     ce module (mods/<module> sous la racine du dépôt) ; sinon le plugin installé à côté du module (même marketplace, version la plus récente
//                     qui a le script). Sans script trouvé : une erreur qui dit quoi faire.

const chaineNonVide = v => typeof v === 'string' && v.trim() !== '';
const sansFin = chemin => chemin.replace(/[\\/]+$/, '');

// Une lecture qui échoue vaut une variable absente : un module ne tombe jamais pour une variable.
async function lire(lecture) {
  try { return await lecture(); } catch (_) { return undefined; }
}

async function existe($, chemin) {
  try { return (await $.fs.exists(chemin)) === true; } catch (_) { return false; }
}

// Windows : une racine de module en « C:... » ou en « \\... ». Là, le dossier de l'utilisateur est USERPROFILE ; ailleurs, HOME.
// (Une déclaration de fonction, pas une fonction fléchée : le moteur ne suit `$` au-delà d'un import que dans une déclaration.)
function sousWindows($) {
  return /^[A-Za-z]:|^\\\\/.test(String($.plugin.root));
}

export async function dossierEtat($) {
  const direct = await lire(() => $.env.get('COCKPIT_DIR'));
  if (chaineNonVide(direct)) return sansFin(direct);
  const maison = await lire(() => $.env.get('AGENT_MEMORY_LEDGER_HOME'));
  if (chaineNonVide(maison)) return `${sansFin(maison.trim())}/cockpit`;
  const profil = await lire(() => $.env.get('USERPROFILE'));
  const dossier = await lire(() => $.env.get('HOME'));
  const utilisateur = sousWindows($) ? (chaineNonVide(profil) ? profil : dossier) : (chaineNonVide(dossier) ? dossier : profil);
  if (!chaineNonVide(utilisateur)) throw new Error('dossier de l\'utilisateur introuvable : poser COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME');
  return `${sansFin(utilisateur.trim())}/.agent-memory-ledger/cockpit`;
}

// Les noms de versions, de la plus récente à la plus ancienne (les nombres se comparent comme des nombres : 0.10.0 vient après 0.9.0).
export function versionsRecentes(noms) {
  return [...noms].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export async function cheminScript($, nom) {
  const explicite = await lire(() => $.env.get('AML_PLUGIN_DIR'));
  if (chaineNonVide(explicite)) return `${sansFin(explicite.trim())}/scripts/${nom}`;
  const parties = sansFin(String($.plugin.root)).split(/[\\/]/);
  const parent = parties.slice(0, -2).join('/');
  if (parent !== '' && await existe($, `${parent}/scripts/${nom}`)) return `${parent}/scripts/${nom}`;
  const installe = `${parent}/agent-memory-ledger`;
  let entrees = [];
  try { entrees = await $.fs.list(installe); } catch (_) { entrees = []; }
  // Un lien symbolique se lit « other » dans la liste : on ne filtre pas sur le genre, la présence du script décide.
  for (const version of versionsRecentes(entrees.filter(e => e && typeof e.name === 'string').map(e => e.name))) {
    if (await existe($, `${installe}/${version}/scripts/${nom}`)) return `${installe}/${version}/scripts/${nom}`;
  }
  throw new Error(`${nom} introuvable : poser AML_PLUGIN_DIR (le dossier du plugin agent-memory-ledger, celui qui contient scripts/)`);
}
