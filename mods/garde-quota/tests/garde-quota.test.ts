import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

// Le dossier d'état du Cockpit que le moteur de test donne au module par COCKPIT_DIR (emplacements-logique.mjs).
const COCKPIT = 'C:/travail/cockpit'
const CONFIG = `${COCKPIT}/garde-quota.json`
const QUOTA = `${COCKPIT}/quota-claude.json`
const DEBUT = Date.parse('2026-03-03T12:00:00.000Z')
const MIN = 60_000
const H = 60 * MIN
const J = 24 * H
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }
const BASE = [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }]
const SPAWN = { prompt: 'Fais le travail A', description: 'travail A', subagentType: 'general-purpose' }
// Le moteur de test remplit lui-même ce que l'appel laisse de côté (origine, présentation, identifiants) : on le dit au typage.
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const lancement = ($: Engine) => $.agent.spawn(SPAWN as never)
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }

// Le moteur donne aux hooks le chemin Windows natif (barres obliques inverses) : on compare en barres obliques.
const normal = (chemin: string) => chemin.replace(/\\/g, '/')

type Limite = { kind: string; percentUsed: number; resetsAt?: string }
const limite = (kind: string, percentUsed: number, dansMs?: number): Limite => ({ kind, percentUsed, ...(dansMs === undefined ? {} : { resetsAt: new Date(DEBUT + dansMs).toISOString() }) })
const mesure = (rateLimits: Limite[], changed: ('context' | 'rateLimits' | 'cost')[] = ['rateLimits']) => ({ context: { window: 200_000 }, rateLimits, changed })

