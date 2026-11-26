import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

// Le dossier d'état du Cockpit que le moteur de test donne au module par COCKPIT_DIR (emplacements-logique.mjs).
const DOSSIER = 'C:/travail/cockpit'
const FICHIER = `${DOSSIER}/consignes.json`
const CONFIG = `${DOSSIER}/config.json`
const DEBUT = Date.parse('2026-03-03T12:00:00.000Z')
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }
const BASE = [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }]
const SPAWN = { prompt: 'Fais le travail A', description: 'travail A', subagentType: 'general-purpose' }
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }

// Le moteur de test remplit lui-même ce que l'appel laisse de côté (origine, présentation, identifiants) : on le dit au typage.
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const lancement = ($: Engine) => $.agent.spawn(SPAWN as never)
const shell = ($: Engine, tool: 'Bash' | 'PowerShell', cmd: string) => $.tool.call({ tool, command: cmd } as never)

// Le moteur donne aux hooks le chemin Windows natif (barres obliques inverses) : on compare en barres obliques.
const normal = (chemin: string) => chemin.replace(/\\/g, '/')

type Consigne = { id: number; texte: string; actif?: boolean; verrou?: string | null }
const fichier = (consignes: Consigne[], prochain = 100) => JSON.stringify({ prochain, consignes: consignes.map(c => ({ actif: true, verrou: null, ...c })) })
const PUSH: Consigne = { id: 1, texte: 'Pas de push sans mon ordre', verrou: 'push' }
const DEPLOIEMENT: Consigne = { id: 2, texte: 'Pas de déploiement', verrou: 'deploiement' }
const REBUILD: Consigne = { id: 3, texte: 'Pas de rebuild APK', verrou: 'rebuild' }
const AGENT: Consigne = { id: 4, texte: 'Aucun nouvel agent cette nuit', verrou: 'agent' }
const TEXTE: Consigne = { id: 5, texte: 'Réponds en français' }

// Le monde simulé sous la mod : le fichier des consignes, ce que la mod montre, lance ou exécute.
function monde(on: On, init: { fichier?: string | null; config?: string | null; ecritureEchoue?: boolean } = {}) {
  const etat = {
    fichier: init.fichier ?? null,
    config: init.config ?? null,
    ecritures: [] as { path: string; text: string }[],
    statuts: [] as (string | undefined)[],
    commandesDeclarees: [] as string[],
    executees: [] as string[],
    lancements: 0,
    demarrages: 0,
    lecturesConfig: 0,
  }
  mock.clock(on, { now: DEBUT })
  mock.env(on, { COCKPIT_DIR: DOSSIER })
  on('session.start', (_$, e) => {
    etat.demarrages++
    return { cwd: e.cwd }
  })
  on('command.register', (_$, e) => {
    etat.commandesDeclarees.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.read', (_$, e) => {
    if (normal(e.path) === CONFIG) {
      etat.lecturesConfig++
      return etat.config === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.config }
    }
    if (normal(e.path) !== FICHIER) return { deny: `chemin inattendu : ${e.path}` }
    return etat.fichier === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.fichier }
  })
  on('fs.write', (_$, e) => {
    if (init.ecritureEchoue === true) return { deny: 'disque plein' }
    etat.ecritures.push({ path: normal(e.path), text: e.text })
    if (normal(e.path) === FICHIER) etat.fichier = e.text
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    etat.executees.push(String((e as { command?: unknown }).command))
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  on('agent.spawn', () => {
    etat.lancements++
    return { model: 'm', agentId: `a${etat.lancements}` }
  })
  on('prompt.compose', () => ({ sections: BASE }))
  return { etat }
}

describe('démarrage', () => {
  test('enregistre la commande /consignes ; sans fichier, aucune ligne de statut', async ($, on) => {
    const { etat } = monde(on)
    await $.session.start(DEMARRAGE)
    expect(etat.commandesDeclarees).toEqual(['consignes'])
    expect(etat.statuts).toEqual([undefined])
    expect(etat.demarrages).toBe(1)
  })

  test('avec des consignes actives, la ligne de statut les compte et dit combien sont verrouillées', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH, TEXTE, { ...REBUILD, actif: false }]) })
    await $.session.start(DEMARRAGE)
    expect(etat.statuts.at(-1)).toBe('Consignes : 2 actives (1 verrouillée)')
  })

  test('un fichier abîmé n empêche pas le démarrage : aucune consigne appliquée, aucune ligne de statut', async ($, on) => {
    const { etat } = monde(on, { fichier: '{pas du json' })
    await $.session.start(DEMARRAGE)
    expect(etat.commandesDeclarees).toEqual(['consignes'])
    expect(etat.statuts).toEqual([undefined])
  })
})

