import { describe, expect, mock as moquerie, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { INSTANTANE, INSTANTANE_PAUSE } from './fixture'

// Chaque test attend la fin des mesures de fond avant de rendre la main : une mesure encore en vol toucherait l'état
// d'une mod déjà déchargée (rejet « $.state.get refused ... no hooks module » constaté de façon intermittente).
let derniereHorloge: ReturnType<typeof moquerie.clock> | null = null
const mock = { clock: (on: On, options?: { now?: number }) => (derniereHorloge = moquerie.clock(on, options)) }
// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) =>
  testMoteur(nom, { timeoutMs: 30_000 }, async ($, on) => {
    derniereHorloge = null
    await corps($, on)
    const horloge = derniereHorloge as ReturnType<typeof moquerie.clock> | null // le corps du test l'a peut-être renseignée
    if (horloge !== null) {
      await horloge.settle()
      await horloge.settle()
    }
  })

// Le dossier du plugin que le moteur de test donne au module par AML_PLUGIN_DIR (emplacements-logique.mjs) : le script du noyau en est scripts/cockpit.js.
const ENV = { AML_PLUGIN_DIR: 'C:/outils/ledger' }
const CLI = 'C:/outils/ledger/scripts/cockpit.js'
const DEBUT = Date.parse('2026-03-02T20:00:12.000Z')
const BANDE = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const PANNEAU = { title: 'Cockpit', isFocused: false, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const SURFACES = ['terminal', 'desktop'] as const
// Le moteur de test remplit lui-même ce que l'appel laisse de côté (origine, présentation) : on le dit au typage.
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)

const sortie = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Reponse = ReturnType<typeof sortie>

type NoeudDessine = { type: string; props?: Record<string, unknown>; children?: unknown[] }

// Le nœud qui contient directement le texte donné dans l'arbre dessiné par le panneau.
const parentDuTexte = (n: NoeudDessine, texte: string): NoeudDessine | undefined => {
  for (const c of n.children ?? []) {
    if (typeof c !== 'object' || c === null) continue
    const fils = c as NoeudDessine
    if (fils.type === 'Text' && (fils.children ?? []).includes(texte)) return n
    const dedans = parentDuTexte(fils, texte)
    if (dedans !== undefined) return dedans
  }

  return undefined
}

// Le bas de la chaîne : ce que le moteur répond quand la mod passe la main avec next(e).
function moteur(on: On) {
  moquerie.env(on, ENV)
  const commandes: string[] = []
  const specs: Record<string, { description: string; argumentHint?: string }> = {}
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    commandes.push(e.name)
    specs[e.name] = { description: e.description, argumentHint: e.argumentHint }
    return { value: { command: e.name } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  return { commandes, specs }
}

// Le noyau simulé : ce que `node cockpit.js <commande>` répondrait, appel par appel.
function noyau(on: On, reponse: (commande: string) => Reponse | Promise<Reponse>) {
  const { commandes, specs } = moteur(on)
  const appels: string[][] = []
  const delais: Record<string, number | undefined> = {}
  on('process.run', (_$, e) => {
    appels.push([...e.argv])
    delais[e.argv[2] ?? ''] = e.init?.timeoutMs
    return reponse(e.argv[2] ?? '')
  })
  const compter = (commande: string) => appels.filter(a => a[2] === commande).length
  return { appels, compter, commandes, specs, delais }
}

const normal = (commande: string): Reponse =>
  commande === 'instantane' ? sortie(JSON.stringify(INSTANTANE)) : sortie('git : 2 dépôts mesurés\n')

const demarrer = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: 'C:/travail', surface: 'terminal', isInteractive: true })

