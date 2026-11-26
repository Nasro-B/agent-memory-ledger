import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

// Le dossier d'état du Cockpit et le dossier du plugin que le moteur de test donne au module par COCKPIT_DIR et AML_PLUGIN_DIR (emplacements-logique.mjs).
const DOSSIER = 'C:/travail/cockpit'
const ENV = { COCKPIT_DIR: DOSSIER, AML_PLUGIN_DIR: 'C:/outils/ledger' }
const FICHIER = `${DOSSIER}/politique-agents.json`
const FICHIER_MODELES = `${DOSSIER}/modeles-agents.json`
const DEBUT = Date.parse('2026-03-02T22:00:00.000Z')
const SPAWN = { prompt: 'Fais le travail A', description: 'travail A', subagentType: 'general-purpose' }
// Le moteur de test remplit lui-même ce que l'appel laisse de côté (origine, présentation, identifiants) : on le dit au typage.
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const lancement = ($: Engine) => $.agent.spawn(SPAWN as never)
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }
const BASE = [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }]

// Le moteur donne aux hooks le chemin Windows natif (barres obliques inverses) : on compare en barres obliques.
const normal = (chemin: string) => chemin.replace(/\\/g, '/')

type Agent = { id: string; status: string }
const agent = (status: string, i = 0): Agent => ({ id: `a${i}`, status })

