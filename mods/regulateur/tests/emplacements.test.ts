import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Où le module lit, écrit et lance : le dossier d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit où la maison est AGENT_MEMORY_LEDGER_HOME, sinon
// <dossier de l'utilisateur>/.agent-memory-ledger : le calcul des noyaux et de scripts/cockpit.js) et le script de la file (scripts/regulateur-file.js du
// plugin, trouvé par AML_PLUGIN_DIR ou à côté du module). Une valeur réglée par la ligne de commande est lue par le module, et l'inverse.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-03T20:00:00.000Z')
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const SPAWN = { prompt: 'Fais le travail A', description: 'travail A', subagentType: 'general-purpose' }
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const FILE_VIDE = { prochain: 1, entrees: [], relances: {} }
const POLITIQUE_FILE = JSON.stringify({ max: 1, pause: false, relance: false, file: true })
const PLEIN = [{ id: 'a0', status: 'running' }]
const POLITIQUE_DEPILAGE = JSON.stringify({ max: 1, pause: false, relance: false, file: true })
const ENTREE = (id: number, ajoute: number) => ({ id, agent: 'claude', session: 'S1', ajoute: new Date(ajoute).toISOString(), description: 'travail ' + id, demande: { prompt: 'Fais le travail ' + id, description: 'travail ' + id, subagentType: 'general-purpose' }, essais: 0, statut: 'en-attente', ordre: null })
const fini = ($: Engine) => $.turn.complete({ answer: 'Travail terminé.', durationMs: 1000, isAborted: false, turnId: 'tour-1', agentId: 'inconnu', reason: 'answer' } as never)
const sortie = (valeur: unknown, exitCode = 0, isStdoutTruncated = false) => ({ value: { exitCode, stdout: JSON.stringify(valeur), stderr: '', isStdoutTruncated, isStderrTruncated: false } })

type Appel = { argv: string[]; operation: string; delai: number | undefined }

// Le monde simulé : les variables d'environnement, les fichiers lus (par chemin), les agents, le script de la file (une réponse par opération, ou une réponse imposée).
function monde(on: On, variables: Record<string, string>, init: { fichiers?: Record<string, string>; agents?: object[]; imposee?: ReturnType<typeof sortie>; parOperation?: Record<string, ReturnType<typeof sortie>> } = {}) {
  const etat = { lectures: [] as string[], ecritures: [] as { path: string; text: string }[], appels: [] as Appel[], statuts: [] as (string | undefined)[], commandes: [] as string[] }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, variables)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    etat.commandes.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.id', () => ({ value: 'S1' }))
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    const fichiers = init.fichiers ?? {}
    return chemin in fichiers ? { value: fichiers[chemin] ?? '' } : { deny: 'ENOENT: fichier absent' }
  })
  on('fs.write', (_$, e) => {
    etat.ecritures.push({ path: normal(e.path), text: e.text })
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ deny: 'ENOENT: dossier absent' }))
  on('process.run', (_$, e) => {
    const { operation } = JSON.parse(e.argv[2] ?? '{}')
    etat.appels.push({ argv: [...e.argv], operation, delai: e.init?.timeoutMs })
    if (init.imposee !== undefined) return init.imposee
    if (init.parOperation?.[operation] !== undefined) return init.parOperation[operation]
    if (operation === 'mettreEnFile') return sortie({ value: { position: 1, total: 1, deja: false } })
    if (operation === 'lireFile') return sortie({ value: FILE_VIDE })
    return sortie({ value: 0 })
  })
  on('agent.list', () => ({ value: init.agents ?? [] }) as never)
  on('agent.spawn', () => ({ model: 'm', agentId: 'n1' }))
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }] }))
  return Object.assign(etat, { horloge })
}

const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const lancement = ($: Engine) => $.agent.spawn(SPAWN as never)
const AVEC_SCRIPT = { COCKPIT_DIR: 'C:/travail/etat-a', AML_PLUGIN_DIR: 'C:/outils/ledger' }

describe('dossier d état', () => {
  test('COCKPIT_DIR : la politique est écrite dans politique-agents.json de ce dossier', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT)
    await commande($, 'plafond', '5')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/politique-agents.json'])
  })

  test('sans COCKPIT_DIR : <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison/', AML_PLUGIN_DIR: 'C:/outils/ledger' })
    await commande($, 'plafond', '5')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/maison/cockpit/politique-agents.json'])
  })

  test('sans variable de dossier : le dossier de l utilisateur, sous .agent-memory-ledger/cockpit', async ($, on) => {
    const etat = monde(on, { USERPROFILE: 'C:/Users/demo', HOME: 'C:/Users/demo', AML_PLUGIN_DIR: 'C:/outils/ledger' })
    await commande($, 'plafond', '5')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/Users/demo/.agent-memory-ledger/cockpit/politique-agents.json'])
  })

  test('COCKPIT_DIR prime sur AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { ...AVEC_SCRIPT, AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison' })
    await commande($, 'plafond', '5')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/politique-agents.json'])
  })

  test('une politique posée dans le dossier est appliquée, et les modèles par agent sont lus dans le même dossier', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, { fichiers: { 'C:/travail/etat-a/politique-agents.json': JSON.stringify({ max: 1, pause: true, relance: false, file: false }) } })
    expect((await lancement($)).deny).toMatch(/en pause/)
    expect(etat.lectures).toContain('C:/travail/etat-a/modeles-agents.json')
    expect(etat.lectures).toContain('C:/travail/etat-a/politique-agents.json')
  })

  test('sans dossier connu : la commande dit la cause sans rien écrire, et un lancement passe', async ($, on) => {
    const etat = monde(on, { AML_PLUGIN_DIR: 'C:/outils/ledger' })
    const r = await commande($, 'plafond', '5')
    expect(r.text).toMatch(/COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME/)
    expect(etat.ecritures).toEqual([])
    expect((await lancement($)).deny).toBeUndefined()
  })
})