describe('bande au-dessus du prompt', () => {
  test('montre la ligne du noyau et un bouton Détail, sur terminal et desktop', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'AbovePrompt', props: BANDE })
      expect(await ui.find({ type: 'Text', text: /^Cockpit \| ledger 2 ouvertes, 1 bloquée/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'detail' })).toBeDefined()
      await ui.unmount()
    }
    expect(n.appels[0]).toEqual(['node', CLI, 'instantane', '--json'])
  })

  test('la ligne tient sur une seule rangée, tronquée au bord, et reste discrète', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'AbovePrompt', props: BANDE })
      const ligne = await ui.find({ type: 'Text', text: /^Cockpit \|/ })
      expect(ligne?.props.wrap).toBe('truncate-end')
      expect(ligne?.props.dimColor).toBe(true)
      await ui.unmount()
    }
  })

  test('chaque appel au noyau a son délai : 20 secondes pour la mesure, 3 minutes pour git', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    expect(n.delais.instantane).toBe(20_000)
    expect(n.delais['rafraichir-git']).toBe(180_000)
  })

  test('une raison d erreur trop longue est coupée à 160 caractères', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, c => (c === 'instantane' ? sortie('', 1, `${'x'.repeat(400)}`) : normal(c)))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect((await ui.find({ type: 'Text' }))?.text).toBe(`Cockpit indisponible : ${'x'.repeat(157)}...`)
    await ui.unmount()
  })

  test('un noyau muet en erreur est dit par son code de sortie', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, c => (c === 'instantane' ? sortie('', 3, '') : normal(c)))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Cockpit indisponible : code de sortie 3')
    await ui.unmount()
  })

  test('dit que la mesure est en cours tant que le noyau n a pas répondu', async ($, on) => {
    mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'AbovePrompt', props: BANDE })
      expect(await ui.find({ type: 'Text', text: 'Cockpit : mesure en cours' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('cède la place à un sondage', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: { ...BANDE, hasSurvey: true } })
    expect(await ui.find({ key: 'detail' })).toBeUndefined()
    await ui.unmount()
  })

  test('dit pourquoi le noyau est indisponible, puis reprend à la mesure suivante', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    let panne = true
    noyau(on, c => (c === 'instantane' && panne ? sortie('', 1, 'boum du noyau') : normal(c)))
    await demarrer($)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'AbovePrompt', props: BANDE })
      expect(await ui.find({ type: 'Text', text: 'Cockpit indisponible : boum du noyau' })).toBeDefined()
      await ui.unmount()
    }
    panne = false
    await horloge.advance(30_000)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect(await ui.find({ type: 'Text', text: /^Cockpit \| ledger 2 ouvertes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /indisponible/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /mesure ancienne/ })).toBeUndefined()
    await ui.unmount()
  })

  test('une réponse illisible du noyau est dite, sans planter', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, c => (c === 'instantane' ? sortie('ceci n est pas du json') : normal(c)))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect(await ui.find({ type: 'Text', text: 'Cockpit indisponible : réponse illisible du noyau' })).toBeDefined()
    await ui.unmount()
  })

  test('un noyau qui ne démarre pas est dit avec sa cause', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    moteur(on)
    on('process.run', () => ({ deny: 'spawn node ENOENT' }))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^Cockpit indisponible : .*spawn node ENOENT$/)
    await ui.unmount()
  })

  test('garde la dernière mesure et signale la panne quand le noyau tombe après avoir répondu', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    let panne = false
    noyau(on, c => (c === 'instantane' && panne ? sortie('', 1, 'disque occupé') : normal(c)))
    await demarrer($)
    await horloge.settle()
    panne = true
    await horloge.advance(30_000)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect(await ui.find({ type: 'Text', text: /^Cockpit \| ledger 2 ouvertes.*\(mesure ancienne : disque occupé\)$/ })).toBeDefined()
    await ui.unmount()
  })
})