// Le monde simulé sous la mod : les réglages de l'utilisateur, les fenêtres que le moteur mesure, ce que la mod montre ou lance.
function monde(on: On, init: { config?: string | null; limites?: Limite[] | 'panne'; ecritureEchoue?: boolean; sonLent?: boolean; sonEchoue?: boolean } = {}) {
  const etat = {
    config: init.config ?? null,
    limites: init.limites ?? ([] as Limite[] | 'panne'),
    ecritures: [] as { path: string; text: string }[],
    toasts: [] as string[],
    delaisToasts: [] as (number | undefined)[],
    delaisSons: [] as (number | undefined)[],
    statuts: [] as (string | undefined)[],
    sons: [] as string[][],
    commandes: [] as string[],
    store: new Map<string, unknown>(),
    lancements: 0,
  }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, { COCKPIT_DIR: COCKPIT })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    etat.commandes.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.read', (_$, e) => {
    if (normal(e.path) !== CONFIG) return { deny: `chemin inattendu : ${e.path}` }
    return etat.config === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.config }
  })
  on('fs.write', (_$, e) => {
    if (init.ecritureEchoue === true) return { deny: 'disque plein' }
    etat.ecritures.push({ path: normal(e.path), text: e.text })
    if (normal(e.path) === CONFIG) etat.config = e.text
    return { value: undefined }
  })
  on('session.usage', () => (etat.limites === 'panne' ? { deny: 'indisponible' } : { value: { startedAt: DEBUT, context: { window: 200_000 }, rateLimits: etat.limites } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', (_$, e) => {
    etat.toasts.push(e.text)
    etat.delaisToasts.push(e.timeoutMs)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    etat.sons.push([...e.argv])
    etat.delaisSons.push(e.init?.timeoutMs)
    if (init.sonEchoue === true) return { deny: 'powershell introuvable' }
    if (init.sonLent === true) await horloge.sleep(60 * 60_000)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', (_$, e) => ({ value: etat.store.get(e.key) }))
  on('store.set', (_$, e) => {
    etat.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('agent.spawn', () => {
    etat.lancements++
    return { model: 'm', agentId: `a${etat.lancements}` }
  })
  on('prompt.compose', () => ({ sections: BASE }))
  return { etat, horloge }
}

const reglages = (c: object) => JSON.stringify(c)

describe('démarrage', () => {
  test('enregistre la commande /quota et montre les fenêtres dès le démarrage', async ($, on) => {
    const { etat } = monde(on, { limites: [limite('five_hour', 12, 2 * H), limite('seven_day', 71, 3 * J)] })
    await $.session.start(DEMARRAGE)
    expect(etat.commandes).toEqual(['quota'])
    expect(etat.statuts.at(-1)).toBe('5 h 12 % (remise à zéro dans 2 h 00) | 7 j 71 % (remise à zéro dans 3 j 0 h)')
  })

  test('sans mesure, la ligne de statut est effacée', async ($, on) => {
    const { etat } = monde(on)
    await $.session.start(DEMARRAGE)
    expect(etat.statuts).toEqual([undefined])
  })

  test('avec des fenêtres indisponibles, le démarrage se fait quand même et la ligne de statut est effacée', async ($, on) => {
    const { etat } = monde(on, { limites: 'panne' })
    await $.session.start(DEMARRAGE)
    expect(etat.commandes).toEqual(['quota'])
    expect(etat.statuts).toEqual([undefined])
  })
})

describe('mesure du quota', () => {
  test('chaque mesure est écrite pour le Cockpit et pour Codex, et la ligne de statut la montre', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([limite('seven_day', 71.64, 3 * J), limite('five_hour', 12, 2 * H)]))
    expect(etat.ecritures).toHaveLength(1)
    expect(etat.ecritures[0]?.path).toBe(QUOTA)
    expect(JSON.parse(etat.ecritures[0]?.text ?? '{}')).toEqual({
      fenetres: [
        { nom: '5 h', pct: 12, resetsAt: new Date(DEBUT + 2 * H).toISOString() },
        { nom: '7 j', pct: 71.6, resetsAt: new Date(DEBUT + 3 * J).toISOString() },
      ],
      mesureA: '2026-03-03T12:00:00.000Z',
      source: 'garde-quota',
    })
    expect(etat.statuts.at(-1)).toBe('5 h 12 % (remise à zéro dans 2 h 00) | 7 j 72 % (remise à zéro dans 3 j 0 h)')
  })

  test('une mesure sans fenêtre n écrit rien : la dernière mesure n est pas remplacée par du vide', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([]))
    expect(etat.ecritures).toHaveLength(0)
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('une mesure où le quota n a pas bougé (contexte ou coût seuls) ne fait rien', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)], ['context', 'cost']))
    expect(etat.ecritures).toHaveLength(0)
    expect(etat.toasts).toEqual([])
    expect(etat.statuts).toEqual([])
  })

  test('l écriture du fichier partagé qui échoue ne gêne ni la ligne de statut ni les annonces', async ($, on) => {
    const { etat } = monde(on, { ecritureEchoue: true })
    await $.session.measure(mesure([limite('five_hour', 85, 2 * H)]))
    expect(etat.statuts.at(-1)).toBe('5 h 85 % ATTENTION (remise à zéro dans 2 h 00)')
    expect(etat.toasts).toHaveLength(1)
  })
})

