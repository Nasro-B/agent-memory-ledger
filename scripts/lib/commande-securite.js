'use strict';
// Lecture d'une ligne de commande shell pour la garde de sécurité : découpage en mots et en segments, commandes
// git réellement exécutées (sous-shells, substitutions, enveloppes connues), forme canonique des commandes git
// (options globales et alias retirés). Aucune de ces fonctions n'exécute quoi que ce soit.
//
// Toute commande qui ne peut pas être lue (guillemet jamais fermé, substitution jamais fermée, shell imbriqué
// trop profond, option globale de git inconnue) lève une erreur : la garde la refuse, elle ne la laisse jamais
// passer faute de l'avoir comprise.
//
// Here-documents (`<<'FIN'`) et here-strings PowerShell (`@'` ... `'@`) : leur corps est du texte, pas des
// commandes, et peut contenir des apostrophes isolées (un message de commit en français). Il est sauté, SAUF si
// la ligne qui l'annonce contient un interpréteur (bash, sh, pwsh, python, node, iex...) : alors il est lu comme
// le reste de la commande, et un `git push` qu'il contient est vu. Sans terminateur trouvé, rien n'est sauté.

const INTERPRETES = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'node', 'ruby', 'perl', 'php',
  'env', 'sudo', 'xargs', 'eval', 'source', 'iex', 'invoke-expression', 'invoke-command', 'start-process',
]);

function nomExecutable(valeur) {
  return String(valeur).replace(/\\/g, '/').split('/').pop().replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
}

// Un interpréteur nommé dans la ligne : son corps de here-document serait exécuté, donc lu comme des commandes.
const RE_INTERPRETE = new RegExp('(?:^|[\\s|;&(`])(?:' + [...INTERPRETES].join('|') + ')(?:\\.exe)?(?![\\w-])', 'i');

// Fin (indice du saut de ligne) de la ligne qui ne porte que le mot de fin du here-document, ou -1.
function finTerminateur(source, depart, h) {
  let pos = depart;
  while (pos <= source.length) {
    const nl = source.indexOf('\n', pos);
    const ligne = source.slice(pos, nl < 0 ? source.length : nl).replace(/\r$/, '');
    if ((h.tab ? ligne.replace(/^\t+/, '') : ligne) === h.mot) return nl < 0 ? source.length : nl;
    if (nl < 0) return -1;
    pos = nl + 1;
  }
  return -1;
}

// Suivi des here-documents annoncés sur une ligne : voir() à chaque « << » rencontré hors guillemets, fin() au
// saut de ligne qui suit.
function creerSuiviHeredoc() {
  let attente = [];
  return {
    voir(source, i) {
      if (source[i] !== '<' || source[i + 1] !== '<' || source[i + 2] === '<' || source[i - 1] === '<') return false;
      const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w.-]*))/.exec(source.slice(i, i + 200));
      if (!m) return false;
      attente.push({ tab: m[1] === '-', mot: m[2] || m[3] || m[4] });
      return true;
    },
    enAttente() { return attente.length > 0; },
    // Indice du saut de ligne qui ferme le dernier here-document annoncé, ou -1 : un terminateur manque, ou la
    // ligne qui les annonce nomme un interpréteur (le corps est alors lu comme des commandes, pas sauté).
    fin(source, i) {
      const liste = attente;
      attente = [];
      if (RE_INTERPRETE.test(source.slice(source.lastIndexOf('\n', i - 1) + 1, i))) return -1; // ancre-mutation:heredoc-interprete
      let pos = i + 1;
      for (const h of liste) {
        const f = finTerminateur(source, pos, h);
        if (f < 0) return -1;
        pos = f + 1;
      }
      return liste.length ? pos - 1 : -1;
    },
  };
}