// Une mesure lancée « en l'air » peut finir quand la mod est déjà déchargée : l'écriture de l'état est alors refusée (« no hooks module of
// that name is loaded ») et la mesure rejette. Aucune ne doit laisser un rejet non géré (le runner le signale en fin de fichier).
// Le refus est simulé PENDANT le test : le rejet réel d'une mesure encore en vol à la fin du fichier dépend de la vitesse du runner, et
// chaque test attend déjà la fin des mesures de fond (voir le début de ce fichier), si bien que ce rejet n'arrive plus jamais seul.
describe('rejets des mesures de fond', () => {
  const modDechargee = (on: On) => {
    const etat = { refuse: false }
    on('state.set', (_$, e, next) => (etat.refuse ? ({ deny: 'refused: no hooks module of that name is loaded' } as never) : next(e)))
    return etat
  }

  test('au démarrage, la mesure et la mesure git lancées par la session', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    modDechargee(on).refuse = true
    await demarrer($)
    await horloge.settle()
  })

  test('à chaque tour du minuteur', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    const mod = modDechargee(on)
    await demarrer($)
    await horloge.settle()
    mod.refuse = true
    await horloge.advance(30_000)
    await horloge.settle()
  })

  test('au bouton Rafraîchir, la mesure git lancée en fond', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    const mod = modDechargee(on)
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    mod.refuse = true
    await ui.press({ key: 'rafraichir' }).catch(() => {})
    await horloge.settle()
    await ui.unmount()
  })

  test('après /cockpit config, la remesure lancée en fond', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    const mod = modDechargee(on)
    await demarrer($)
    await horloge.settle()
    mod.refuse = true
    expect((await commande($, 'cockpit', 'config afficher')).text).toBe('git : 2 dépôts mesurés')
    await horloge.settle()
  })
})

describe('mesures périodiques', () => {
  test('enregistre la commande /cockpit au démarrage de la session', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    expect(n.commandes).toEqual(['cockpit'])
  })

  test('mesure au démarrage puis toutes les 30 secondes, git au démarrage puis toutes les 5 minutes', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    expect(n.compter('instantane')).toBeGreaterThanOrEqual(1)
    expect(n.compter('rafraichir-git')).toBe(1)
    await horloge.advance(30_000)
    expect(n.compter('instantane')).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < 8; i++) await horloge.advance(30_000)
    expect(n.compter('rafraichir-git')).toBe(1)
    await horloge.advance(30_000)
    expect(n.compter('rafraichir-git')).toBe(2)
  })

  test('ne lance jamais deux mesures git en même temps', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, async c => {
      if (c === 'rafraichir-git') await horloge.sleep(6 * 60_000)
      return normal(c)
    })
    await demarrer($)
    await horloge.settle()
    for (let i = 0; i < 11; i++) await horloge.advance(30_000)
    expect(n.compter('rafraichir-git')).toBe(1)
    await horloge.advance(30_000)
    await horloge.advance(300_000)
    expect(n.compter('rafraichir-git')).toBe(2)
    await horloge.settle()
  })

  test('relit la mesure dès que la mesure git est terminée', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, async c => {
      if (c === 'rafraichir-git') await horloge.sleep(10_000)
      return normal(c)
    })
    await demarrer($)
    await horloge.settle()
    expect(n.compter('instantane')).toBe(1)
    await horloge.advance(10_000)
    expect(n.compter('instantane')).toBe(2)
  })
})

