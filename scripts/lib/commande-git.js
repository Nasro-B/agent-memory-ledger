'use strict';
// Lecture d'une ligne de commande shell : y a-t-il un VRAI `git commit`, et dans quel dépôt ?
// Utilisé par le noyau du fichier contexte (preuve par message de commit) et par le journal des commits.

// Masque le contenu des chaînes "..." et '...' SANS changer les index (remplacé par des espaces) : un
// `rg "git commit"` ou un `echo "cd x && git commit"` ne doit jamais passer pour un commit.
function maskQuotedSegments(value) {
  const source = [...String(value)];
  const masked = [...source];
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (!quote) {
      if (char === '"' || char === "'") quote = char;
      continue;
    }
    if (char === quote) {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) backslashes++;
      const escaped = (quote === '"' && (backslashes % 2 === 1 || source[i - 1] === '`')) ||
        (quote === "'" && source[i + 1] === "'");
      if (!escaped) {
        quote = '';
        continue;
      }
    }
    masked[i] = ' ';
  }
  return masked.join('');
}

const RE_COMMIT = /(?:^|&&|\|\||[;\r\n])\s*(?:&\s*)?git\s+(?:-C\s+(?:"[^"]*"|'[^']*'|[^\s"']+)\s+|-c\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+)*commit\b/i;

// Dit si `cmd` contient un vrai segment `git commit` (pas une citation) et résout le dossier du dépôt visé :
// `git -C <chemin>` d'abord, sinon un `cd <chemin> &&` en tête de commande, sinon `hookCwd`.
// `--amend` est exclu : il ne crée pas un nouveau travail à journaliser.
function resolveCommitTarget(cmd, hookCwd) {
  const path = require('path');
  const texte = String(cmd);
  const masked = maskQuotedSegments(texte); // ancre-mutation:citation
  const m = masked.match(RE_COMMIT);
  if (!m) return { isCommit: false };
  if (/--amend\b/i.test(texte)) return { isCommit: false };
  const gitOffset = m[0].search(/\bgit\b/i);
  const gitStart = m.index + gitOffset;
  const prefix = texte.slice(gitStart, m.index + m[0].length);
  const mC = prefix.match(/git\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i);
  const mCd = texte.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"'&;]+))\s*&&/);
  const target = mC ? (mC[1] || mC[2] || mC[3]) : (mCd ? (mCd[1] || mCd[2] || mCd[3]) : null);
  const gitCwd = target ? path.resolve(hookCwd, target) : hookCwd;
  return { isCommit: true, gitCwd };
}

module.exports = { maskQuotedSegments, resolveCommitTarget };