describe('annonces', () => {
  test('l attention est annoncée une fois, avec un son, puis plus tant que la période ne change pas', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([limite('seven_day', 82, 3 * J)]))
    expect(etat.toasts).toEqual(['Quota 7 j à 82 % : attention (remise à zéro dans 3 j 0 h)'])
    expect(etat.sons).toHaveLength(1)
    expect(etat.sons[0]).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command', '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 1500'])
    expect(etat.delaisSons).toEqual([10_000])
    expect(etat.delaisToasts).toEqual([15_000])
    await $.session.measure(mesure([limite('seven_day', 84, 3 * J)]))
    expect(etat.toasts).toHaveLength(1)
    expect(etat.sons).toHaveLength(1)
  })

  test('un son qui ne peut pas être joué ne gêne ni l annonce ni la suite, et ne laisse aucun rejet non géré', async ($, on) => {
    const { etat } = monde(on, { sonEchoue: true })
    await $.session.measure(mesure([limite('five_hour', 85, 2 * H)]))
    expect(etat.toasts).toEqual(['Quota 5 h à 85 % : attention (remise à zéro dans 2 h 00)'])
    expect(etat.statuts.at(-1)).toBe('5 h 85 % ATTENTION (remise à zéro dans 2 h 00)')
    expect(etat.sons).toHaveLength(1)
  })

  test('le critique est annoncé à son tour, avec un autre son et le blocage dit', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([limite('seven_day', 82, 3 * J)]))
    await $.session.measure(mesure([limite('seven_day', 91, 3 * J)]))
    expect(etat.toasts.at(-1)).toBe('Quota 7 j à 91 % : seuil critique, nouveaux agents bloqués (remise à zéro dans 3 j 0 h)')
    expect(etat.sons).toHaveLength(2)
    expect(etat.sons[1]?.[4]).toContain('SystemSounds]::Hand.Play()')
  })

  test('les annonces survivent à un rechargement : la mémoire est dans le magasin de la mod', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([limite('seven_day', 82, 3 * J)]))
    expect(etat.store.get('deja')).toEqual([`7 j|${new Date(DEBUT + 3 * J).toISOString()}|attention`])
    etat.toasts.length = 0
    await $.session.measure(mesure([limite('seven_day', 83, 3 * J)]))
    expect(etat.toasts).toEqual([])
  })

  test('sans son dans les réglages, les annonces restent à l écran et aucun son n est lancé', async ($, on) => {
    const { etat } = monde(on, { config: reglages({ son: false }) })
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)]))
    expect(etat.toasts).toHaveLength(1)
    expect(etat.sons).toEqual([])
  })

  test('les seuils des réglages sont ceux qui comptent', async ($, on) => {
    const { etat } = monde(on, { config: reglages({ attention: 50, critique: 60 }) })
    await $.session.measure(mesure([limite('five_hour', 55, 2 * H)]))
    expect(etat.toasts).toEqual(['Quota 5 h à 55 % : attention (remise à zéro dans 2 h 00)'])
  })
})

describe('remise à zéro', () => {
  test('une fenêtre haute que la mesure donne ensuite basse est annoncée, avec un son, et la consigne de relance reste 30 minutes', async ($, on) => {
    const { etat, horloge } = monde(on)
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)]))
    await horloge.advance(3 * H)
    etat.limites = [limite('five_hour', 3, 8 * H)]
    etat.toasts.length = 0
    etat.sons.length = 0
    await $.session.measure(mesure(etat.limites))
    expect(etat.toasts).toEqual(['Quota remis à zéro : 5 h'])
    expect(etat.sons).toHaveLength(1)
    expect(etat.sons[0]?.[4]).toContain('SystemSounds]::Asterisk.Play()')
    expect(etat.store.get('hauts')).toEqual([])
    const r = await $.prompt.compose({ ...COMPOSE })
    expect(r.sections.at(-1)?.id).toBe('garde-quota:remise')
    expect(r.sections.at(-1)?.scope).toBe('session')
    expect(r.sections.at(-1)?.text).toMatch(/^GARDE-QUOTA : la fenêtre 5 h est remise à zéro\./)
    await horloge.advance(31 * MIN)
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })

  test('sans son dans les réglages, la remise à zéro est annoncée sans son', async ($, on) => {
    const { etat, horloge } = monde(on, { config: reglages({ son: false }) })
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)]))
    await horloge.advance(3 * H)
    etat.sons.length = 0
    await $.session.measure(mesure([limite('five_hour', 3, 8 * H)]))
    expect(etat.toasts.at(-1)).toBe('Quota remis à zéro : 5 h')
    expect(etat.sons).toEqual([])
  })

  test('sans consigne dans les réglages, la remise à zéro est annoncée à l écran mais n ajoute aucune section au prompt', async ($, on) => {
    const { etat, horloge } = monde(on, { config: reglages({ consigne: false }) })
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)]))
    await horloge.advance(3 * H)
    await $.session.measure(mesure([limite('five_hour', 3, 8 * H)]))
    expect(etat.toasts.at(-1)).toBe('Quota remis à zéro : 5 h')
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })

  test('rien n est annoncé tant que la fenêtre reste haute', async ($, on) => {
    const { etat } = monde(on)
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)]))
    etat.toasts.length = 0
    await $.session.measure(mesure([limite('five_hour', 96, 2 * H)]))
    expect(etat.toasts).toEqual([])
    expect(etat.store.get('remise')).toBeUndefined()
  })
})

