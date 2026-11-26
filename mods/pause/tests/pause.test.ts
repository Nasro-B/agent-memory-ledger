import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

// Le dossier d'état du Cockpit et le dossier du plugin que le moteur de test donne au module par COCKPIT_DIR et AML_PLUGIN_DIR (emplacements-logique.mjs).
const DOSSIER = 'C:/travail/cockpit'
const ENV = { COCKPIT_DIR: DOSSIER, AML_PLUGIN_DIR: 'C:/outils/ledger' }
const CLI = 'C:/outils/ledger/scripts/cockpit.js'
const FICHIER_ETAT = `${DOSSIER}/pause.json`
const DEBUT = Date.parse('2026-03-04T05:00:00.000Z')
const MIN = 60 * 1000
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const BANDE = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const SURFACES = ['terminal', 'desktop'] as const
const PLAFOND_APPELS = 80
// Une mod qui redemande sans fin au noyau (une boucle dont la sortie est cassée) fait échouer l'étape ou l'outil en cours tout de suite :
// sans cela elle resterait suspendue sur un appel sans réponse jusqu'au délai du test. `monde` en prépare un neuf pour chaque test.
let emballement: Promise<never> = new Promise<never>(() => {})
let emballer: () => void = () => {}

const iso = (ms: number) => new Date(ms).toISOString()
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const sortie = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// Le fichier du noyau : la session S1 (le test) et S2 (une autre), chacune avec ses agents.
type Agent = { nom?: string; statut?: string; pause?: boolean; depuis?: string | null }
type Session = { titre?: string; pause?: boolean; depuis?: string | null; agents?: Record<string, Agent> }
const session = (extra: Session = {}) => ({ titre: 'atelier', vu: iso(DEBUT), pause: false, depuis: null, agents: {}, ...extra })
const enPause = (extra: Session = {}) => session({ pause: true, depuis: iso(DEBUT - 3 * MIN), ...extra })
const fichier = (sessions: Record<string, object>) => JSON.stringify({ sessions })

// Le moteur de test remplit lui-même ce que l'appel laisse de côté (origine, présentation, identifiants) : on le dit au typage.
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
// Le typage de `$.tool.call` (une union de tous les outils) est trop profond pour une entrée construite ici : on lui donne la forme utile.
const outil = ($: Engine, tool: string, extra: object = {}) =>
  Promise.race([($.tool as unknown as { call: (e: object) => Promise<{ deny?: string; text?: string }> }).call({ tool, ...extra }), emballement])

type Appel = { argv: string[]; operation: string; entree: Record<string, unknown>; delai: number | undefined }
type Reponse = unknown | ((entree: Record<string, unknown>) => unknown)