describe('panneau', () => {
  test('groupe les sections du noyau par vue sur terminal et desktop', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: PANNEAU })
      await ui.select({ key: 'vue', value: 'apercu' })
      for (const titre of ['Mesure', 'Ledger', 'Agents', 'Nuit', 'Quota']) {
        expect(await ui.find({ type: 'Text', text: new RegExp(`^${titre}$`) }), titre).toBeDefined()
      }
      expect(await ui.find({ type: 'Text', text: 'inactive, rien à décider en boîte' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'bloquée : P1/C-0003 : attend la décision de l\'utilisateur sur le push' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'échoué : C (failed) ligne P1/C-0012' })).toBeDefined()
      await ui.select({ key: 'vue', value: 'agents' })
      expect(await ui.find({ type: 'Text', text: "aucun agent en file d'attente" })).toBeDefined()
      await ui.select({ key: 'vue', value: 'projets' })
      expect(await ui.find({ type: 'Text', text: '  contre son distant : +15' })).toBeDefined()
      await ui.select({ key: 'vue', value: 'plans' })
      expect(await ui.find({ type: 'Text', text: 'A.md : 2 restantes (1/3)' })).toBeDefined()
      await ui.select({ key: 'vue', value: 'reglages' })
      expect(await ui.find({ type: 'Text', text: 'Worktrees suivis : 2/8' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rafraichir' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('le bouton Rafraîchir relance la mesure et la mesure git', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.press({ key: 'rafraichir' })
    await horloge.settle()
    expect(n.compter('instantane')).toBeGreaterThanOrEqual(2)
    expect(n.compter('rafraichir-git')).toBe(2)
    await ui.unmount()
  })

  test('quand le noyau tombe après une mesure, le panneau garde les sections et dit que la mesure est ancienne', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    let panne = false
    noyau(on, c => (c === 'instantane' && panne ? sortie('', 1, 'disque occupé') : normal(c)))
    await demarrer($)
    await horloge.settle()
    panne = true
    await horloge.advance(30_000)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    expect(await ui.find({ type: 'Text', text: 'mesure ancienne : disque occupé' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ledger' })).toBeDefined()
    await ui.unmount()
  })

  test('sans mesure, le panneau le dit', async ($, on) => {
    mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    expect(await ui.find({ type: 'Text', text: 'Cockpit : mesure en cours' })).toBeDefined()
    await ui.unmount()
  })
})

// Les boutons de la section Pause : chacun lance `cockpit.js pause|reprendre ...` (le noyau contrôle et écrit), dit le résultat par un toast,
// puis relance la mesure pour que le panneau suive.
describe('boutons de la pause dans le panneau', () => {
  // Les réponses du noyau par commande : une valeur, ou une fonction relue à chaque appel (le test la change en cours de route). Sans entrée,
  // l'instantané porte la pause de la fixture et les autres commandes répondent comme d'ordinaire.
  type Table = Record<string, Reponse | (() => Reponse)>
  const monterPanneau = async ($: Engine, on: On, table: Table = {}) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, c => {
      const r = table[c]
      if (r !== undefined) return typeof r === 'function' ? r() : r

      return c === 'instantane' ? sortie(JSON.stringify(INSTANTANE_PAUSE)) : normal(c)
    })
    const toasts: string[] = []
    on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
    await demarrer($)
    await horloge.settle()
    return { horloge, n, toasts }
  }

  test('montre Tout mettre en pause, Tout reprendre, un bouton par session et par agent, sur terminal et desktop', async ($, on) => {
    await monterPanneau($, on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: PANNEAU })
      await ui.select({ key: 'vue', value: 'agents' })
      expect(await ui.find({ type: 'Text', text: '2 sessions ouvertes, 1 en pause, 2 agents arrêtés' }), surface).toBeDefined()
      for (const [cle, libelle] of [
        ['pause-tout', 'Tout mettre en pause'],
        ['reprendre-tout', 'Tout reprendre'],
        ['reprendre-session-aaaa1111-2222-3333', 'Reprendre'],
        ['pause-session-bbbb2222-3333-4444', 'Pause'],
        ['pause-agent-bbbb2222-3333-4444-ag-2', 'Pause'],
        ['reprendre-agent-bbbb2222-3333-4444-ag-3', 'Reprendre'],
      ] as const) {
        expect((await ui.find({ type: 'Button', key: cle }))?.props.label, `${surface} ${cle}`).toBe(libelle)
      }
      expect(await ui.find({ type: 'Button', key: 'pause-agent-aaaa1111-2222-3333-ag-1' }), 'un agent arrêté par sa session n a pas de bouton').toBeUndefined()
      await ui.unmount()
    }
  })

  test('sans pause dans la mesure, le panneau ne montre aucun bouton de pause', async ($, on) => {
    await monterPanneau($, on, { instantane: sortie(JSON.stringify(INSTANTANE)) })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    expect(await ui.find({ type: 'Text', text: 'aucune session ouverte' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'pause-tout' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'reprendre-tout' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Pause' })).toBeDefined()
    await ui.unmount()
  })

  test('les autres sections se dessinent comme avant : un texte seul, sans bouton', async ($, on) => {
    await monterPanneau($, on)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(7) // Rafraîchir, deux boutons du compte, deux sessions, deux agents
    expect(await ui.find({ type: 'Text', text: 'aucun agent en file d\'attente' })).toBeDefined()
    // Une ligne sans bouton est un texte posé directement dans la section (une colonne), sans boîte de ligne autour.
    const arbre = (await ui.drawn()) as unknown as NoeudDessine
    expect(parentDuTexte(arbre, 'aucun agent en file d\'attente')?.props?.flexDirection).toBe('column')
    await ui.unmount()
  })

  test('Tout mettre en pause lance « pause tout », dit le résultat par un toast et relance la mesure', async ($, on) => {
    const { horloge, n, toasts } = await monterPanneau($, on, { pause: sortie('Pause : tout est en pause (2 sessions, leurs agents avec).\n') })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    const avant = n.compter('instantane')
    const avantGit = n.compter('rafraichir-git')
    await ui.press({ key: 'pause-tout' })
    await horloge.settle()
    expect(n.appels.filter(a => a[2] === 'pause')).toEqual([['node', CLI, 'pause', 'tout']])
    expect(n.delais.pause).toBe(20_000)
    expect(toasts).toEqual(['Pause : tout est en pause (2 sessions, leurs agents avec).'])
    expect(n.compter('instantane')).toBeGreaterThan(avant)
    expect(n.compter('rafraichir-git'), 'la pause ne relance pas la mesure git, lente').toBe(avantGit)
    await ui.unmount()
  })

  test('Tout reprendre lance « reprendre tout »', async ($, on) => {
    const { horloge, n, toasts } = await monterPanneau($, on, { reprendre: sortie('Reprise : tout reprend (1 session reprise).\n') })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    await ui.press({ key: 'reprendre-tout' })
    await horloge.settle()
    expect(n.appels.filter(a => a[2] === 'reprendre')).toEqual([['node', CLI, 'reprendre', 'tout']])
    expect(toasts).toEqual(['Reprise : tout reprend (1 session reprise).'])
    await ui.unmount()
  })

  test('les boutons d une session et d un agent désignent la session par son identifiant complet', async ($, on) => {
    const { horloge, n } = await monterPanneau($, on, { pause: sortie('ok\n'), reprendre: sortie('ok\n') })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    await ui.press({ key: 'reprendre-session-aaaa1111-2222-3333' })
    await ui.press({ key: 'pause-session-bbbb2222-3333-4444' })
    await ui.press({ key: 'pause-agent-bbbb2222-3333-4444-ag-2' })
    await ui.press({ key: 'reprendre-agent-bbbb2222-3333-4444-ag-3' })
    await horloge.settle()
    expect(n.appels.filter(a => a[2] === 'pause' || a[2] === 'reprendre')).toEqual([
      ['node', CLI, 'reprendre', '--session', 'aaaa1111-2222-3333'],
      ['node', CLI, 'pause', '--session', 'bbbb2222-3333-4444'],
      ['node', CLI, 'pause', '--session', 'bbbb2222-3333-4444', 'agent', 'ag-2'],
      ['node', CLI, 'reprendre', '--session', 'bbbb2222-3333-4444', 'agent', 'ag-3'],
    ])
    await ui.unmount()
  })

  test('une erreur du noyau est dite par le toast, avec ou sans message, et la mesure est relancée quand même', async ($, on) => {
    let reponse: Reponse = sortie('', 2, 'Cette session n\'est pas dans l\'état de la pause.\n')
    const { horloge, n, toasts } = await monterPanneau($, on, { pause: () => reponse })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    const avant = n.compter('instantane')
    await ui.press({ key: 'pause-tout' })
    reponse = sortie('', 1, '')
    await ui.press({ key: 'pause-tout' })
    await horloge.settle()
    expect(toasts).toEqual(['Cette session n\'est pas dans l\'état de la pause.', 'Pause : code de sortie 1'])
    expect(n.compter('instantane')).toBeGreaterThan(avant)
    await ui.unmount()
  })

  test('un noyau qui ne démarre pas est dit avec sa cause', async ($, on) => {
    const { horloge, toasts } = await monterPanneau($, on, { pause: () => ({ deny: 'spawn node ENOENT' }) as never })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    await ui.press({ key: 'pause-tout' })
    await horloge.settle()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/^Pause : .*spawn node ENOENT$/)
    expect(toasts[0], 'le message de l\'erreur, sans le nom de sa classe').not.toContain('Error:')
    await ui.unmount()
  })
})