describe('rappel dans le prompt', () => {
  test('ajoute une section de session après celles du moteur, avec les consignes actives et leurs verrous', async ($, on) => {
    monde(on, { fichier: fichier([PUSH, TEXTE]) })
    const r = await $.prompt.compose({ ...COMPOSE })
    expect(r.sections).toHaveLength(2)
    expect(r.sections[0]).toEqual(BASE[0])
    expect(r.sections[1]?.id).toBe('consignes:en-vigueur')
    expect(r.sections[1]?.scope).toBe('session')
    expect(r.sections[1]?.text).toBe([
      "CONSIGNES EN VIGUEUR DE L'UTILISATEUR (ordres permanents, liste complète et à jour : elle remplace toute liste vue avant ; valables après compactage ; « verrou » = le code refuse ce qu'il sait reconnaître) :",
      '1. Pas de push sans mon ordre [verrou : push]',
      '5. Réponds en français',
    ].join('\n'))
  })

  test('sans fichier, sans consigne active ou avec un fichier abîmé, le prompt reste celui du moteur', async ($, on) => {
    const { etat } = monde(on)
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
    etat.fichier = fichier([{ ...PUSH, actif: false }])
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
    etat.fichier = '{pas du json'
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })

  test('une entrée invalide du fichier est écartée, et un BOM en tête du fichier est toléré', async ($, on) => {
    const { etat } = monde(on, { fichier: `\uFEFF${fichier([PUSH, { id: 0, texte: 'sans identifiant valide' }, { id: 7, texte: '   ' }])}` })
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('1. Pas de push sans mon ordre [verrou : push]')
    expect(texte).not.toContain('sans identifiant valide')
    expect(texte.split('\n')).toHaveLength(2)
    expect(etat.statuts.at(-1)).toBe('Consignes : 1 active (1 verrouillée)')
  })

  test('une consigne en pause n est pas rappelée', async ($, on) => {
    monde(on, { fichier: fichier([PUSH, { ...TEXTE, actif: false }]) })
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('Pas de push sans mon ordre')
    expect(texte).not.toContain('Réponds en français')
  })

  test('le fichier est relu à chaque composition : une consigne ajoutée à la main apparaît tout de suite, avec la ligne de statut', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]) })
    await $.prompt.compose({ ...COMPOSE })
    expect(etat.statuts.at(-1)).toBe('Consignes : 1 active (1 verrouillée)')
    etat.fichier = fichier([PUSH, TEXTE])
    const r = await $.prompt.compose({ ...COMPOSE })
    expect(r.sections[1]?.text).toContain('5. Réponds en français')
    expect(etat.statuts.at(-1)).toBe('Consignes : 2 actives (1 verrouillée)')
  })

  test('le texte ne change pas d une composition à l autre : le prompt reste en cache', async ($, on) => {
    monde(on, { fichier: fichier([PUSH, TEXTE]) })
    const a = await $.prompt.compose({ ...COMPOSE })
    const b = await $.prompt.compose({ ...COMPOSE })
    expect(a.sections[1]?.text).toBe(b.sections[1]?.text)
  })

  test('sans consigne active, la ligne de statut est effacée', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([{ ...PUSH, actif: false }]) })
    await $.prompt.compose({ ...COMPOSE })
    expect(etat.statuts.at(-1)).toBeUndefined()
  })
})