describe('lancement d un agent', () => {
  test('autorisé tant qu aucune fenêtre n est au seuil critique, même à l attention', async ($, on) => {
    const { etat } = monde(on, { limites: [limite('five_hour', 89, 2 * H)] })
    const r = await lancement($)
    expect(r.deny).toBeUndefined()
    expect(etat.lancements).toBe(1)
  })

  test('refusé au seuil critique, avec la fenêtre, les chiffres et le temps restant, et rien ne démarre', async ($, on) => {
    const { etat } = monde(on, { limites: [limite('seven_day', 91, 2 * H + 5 * MIN)] })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Garde-quota : fenêtre 7 j à 91 % \(seuil 90 %\), remise à zéro dans 2 h 05\./)
    expect(etat.lancements).toBe(0)
  })

  test('autorisé quand le blocage est désactivé dans les réglages', async ($, on) => {
    const { etat } = monde(on, { config: reglages({ bloquerAgents: false }), limites: [limite('seven_day', 99, 2 * H)] })
    expect((await lancement($)).deny).toBeUndefined()
    expect(etat.lancements).toBe(1)
  })

  test('autorisé quand les fenêtres sont indisponibles : une panne de mesure ne bloque pas le travail', async ($, on) => {
    const { etat } = monde(on, { limites: 'panne' })
    expect((await lancement($)).deny).toBeUndefined()
    expect(etat.lancements).toBe(1)
  })

  test('autorisé quand la fenêtre critique est déjà remise à zéro (la date prévue est passée)', async ($, on) => {
    const { etat, horloge } = monde(on, { limites: [limite('five_hour', 95, 2 * H)] })
    await horloge.advance(3 * H)
    expect((await lancement($)).deny).toBeUndefined()
    expect(etat.lancements).toBe(1)
  })

  test('un fichier de réglages abîmé laisse les réglages par défaut : le blocage reste actif', async ($, on) => {
    const { etat } = monde(on, { config: '{pas du json', limites: [limite('seven_day', 95, 2 * H)] })
    expect((await lancement($)).deny).toMatch(/^Garde-quota/)
    expect(etat.lancements).toBe(0)
  })
})

describe('consigne dans le prompt système', () => {
  test('aucune section tant qu aucune fenêtre n est au seuil critique', async ($, on) => {
    monde(on, { limites: [limite('five_hour', 89, 2 * H)] })
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })

  test('une section de session est ajoutée à la fin au seuil critique, avec le texte stable', async ($, on) => {
    monde(on, { limites: [limite('five_hour', 91, 2 * H)] })
    const r = await $.prompt.compose({ ...COMPOSE })
    expect(r.sections).toHaveLength(2)
    expect(r.sections[0]).toEqual(BASE[0])
    expect(r.sections[1]).toEqual({
      id: 'garde-quota:critique',
      scope: 'session',
      text: `GARDE-QUOTA (ordre de l'utilisateur, valable après compactage) : fenêtre 5 h au-delà de 90 %. Maintenant : journalise ce qui est fait (history et Memory-Auto), commite les fichiers attribués (jamais de push), écris le prompt de relais pour Codex dans ${COCKPIT}/relais-codex.md, puis ne lance plus d'agent avant la remise à zéro.`,
    })
  })

  test('le texte ne dépend ni du pourcentage ni de l heure (le cache du prompt reste valable)', async ($, on) => {
    const { etat, horloge } = monde(on, { limites: [limite('five_hour', 91, 2 * H)] })
    const a = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text
    etat.limites = [limite('five_hour', 97.4, 2 * H)]
    await horloge.advance(7 * MIN)
    expect((await $.prompt.compose({ ...COMPOSE })).sections[1]?.text).toBe(a)
  })

  test('sans consigne dans les réglages, le prompt est celui du moteur', async ($, on) => {
    monde(on, { config: reglages({ consigne: false }), limites: [limite('five_hour', 99, 2 * H)] })
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })
})