describe('script de la file', () => {
  test('est scripts/regulateur-file.js du plugin (AML_PLUGIN_DIR), lancé avec l opération en JSON et dix secondes de délai', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT)
    await $.session.start(DEMARRAGE)
    const lire = etat.appels.find(a => a.operation === 'lireFile')
    expect(lire?.argv.slice(0, 2)).toEqual(['node', 'C:/outils/ledger/scripts/regulateur-file.js'])
    expect(JSON.parse(lire?.argv[2] ?? '{}')).toEqual({ operation: 'lireFile', args: [] })
    expect(lire?.delai).toBe(10_000)
  })

  test('introuvable : le démarrage ne tombe pas, la ligne de statut reste vide, et vider la file le dit', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' })
    await $.session.start(DEMARRAGE)
    expect(etat.commandes).toEqual(['plafond'])
    expect(etat.appels).toEqual([])
    expect(etat.statuts.filter(s => s !== undefined)).toEqual([])
    const r = await commande($, 'plafond', 'file vider')
    expect(r.text).toMatch(/^Régulateur d'agents : la file n'a pas pu être vidée \(.*regulateur-file\.js introuvable : poser AML_PLUGIN_DIR/)
  })

  test('introuvable : un agent refusé au maximum n est jamais mis en file sur une promesse, le refus dit que la file ne peut pas être écrite', async ($, on) => {
    monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' }, { fichiers: { 'C:/travail/etat-a/politique-agents.json': POLITIQUE_FILE }, agents: PLEIN })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : maximum atteint, et la file d'attente ne peut pas être écrite\./)
    expect(r.deny).not.toMatch(/mis en file/)
  })

  test('un script qui sort en échec est une panne, même avec une réponse lisible : la file ne peut pas être écrite', async ($, on) => {
    monde(on, AVEC_SCRIPT, { fichiers: { 'C:/travail/etat-a/politique-agents.json': POLITIQUE_FILE }, agents: PLEIN, imposee: sortie({ value: { position: 1, total: 1, deja: false } }, 1) })
    const r = await lancement($)
    expect(r.deny).toMatch(/la file d'attente ne peut pas être écrite/)
    expect(r.deny).not.toMatch(/mis en file/)
  })

  test('une réponse tronquée est une panne aussi', async ($, on) => {
    monde(on, AVEC_SCRIPT, { fichiers: { 'C:/travail/etat-a/politique-agents.json': POLITIQUE_FILE }, agents: PLEIN, imposee: sortie({ value: { position: 1, total: 1, deja: false } }, 0, true) })
    const r = await lancement($)
    expect(r.deny).toMatch(/la file d'attente ne peut pas être écrite/)
  })
})

describe('ligne de statut et dépilage au démarrage', () => {
  test('une purge qui retire des demandes met la ligne de statut à jour, avec ce qui reste en file', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, {
      fichiers: { 'C:/travail/etat-a/politique-agents.json': POLITIQUE_DEPILAGE },
      agents: PLEIN,
      parOperation: { purgerFile: sortie({ value: 1 }), lireFile: sortie({ value: { prochain: 3, entrees: [ENTREE(2, DEBUT)], relances: {} } }) },
    })
    await fini($)
    await etat.horloge.settle()
    expect(etat.statuts.at(-1)).toBe('File : 1 en attente')
  })

  test('une purge qui ne retire rien ne touche pas la ligne de statut', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, {
      fichiers: { 'C:/travail/etat-a/politique-agents.json': POLITIQUE_DEPILAGE },
      agents: PLEIN,
      parOperation: { purgerFile: sortie({ value: 0 }), lireFile: sortie({ value: { prochain: 3, entrees: [ENTREE(2, DEBUT)], relances: {} } }) },
    })
    await fini($)
    await etat.horloge.settle()
    expect(etat.statuts).toEqual([])
  })

  test('un script de la file qui échoue à la lecture au démarrage ne retient pas le dépilage : la minuterie réessaie tout de suite', async ($, on) => {
    const etat = monde(on, AVEC_SCRIPT, {
      fichiers: { 'C:/travail/etat-a/politique-agents.json': POLITIQUE_DEPILAGE },
      parOperation: { lireFile: sortie({ value: FILE_VIDE }, 1) },
    })
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    expect(etat.commandes).toEqual(['plafond'])
    expect(etat.appels.map(a => a.operation)).toContain('purgerFile')
  })
})