describe('jetons {worktrees} et {plans}', () => {
  const WORKTREES: Consigne = { id: 1, texte: 'Travailler uniquement dans {worktrees}' }
  const PLANS: Consigne = { id: 2, texte: 'Les plans sont dans {plans}' }
  const reglages = (c: object) => JSON.stringify(c)

  test('sans config.json, la section dit (aucun) pour les worktrees et (non configuré) pour le dossier des plans : les valeurs par défaut', async ($, on) => {
    monde(on, { fichier: fichier([WORKTREES, PLANS]) })
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('1. Travailler uniquement dans (aucun)')
    expect(texte).toContain('2. Les plans sont dans (non configuré)')
    expect(texte).not.toContain('{')
  })

  test('changer config.json change la section à la composition suivante, sans toucher à consignes.json', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([WORKTREES, PLANS]) })
    await $.prompt.compose({ ...COMPOSE })
    etat.config = reglages({ worktrees: [{ nom: 'WA', chemin: 'C:/travail/wa' }], plans: { dossier: 'C:/travail/mes-plans' } })
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('1. Travailler uniquement dans WA (C:/travail/wa)')
    expect(texte).toContain('2. Les plans sont dans C:/travail/mes-plans')
    expect(etat.ecritures).toEqual([])
  })

  test('un config.json abîmé ou absent donne les défauts, une liste vide de worktrees se dit (aucun)', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([WORKTREES]), config: '{pas du json' })
    expect((await $.prompt.compose({ ...COMPOSE })).sections[1]?.text).toContain('Travailler uniquement dans (aucun)')
    etat.config = reglages({ worktrees: [] })
    expect((await $.prompt.compose({ ...COMPOSE })).sections[1]?.text).toContain('1. Travailler uniquement dans (aucun)')
    etat.config = `\uFEFF${reglages({ worktrees: [{ nom: 'B', chemin: 'C:/travail/b' }] })}`
    expect((await $.prompt.compose({ ...COMPOSE })).sections[1]?.text).toContain('dans B (C:/travail/b)')
  })

  test('la raison d un refus de commande ou d agent cite les valeurs courantes', async ($, on) => {
    monde(on, {
      fichier: fichier([{ id: 1, texte: 'Pas de push dans {worktrees}', verrou: 'push' }, { id: 2, texte: 'Aucun agent hors de {plans}', verrou: 'agent' }]),
      config: reglages({ worktrees: [{ nom: 'WA', chemin: 'C:/travail/wa' }], plans: { dossier: 'C:/travail/mes-plans' } }),
    })
    expect((await shell($, 'Bash', 'git push')).deny).toContain('« Pas de push dans WA (C:/travail/wa) »')
    expect((await lancement($)).deny).toContain('« Aucun agent hors de C:/travail/mes-plans »')
  })

  test('les réglages ne sont lus que pour un refus : une commande ou un agent autorisé ne les lit pas', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]) })
    await shell($, 'Bash', 'ls')
    await shell($, 'PowerShell', 'Get-Date')
    await lancement($)
    expect(etat.lecturesConfig).toBe(0)
    await shell($, 'Bash', 'git push')
    expect(etat.lecturesConfig).toBe(1)
    etat.fichier = fichier([AGENT])
    await lancement($)
    expect(etat.lecturesConfig).toBe(2)
  })

  test('la liste de /consignes cite les valeurs courantes, et ajouter n écrit pas config.json', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([WORKTREES]), config: reglages({ worktrees: [{ nom: 'WA', chemin: 'C:/travail/wa' }] }) })
    expect((await commande($, 'consignes', 'liste')).text).toContain('1. [actif] Travailler uniquement dans WA (C:/travail/wa)')
    await commande($, 'consignes', 'ajouter Les plans sont dans {plans}')
    expect(etat.ecritures.every(e => e.path === FICHIER)).toBe(true)
    expect(JSON.parse(etat.fichier ?? '{}').consignes.at(-1).texte).toBe('Les plans sont dans {plans}')
  })
})