describe('commande /quota', () => {
  test('sans argument : les réglages puis les fenêtres du moment, sans rien écrire', async ($, on) => {
    const { etat } = monde(on, { limites: [limite('five_hour', 12, 2 * H)] })
    const r = await commande($, 'quota', '')
    expect(r.text).toBe('Quota : seuils 80 % puis 90 %. Blocage des agents : oui. Consigne au modèle : oui. Son : oui.\n5 h 12 % (remise à zéro dans 2 h 00)')
    expect(etat.ecritures).toHaveLength(0)
  })

  test('sans fenêtre mesurée, seule la ligne des réglages est rendue', async ($, on) => {
    monde(on)
    const r = await commande($, 'quota', 'etat')
    expect(r.text).toBe('Quota : seuils 80 % puis 90 %. Blocage des agents : oui. Consigne au modèle : oui. Son : oui.')
  })

  test('deux nombres fixent les seuils et les écrivent dans le fichier de réglages', async ($, on) => {
    const { etat } = monde(on)
    const r = await commande($, 'quota', '70 85')
    expect(r.text).toBe('Quota : seuils 70 % puis 85 %.')
    expect(etat.ecritures).toHaveLength(1)
    expect(etat.ecritures[0]?.path).toBe(CONFIG)
    expect(JSON.parse(etat.ecritures[0]?.text ?? '{}')).toEqual({ attention: 70, critique: 85, bloquerAgents: true, consigne: true, son: true, maj: '2026-03-03T12:00:00.000Z' })
  })

  test('un réglage écrit change aussitôt le comportement de la mod', async ($, on) => {
    const { etat } = monde(on, { limites: [limite('five_hour', 95, 2 * H)] })
    expect((await lancement($)).deny).toMatch(/^Garde-quota/)
    await commande($, 'quota', 'bloquer off')
    expect((await lancement($)).deny).toBeUndefined()
    expect(etat.lancements).toBe(1)
    await commande($, 'quota', 'bloquer on')
    expect((await lancement($)).deny).toMatch(/^Garde-quota/)
  })

  test('une commande qui ne change rien n écrit rien, une commande invalide donne l usage', async ($, on) => {
    const { etat } = monde(on)
    await commande($, 'quota', '80 90')
    expect(etat.ecritures).toHaveLength(0)
    const r = await commande($, 'quota', '90 80')
    expect(r.text).toMatch(/^Usage : \/quota /)
    expect(etat.ecritures).toHaveLength(0)
  })

  test('defaut remet les réglages par défaut', async ($, on) => {
    const { etat } = monde(on, { config: reglages({ attention: 50, critique: 60, son: false }) })
    const r = await commande($, 'quota', 'defaut')
    expect(r.text).toBe('Quota : réglages remis aux valeurs par défaut.')
    expect(JSON.parse(etat.ecritures[0]?.text ?? '{}')).toMatchObject({ attention: 80, critique: 90, son: true })
  })

  test('la commande marche même si les fenêtres sont indisponibles', async ($, on) => {
    monde(on, { limites: 'panne' })
    expect((await commande($, 'quota', '')).text).toMatch(/^Quota : seuils 80 % puis 90 %\./)
  })
})

describe('fin de vie', () => {
  // Le test se termine alors que le son attend encore (horloge simulée immobile) : le runner décharge la mod.
  // Un son laissé en vol ne doit laisser aucun rejet derrière lui (le runner le signale en fin de fichier).
  test('un son encore en attente à la fin ne laisse aucun rejet non géré', async ($, on) => {
    const { horloge } = monde(on, { sonLent: true })
    await $.session.measure(mesure([limite('five_hour', 95, 2 * H)]))
    await horloge.settle()
  })
})
