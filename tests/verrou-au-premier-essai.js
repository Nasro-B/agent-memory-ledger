'use strict';
// Aide de banc, préchargée dans le processus testé (node --require <ce fichier> <script>).
// Le verrou nommé par AML_TEST_VERROU est posé, au nom d'un autre processus, à l'instant où le processus
// testé tente de le prendre pour la première fois ; il reste tenu AML_TEST_VERROU_MS millisecondes, puis
// devient périmé. La durée court donc depuis la première tentative, pas depuis le lancement.
//
// Pourquoi : un verrou posé par le banc AVANT de lancer le processus s'use pendant le démarrage de node.
// Sous forte charge (mesuré : jusqu'à 21 s avant la première ligne d'un hook), le processus arrivait après
// la fin du verrou, ne l'attendait plus, et une mutation « réessai désactivé » restait verte.

const fs = require('fs');
const path = require('path');

const VERROU_PERIME_MS = 10000; // âge au-delà duquel le noyau tient un verrou pour abandonné
const cible = process.env.AML_TEST_VERROU;
const duree = Number(process.env.AML_TEST_VERROU_MS);
const norme = f => path.resolve(String(f).replace(/^\\\\\?\\/, '')).toLowerCase();

if (cible && Number.isFinite(duree) && duree > 0) {
  const openSync = fs.openSync;
  let pose = false;
  fs.openSync = function (fichier, drapeaux, ...reste) {
    if (!pose && drapeaux === 'wx' && norme(fichier) === norme(cible)) {
      pose = true;
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      fs.writeFileSync(cible, '99999 autre processus');
      const t = new Date(Date.now() - (VERROU_PERIME_MS - duree));
      fs.utimesSync(cible, t, t);
    }
    return openSync.call(fs, fichier, drapeaux, ...reste);
  };
}