describe('refus des commandes', () => {
  for (const outil of ['Bash', 'PowerShell'] as const) {
    test(`${outil} : git push est refusé avec la consigne, son texte et la façon de la lever, et rien ne s exécute`, async ($, on) => {
      const { etat } = monde(on, { fichier: fichier([PUSH]) })
      const r = await shell($, outil, 'git push origin main')
      expect(r.deny).toBeDefined()
      expect(r.deny).toMatch(/Consigne 1 de l'utilisateur \(« Pas de push sans mon ordre »\), verrou push/)
      expect(r.deny).toContain('/consignes pause 1')
      expect(etat.executees).toEqual([])
    })

    test(`${outil} : une commande ordinaire s exécute`, async ($, on) => {
      const { etat } = monde(on, { fichier: fichier([PUSH, DEPLOIEMENT, REBUILD]) })
      const r = await shell($, outil, 'git status')
      expect(r.deny).toBeUndefined()
      expect(etat.executees).toEqual(['git status'])
    })
  }

  test('déploiement et rebuild sont refusés par leur verrou', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([DEPLOIEMENT, REBUILD]) })
    expect((await shell($, 'Bash', 'vercel --prod')).deny).toMatch(/Consigne 2 de l'utilisateur .*verrou deploiement/)
    expect((await shell($, 'Bash', './gradlew assembleRelease')).deny).toMatch(/Consigne 3 de l'utilisateur .*verrou rebuild/)
    expect((await shell($, 'PowerShell', 'eas build --platform android')).deny).toMatch(/Consigne 3 de l'utilisateur/)
    expect(etat.executees).toEqual([])
  })

  test('chaque verrou ne refuse que sa famille de commandes', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]) })
    expect((await shell($, 'Bash', 'vercel --prod')).deny).toBeUndefined()
    expect((await shell($, 'Bash', './gradlew assembleRelease')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['vercel --prod', './gradlew assembleRelease'])
  })

  test('une consigne en pause, sans verrou ou avec le verrou agent ne refuse aucune commande', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([{ ...PUSH, actif: false }, { ...TEXTE, id: 6 }, AGENT]) })
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['git push'])
  })

  test('sans fichier ou avec un fichier abîmé, rien n est refusé', async ($, on) => {
    const { etat } = monde(on)
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    etat.fichier = '{pas du json'
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['git push', 'git push'])
  })

  test('le fichier est relu à chaque appel : un verrou posé à la main refuse l appel suivant, et sa pause le rend', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([{ ...PUSH, verrou: null }]) })
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    etat.fichier = fichier([PUSH])
    expect((await shell($, 'Bash', 'git push')).deny).toBeDefined()
    etat.fichier = fichier([{ ...PUSH, actif: false }])
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['git push', 'git push'])
  })

  test('les outils qui ne sont pas un shell ne sont pas concernés', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]) })
    const r = await $.tool.call({ tool: 'Edit', file_path: 'C:/x/a.txt', old_string: 'a', new_string: 'git push' } as never)
    expect(r.deny).toBeUndefined()
    expect(etat.executees).toHaveLength(1)
  })
})

describe('refus des nouveaux agents', () => {
  test('avec le verrou agent, le lancement est refusé avec la consigne et rien ne démarre', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([AGENT]) })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Consigne 4 de l'utilisateur \(« Aucun nouvel agent cette nuit »\), verrou agent/)
    expect(r.deny).toContain('/consignes pause 4')
    expect(etat.lancements).toBe(0)
  })

  test('sans fichier, en pause, sans verrou ou avec un autre verrou, le lancement est autorisé', async ($, on) => {
    const { etat } = monde(on)
    expect((await lancement($)).deny).toBeUndefined()
    etat.fichier = fichier([{ ...AGENT, actif: false }])
    expect((await lancement($)).deny).toBeUndefined()
    etat.fichier = fichier([TEXTE, PUSH, DEPLOIEMENT, REBUILD])
    expect((await lancement($)).deny).toBeUndefined()
    etat.fichier = '{pas du json'
    expect((await lancement($)).deny).toBeUndefined()
    expect(etat.lancements).toBe(4)
  })
})