// Mots de la ligne, avec leur position : { start, end, value, separator }. Les séparateurs (| ; & ( ) { } et
// sauts de ligne) sont des mots à part. `commentaires` : un « # » en début de mot ignore la fin de la ligne.
function lireMots(source, options = {}) {
  const commentaires = options.commentaires !== false;
  const tokens = [];
  const heredoc = creerSuiviHeredoc();
  let start = -1;
  let value = '';
  let quote = '';
  const flush = end => {
    if (start >= 0) tokens.push({ start, end, value, separator: false });
    start = -1;
    value = '';
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && source[i + 1] === "'") { value += char; i++; }
        else quote = '';
      } else if ((quote === '"' && (char === '\\' || char === '`')) && source[i + 1] === '"') {
        value += source[++i];
      } else value += char;
      continue;
    }
    if (char === '@' && (source[i + 1] === "'" || source[i + 1] === '"') && (source[i + 2] === '\n' || (source[i + 2] === '\r' && source[i + 3] === '\n'))) {
      // Here-string PowerShell : le corps va jusqu'à la ligne qui commence par le guillemet et « @ ».
      const q = source[i + 1];
      const fin = source.indexOf('\n' + q + '@', i + 2);
      if (fin >= 0) {
        const finLigne = source.indexOf('\n', fin + 3);
        const ligne = source.slice(source.lastIndexOf('\n', i - 1) + 1, i) + ' ' + source.slice(fin + 3, finLigne < 0 ? source.length : finLigne);
        if (!RE_INTERPRETE.test(ligne)) { // ancre-mutation:here-string
          if (start < 0) start = i;
          i = fin + 2;
          continue;
        }
      }
    }
    if (char === '<' && heredoc.voir(source, i)) { /* annoncé : le corps est vu au saut de ligne */ }
    if (char === '"' || char === "'") {
      if (start < 0) start = i;
      quote = char;
    } else if (commentaires && char === '#' && start < 0) {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      i--;
    } else if (/[|;&\r\n(){}]/.test(char)) {
      flush(i);
      tokens.push({ start: i, end: i + 1, value: char, separator: true });
      if (char === '\n' && heredoc.enAttente()) {
        const fin = heredoc.fin(source, i);
        if (fin >= 0) i = fin - 1; // ancre-mutation:heredoc-saute
      }
    } else if (/\s/.test(char)) flush(i);
    else { if (start < 0) start = i; value += char; }
  }
  if (quote) throw new Error('Citation non terminee : commande non analysable');
  flush(source.length);
  return tokens;
}

function segmentsDe(source) {
  const segments = [];
  let courant = [];
  for (const token of lireMots(source)) {
    if (token.separator) {
      if (courant.length) segments.push(courant);
      courant = [];
    } else courant.push(token);
  }
  if (courant.length) segments.push(courant);
  return segments;
}

// Texte exécuté par un shell appelé avec -c, /c, -Command ou -EncodedCommand.
function corpsDeCommande(tokens, name) {
  for (let i = 1; i < tokens.length; i++) {
    const option = tokens[i].value.toLowerCase();
    if (name === 'cmd' && /^\/(?:c|k)$/.test(option)) return tokens.slice(i + 1).map(x => x.value).join(' ');
    if (name === 'pwsh' || name === 'powershell') {
      if (/^-(?:command|c)$/.test(option)) return tokens.slice(i + 1).map(x => x.value).join(' ');
      if (/^-(?:encodedcommand|e)$/.test(option)) {
        const encoded = tokens[i + 1] && tokens[i + 1].value;
        if (!encoded) return '';
        return Buffer.from(encoded, 'base64').toString('utf16le');
      }
      continue;
    }
    if (option === '--') continue;
    if (/^--command$/.test(option) || /^-[a-z]*c[a-z]*$/i.test(option)) {
      return tokens.slice(i + 1).map(x => x.value).join(' ');
    }
  }
  return '';
}

// Fin (indice de la parenthèse fermante) de la substitution « $( » qui commence en `debut`, ou -1. Les guillemets,
// les parenthèses imbriquées et les corps de here-document sont suivis. `dansGuillemets` : la substitution est
// elle-même dans une chaîne entre guillemets doubles (le contre-guillemet y échappe aussi).
function finSubstitution(source, debut, dansGuillemets) {
  let profondeur = 1;
  let imbrique = '';
  const heredoc = creerSuiviHeredoc();
  for (let j = debut; j < source.length; j++) {
    const c = source[j];
    if (imbrique) {
      const echappe = imbrique === '"' && (c === '\\' || (dansGuillemets && c === '`')) && source[j + 1] === imbrique;
      if (echappe) { j++; continue; }
      if (c === imbrique) imbrique = '';
    } else if (c === '"' || c === "'") imbrique = c;
    else if (c === '<' && heredoc.voir(source, j)) { /* le corps est sauté au saut de ligne */ }
    else if (c === '\n' && heredoc.enAttente()) {
      const fin = heredoc.fin(source, j);
      if (fin >= 0) j = fin - 1; // ancre-mutation:heredoc-substitution
    } else if (c === '(') profondeur++;
    else if (c === ')' && --profondeur === 0) return j;
  }
  return -1;
}

