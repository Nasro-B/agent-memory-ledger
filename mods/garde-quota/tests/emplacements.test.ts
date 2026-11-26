import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Où le module lit et écrit : le dossier d'état du Cockpit, calculé comme celui des noyaux et de scripts/cockpit.js (COCKPIT_DIR, sinon
// <maison>/cockpit où la maison est AGENT_MEMORY_LEDGER_HOME, sinon <dossier de l'utilisateur>/.agent-memory-ledger). Une valeur réglée par la ligne
// de commande est lue par le module, et l'inverse : mêmes fichiers, même dossier.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-03T12:00:00.000Z')
const H = 3_600_000
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }
const BASE = [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }]
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const MESURE = { context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 71, resetsAt: new Date(DEBUT + 3 * H).toISOString() }], changed: ['rateLimits' as const] }
const CRITIQUE = [{ kind: 'five_hour', percentUsed: 91, resetsAt: new Date(DEBUT + 2 * H).toISOString() }]

// Le monde simulé : les variables d'environnement, les fichiers lus (par chemin), les fenêtres que le moteur mesure et ce qui est écrit.
function monde(on: On, variables: Record<string, string>, fichiers: Record<string, string> = {}, limites: object[] = []) {
  const etat = { lectures: [] as string[], ecritures: [] as { path: string; text: string }[], statuts: [] as (string | undefined)[], memoire: new Map<string, unknown>() }
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
  on('session.usage', () => ({ value: { startedAt: DEBUT, context: { window: 200_000 }, rateLimits: limites } }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('store.get', (_$, e) => ({ value: etat.memoire.get(e.key) }))
  on('store.set', (_$, e) => {
    etat.memoire.set(e.key, e.value)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: BASE }))
  return etat
}

const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)

describe('dossier d état', () => {
  test('COCKPIT_DIR : la mesure est écrite dans quota-claude.json de ce dossier', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' })
    await $.session.measure(MESURE as never)
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/quota-claude.json'])
    expect(etat.lectures).toContain('C:/travail/etat-a/garde-quota.json')
  })

  test('COCKPIT_DIR : les réglages sont lus et écrits dans garde-quota.json de ce dossier', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' }, { 'C:/travail/etat-a/garde-quota.json': JSON.stringify({ attention: 50, critique: 60 }) })
    expect((await commande($, 'quota', '')).text).toMatch(/seuils 50 % puis 60 %/)
    await commande($, 'quota', '70 85')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/garde-quota.json'])
  })

  test('sans COCKPIT_DIR : <maison>/cockpit, la maison étant AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison/' })
    await commande($, 'quota', '70 85')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/maison/cockpit/garde-quota.json'])
  })

  test('sans variable de dossier : le dossier de l utilisateur, sous .agent-memory-ledger/cockpit', async ($, on) => {
    const etat = monde(on, { USERPROFILE: 'C:/Users/demo', HOME: 'C:/Users/demo' })
    await $.session.measure(MESURE as never)
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/Users/demo/.agent-memory-ledger/cockpit/quota-claude.json'])
  })

  test('COCKPIT_DIR prime sur AGENT_MEMORY_LEDGER_HOME', async ($, on) => {
    const etat = monde(on, { COCKPIT_DIR: 'C:/travail/etat-a', AGENT_MEMORY_LEDGER_HOME: 'C:/travail/maison' })
    await commande($, 'quota', '70 85')
    expect(etat.ecritures.map(e => e.path)).toEqual(['C:/travail/etat-a/garde-quota.json'])
  })

  test('le prompt de relais est demandé dans le même dossier : relais-codex.md', async ($, on) => {
    monde(on, { COCKPIT_DIR: 'C:/travail/etat-a' }, {}, CRITIQUE)
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('écris le prompt de relais pour Codex dans C:/travail/etat-a/relais-codex.md, puis')
  })

  test('sans dossier connu : la mesure ne tombe pas et rien n est écrit, la consigne nomme l autre agent sans fichier, la commande dit la cause', async ($, on) => {
    const etat = monde(on, {}, {}, CRITIQUE)
    await $.session.measure(MESURE as never)
    expect(etat.ecritures).toEqual([])
    expect(etat.statuts.at(-1)).toMatch(/^7 j 71 %/)
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('écris le prompt de relais pour Codex, puis ne lance plus d\'agent')
    expect(texte).not.toContain('relais-codex.md')
    const r = await commande($, 'quota', '70 85')
    expect(r.text).toMatch(/COCKPIT_DIR ou AGENT_MEMORY_LEDGER_HOME/)
    expect(etat.ecritures).toEqual([])
  })
})