describe('commande /consignes', () => {
  const ecrit = (etat: { ecritures: { text: string }[] }) => JSON.parse(etat.ecritures.at(-1)?.text ?? '{}')

  test('sans fichier, la liste dit qu il n y a aucune consigne et n écrit rien', async ($, on) => {
    const { etat } = monde(on)
    const r = await commande($, 'consignes', '')
    expect(r.text).toMatch(/^Aucune consigne en vigueur/)
    expect(etat.ecritures).toEqual([])
  })

  test('la liste montre l état, le texte et le verrou de chaque consigne, sans rien écrire', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH, { ...TEXTE, actif: false }]) })
    const r = await commande($, 'consignes', 'liste')
    expect(r.text).toBe('Consignes en vigueur : 1 active sur 2.\n1. [actif] Pas de push sans mon ordre [verrou : push]\n5. [pause] Réponds en français')
    expect(etat.ecritures).toEqual([])
  })

  test('ajouter crée le fichier avec la consigne, le prochain identifiant et la date, puis met la ligne de statut à jour', async ($, on) => {
    const { etat } = monde(on)
    const r = await commande($, 'consignes', 'ajouter Uniquement les worktrees suivis')
    expect(r.text).toBe('Consigne 1 ajoutée.')
    expect(etat.ecritures).toHaveLength(1)
    expect(etat.ecritures[0]?.path).toBe(FICHIER)
    expect(ecrit(etat)).toEqual({ prochain: 2, consignes: [{ id: 1, texte: 'Uniquement les worktrees suivis', actif: true, verrou: null }], maj: '2026-03-03T12:00:00.000Z' })
    expect(etat.statuts.at(-1)).toBe('Consignes : 1 active (0 verrouillée)')
  })

  test('verrou, pause, reprendre et retirer changent le fichier et la ligne de statut', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([{ id: 1, texte: 'Pas de push' }, TEXTE], 6) })
    expect((await commande($, 'consignes', 'verrou 1 push')).text).toBe('Consigne 1 : verrou push.')
    expect(ecrit(etat).consignes[0]).toEqual({ id: 1, texte: 'Pas de push', actif: true, verrou: 'push' })
    expect(etat.statuts.at(-1)).toBe('Consignes : 2 actives (1 verrouillée)')
    expect((await commande($, 'consignes', 'pause 1')).text).toMatch(/^Consigne 1 en pause/)
    expect(ecrit(etat).consignes[0].actif).toBe(false)
    expect(etat.statuts.at(-1)).toBe('Consignes : 1 active (0 verrouillée)')
    expect((await commande($, 'consignes', 'reprendre 1')).text).toBe('Consigne 1 reprise.')
    expect(ecrit(etat).consignes[0].actif).toBe(true)
    expect((await commande($, 'consignes', 'retirer 5')).text).toBe('Consigne 5 retirée.')
    expect(ecrit(etat).consignes.map((c: { id: number }) => c.id)).toEqual([1])
    expect(ecrit(etat).prochain).toBe(6)
    expect((await commande($, 'consignes', 'verrou 1 aucun')).text).toBe('Consigne 1 : verrou retiré.')
    expect(ecrit(etat).consignes[0].verrou).toBeNull()
  })

  test('un verrou posé par la commande refuse tout de suite la commande suivante', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([{ id: 1, texte: 'Pas de push' }]) })
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    await commande($, 'consignes', 'verrou 1 push')
    expect((await shell($, 'Bash', 'git push')).deny).toBeDefined()
    await commande($, 'consignes', 'pause 1')
    expect((await shell($, 'Bash', 'git push')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['git push', 'git push'])
  })

  test('une saisie invalide rend l aide ou l erreur et n écrit rien', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]) })
    expect((await commande($, 'consignes', 'xyz')).text).toMatch(/^Usage : \/consignes/)
    expect((await commande($, 'consignes', 'retirer 99')).text).toMatch(/^Consigne 99 introuvable/)
    expect((await commande($, 'consignes', 'ajouter')).text).toMatch(/^Texte manquant/)
    expect(etat.ecritures).toEqual([])
  })

  test('une commande sans effet (rien ne change) n écrit rien', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]) })
    await commande($, 'consignes', 'reprendre 1')
    await commande($, 'consignes', 'verrou 1 push')
    expect(etat.ecritures).toEqual([])
  })

  test('une écriture qui échoue est dite à l utilisateur, et rien ne change', async ($, on) => {
    const { etat } = monde(on, { fichier: fichier([PUSH]), ecritureEchoue: true })
    const r = await commande($, 'consignes', 'ajouter Une de plus')
    expect(r.text).toMatch(/^Écriture impossible dans C:\/travail\/cockpit\/consignes\.json \(.*disque plein.*\) : rien n'a changé\.$/)
    expect(etat.fichier).toBe(fichier([PUSH]))
    expect(etat.statuts.at(-1)).not.toBe('Consignes : 2 actives (1 verrouillée)')
  })

  test('un fichier illisible n est jamais écrasé : la commande le dit et ne touche à rien', async ($, on) => {
    const { etat } = monde(on, { fichier: '{pas du json' })
    for (const args of ['', 'liste', 'ajouter x', 'retirer 1', 'verrou 1 push']) {
      const r = await commande($, 'consignes', args)
      expect(r.text).toBe(`${FICHIER} est illisible : corrige-le ou supprime-le, puis recommence (rien n'a été écrit).`)
    }
    expect(etat.ecritures).toEqual([])
    expect(etat.fichier).toBe('{pas du json')
  })
})