// Textes des substitutions « $(...) » de la commande (y compris celles qui sont dans des guillemets doubles, pas
// celles qui sont dans des apostrophes ni échappées).
function substitutions(source) {
  const trouvees = [];
  let quote = '';
  const heredoc = creerSuiviHeredoc();
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (quote === '"' && (char === '\\' || char === '`') && source[i + 1] === '$') { i++; continue; }
      if (quote === '"' && char === '$' && source[i + 1] === '(') {
        const debut = i + 2;
        const fin = finSubstitution(source, debut, true);
        if (fin < 0) throw new Error('Substitution shell non terminee : commande non analysable');
        trouvees.push(source.slice(debut, fin));
        i = fin;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\' && source[i + 1] === '$') i++;
    else if (char === '<' && heredoc.voir(source, i)) { /* le corps est sauté au saut de ligne */ }
    else if (char === '\n' && heredoc.enAttente()) {
      const fin = heredoc.fin(source, i);
      if (fin >= 0) i = fin - 1;
    } else if (char === '$' && source[i + 1] === '(') {
      const debut = i + 2;
      const fin = finSubstitution(source, debut, false);
      if (fin < 0) throw new Error('Substitution shell non terminee : commande non analysable');
      trouvees.push(source.slice(debut, fin));
      i = fin;
    }
  }
  return trouvees;
}

const AFFICHAGE = ['echo', 'printf', 'write-output', 'write-host', 'write-error', 'write-warning', 'write-verbose', 'cat', 'type', 'get-content', 'rg', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'set-content', 'add-content', 'out-file', 'sed', 'awk', 'head', 'tail', 'less', 'more', 'ls', 'dir'];
const RE_GIT = /(?:^|[\\/])git(?:\.(?:exe|cmd|bat))?$/i;

// Commandes git exécutées par `source`, sous leur forme canonique. Un « git push » cité dans un echo ou un grep
// n'est pas une commande ; celui d'un sous-shell, d'une substitution ou d'une enveloppe (env, sudo, time, bash -c,
// pwsh -Command, cmd /c...) l'est.
function commandesGitExecutees(source, profondeur = 0) {
  if (profondeur > 8) throw new Error('Shell imbrique : commande non analysable');
  const trouvees = [];
  for (const imbriquee of substitutions(source)) trouvees.push(...commandesGitExecutees(imbriquee, profondeur + 1));
  for (const tokens of segmentsDe(source)) {
    let i = 0;
    while (i < tokens.length) {
      const valeur = tokens[i].value;
      const nom = nomExecutable(valeur);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(valeur)) { i++; continue; }
      if (nom === 'env') {
        i++;
        while (i < tokens.length) {
          const option = tokens[i].value;
          if (option === '--') { i++; break; }
          if (/^(?:-i|--ignore-environment|--null|--debug)$/.test(option)) { i++; continue; }
          if (/^(?:-u|--unset)$/.test(option)) { i += 2; continue; }
          if (/^(?:-u.+|--unset=)/.test(option)) { i++; continue; }
          if (/^(?:-S|--split-string)$/.test(option)) {
            const corps = tokens.slice(i + 1).map(x => x.value).join(' ');
            trouvees.push(...commandesGitExecutees(corps, profondeur + 1));
            i = tokens.length;
            break;
          }
          if (option.startsWith('-')) { i++; continue; }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) { i++; continue; }
          break;
        }
        continue;
      }
      if (nom === 'sudo') {
        i++;
        while (i < tokens.length && tokens[i].value.startsWith('-')) {
          const option = tokens[i].value;
          i++;
          if (/^(?:-u|-g|-h|-p|-C|-D|-R|-r)$/.test(option)) i++;
        }
        continue;
      }
      if (['command', 'exec', 'nohup', 'time'].includes(nom)) {
        i++;
        while (i < tokens.length && tokens[i].value.startsWith('-')) i++;
        continue;
      }
      if (['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'].includes(nom)) {
        const corps = corpsDeCommande(tokens.slice(i), nom);
        if (corps) trouvees.push(...commandesGitExecutees(corps, profondeur + 1));
        break;
      }
      if (RE_GIT.test(valeur)) {
        const segment = source.slice(tokens[i].start, tokens[tokens.length - 1].end);
        trouvees.push(normalizeGitCommands(segment));
      } else if (!AFFICHAGE.includes(nom)) {
        // Enveloppe d'arguments (xargs, timeout, nice, wsl, find -exec, start...) : un mot « git » non cité plus loin
        // dans le segment est une invocation. Les commandes qui ne font qu'afficher, chercher ou écrire du texte
        // (echo, rg, Set-Content...) en sont exclues : un exemple affiché n'est pas une commande.
        for (let k = i + 1; k < tokens.length; k++) {
          if (RE_GIT.test(tokens[k].value)) {
            trouvees.push(normalizeGitCommands(source.slice(tokens[k].start, tokens[tokens.length - 1].end)));
            break;
          }
        }
      }
      break;
    }
  }
  return trouvees;
}

