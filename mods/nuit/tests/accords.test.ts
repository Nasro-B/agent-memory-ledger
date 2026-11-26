import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Les accords de l'utilisateur : une commande qu'il autorise lui-même (le bouton « Autoriser » du panneau, ou /nuit repondre N Autoriser tapé par lui) est
// retenue en mémoire du module, jamais dans un fichier, et jointe à l'appel de la garde : le noyau ne laisse passer une commande autorisée que si elle est
// attestée ainsi. Un agent peut écrire la boîte ou lancer le script dans son shell : il ne peut pas écrire dans la mémoire du module.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-04T00:10:00.000Z')
const MIN = 60_000
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const PANNEAU = { title: 'Nuit', isFocused: false, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const ENV = { COCKPIT_DIR: 'C:/travail/etat-a', AML_PLUGIN_DIR: 'C:/outils/ledger' }
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const iso = (ms: number) => new Date(ms).toISOString()
const ACTIVE = JSON.stringify({ actif: true, mode: 'nuit', depuis: iso(DEBUT - 10 * MIN), tours: 3, maxTours: 60 })
const ENTREE = (id: number, extra: object = {}) => ({ id, agent: 'claude', session: 'S1', type: 'action', ajoute: iso(DEBUT - 5 * MIN), titre: 'Commande en attente d\'accord : git push', details: '', options: [{ label: 'Autoriser', description: '' }, { label: 'Refuser', description: '' }], statut: 'en-attente', reponse: null, traite: null, ...extra })
const sortie = (valeur: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(valeur), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Appel = { operation: string; entree: Record<string, unknown> }

// Le monde simulé : la nuit active, une boîte, et le noyau. La réponse du noyau à une commande /nuit repondre N <texte> est une décision notée (effet « reponse »)
// dont la forme est celle du noyau : le numéro, le texte, et l'entrée avec son type et son empreinte.
function monde(on: On, boite: object[] = [], typeEntree = 'action', variante: { effet?: string | null; empreinte?: unknown } = {}) {
  const etat = { appels: [] as Appel[], lectures: [] as string[], executees: [] as string[] }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, ENV)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'S1' }))
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    if (chemin === 'C:/travail/etat-a/nuit.json') return { value: ACTIVE }
    if (chemin === 'C:/travail/etat-a/nuit-boite.json') return { value: JSON.stringify({ prochain: 100, entrees: boite }) }
    return { deny: 'ENOENT: fichier absent' }
  })
  on('process.run', (_$, e) => {
    const operation = e.argv[3] ?? ''
    const entree = JSON.parse(e.init?.stdin ?? '{}') as Record<string, unknown>
    etat.appels.push({ operation, entree })
    if (operation === 'commande') {
      const [, id, ...mots] = String(entree.args ?? '').split(' ')
      const texte = mots.join(' ')
      const empreinte = 'empreinte' in variante ? variante.empreinte : `EMPREINTE-${id}`
      return sortie({ message: `Boîte : réponse notée pour la commande n° ${id}.`, effet: variante.effet === undefined ? 'reponse' : variante.effet, prompt: `NUIT : décision ${texte}.`, reponse: { id: Number(id), texte, entree: { type: typeEntree, empreinte } } })
    }
    if (operation === 'garde') {
      const autorisees = (entree.autorisees ?? []) as { id: number }[]
      return sortie(autorisees.length > 0 ? { refuser: false, autorisee: autorisees[0]?.id } : { refuser: false })
    }
    return sortie({ refuser: false })
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.call', (_$, e) => {
    etat.executees.push(e.tool)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  return Object.assign(etat, { horloge })
}

const ORIGINES = { composer: { kind: 'composer' }, plugin: { kind: 'plugin', name: 'autre' } } as const
const commande = ($: Engine, args: string, origine: keyof typeof ORIGINES = 'composer') => $.command.run({ command: 'nuit', args, origin: ORIGINES[origine] } as never)
const shell = ($: Engine, cmd = 'git push origin main') => ($.tool as unknown as { call: (e: object) => Promise<{ deny?: string; text?: string }> }).call({ tool: 'Bash', command: cmd })
const gardes = (etat: { appels: Appel[] }) => etat.appels.filter(a => a.operation === 'garde').map(a => a.entree)
const monter = ($: Engine) => $.ui.mount({ plugin: 'nuit', surface: 'terminal', component: 'Pane', requestId: 'nuit', props: PANNEAU })

describe('accord tapé par l utilisateur', () => {
  test('/nuit repondre N Autoriser tapé au clavier est joint à l appel de la garde, une seule fois', async ($, on) => {
    const etat = monde(on)
    await commande($, 'repondre 4 Autoriser')
    await shell($)
    await shell($)
    expect(gardes(etat)[0]?.autorisees).toEqual([{ id: 4, empreinte: 'EMPREINTE-4' }])
    expect(gardes(etat)[1]?.autorisees).toBeUndefined()
  })

  test('la même commande lancée par un autre plugin n atteste rien', async ($, on) => {
    const etat = monde(on)
    await commande($, 'repondre 5 Autoriser', 'plugin')
    await shell($)
    expect(gardes(etat)[0]).not.toHaveProperty('autorisees')
  })

  test('une réponse qui n est pas « Autoriser » n atteste rien', async ($, on) => {
    const etat = monde(on)
    await commande($, 'repondre 6 Refuser')
    await shell($)
    expect(gardes(etat)[0]).not.toHaveProperty('autorisees')
  })

  test('une réponse du noyau qui n est pas une décision notée (sans effet « reponse ») n atteste rien', async ($, on) => {
    const etat = monde(on, [], 'action', { effet: null })
    await commande($, 'repondre 8 Autoriser')
    await shell($)
    expect(gardes(etat)[0]).not.toHaveProperty('autorisees')
  })

  test('une entrée du noyau sans empreinte de texte n atteste rien', async ($, on) => {
    const etat = monde(on, [], 'action', { empreinte: 12 })
    await commande($, 'repondre 9 Autoriser')
    await shell($)
    expect(gardes(etat)[0]).not.toHaveProperty('autorisees')
  })

  test('sans accord retenu, l appel de la garde n a pas de clé autorisees', async ($, on) => {
    const etat = monde(on)
    await shell($)
    expect(gardes(etat)[0]).toEqual({ agent: 'claude', session: 'S1', tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
  })

  test('cinquante accords au plus sont retenus : le plus ancien est oublié au cinquante et unième', async ($, on) => {
    const etat = monde(on)
    for (let id = 100; id < 151; id++) await commande($, `repondre ${id} Autoriser`)
    await shell($)
    const retenus = (gardes(etat)[0]?.autorisees ?? []) as { id: number }[]
    expect(retenus).toHaveLength(50)
    expect(retenus[0]?.id).toBe(101)
    expect(retenus.at(-1)?.id).toBe(150)
  })
})

describe('accord donné par le bouton du panneau', () => {
  test('le bouton Autoriser d une commande à valider atteste l accord', async ($, on) => {
    const etat = monde(on, [ENTREE(4)])
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const ui = await monter($)
    await ui.press({ key: 'rep-4-0' })
    await shell($)
    expect(gardes(etat)[0]?.autorisees).toEqual([{ id: 4, empreinte: 'EMPREINTE-4' }])
    await ui.unmount()
  })

  test('le bouton Refuser n atteste rien', async ($, on) => {
    const etat = monde(on, [ENTREE(4)])
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const ui = await monter($)
    await ui.press({ key: 'rep-4-1' })
    await shell($)
    expect(gardes(etat)[0]).not.toHaveProperty('autorisees')
    await ui.unmount()
  })

  test('une question qui reçoit « Autoriser » n est pas un accord : seule une commande l est', async ($, on) => {
    const etat = monde(on, [ENTREE(4, { type: 'question', options: [{ label: 'Autoriser', description: '' }] })], 'question')
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const ui = await monter($)
    await ui.press({ key: 'rep-4-0' })
    await shell($)
    expect(gardes(etat)[0]).not.toHaveProperty('autorisees')
    await ui.unmount()
  })
})

describe('récap et comptes du panneau', () => {
  test('l entête des comptes est en gras', async ($, on) => {
    const etat = monde(on, [ENTREE(4)])
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const ui = await monter($)
    const entete = await ui.find({ type: 'Text', text: '1 à traiter, 0 en historique' })
    expect(entete?.props.bold).toBe(true)
    await ui.unmount()
  })

  test('avant la première lecture, le panneau le dit et n affiche aucun compte', async ($, on) => {
    monde(on, [ENTREE(4)])
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: 'Nuit : lecture en cours' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /à traiter/ })).toBeUndefined()
    await ui.unmount()
  })

  test('le récap du panneau ne répète pas la liste « À décider » : chaque question a son bloc', async ($, on) => {
    const etat = monde(on, [ENTREE(4, { type: 'question', titre: 'Quel nom ?' })])
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: /^À décider/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '4. [question] Quel nom ?' })).toBeDefined()
    await ui.unmount()
  })
})

describe('lot de questions', () => {
  test('les questions posées ensemble portent le même lot, dit après le type', async ($, on) => {
    const etat = monde(on, [ENTREE(1, { type: 'question', titre: 'Quel nom ?', lot: 2 }), ENTREE(2, { type: 'question', titre: 'Sans lot ?' })])
    await $.session.start(DEMARRAGE)
    await etat.horloge.settle()
    const ui = await monter($)
    await ui.select({ key: 'entree', value: '1' })
    expect(await ui.find({ type: 'Text', text: '1. [question, lot 2] Quel nom ?' })).toBeDefined()
    await ui.select({ key: 'entree', value: '2' })
    expect(await ui.find({ type: 'Text', text: '2. [question] Sans lot ?' })).toBeDefined()
    await ui.unmount()
  })
})
