'use strict';
// Écriture d'un fichier sans le laisser à moitié écrit, et verrou entre processus. Utilisé par la mémoire
// (lib/memoire.js) : deux agents qui journalisent en même temps sur le même projet ne doivent ni perdre une
// ligne ni laisser un fichier tronqué.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRANSITOIRES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Écrit `contenu` dans un fichier voisin puis le renomme : un lecteur voit l'ancien fichier ou le nouveau, jamais
// un morceau. Sous Windows, un antivirus ou un indexeur peut tenir le fichier une fraction de seconde : le
// renommage est réessayé.
function ecrireAtomique(fichier, contenu) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const tmp = `${fichier}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, contenu);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, fichier); return; } catch (e) {
        if (i >= 40 || !TRANSITOIRES.has(e.code)) throw e;
        pause(25);
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* déjà renommé */ } }
}

// Verrou exclusif <fichier>.lock (création exclusive), réessayé jusqu'au délai. Un verrou dont le processus est
// mort est retiré. AML_DELAI_VERROU_MS ne sert qu'aux bancs.
function avecVerrou(fichier, fn, delai) {
  const limiteMs = delai || Number(process.env.AML_DELAI_VERROU_MS) || 5000;
  const verrou = fichier + '.lock';
  const jeton = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.dirname(verrou), { recursive: true });
  const fin = Date.now() + limiteMs;
  for (;;) {
    try {
      const fd = fs.openSync(verrou, 'wx');
      try { fs.writeSync(fd, jeton); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && !TRANSITOIRES.has(e.code)) throw e;
      if (e.code === 'EEXIST') {
        try {
          const proprietaire = fs.readFileSync(verrou, 'utf8');
          const pid = Number(proprietaire.split(' ')[0]);
          let mort = false;
          try { process.kill(pid, 0); } catch (err) { mort = err.code === 'ESRCH'; }
          if (mort && pid > 0 && fs.readFileSync(verrou, 'utf8') === proprietaire) fs.unlinkSync(verrou); // ancre-mutation:verrou-perime
        } catch (_) { /* disparu entre-temps */ }
      }
      if (Date.now() >= fin) throw new Error('verrou occupé : ' + fichier);
      pause(10 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); } finally {
    try { if (fs.readFileSync(verrou, 'utf8') === jeton) fs.unlinkSync(verrou); } catch (_) { /* déjà retiré */ }
  }
}

module.exports = { ecrireAtomique, avecVerrou };