// Enveloppes d'exécution que l'extracteur ne sait pas ouvrir (xargs, find -exec, Invoke-Expression, eval,
// Start-Process, Invoke-Command, source, python/node/ruby/perl -c ou -e) : le texte « git push » de la commande
// suffit alors à la refuser.
function enveloppeOpaque(commande) {
  return /(?:^|[\s;|&(])(?:xargs|iex|invoke-expression|eval|start-process|invoke-command|source)(?=[\s;|&)]|$)|\s-exec(?:dir)?(?=\s)|(?:^|[\s;|&(])(?:python3?|node|ruby|perl)(?:\.exe)?\s+-[ce](?=\s)/i.test(commande);
}

// « git.exe » devient « git » (et de même pour les autres outils connus), pour les seules règles de texte.
function sansExtension(commande) {
  return String(commande).replace(/\b(git|vercel|npx|wrangler|npm|pnpm|node)\.(exe|cmd|bat)\b/gi, '$1');
}

const OPTIONS_SANS_VALEUR = new Set([
  '--no-pager', '--paginate', '-p', '-P', '--bare', '--no-replace-objects',
  '--no-lazy-fetch', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--no-advice',
]);
const OPTIONS_AVEC_VALEUR = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

// Forme canonique, pour les gardes seulement : « git -C x -c alias.p=push p origin » devient « git push origin ».
// Ne jamais l'exécuter ni s'en servir pour retrouver un dépôt.
function normalizeGitCommands(commande, profondeur = 0, alias0 = new Map()) {
  if (profondeur > 8) throw new Error('Alias Git recursif : commande non analysable');
  const source = String(commande);
  const tokens = lireMots(source, { commentaires: false });
  const remplacements = [];
  for (let i = 0; i < tokens.length; i++) {
    const executable = tokens[i];
    if (executable.separator || !RE_GIT.test(executable.value)) continue;
    const precedent = tokens[i - 1];
    if (precedent && !precedent.separator && !/^(?:env|sudo|command|exec|nohup|time)$/i.test(precedent.value)) continue;
    const alias = new Map(alias0);
    const retenir = reglage => {
      const m = reglage.match(/^alias\.([^=]+)=(.*)$/s);
      if (m) alias.set(m[1], m[2]);
    };
    let j = i + 1;
    for (; j < tokens.length && !tokens[j].separator; j++) {
      const option = tokens[j].value;
      if (!option.startsWith('-')) break;
      if (option === '--') { j++; break; }
      if (['--version', '--help', '-v', '-h'].includes(option)) { j = tokens.length; break; }
      if (OPTIONS_SANS_VALEUR.has(option)) continue;
      if (/^(?:-C|-c).+/.test(option)) {
        if (option.startsWith('-c')) retenir(option.slice(2));
        continue;
      }
      if (/^--(?:git-dir|work-tree|namespace|super-prefix|config-env|exec-path)=/.test(option)) continue;
      if (OPTIONS_AVEC_VALEUR.has(option)) {
        if (!tokens[j + 1] || tokens[j + 1].separator) throw new Error('Argument Git manquant pour ' + option);
        if (option === '-c') retenir(tokens[j + 1].value);
        j++;
        continue;
      }
      throw new Error('Option globale Git non reconnue : ' + option);
    }
    if (tokens[j] && !tokens[j].separator) {
      const valeur = alias.get(tokens[j].value);
      const texte = valeur === undefined ? 'git ' + tokens[j].value
        : normalizeGitCommands(valeur.startsWith('!') ? valeur.slice(1) : 'git ' + valeur, profondeur + 1, alias);
      remplacements.push({ start: executable.start, end: tokens[j].end, text: texte });
      i = j;
    }
  }
  let resultat = source;
  for (const r of remplacements.reverse()) resultat = resultat.slice(0, r.start) + r.text + resultat.slice(r.end);
  return resultat;
}

module.exports = { lireMots, segmentsDe, nomExecutable, substitutions, commandesGitExecutees, enveloppeOpaque, sansExtension, normalizeGitCommands, INTERPRETES };