describe('configuration depuis le panneau', () => {
  test('enregistre le modèle global et un héritage exact par type', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, c => c === 'config' ? sortie('Réglage enregistré.\n') : normal(c))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'reglages' })
    expect((await ui.find({ type: 'Select', key: 'modele-global' }))?.props.value).toBe('sonnet')
    await ui.select({ key: 'modele-global', value: 'opus' })
    await ui.press({ key: 'sauver-modele-global' })
    await ui.select({ key: 'type-existant', value: 'Explore' })
    await ui.select({ key: 'modele-type', value: 'heritage' })
    await ui.press({ key: 'sauver-modele-type' })
    expect(n.appels.filter(a => a[2] === 'config')).toEqual([
      ['node', CLI, 'config', 'modeles', 'defaut', 'opus'],
      ['node', CLI, 'config', 'modeles', 'type', 'Explore', 'heritage'],
    ])
    await ui.unmount()
  })

  test('valide le modèle personnalisé avant tout appel au CLI', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, normal)
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'reglages' })
    await ui.select({ key: 'modele-global', value: 'personnalise' })
    await ui.input({ key: 'modele-global-perso', text: 'identifiant invalide', kind: 'change' })
    await ui.press({ key: 'sauver-modele-global' })
    expect(n.compter('config')).toBe(0)
    await ui.unmount()
  })

  test('ajoute, met à jour et retire du suivi après confirmation sans supprimer de dossier', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const n = noyau(on, c => c === 'config' ? sortie('Réglage enregistré.\n') : normal(c))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'reglages' })
    await ui.input({ key: 'worktree-nom', text: 'NOUVEAU', kind: 'change' })
    await ui.input({ key: 'worktree-chemin', text: 'C:/travail/infra', kind: 'change' })
    await ui.press({ key: 'sauver-worktree' })
    await ui.select({ key: 'worktree', value: 'WB' })
    await ui.input({ key: 'worktree-chemin', text: 'C:/travail/nouveau', kind: 'change' })
    await ui.press({ key: 'sauver-worktree' })
    await ui.press({ key: 'demander-retrait' })
    await ui.press({ key: 'annuler-retrait' })
    expect(n.appels.filter(a => a[2] === 'config' && a[4] === 'retirer')).toHaveLength(0)
    await ui.press({ key: 'demander-retrait' })
    await ui.press({ key: 'confirmer-retrait' })
    expect(n.appels.filter(a => a[2] === 'config')).toEqual([
      ['node', CLI, 'config', 'worktree', 'ajouter', 'NOUVEAU', 'C:/travail/infra'],
      ['node', CLI, 'config', 'worktree', 'ajouter', 'WB', 'C:/travail/nouveau'],
      ['node', CLI, 'config', 'worktree', 'retirer', 'WB'],
    ])
    expect(n.appels.some(a => a.includes('rm') || a.includes('Remove-Item'))).toBe(false)
    await ui.unmount()
  })

  test('au plafond 8/8, ne propose pas un neuvième ajout', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    const limite = { ...INSTANTANE, config: { ...INSTANTANE.config!, worktrees: Array.from({ length: 8 }, (_, i) => ({ nom: `W${i}`, chemin: `C:/travail/w${i}` })) } }
    noyau(on, c => c === 'instantane' ? sortie(JSON.stringify(limite)) : normal(c))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'reglages' })
    expect(await ui.find({ type: 'Text', text: 'Worktrees suivis : 8/8' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'sauver-worktree' })).toBeUndefined()
    await ui.unmount()
  })

  test('une sélection supprimée ailleurs ne devient pas un nouvel ajout implicite', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    let mesure = INSTANTANE
    const n = noyau(on, c => c === 'instantane' ? sortie(JSON.stringify(mesure)) : normal(c))
    await demarrer($)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'reglages' })
    await ui.select({ key: 'worktree', value: 'WB' })
    mesure = { ...INSTANTANE, config: { ...INSTANTANE.config!, worktrees: [INSTANTANE.config!.worktrees[0]!] } }
    await ui.press({ key: 'rafraichir' })
    await horloge.settle()
    await ui.press({ key: 'sauver-worktree' })
    expect(n.compter('config')).toBe(0)
    await ui.unmount()
  })
})