// Le monde simulé sous la mod : le fichier du noyau, le noyau lui-même (ses réponses par opération), ce que la mod montre, ce que le moteur
// exécute en bas de chaîne (les étapes du modèle et les outils que la pause retient ou laisse passer).
function monde(on: On, init: { fichier?: string | null; session?: string; cwd?: string } = {}) {
  const etat = {
    fichier: init.fichier ?? null,
    session: init.session ?? 'S1',
    cwd: init.cwd ?? 'C:/travail/projets/atelier',
    agents: [] as { id: string; name?: string; description: string; type: string; status: string }[],
    reponses: {} as Record<string, Reponse>,
    brut: null as string | null,
    code: 0,
    stderr: '',
    panne: false,
    sessionEnPanne: false,
    cwdEnPanne: false,
    agentsEnPanne: false,
    appels: [] as Appel[],
    etapes: [] as (string | undefined)[],
    executees: [] as { tool: string; agentId?: string }[],
    statuts: [] as (string | undefined)[],
    toasts: [] as string[],
    commandes: [] as { name: string; description: string; argumentHint?: string }[],
    dessous: null as string | null,
    lectures: 0,
  }
  emballement = new Promise<never>((_, rejeter) => {
    emballer = () => rejeter(new Error('la mod redemande au noyau sans fin (plafond d appels dépassé)'))
  })
  emballement.catch(() => {})
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, ENV)
  on('session.start', (_$, e) => ({ cwd: `bas de chaîne : ${e.cwd}` }))
  on('command.register', (_$, e) => {
    etat.commandes.push({ name: e.name, description: e.description, argumentHint: e.argumentHint })
    return { value: { command: e.name } }
  })
  on('session.id', () => (etat.sessionEnPanne ? { deny: 'session introuvable' } : { value: etat.session }))
  on('session.cwd', () => (etat.cwdEnPanne ? { deny: 'dossier introuvable' } : { value: etat.cwd }))
  on('agent.list', () => (etat.agentsEnPanne ? { deny: 'agents indisponibles' } : { value: etat.agents }) as never)
  on('fs.read', (_$, e) => {
    etat.lectures += 1
    if (normal(e.path) !== FICHIER_ETAT) return { deny: `chemin inattendu : ${e.path}` }
    return etat.fichier === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.fichier }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const stdin = e.init?.stdin
    const entree = stdin === undefined ? {} : (JSON.parse(stdin) as Record<string, unknown>)
    const operation = argv[3] ?? ''
    etat.appels.push({ argv, operation, entree, delai: e.init?.timeoutMs })
    // Une boucle qui redemande sans fin fait échouer l'étape ou l'outil en cours, et reste ici suspendue : la machine n'est pas monopolisée.
    if (etat.appels.length > PLAFOND_APPELS) {
      emballer()

      return new Promise<never>(() => {})
    }
    if (etat.panne) return { deny: 'spawn node ENOENT' }
    if (etat.brut !== null) return sortie(etat.brut, etat.code, etat.stderr)
    const r = etat.reponses[operation]
    const valeur = typeof r === 'function' ? (r as (entree: Record<string, unknown>) => unknown)(entree) : r
    if (valeur instanceof Promise) return valeur.then(v => sortie(JSON.stringify(v), etat.code, etat.stderr))
    return sortie(JSON.stringify(valeur ?? {}), etat.code, etat.stderr)
  })
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    etat.toasts.push(e.text)
    return { value: undefined }
  })
  // Ce que dessine un autre plugin sous la mod (le Cockpit), ou rien : la bande de la mod s'ajoute à lui.
  on('ui.render', () => (etat.dessous === null ? { type: 'Box', props: {}, children: [] } : { type: 'Text', props: {}, children: [etat.dessous] }))
  on('tool.call', (_$, e) => {
    etat.executees.push({ tool: e.tool, agentId: e.agentId })
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  // Le bas de la chaîne marque sa réponse : une étape que la mod retient n'arrive pas jusqu'ici.
  on('turn.step', async function* (_$, e) {
    etat.etapes.push(e.agentId)

    return { turnId: e.turnId, index: e.index, answer: 'réponse du modèle', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  const appelsDe = (operation: string) => etat.appels.filter(a => a.operation === operation)
  return { etat, horloge, appelsDe }
}

// Une étape du modèle (une requête) de la boucle principale, ou de celle d'un agent : le flux est lu jusqu'au bout, son résultat rendu
// (la valeur de retour du flux, que `for await` ne donne pas).
async function etape($: Engine, agentId?: string): Promise<{ answer: string }> {
  const flux = ($.turn as unknown as { step: (e: object) => AsyncGenerator<unknown, { answer: string }> }).step({
    turnId: 'tour-1',
    index: 0,
    model: 'm',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  const lire = async (): Promise<{ answer: string }> => {
    let suivant = await flux.next()
    while (suivant.done !== true) suivant = await flux.next()

    return suivant.value
  }

  return Promise.race([lire(), emballement])
}

// Une réponse du noyau que le test libère quand il le décide : l'attente d'une boucle retenue.
function retenue<T>() {
  let liberer!: (v: T) => void
  const promesse = new Promise<T>(resolve => {
    liberer = resolve
  })

  return { promesse, liberer }
}

type Noeud = { type: string; props?: Record<string, unknown>; children?: unknown[]; part?: { plugin: string } }

// Le nœud que le module a dessiné (celui que le moteur marque de son nom) dans l'arbre complet de la bande.
const boiteDuModule = (n: Noeud): Noeud | undefined =>
  n.part?.plugin === 'pause' ? n : (n.children ?? []).map(c => (typeof c === 'object' && c !== null ? boiteDuModule(c as Noeud) : undefined)).find(x => x !== undefined)

describe('démarrage', () => {
  test('enregistre /pause et /reprendre, et laisse le démarrage de session aux autres', async ($, on) => {
    const { etat } = monde(on)
    expect(await $.session.start(DEMARRAGE)).toEqual({ cwd: 'bas de chaîne : C:/x' })
    expect(etat.commandes.map(c => c.name)).toEqual(['pause', 'reprendre'])
    expect(etat.commandes[0]?.description).toMatch(/^Pause : retient cette session/)
    expect(etat.commandes[1]?.description).toMatch(/^Reprise : relance ce que \/pause a retenu/)
    for (const c of etat.commandes) expect(c.argumentHint).toBe('[tout | session [id] | agent <nom> | agents | statut]')
  })

  test('inscrit la session par un battement : son identifiant, le dossier où elle travaille, ses agents', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on)
    etat.agents = [
      { id: 'a1', name: 'revue', description: 'Relire le diff', type: 'general-purpose', status: 'running' },
      { id: 'a2', description: 'Chercher les appels', type: 'Explore', status: 'idle' },
      { id: 'a3', description: '', type: 'general-purpose', status: 'running' },
    ]
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(appelsDe('battre')).toHaveLength(1)
    const battement = appelsDe('battre')[0]
    expect(battement?.argv).toEqual(['node', CLI, 'pause-hook', 'battre'])
    expect(battement?.delai).toBe(20_000)
    expect(battement?.entree).toEqual({
      session: 'S1',
      titre: 'atelier',
      agents: [
        { id: 'a1', nom: 'revue', statut: 'running' },
        { id: 'a2', nom: 'Chercher les appels', statut: 'idle' },
        { id: 'a3', nom: 'general-purpose', statut: 'running' },
      ],
    })
  })

  for (const [cwd, titre] of [['C:\\travail\\projets\\atelier\\', 'atelier'], ['/home/demo/atelier', 'atelier'], ['C:/', 'C:'], ['', '']] as const) {
    test(`le titre est le dernier dossier du chemin, quel que soit le séparateur (${JSON.stringify(cwd)})`, async ($, on) => {
      const { horloge, appelsDe } = monde(on, { cwd })
      await $.session.start(DEMARRAGE)
      await horloge.settle()
      expect(appelsDe('battre')[0]?.entree.titre).toBe(titre)
    })
  }

  test('le battement se répète toutes les 30 secondes, pas avant', async ($, on) => {
    const { horloge, appelsDe } = monde(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(appelsDe('battre')).toHaveLength(1)
    await horloge.advance(29_000)
    expect(appelsDe('battre')).toHaveLength(1)
    await horloge.advance(1_000)
    expect(appelsDe('battre')).toHaveLength(2)
    await horloge.advance(30_000)
    expect(appelsDe('battre')).toHaveLength(3)
  })

  test('un dossier ou des agents illisibles ne privent pas la session de son battement', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on)
    etat.cwdEnPanne = true
    etat.agentsEnPanne = true
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(appelsDe('battre')[0]?.entree).toEqual({ session: 'S1', titre: '', agents: [] })
  })

  test('une session sans identifiant est transmise vide : le noyau ne l inscrit pas', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on)
    etat.sessionEnPanne = true
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(appelsDe('battre')[0]?.entree.session).toBe('')
  })

  test('un noyau en panne ne gêne pas le démarrage', async ($, on) => {
    const { etat, horloge } = monde(on)
    etat.panne = true
    await $.session.start(DEMARRAGE)
    await horloge.advance(60_000)
    expect(etat.commandes).toHaveLength(2)
  })
})

describe('étape du modèle (turn.step)', () => {
  test('rien n est en pause : aucun processus, aucune ligne de statut, l étape passe', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = etat.appels.length
    const statuts = etat.statuts.length
    expect((await etape($)).answer).toBe('réponse du modèle')
    await horloge.settle()
    expect(etat.etapes).toEqual([undefined])
    expect(etat.appels).toHaveLength(avant)
    expect(etat.statuts).toHaveLength(statuts)
  })

  test('un fichier précédé d un BOM est lu', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: `${String.fromCharCode(0xfeff)}${fichier({ S1: enPause() })}` })
    etat.reponses.attendre = () => ({ enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await etape($)
    expect(appelsDe('attendre')).toHaveLength(1)
  })

  test('un fichier absent ou abîmé ne retient personne', async ($, on) => {
    const { etat, horloge } = monde(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = etat.appels.length
    expect((await etape($)).answer).toBe('réponse du modèle')
    etat.fichier = '{ pas du json'
    expect((await etape($)).answer).toBe('réponse du modèle')
    etat.fichier = 'null'
    expect((await etape($)).answer).toBe('réponse du modèle')
    expect(etat.appels).toHaveLength(avant)
  })

  test('une autre session en pause ne retient pas celle-ci', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session(), S2: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = etat.appels.length
    await etape($)
    expect(etat.appels).toHaveLength(avant)
  })

  test('une session en pause retient l étape jusqu à la reprise, puis la laisse partir', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const fin = etape($)
    await horloge.settle()
    expect(etat.etapes).toEqual([])
    expect(appelsDe('attendre')).toHaveLength(1)
    etat.fichier = fichier({ S1: session() })
    reprise.liberer({ enPause: false })
    expect((await fin).answer).toBe('réponse du modèle')
    expect(etat.etapes).toEqual([undefined])
  })

  test('demande au noyau d attendre vingt secondes à la fois, avec trente secondes de délai', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    etat.reponses.attendre = () => ({ enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await etape($)
    const a = appelsDe('attendre')[0]
    expect(a?.argv).toEqual(['node', CLI, 'pause-hook', 'attendre'])
    expect(a?.delai).toBe(30_000)
    expect(a?.entree).toEqual({ session: 'S1', dureeMs: 20_000 })
  })

  test('la pause qui dure est redemandée tranche après tranche, avec un battement entre deux', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    let n = 0
    etat.reponses.attendre = () => (++n < 3 ? { enPause: true, cible: 'session', depuis: iso(DEBUT - 3 * MIN) } : { enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = appelsDe('battre').length
    await etape($)
    expect(appelsDe('attendre')).toHaveLength(3)
    await horloge.settle()
    expect(appelsDe('battre')).toHaveLength(avant + 2)
    expect(etat.etapes).toEqual([undefined])
  })

  test('une pause levée dans le fichier pendant une tranche libère la boucle sans nouvel appel', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    etat.reponses.attendre = () => {
      etat.fichier = fichier({ S1: session() })

      return { enPause: true, cible: 'session', depuis: iso(DEBUT - 3 * MIN) }
    }
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await etape($)
    expect(appelsDe('attendre')).toHaveLength(1)
    expect(etat.etapes).toEqual([undefined])
  })

  test('un noyau qui ne répond pas, qui échoue ou qui parle mal ne retient jamais la boucle', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.panne = true
    expect((await etape($)).answer).toBe('réponse du modèle')
    etat.panne = false
    etat.code = 1
    etat.stderr = 'boum'
    expect((await etape($)).answer).toBe('réponse du modèle')
    etat.code = 0
    etat.brut = 'ceci n est pas du json'
    expect((await etape($)).answer).toBe('réponse du modèle')
    etat.brut = '[1, 2]'
    expect((await etape($)).answer).toBe('réponse du modèle')
    etat.brut = 'null'
    expect((await etape($)).answer).toBe('réponse du modèle')
    expect(etat.etapes).toHaveLength(5)
    expect(appelsDe('attendre')).toHaveLength(5)
  })

  test('un agent en pause seul est retenu avec son identifiant, la boucle principale et les autres agents passent', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, {
      fichier: fichier({ S1: session({ agents: { a1: { nom: 'revue', pause: true, depuis: iso(DEBUT - MIN) }, a2: { nom: 'recherche' } } }) }),
    })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await etape($)
    await etape($, 'a2')
    expect(appelsDe('attendre')).toHaveLength(0)
    const fin = etape($, 'a1')
    await horloge.settle()
    expect(etat.etapes).toEqual([undefined, 'a2'])
    expect(appelsDe('attendre')[0]?.entree).toEqual({ session: 'S1', agentId: 'a1', dureeMs: 20_000 })
    reprise.liberer({ enPause: false })
    await fin
    expect(etat.etapes).toEqual([undefined, 'a2', 'a1'])
  })

  test('un agent en pause seul est redemandé tranche après tranche, avec son identifiant à chaque fois', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: session({ agents: { a1: { nom: 'revue', pause: true, depuis: iso(DEBUT - MIN) } } }) }) })
    let n = 0
    etat.reponses.attendre = () => (++n < 3 ? { enPause: true, cible: 'agent', depuis: iso(DEBUT - MIN) } : { enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await etape($, 'a1')
    expect(appelsDe('attendre').map(a => a.entree.agentId)).toEqual(['a1', 'a1', 'a1'])
    expect(etat.etapes).toEqual(['a1'])
  })

  test('une session en pause retient aussi ses agents, même ceux que le fichier ne connaît pas encore', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause({ agents: { a1: { nom: 'revue' } } }) }) })
    etat.reponses.attendre = () => ({ enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await etape($, 'a1')
    await etape($, 'inconnu')
    expect(appelsDe('attendre').map(a => a.entree.agentId)).toEqual(['a1', 'inconnu'])
  })
})

