import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Où le module lit et écrit : le dossier d'état du Cockpit, calculé comme celui des noyaux et de scripts/cockpit.js (COCKPIT_DIR, sinon
// <maison>/cockpit où la maison est AGENT_MEMORY_LEDGER_HOME, sinon <dossier de l'utilisateur>/.agent-memory-ledger). Une valeur réglée par la ligne
// de commande est lue par le module, et l'inverse : mêmes fichiers, même dossier.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-03T12:00:00.000Z')
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }
const BASE = [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }]
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const PUSH = JSON.stringify({ prochain: 2, consignes: [{ id: 1, texte: 'Pas de push', actif: true, verrou: 'push' }] })

// Le monde simulé : les variables d'environnement, les fichiers lus (par chemin) et ce qui est écrit.
function monde(on: On, variables: Record<string, string>, fichiers: Record<string, string> = {}) {
  const etat = { lectures: [] as string[], ecritures: [] as { path: string; text: string }[], executees: 0 }
  mock.clock(on, { now: DEBUT })
  mock.env(on, variables)
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    return chemin in fichiers ? { value: fichiers[chemin] ?? '' } : { deny: 'ENOENT: fichier absent' }
  })
  on('fs.write', (_$, e) => {
    etat.ecritures.push({ path: normal(e.path), text: e.text })
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', () => {
    etat.executees++
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  on('prompt.compose', () => ({ sections: BASE }))
  return etat
}

const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const shell = ($: Engine, cmd: string) => $.tool.call({ tool: 'Bash', command: cmd } as never)

describe('dossier d état', () => {
  test('COCKPIT_DIR : la commande écrit consignes.json dans ce dossier', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' })
    await commande($, 'consignes', 'ajouter Une consigne')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/consignes.json'])
    expect(etat.lectures).toEqual(['C:/travail/etat-a/consignes.json', 'C:/travail/etat-a/config.json'])
  })

  test('sans COCKPIT_DIR : <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison/' })
    await commande($, 'consignes', 'ajouter Une consigne')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/maison/cockpit/consignes.json'])
  })

  test('sans variable de dossier : le dossier de l utilisateur, sous .agent-memory-ledger/cockpit', async ($, on) => {
    const etat = monde(on, { USERPROFILE: 'C:/Users/demo', HOME: 'C:/Users/demo' })
    await commande($, 'consignes', 'ajouter Une consigne')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/Users/demo/.agent-memory-ledger/cockpit/consignes.json'])
  })

  test('COCKPIT_DIR prime sur AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a', AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison' })
    await commande($, 'consignes', 'ajouter Une consigne')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/consignes.json'])
  })

  test('une consigne posée dans le dossier est appliquée, et les réglages sont lus dans le même dossier', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' }, { 'C:/travail/etat-a/consignes.json': PUSH })
    expect((await shell($, 'git push')).deny).toMatch(/Consigne 1/)
    expect(etat.lectures).toContain('C:/travail/etat-a/config.json')
    expect(etat.executees).toBe(0)
  })

  test('sans dossier connu : la commande le dit sans rien écrire, et le module ne gêne rien', async ($, on) => {
    const etat = monde(on, {})
    const r = await commande($, 'consignes', 'ajouter Une consigne')
    expect(r.text).toMatch(/COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME/)
    expect(etat.ecritures).toEqual([])
    expect((await shell($, 'git push')).deny).toBeUndefined()
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })
})