describe('ouverture du panneau', () => {
  test('le bouton Détail de la bande ouvre le panneau cockpit', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    const ouverts: string[] = []
    on('ui.open', (_$, e) => { ouverts.push(e.id); return { value: { isPlaced: true as const } } })
    await demarrer($)
    await horloge.settle()
    const ouvertsAuDemarrage = ouverts.length
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    await ui.press({ key: 'detail' })
    expect(ouverts.slice(ouvertsAuDemarrage)).toEqual(['cockpit'])
    await ui.unmount()
  })

  test('la commande /cockpit ouvre le panneau et répond par la ligne du noyau', async ($, on) => {
    const horloge = mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    const ouverts: string[] = []
    on('ui.open', (_$, e) => { ouverts.push(e.id); return { value: { isPlaced: true as const } } })
    await demarrer($)
    await horloge.settle()
    const avant = ouverts.length
    const r = await commande($, 'cockpit')
    expect(ouverts.slice(avant)).toEqual(['cockpit'])
    expect(r.text).toMatch(/^Cockpit \| ledger 2 ouvertes, 1 bloquée/)
  })

  describe('réglages : /cockpit config', () => {
    test('affiche les réglages par le noyau, sans ouvrir le panneau', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const n = noyau(on, c => (c === 'config' ? sortie('Réglages du Cockpit.\nWorktrees mesurés (2) : WA C:/travail/a ; WB C:/travail/b\n') : normal(c)))
      const ouverts: string[] = []
      on('ui.open', (_$, e) => { ouverts.push(e.id); return { value: { isPlaced: true as const } } })
      await demarrer($)
      await horloge.settle()
      const avant = ouverts.length
      const r = await commande($, 'cockpit', 'config')
      expect(r.text).toBe('Réglages du Cockpit.\nWorktrees mesurés (2) : WA C:/travail/a ; WB C:/travail/b')
      expect(ouverts.length).toBe(avant)
      expect(n.appels.filter(a => a[2] === 'config')).toEqual([['node', CLI, 'config']])
    })

    test('passe les arguments tels quels au noyau, avec le délai de la mesure, puis relit la mesure', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const n = noyau(on, c => (c === 'config' ? sortie('Worktree T ajouté : C:/travail/x.\n') : normal(c)))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      const avant = n.compter('instantane')
      const avantGit = n.compter('rafraichir-git')
      const r = await commande($, 'cockpit', 'config worktree ajouter T C:/travail/x')
      await horloge.settle()
      expect(r.text).toBe('Worktree T ajouté : C:/travail/x.')
      expect(n.appels.filter(a => a[2] === 'config')).toEqual([['node', CLI, 'config', 'worktree', 'ajouter', 'T', 'C:/travail/x']])
      expect(n.delais.config).toBe(20_000)
      expect(n.compter('instantane')).toBeGreaterThan(avant)
      expect(n.compter('rafraichir-git')).toBe(avantGit + 1) // un worktree ajouté n'est mesuré que par la mesure git
    })

    test('la réponse vient tout de suite : elle n attend pas la fin des mesures relancées', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      let bloquer = false
      let liberer = () => {}
      const attente = new Promise<void>(fin => { liberer = fin })
      noyau(on, async c => {
        if (c !== 'config' && bloquer) await attente
        return c === 'config' ? sortie('Dossier des plans changé.\n') : normal(c)
      })
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      bloquer = true
      // Le moteur de test lâche de lui-même, au bout de 10 s, une mesure qui ne répond jamais : une commande qui attendrait la mesure
      // finirait donc après ces 10 s, et non au bout de quelques millisecondes.
      const debut = Date.now()
      try {
        expect((await commande($, 'cockpit', 'config plans C:/x')).text).toBe('Dossier des plans changé.')
      } finally {
        liberer()
      }
      expect(Date.now() - debut).toBeLessThan(5_000)
      await horloge.settle()
    })

    test('une erreur longue du noyau (l usage, par exemple) est rendue en entier, sans être coupée', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const longue = `Usage : ${'cockpit config [afficher | worktree ajouter <nom> <chemin>] '.repeat(5).trim()}`
      noyau(on, c => (c === 'config' ? sortie('', 2, `${longue}\n`) : normal(c)))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      const r = await commande($, 'cockpit', 'config xyz')
      expect(longue.length).toBeGreaterThan(200)
      expect(r.text).toBe(longue)
    })

    test('la liste des commandes dit que /cockpit config existe', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const n = noyau(on, normal)
      await demarrer($)
      await horloge.settle()
      expect(n.specs.cockpit?.description).toContain('/cockpit config')
      expect(n.specs.cockpit?.argumentHint).toBe('[config ...]')
    })

    test('une erreur du noyau est dite telle quelle, sans relire la mesure', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const n = noyau(on, c => (c === 'config' ? sortie('', 2, "Le dossier C:/travail/z n'existe pas.\n") : normal(c)))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      const avant = n.compter('instantane')
      const r = await commande($, 'cockpit', 'config plans C:/travail/z')
      await horloge.settle()
      expect(r.text).toBe("Le dossier C:/travail/z n'existe pas.")
      expect(n.compter('instantane')).toBe(avant)
    })

    test('un noyau qui ne répond pas est dit, sans planter', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      noyau(on, c => (c === 'config' ? sortie('', 3, '') : normal(c)))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      expect((await commande($, 'cockpit', 'config xyz')).text).toBe('Réglages : code de sortie 3')
    })

    test('le mot config est reconnu quelle que soit la casse, les autres mots gardent la leur', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const n = noyau(on, c => (c === 'config' ? sortie('Worktree Nouveau ajouté : C:/travail/Dossier.\n') : normal(c)))
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      const r = await commande($, 'cockpit', '  CONFIG   worktree  ajouter Nouveau   C:/travail/Dossier  ')
      await horloge.settle()
      expect(r.text).toBe('Worktree Nouveau ajouté : C:/travail/Dossier.')
      expect(n.appels.filter(a => a[2] === 'config')).toEqual([['node', CLI, 'config', 'worktree', 'ajouter', 'Nouveau', 'C:/travail/Dossier']])
    })

    test('un appel au noyau qui échoue est dit, sans planter ni relire la mesure', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      // Le moteur de test ne transmet pas le message d'une exception du noyau simulé : la mod reçoit son propre refus (« no implementation »).
      const n = noyau(on, c => {
        if (c === 'config') throw new Error('le noyau a disparu')
        return normal(c)
      })
      on('ui.open', () => ({ value: { isPlaced: true as const } }))
      await demarrer($)
      await horloge.settle()
      const avant = n.compter('instantane')
      const r = await commande($, 'cockpit', 'config')
      await horloge.settle()
      expect(r.text).toBe('Réglages : no implementation for process.run')
      expect(n.compter('instantane')).toBe(avant)
    })

    test('seul le mot config ouvre les réglages : tout autre argument garde le comportement d avant', async ($, on) => {
      const horloge = mock.clock(on, { now: DEBUT })
      const n = noyau(on, normal)
      const ouverts: string[] = []
      on('ui.open', (_$, e) => { ouverts.push(e.id); return { value: { isPlaced: true as const } } })
      await demarrer($)
      await horloge.settle()
      const avant = ouverts.length
      for (const args of ['', 'detail', 'configurer', 'x config']) {
        const r = await commande($, 'cockpit', args)
        expect(r.text).toMatch(/^Cockpit \| ledger/)
      }
      expect(ouverts.length - avant).toBe(4)
      expect(n.compter('config')).toBe(0)
    })
  })

  test('la commande /cockpit sans mesure le dit au lieu de planter', async ($, on) => {
    mock.clock(on, { now: DEBUT })
    noyau(on, normal)
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    const r = await commande($, 'cockpit')
    expect(r.text).toBe('Cockpit : mesure en cours')
  })
})
