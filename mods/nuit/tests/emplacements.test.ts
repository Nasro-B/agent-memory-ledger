import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Où le module lit et lance : le dossier d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit où la maison est AGENT_MEMORY_LEDGER_HOME, sinon
// <dossier de l'utilisateur>/.agent-memory-ledger : le calcul des noyaux et de scripts/cockpit.js) et le script du noyau (scripts/cockpit.js du plugin,
// trouvé par AML_PLUGIN_DIR ou à côté du module). Une valeur réglée par la ligne de commande est lue par le module, et l'inverse.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-04T00:10:00.000Z')
const MIN = 60_000
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const QUESTIONS = [{ question: 'Quel nom ?', header: 'Nom', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const ACTIVE = JSON.stringify({ actif: true, mode: 'nuit', depuis: new Date(DEBUT - 10 * MIN).toISOString(), tours: 3, maxTours: 60 })
const AVEC_SCRIPT = { COCKPIT_DIR: 'C:/travail/etat-a', AML_PLUGIN_DIR: 'C:/outils/ledger' }
const sortie = (valeur: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(valeur), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Appel = { argv: string[]; operation: string }

// Le monde simulé : les variables d'environnement, les fichiers de la nuit (par chemin), le noyau (il refuse toute question) et ce que le moteur exécute.
function monde(on: On, variables: Record<string, string>, fichiers: Record<string, string> = {}) {
  const etat = { lectures: [] as string[], appels: [] as Appel[], executees: [] as string[] }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, variables)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'S1' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ deny: 'ENOENT: dossier absent' }))
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    return chemin in fichiers ? { value: fichiers[chemin] ?? '' } : { deny: 'ENOENT: fichier absent' }
  })
  on('process.run', (_$, e) => {
    etat.appels.push({ argv: [...e.argv], operation: e.argv[3] ?? '' })
    return sortie({ refuser: true, id: 1, texte: 'NUIT : refus de la question.', message: 'Nuit : ok.' })
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', (_$, e) => {
    etat.executees.push(e.tool)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  return Object.assign(etat, { horloge })
}

const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const question = ($: Engine) => ($.tool as unknown as { call: (e: object) => Promise<{ deny?: string; text?: string }> }).call({ tool: 'AskUserQuestion', questions: QUESTIONS })

describe('dossier d état', () => {
  test('COCKPIT_DIR : l état et la boîte de la nuit sont lus dans ce dossier', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT)
    await $.session.start(DEMARRAGE)
    expect(etat.lectures).toContain('C:/travail/etat-a/nuit.json')
    expect(etat.lectures).toContain('C:/travail/etat-a/nuit-boite.json')
  })

  test('sans COCKPIT_DIR : <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison/', AML_PLUGIN_DIR: 'C:/outils/ledger' })
    await $.session.start(DEMARRAGE)
    expect(etat.lectures).toContain('C:/travail/maison/cockpit/nuit.json')
    expect(etat.lectures).toContain('C:/travail/maison/cockpit/nuit-boite.json')
  })

  test('sans variable de dossier : le dossier de l utilisateur, sous .agent-memory-ledger/cockpit', async ($, on) => {
    const etat = monde(on, { USERPROFILE: 'C:/Users/demo', HOME: 'C:/Users/demo', AML_PLUGIN_DIR: 'C:/outils/ledger' })
    await $.session.start(DEMARRAGE)
    expect(etat.lectures).toContain('C:/Users/demo/.agent-memory-ledger/cockpit/nuit.json')
  })

  test('COCKPIT_DIR prime sur AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { ...AVEC_SCRIPT, AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison' })
    await $.session.start(DEMARRAGE)
    expect(etat.lectures).toContain('C:/travail/etat-a/nuit.json')
    expect(etat.lectures).not.toContain('C:/travail/maison/cockpit/nuit.json')
  })

  test('une nuit active posée dans le dossier détourne la question : le noyau est interrogé', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, { 'C:/travail/etat-a/nuit.json': ACTIVE })
    expect((await question($)).deny).toBe('NUIT : refus de la question.')
    expect(etat.appels.map(a => a.operation)).toContain('question')
    expect(etat.executees).toEqual([])
  })

  test('sans dossier connu : la nuit n est pas active, la question passe et aucun noyau n est interrogé', async ($, on) => {
    const etat = monde(on, { AML_PLUGIN_DIR: 'C:/outils/ledger' })
    expect((await question($)).deny).toBeUndefined()
    expect(etat.appels).toEqual([])
    expect(etat.lectures).toEqual([])
  })
})

describe('script du noyau', () => {
  test('est scripts/cockpit.js du plugin (AML_PLUGIN_DIR), lancé avec nuit-hook et l opération', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, { 'C:/travail/etat-a/nuit.json': ACTIVE })
    await question($)
    expect(etat.appels[0]?.argv.slice(0, 4)).toEqual(['node', 'C:/outils/ledger/scripts/cockpit.js', 'nuit-hook', 'question'])
  })

  test('introuvable : la commande le dit avec la cause', async ($, on) => {
    monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' })
    expect((await commande($, 'nuit', 'on')).text).toMatch(/^Nuit : le noyau ne répond pas \(cockpit\.js introuvable : poser AML_PLUGIN_DIR/)
  })

  test('introuvable : une nuit active ne retient pas la question, jamais bloquée sur une panne du noyau', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' }, { 'C:/travail/etat-a/nuit.json': ACTIVE })
    expect((await question($)).deny).toBeUndefined()
    expect(etat.executees).toEqual(['AskUserQuestion'])
    expect(etat.appels).toEqual([])
  })
})