describe('outils (tool.call)', () => {
  test('rien n est en pause : aucun processus, l outil s exécute et rend son résultat', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = etat.appels.length
    expect((await outil($, 'Bash', { command: 'ls' })).text).toBe('ok')
    expect(etat.executees).toEqual([{ tool: 'Bash', agentId: undefined }])
    expect(etat.appels).toHaveLength(avant)
  })

  test('une session en pause retient l outil jusqu à la reprise, puis l exécute', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const fin = outil($, 'Bash', { command: 'ls' })
    await horloge.settle()
    expect(etat.executees).toEqual([])
    expect(appelsDe('attendre')).toHaveLength(1)
    expect(appelsDe('attendre')[0]?.entree).toEqual({ session: 'S1', dureeMs: 20_000 })
    etat.fichier = fichier({ S1: session() })
    reprise.liberer({ enPause: false })
    expect((await fin).text).toBe('ok')
    expect(etat.executees).toEqual([{ tool: 'Bash', agentId: undefined }])
  })

  test('tous les outils sont retenus, y compris ceux d un serveur MCP', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    etat.reponses.attendre = () => ({ enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    for (const tool of ['Bash', 'Read', 'Edit', 'Agent', 'mcp__serveur__outil']) await outil($, tool, tool === 'mcp__serveur__outil' ? {} : { command: 'x', file_path: 'x', old_string: 'a', new_string: 'b', prompt: 'p' })
    expect(appelsDe('attendre')).toHaveLength(5)
    expect(etat.executees.map(x => x.tool)).toEqual(['Bash', 'Read', 'Edit', 'Agent', 'mcp__serveur__outil'])
  })

  test('un agent en pause seul est retenu pour ses outils, la boucle principale non', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: session({ agents: { a1: { nom: 'revue', pause: true, depuis: iso(DEBUT - MIN) } } }) }) })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await outil($, 'Bash', { command: 'ls' })
    expect(appelsDe('attendre')).toHaveLength(0)
    const fin = outil($, 'Bash', { command: 'ls', agentId: 'a1' })
    await horloge.settle()
    expect(etat.executees).toEqual([{ tool: 'Bash', agentId: undefined }])
    expect(appelsDe('attendre')[0]?.entree).toEqual({ session: 'S1', agentId: 'a1', dureeMs: 20_000 })
    reprise.liberer({ enPause: false })
    await fin
    expect(etat.executees).toEqual([{ tool: 'Bash', agentId: undefined }, { tool: 'Bash', agentId: 'a1' }])
  })

  test('un noyau en panne ne retient pas l outil', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.panne = true
    expect((await outil($, 'Bash', { command: 'ls' })).text).toBe('ok')
    etat.panne = false
    etat.brut = 'pas du json'
    expect((await outil($, 'Bash', { command: 'ls' })).text).toBe('ok')
    expect(etat.executees).toHaveLength(2)
  })
})

