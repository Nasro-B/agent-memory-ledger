import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Où le module lit et lance : le dossier d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit où la maison est AGENT_MEMORY_LEDGER_HOME, sinon
// <dossier de l'utilisateur>/.agent-memory-ledger : le calcul des noyaux et de scripts/cockpit.js) et le script du noyau (scripts/cockpit.js du plugin,
// trouvé par AML_PLUGIN_DIR ou à côté du module). Une valeur réglée par la ligne de commande est lue par le module, et l'inverse.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-04T05:00:00.000Z')
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const iso = (ms: number) => new Date(ms).toISOString()
const EN_PAUSE = JSON.stringify({ sessions: { S1: { titre: 'atelier', vu: iso(DEBUT), pause: true, depuis: iso(DEBUT - 180_000), agents: {} } } })
const AVEC_SCRIPT = { COCKPIT_DIR: 'C:/travail/etat-a', AML_PLUGIN_DIR: 'C:/outils/ledger' }

type Appel = { argv: string[]; operation: string; delai: number | undefined }

// Le monde simulé : les variables d'environnement, le fichier de la pause (par chemin), le noyau (il répond toujours que la pause est levée) et ce que le moteur exécute.
function monde(on: On, variables: Record<string, string>, fichiers: Record<string, string> = {}) {
  const etat = { lectures: [] as string[], appels: [] as Appel[], executees: [] as string[] }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, variables)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: 'C:/travail/projets/atelier' }))
  on('agent.list', () => ({ value: [] }) as never)
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ deny: 'ENOENT: dossier absent' }))
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    // Un module qui redemanderait le noyau sans fin (la pause levée n'arrête pas son attente) ferait tourner le banc sans fin : au-delà de 40 appels du noyau,
    // le fichier ne demande plus de pause, ce qui libère la boucle, et le test qui compte les appels rougit.
    if (etat.appels.length > 40 && chemin.endsWith('/pause.json')) return { value: '{}' }
    return chemin in fichiers ? { value: fichiers[chemin] ?? '' } : { deny: 'ENOENT: fichier absent' }
  })
  on('process.run', (_$, e) => {
    etat.appels.push({ argv: [...e.argv], operation: e.argv[3] ?? '', delai: e.init?.timeoutMs })
    return { value: { exitCode: 0, stdout: JSON.stringify({ enPause: false, message: 'Pause : ok.' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_$, e) => {
    etat.executees.push(e.tool)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  return Object.assign(etat, { horloge })
}

const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const outil = ($: Engine) => ($.tool as unknown as { call: (e: object) => Promise<{ deny?: string; text?: string }> }).call({ tool: 'Bash', command: 'ls' })

describe('dossier d état', () => {
  test('COCKPIT_DIR : l état de la pause est lu dans pause.json de ce dossier', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT)
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    expect(etat.lectures).toContain('C:/travail/etat-a/pause.json')
  })

  test('sans COCKPIT_DIR : <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison/', AML_PLUGIN_DIR: 'C:/outils/ledger' })
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    expect(etat.lectures).toContain('C:/travail/maison/cockpit/pause.json')
  })

  test('sans variable de dossier : le dossier de l utilisateur, sous .agent-memory-ledger/cockpit', async ($, on) => {
    const etat = monde(on, { USERPROFILE: 'C:/Users/demo', HOME: 'C:/Users/demo', AML_PLUGIN_DIR: 'C:/outils/ledger' })
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    expect(etat.lectures).toContain('C:/Users/demo/.agent-memory-ledger/cockpit/pause.json')
  })

  test('COCKPIT_DIR prime sur AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { ...AVEC_SCRIPT, AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison' })
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    expect(etat.lectures).toContain('C:/travail/etat-a/pause.json')
    expect(etat.lectures).not.toContain('C:/travail/maison/cockpit/pause.json')
  })

  test('une pause posée dans le dossier retient l outil, le noyau est interrogé', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, { 'C:/travail/etat-a/pause.json': EN_PAUSE })
    expect((await outil($)).text).toBe('ok')
    expect(etat.appels.map(a => a.operation)).toContain('attendre')
    expect(etat.appels.filter(a => a.operation === 'attendre')).toHaveLength(1)
  })

  test('sans dossier connu : rien n est retenu, aucun noyau n est interrogé', async ($, on) => {
    const etat = monde(on, { AML_PLUGIN_DIR: 'C:/outils/ledger' })
    expect((await outil($)).text).toBe('ok')
    expect(etat.appels).toEqual([])
    expect(etat.lectures).toEqual([])
  })
})

describe('script du noyau', () => {
  test('est scripts/cockpit.js du plugin (AML_PLUGIN_DIR), lancé avec pause-hook et l opération', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT)
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const battement = etat.appels.find(a => a.operation === 'battre')
    expect(battement?.argv.slice(0, 4)).toEqual(['node', 'C:/outils/ledger/scripts/cockpit.js', 'pause-hook', 'battre'])
  })

  test('introuvable : la commande le dit avec la cause, sans rien affirmer', async ($, on) => {
    monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' })
    const r = await commande($, 'pause')
    expect(r.text).toMatch(/^Pause : le noyau ne répond pas \(cockpit\.js introuvable : poser AML_PLUGIN_DIR/)
    expect((await commande($, 'reprendre', 'tout')).text).toMatch(/^Pause : le noyau ne répond pas \(cockpit\.js introuvable/)
  })

  test('introuvable : le battement du démarrage ne tombe pas, la session démarre, rien n est retenu', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' })
    expect(await $.session.start(DEMARRAGE)).toEqual({ cwd: 'C:/x' })
    expect((await outil($)).text).toBe('ok')
    expect(etat.appels).toEqual([])
  })
})