// Le monde simulé sous la mod : le fichier de politique, la liste des agents, ce que le moteur répond au lancement.
function monde(on: On, init: { fichier?: string | null; modeles?: string | null; agents?: Agent[] | 'panne' } = {}) {
  const etat = {
    fichier: init.fichier ?? null,
    modeles: init.modeles ?? null,
    agents: init.agents ?? [],
    chemins: [] as string[],
    ecritures: [] as { path: string; text: string }[],
    lancements: 0,
    modelesLances: [] as (string | undefined)[],
    listes: 0,
    commandes: [] as string[],
  }
  mock.clock(on, { now: DEBUT })
  mock.env(on, ENV)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ value: { prochain: 1, entrees: [], relances: {} } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    etat.commandes.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.chemins.push(chemin)
    if (chemin === FICHIER) return etat.fichier === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.fichier }
    if (chemin === FICHIER_MODELES) return etat.modeles === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.modeles }
    return { deny: `chemin inattendu : ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    if (normal(e.path) === FICHIER_MODELES) return { deny: 'la politique des modeles est en lecture seule pour le Regulateur' }
    etat.ecritures.push({ path: normal(e.path), text: e.text })
    etat.fichier = e.text
    return { value: undefined }
  })
  on('agent.list', () => {
    etat.listes++
    return etat.agents === 'panne' ? { deny: 'liste indisponible' } : { value: etat.agents as never }
  })
  on('agent.spawn', (_$, e) => {
    etat.lancements++
    etat.modelesLances.push(e.model)
    return { model: 'm', agentId: `nouveau${etat.lancements}` }
  })
  on('prompt.compose', () => ({ sections: BASE }))
  return etat
}

const politique = (max: number | null, pause = false, relance = false) => JSON.stringify({ max, pause, relance, maj: '2026-03-02T20:00:00.000Z' })

describe('refus au lancement', () => {
  test('sans fichier de politique, tout lancement passe et la liste des agents n est même pas lue', async ($, on) => {
    const m = monde(on, { agents: [agent('running'), agent('running', 1)] })
    const r = await lancement($)
    expect(r.deny).toBeUndefined()
    expect(m.lancements).toBe(1)
    expect(m.listes).toBe(0)
    expect(m.modelesLances).toEqual([undefined])
  })

  test('sous le maximum, le lancement passe', async ($, on) => {
    const m = monde(on, { fichier: politique(3), agents: [agent('running'), agent('pending', 1)] })
    const r = await lancement($)
    expect(r.deny).toBeUndefined()
    expect(m.lancements).toBe(1)
  })

  test('au maximum, le lancement est refusé avec les chiffres, et rien ne démarre', async ($, on) => {
    const m = monde(on, { fichier: politique(3), agents: [agent('running'), agent('running', 1), agent('waiting', 2), agent('completed', 3), agent('failed', 4), agent('idle', 5)] })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : 3 agents en cours sur 3 /)
    expect(r.deny).toMatch(/dès qu'un agent finit, lance le suivant/)
    expect(m.lancements).toBe(0)
  })

  test('en pause, le lancement est refusé même sans aucun agent', async ($, on) => {
    const m = monde(on, { fichier: politique(null, true), agents: [] })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : en pause\./)
    expect(m.lancements).toBe(0)
  })

  test('un fichier abîmé ou mal typé est une politique inerte', async ($, on) => {
    const m = monde(on, { fichier: null, agents: [agent('running'), agent('running', 1), agent('running', 2)] })
    let attendus = 0
    for (const fichier of ['{pas du json', '[]', '"x"', 'null', '', JSON.stringify({ max: 'cinq', pause: 'oui' })]) {
      m.fichier = fichier
      const r = await lancement($)
      expect(r.deny).toBeUndefined()
      attendus++
      expect(m.lancements).toBe(attendus)
    }
    expect(m.listes).toBe(0)
  })

  test('si la liste des agents est indisponible, le plafond laisse passer (le Régulateur ne bloque pas sur une panne), la pause refuse', async ($, on) => {
    const m = monde(on, { fichier: politique(1), agents: 'panne' })
    expect((await lancement($)).deny).toBeUndefined()
    expect(m.lancements).toBe(1)
    m.fichier = politique(1, true)
    expect((await lancement($)).deny).toMatch(/en pause/)
    expect(m.lancements).toBe(1)
  })

  test('seuls les fichiers de politique et de modeles sont lus', async ($, on) => {
    const m = monde(on, { fichier: politique(1), agents: [] })
    await lancement($)
    await commande($, 'plafond', '')
    expect(m.chemins.length).toBeGreaterThan(0)
    expect([...new Set(m.chemins)]).toEqual([FICHIER_MODELES, FICHIER])
  })

  test('le modele global et le type exact sont appliques avant le lancement', async ($, on) => {
    const m = monde(on, { modeles: JSON.stringify({ defaut: 'sonnet', parType: { Explore: 'haiku' } }) })
    await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
    await lancement($)
    expect(m.modelesLances).toEqual(['haiku', 'sonnet'])
    expect(m.ecritures).toHaveLength(0)
  })

  test('un modele explicite et un fork ne sont pas modifies', async ($, on) => {
    const m = monde(on, { modeles: JSON.stringify({ defaut: 'sonnet' }) })
    await $.agent.spawn({ ...SPAWN, model: 'opus' } as never)
    await $.agent.spawn({ ...SPAWN, fork: true } as never)
    expect(m.modelesLances).toEqual(['opus', undefined])
    expect(m.chemins.filter(x => x === FICHIER_MODELES)).toHaveLength(0)
  })

  test('un fichier de modeles abime laisse le choix natif', async ($, on) => {
    const m = monde(on, { modeles: '{abime' })
    await lancement($)
    expect(m.modelesLances).toEqual([undefined])
    expect(m.ecritures).toHaveLength(0)
  })
})

describe('rappel dans le prompt système', () => {
  const composer = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.prompt.compose({ ...COMPOSE })

  test('politique inerte : le prompt est celui du moteur, tel quel', async ($, on) => {
    monde(on)
    const r = await composer($)
    expect(r.sections).toEqual(BASE)
  })

  test('plafond : une section de session est ajoutée à la fin, avec le texte stable', async ($, on) => {
    monde(on, { fichier: politique(5, false, true) })
    const r = await composer($)
    expect(r.sections).toHaveLength(2)
    expect(r.sections[0]).toEqual(BASE[0])
    expect(r.sections[1]).toEqual({
      id: 'regulateur:politique',
      scope: 'session',
      text: "RÉGULATEUR D'AGENTS (ordre de l'utilisateur, valable après compactage) : Maximum 5 agents en parallèle. Dès qu'un agent finit, lance le suivant de ta liste sans attendre ; si le maximum est atteint, n'en lance pas avant qu'un finisse. Relance activée : un agent échoué se relance depuis son point d'arrêt, 2 fois au plus chacun.",
    })
  })

  test('le texte ne dépend pas du nombre d agents (le cache du prompt reste valable)', async ($, on) => {
    const m = monde(on, { fichier: politique(5), agents: [] })
    const a = (await composer($)).sections[1]?.text
    m.agents = [agent('running'), agent('running', 1), agent('running', 2)]
    const b = (await composer($)).sections[1]?.text
    expect(a).toBeDefined()
    expect(b).toBe(a)
  })

  test('pause : le rappel dit la pause', async ($, on) => {
    monde(on, { fichier: politique(5, true) })
    const r = await composer($)
    expect(r.sections[1]?.text).toMatch(/PAUSE : ne lance aucun agent/)
  })

  test('le rappel suit un changement de la politique sans rechargement', async ($, on) => {
    const m = monde(on, { fichier: politique(5) })
    expect((await composer($)).sections).toHaveLength(2)
    m.fichier = politique(null)
    expect((await composer($)).sections).toHaveLength(1)
  })
})

describe('commande /plafond', () => {
  test('est enregistrée au démarrage de la session', async ($, on) => {
    const m = monde(on)
    await $.session.start({ cwd: 'C:/x', surface: 'terminal', isInteractive: true })
    expect(m.commandes).toEqual(['plafond'])
  })

  test('un nombre fixe le plafond, l écrit dans le fichier partagé et répond par le message', async ($, on) => {
    const m = monde(on)
    const r = await commande($, 'plafond', '5')
    expect(r.text).toBe('Agents : maximum 5 en parallèle.')
    expect(m.ecritures).toHaveLength(1)
    expect(m.ecritures[0]?.path).toBe(FICHIER)
    expect(JSON.parse(m.ecritures[0]?.text ?? '{}')).toEqual({ max: 5, pause: false, relance: false, file: false, maj: '2026-03-02T22:00:00.000Z' })
  })

  test('pause puis reprendre : la politique garde le plafond', async ($, on) => {
    const m = monde(on, { fichier: politique(4) })
    await commande($, 'plafond', 'pause')
    expect(JSON.parse(m.fichier ?? '{}')).toMatchObject({ max: 4, pause: true })
    const r = await commande($, 'plafond', 'reprendre')
    expect(r.text).toBe('Agents : reprise, maximum 4 en parallèle.')
    expect(JSON.parse(m.fichier ?? '{}')).toMatchObject({ max: 4, pause: false })
  })

  test('sans argument : l état avec le nombre réel d agents en cours, sans rien écrire', async ($, on) => {
    const m = monde(on, { fichier: politique(5), agents: [agent('running'), agent('pending', 1), agent('running', 2), agent('completed', 3)] })
    const r = await commande($, 'plafond', '')
    expect(r.text).toBe('Agents : maximum 5, 3 en cours (2 créneaux libres). Relance des échoués : non. File : non.')
    expect(m.ecritures).toHaveLength(0)
  })

  test('une commande qui ne change rien n écrit rien', async ($, on) => {
    const m = monde(on, { fichier: politique(5) })
    await commande($, 'plafond', '5')
    expect(m.ecritures).toHaveLength(0)
  })

  test('une commande invalide donne l usage et n écrit rien', async ($, on) => {
    const m = monde(on, { fichier: politique(5) })
    const r = await commande($, 'plafond', 'abc')
    expect(r.text).toMatch(/^Usage : \/plafond /)
    expect(m.ecritures).toHaveLength(0)
  })

  test('la commande marche même si la liste des agents est indisponible', async ($, on) => {
    monde(on, { agents: 'panne' })
    const r = await commande($, 'plafond', '')
    expect(r.text).toBe('Agents : libre. Relance des échoués : non. File : non.')
  })

  test('libre supprime le plafond et la pause', async ($, on) => {
    const m = monde(on, { fichier: politique(3, true, true) })
    const r = await commande($, 'plafond', 'libre')
    expect(r.text).toBe('Agents : libre, aucun maximum.')
    expect(JSON.parse(m.fichier ?? '{}')).toMatchObject({ max: null, pause: false, relance: true })
  })
})