describe('ligne de statut', () => {
  test('rien n est en pause : aucune ligne', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('au démarrage, dit ce qui est en pause : cette session, ses agents, les autres sessions', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause(), S2: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBe('Pause : cette session en pause depuis 3 min ; 1 autre session en pause')
  })

  test('un agent en pause seul est dit', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session({ agents: { a1: { nom: 'revue', pause: true, depuis: iso(DEBUT) } } }) }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBe('Pause : 1 agent en pause')
  })

  test('la ligne suit le fichier, relu toutes les dix secondes', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBeUndefined()
    etat.fichier = fichier({ S1: session(), S2: enPause() })
    await horloge.advance(9_000)
    expect(etat.statuts.at(-1)).toBeUndefined()
    await horloge.advance(1_000)
    expect(etat.statuts.at(-1)).toBe('Pause : 1 autre session en pause')
    etat.fichier = fichier({ S1: session(), S2: session() })
    await horloge.advance(10_000)
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('la durée affichée avance à la minute, sans que le fichier change', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBe('Pause : cette session en pause depuis 3 min')
    await horloge.advance(60_000)
    expect(etat.statuts.at(-1)).toBe('Pause : cette session en pause depuis 4 min')
  })

  test('une lecture identique ne repose pas la ligne', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = etat.statuts.length
    await horloge.advance(30_000)
    expect(etat.statuts).toHaveLength(avant)
  })

  test('rien n est en pause : la lecture périodique ne repose pas une ligne vide', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const avant = etat.statuts.length
    await horloge.advance(60_000)
    expect(etat.statuts).toHaveLength(avant)
  })

  test('pendant l attente, la ligne dit pourquoi la boucle est à l arrêt et la lecture périodique n y touche pas', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const fin = etape($)
    await horloge.settle()
    const attente = "Pause : cette session est à l'arrêt depuis 3 min (reprise : bouton Reprendre ou panneau Cockpit, pas /reprendre)"
    expect(etat.statuts.at(-1)).toBe(attente)
    etat.fichier = fichier({ S1: enPause(), S2: enPause() })
    await horloge.advance(10_000)
    expect(etat.statuts.at(-1)).toBe(attente)
    etat.fichier = fichier({ S1: session(), S2: enPause() })
    reprise.liberer({ enPause: false })
    await fin
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBe('Pause : 1 autre session en pause')
  })

  test('l attente finie, la ligne revient au texte de la bande même quand ce texte n a pas changé', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    etat.reponses.attendre = () => ({ enPause: false })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const texte = 'Pause : cette session en pause depuis 3 min'
    expect(etat.statuts.at(-1)).toBe(texte)
    await etape($)
    await horloge.settle()
    expect(etat.statuts.at(-2)).toMatch(/^Pause : cette session est à l'arrêt/)
    expect(etat.statuts.at(-1)).toBe(texte)
  })

  test('l attente finie, la ligne revient à vide quand plus rien n est en pause', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const fin = etape($)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toMatch(/^Pause : cette session est à l'arrêt/)
    etat.fichier = fichier({ S1: session() })
    reprise.liberer({ enPause: false })
    await fin
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('la ligne d un agent arrêté dit « cet agent »', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session({ agents: { a1: { nom: 'revue', pause: true, depuis: iso(DEBUT - MIN) } } }) }) })
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const fin = etape($, 'a1')
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBe("Pause : cet agent est à l'arrêt depuis 1 min (reprise : bouton Reprendre ou /reprendre)")
    etat.fichier = fichier({ S1: session() })
    reprise.liberer({ enPause: false })
    await fin
  })
})

describe('commandes /pause et /reprendre', () => {
  test('/pause demande au noyau d arrêter cette session, avec sa fiche, et rend son message', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on)
    etat.agents = [{ id: 'a1', name: 'revue', description: 'x', type: 'y', status: 'running' }]
    etat.reponses.commande = () => ({ message: 'Pause : cette session est en pause.' })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const r = await commande($, 'pause')
    expect(r).toEqual({ text: 'Pause : cette session est en pause.' })
    const c = appelsDe('commande')[0]
    expect(c?.argv).toEqual(['node', CLI, 'pause-hook', 'commande'])
    expect(c?.delai).toBe(20_000)
    expect(c?.entree).toEqual({ session: 'S1', sens: 'pause', args: '', fiche: { titre: 'atelier', agents: [{ id: 'a1', nom: 'revue', statut: 'running' }] } })
  })

  test('/reprendre demande la reprise', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on)
    etat.reponses.commande = () => ({ message: 'Reprise : cette session reprend.' })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(await commande($, 'reprendre')).toEqual({ text: 'Reprise : cette session reprend.' })
    expect(appelsDe('commande')[0]?.entree.sens).toBe('reprendre')
  })

  test('les arguments sont transmis tels quels, sans espaces en bordure', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on)
    etat.reponses.commande = () => ({ message: 'ok' })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    await commande($, 'pause', '  agent revue  ')
    await commande($, 'reprendre', 'tout')
    expect(appelsDe('commande').map(a => [a.entree.sens, a.entree.args])).toEqual([['pause', 'agent revue'], ['reprendre', 'tout']])
  })

  test('une erreur du noyau est dite telle quelle', async ($, on) => {
    const { etat, horloge } = monde(on)
    etat.reponses.commande = () => ({ erreur: 'Usage : /pause [tout | session [id ou titre] | agent <nom ou id> | agents | statut]' })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(await commande($, 'pause', 'n importe quoi')).toEqual({ text: 'Usage : /pause [tout | session [id ou titre] | agent <nom ou id> | agents | statut]' })
  })

  test('une réponse sans message ni erreur est dite illisible', async ($, on) => {
    const { etat, horloge } = monde(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.reponses.commande = () => ({ autre: 1 })
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : réponse illisible du noyau.' })
    etat.brut = 'ceci n est pas du json'
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : réponse illisible du noyau.' })
    etat.brut = 'null'
    expect(await commande($, 'reprendre')).toEqual({ text: 'Pause : réponse illisible du noyau.' })
  })

  test('un noyau qui ne démarre pas, qui échoue avec ou sans message est dit avec sa cause', async ($, on) => {
    const { etat, horloge } = monde(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.panne = true
    expect((await commande($, 'pause')).text).toMatch(/^Pause : le noyau ne répond pas \(.*spawn node ENOENT\)\.$/)
    etat.panne = false
    etat.brut = ''
    etat.code = 2
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : code de sortie 2.' })
    etat.stderr = 'boum du noyau'
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : boum du noyau' })
    etat.stderr = `${'x'.repeat(400)}\n\n  fin`
    expect((await commande($, 'pause')).text).toBe(`Pause : ${'x'.repeat(157)}...`)
  })

  test('le texte d un échec tient sur une ligne, sans espaces en bordure, et ne dépasse pas 160 caractères', async ($, on) => {
    const { etat, horloge } = monde(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.brut = ''
    etat.code = 2
    etat.stderr = 'ligne un\nligne deux\n  '
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : ligne un ligne deux' })
    etat.stderr = '   boum   '
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : boum' })
    etat.stderr = 'x'.repeat(160)
    expect(await commande($, 'pause')).toEqual({ text: `Pause : ${'x'.repeat(160)}` })
    etat.stderr = 'x'.repeat(161)
    expect(await commande($, 'pause')).toEqual({ text: `Pause : ${'x'.repeat(157)}...` })
  })

  test('après une commande, la ligne de statut relit le fichier', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    etat.reponses.commande = () => {
      etat.fichier = fichier({ S1: enPause() })

      return { message: 'Pause : cette session est en pause.' }
    }
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBeUndefined()
    await commande($, 'pause')
    expect(etat.statuts.at(-1)).toBe('Pause : cette session en pause depuis 3 min')
  })
})

describe('bande au-dessus du prompt', () => {
  test('deux boutons, Pause et Reprendre, sur terminal et desktop', async ($, on) => {
    const { horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'pause', surface, component: 'AbovePrompt', props: BANDE })
      expect((await ui.find({ type: 'Button', key: 'pause' }))?.props.label).toBe('Pause')
      expect((await ui.find({ type: 'Button', key: 'reprendre' }))?.props.label).toBe('Reprendre')
      expect(await ui.find({ type: 'Text' })).toBeUndefined()
      expect((await ui.find({ type: 'Box' }))?.props.flexDirection).toBe('column')
      const boite = boiteDuModule((await ui.drawn()) as unknown as Noeud)
      expect(boite?.props?.flexDirection).toBe('column')
      expect((boite?.children?.[0] as Noeud).type).toBe('engine')
      await ui.unmount()
    }
  })

  test('dit ce qui est en pause, à côté des boutons', async ($, on) => {
    const { horloge } = monde(on, { fichier: fichier({ S1: enPause(), S2: enPause() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'pause', surface, component: 'AbovePrompt', props: BANDE })
      const texte = await ui.find({ type: 'Text', text: /^Pause :/ })
      expect(texte?.text).toBe('Pause : cette session en pause depuis 3 min ; 1 autre session en pause')
      expect(texte?.props.dimColor).toBe(true)
      expect(texte?.props.wrap).toBe('truncate-end')
      expect(await ui.find({ type: 'Button', key: 'pause' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('s ajoute à ce qu un autre plugin dessine en dessous', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    etat.dessous = 'Cockpit | ledger 2 ouvertes'
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect(await ui.find({ type: 'Text', text: 'Cockpit | ledger 2 ouvertes' })).toBeDefined()
    const arbre = (await ui.drawn()) as unknown as Noeud
    expect((arbre.children?.[1] as Noeud).children?.[0]).toBe('Cockpit | ledger 2 ouvertes')
    expect((boiteDuModule(arbre)?.children?.[0] as Noeud).type).toBe('engine')
    expect(await ui.find({ type: 'Button', key: 'pause' })).toBeDefined()
    await ui.unmount()
  })

  test('cède la place à un sondage', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    etat.dessous = 'Sondage : êtes-vous satisfait ?'
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'terminal', component: 'AbovePrompt', props: { ...BANDE, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: 'Sondage : êtes-vous satisfait ?' })).toBeDefined()
    expect(await ui.find({ key: 'pause' })).toBeUndefined()
    expect(await ui.find({ key: 'reprendre' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Pause :/ })).toBeUndefined()
    const arbre = (await ui.drawn()) as unknown as Noeud
    expect(arbre.type).toBe('Text')
    expect(arbre.children?.[0]).toBe('Sondage : êtes-vous satisfait ?')
    await ui.unmount()
  })

  test('le bouton Pause lance /pause pour cette session et dit le résultat', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: session() }) })
    etat.reponses.commande = () => ({ message: 'Pause : cette session est en pause.' })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    await ui.press({ key: 'pause' })
    expect(appelsDe('commande').map(a => [a.entree.sens, a.entree.args, a.entree.session])).toEqual([['pause', '', 'S1']])
    expect(etat.toasts).toEqual(['Pause : cette session est en pause.'])
    await ui.unmount()
  })

  test('le bouton Reprendre lance /reprendre pour cette session et dit le résultat', async ($, on) => {
    const { etat, horloge, appelsDe } = monde(on, { fichier: fichier({ S1: enPause() }) })
    etat.reponses.commande = () => ({ message: 'Reprise : cette session reprend.' })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'desktop', component: 'AbovePrompt', props: BANDE })
    await ui.press({ key: 'reprendre' })
    expect(appelsDe('commande').map(a => [a.entree.sens, a.entree.args, a.entree.session])).toEqual([['reprendre', '', 'S1']])
    expect(etat.toasts).toEqual(['Reprise : cette session reprend.'])
    await ui.unmount()
  })

  test('un noyau en panne est dit par le toast, sans casser la bande', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.panne = true
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    await ui.press({ key: 'pause' })
    expect(etat.toasts).toHaveLength(1)
    expect(etat.toasts[0]).toMatch(/^Pause : le noyau ne répond pas/)
    expect(await ui.find({ type: 'Button', key: 'pause' })).toBeDefined()
    await ui.unmount()
  })

  test('la bande se met à jour avec le fichier', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    etat.fichier = fichier({ S1: enPause() })
    await horloge.advance(10_000)
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Pause : cette session en pause depuis 3 min')
    etat.fichier = fichier({ S1: session() })
    await horloge.advance(10_000)
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  })

  test('avant la première lecture, la bande montre déjà ses boutons', async ($, on) => {
    monde(on)
    const ui = await $.ui.mount({ plugin: 'pause', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect(await ui.find({ type: 'Button', key: 'pause' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reprendre' })).toBeDefined()
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  })
})

// Une action lancée « en l'air » peut finir quand la mod est déjà déchargée : l'écriture de l'état est alors refusée (« no hooks module of
// that name is loaded ») et l'action rejette. Aucune ne doit laisser un rejet non géré (le runner le signale en fin de fichier).
// Le refus est simulé PENDANT le test : le rejet réel d'une action encore en vol à la fin du fichier dépend de la vitesse du runner.
describe('rejets des actions de fond', () => {
  const modDechargee = (on: On) => {
    const etat = { refuse: false }
    on('state.set', (_$, e, next) => (etat.refuse ? ({ deny: 'refused: no hooks module of that name is loaded' } as never) : next(e)))
    return etat
  }

  test('au démarrage, le battement et la première lecture lancés par la session', async ($, on) => {
    const { horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    modDechargee(on).refuse = true
    await $.session.start(DEMARRAGE)
    await horloge.settle()
  })

  test('à chaque tour de la lecture périodique', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    const mod = modDechargee(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    mod.refuse = true
    etat.fichier = fichier({ S1: enPause() })
    await horloge.advance(10_000)
    await horloge.settle()
  })

  test('après une attente, la ligne de statut restaurée en fond', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: enPause() }) })
    const mod = modDechargee(on)
    const reprise = retenue<object>()
    etat.reponses.attendre = () => reprise.promesse
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const fin = etape($)
    await horloge.settle()
    mod.refuse = true
    etat.fichier = fichier({ S1: session() })
    reprise.liberer({ enPause: false })
    expect((await fin).answer).toBe('réponse du modèle')
    await horloge.settle()
  })

  test('une commande dont la relecture échoue rend quand même son message', async ($, on) => {
    const { etat, horloge } = monde(on, { fichier: fichier({ S1: session() }) })
    const mod = modDechargee(on)
    etat.reponses.commande = () => {
      etat.fichier = fichier({ S1: enPause() })

      return { message: 'Pause : cette session est en pause.' }
    }
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    mod.refuse = true
    expect(await commande($, 'pause')).toEqual({ text: 'Pause : cette session est en pause.' })
    await horloge.settle()
  })
})
