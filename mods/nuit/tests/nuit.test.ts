import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { NuitSuivi } from '../types'

// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

// Le dossier d'état du Cockpit et le dossier du plugin que le moteur de test donne au module par COCKPIT_DIR et AML_PLUGIN_DIR (emplacements-logique.mjs).
const DOSSIER = 'C:/travail/cockpit'
const ENV = { COCKPIT_DIR: DOSSIER, AML_PLUGIN_DIR: 'C:/outils/ledger' }
const CLI = 'C:/outils/ledger/scripts/cockpit.js'
const FICHIER_ETAT = `${DOSSIER}/nuit.json`
const FICHIER_BOITE = `${DOSSIER}/nuit-boite.json`
const DEBUT = Date.parse('2026-03-04T00:10:00.000Z')
const MIN = 60 * 1000
const HEURE = 60 * MIN
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }
const BASE = [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }]
const PANNEAU = { title: 'Nuit', isFocused: false, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const SURFACES = ['terminal', 'desktop'] as const
const QUESTIONS = [{ question: 'Quel nom pour le mod ?', header: 'Nom', multiSelect: false, options: [{ label: 'Veilleur (Recommended)', description: 'court' }, { label: 'Nuit', description: 'direct' }] }]

const iso = (ms: number) => new Date(ms).toISOString()
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const sortie = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// Un état de la nuit écrit par le noyau : actif depuis dix minutes, par défaut.
const etatActif = (extra: object = {}) => JSON.stringify({ actif: true, mode: 'nuit', depuis: iso(DEBUT - 10 * MIN), tours: 3, maxTours: 60, ...extra })
const etatInactif = (extra: object = {}) => JSON.stringify({ actif: false, ...extra })
const entreeBoite = (id: number, extra: object = {}) => ({ id, agent: 'claude', session: 'S1', type: 'question', ajoute: iso(DEBUT - 5 * MIN), titre: 'Quel nom pour le mod ?', details: '', options: [{ label: 'Veilleur (Recommended)', description: 'court' }, { label: 'Nuit', description: '' }], statut: 'en-attente', reponse: null, traite: null, ...extra })
const boite = (entrees: object[]) => JSON.stringify({ prochain: 10, entrees })

// Le moteur de test remplit lui-même ce que l'appel laisse de côté (origine, présentation, identifiants) : on le dit au typage.
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
// Le typage de `$.tool.call` (une union de tous les outils) est trop profond pour une entrée construite ici : on lui donne la forme utile.
const outil = ($: Engine, tool: string, extra: object = {}) => ($.tool as unknown as { call: (e: object) => Promise<{ deny?: string }> }).call({ tool, ...extra })
const question = ($: Engine, extra: object = {}) => outil($, 'AskUserQuestion', { questions: QUESTIONS, ...extra })
const shell = ($: Engine, tool: 'Bash' | 'PowerShell', cmd: string, extra: object = {}) => outil($, tool, { command: cmd, ...extra })
const fini = ($: Engine, reason: 'answer' | 'aborted' | 'error' | 'refusal' = 'answer', agentId?: string) =>
  $.turn.complete({ answer: 'Terminé.', durationMs: 1000, isAborted: reason === 'aborted', turnId: 'tour-1', ...(agentId === undefined ? {} : { agentId }), reason, ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}) } as never)
// Un message de l'utilisateur (tapé au clavier, ou envoyé par Remote Control), ou d'une autre origine.
const message = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false } as never)

type Appel = { argv: string[]; operation: string; entree: Record<string, unknown>; delai: number | undefined }
type Reponse = unknown | ((entree: Record<string, unknown>) => unknown)

// Le monde simulé sous la mod : les deux fichiers du noyau, le noyau lui-même (ses réponses par opération), ce que la mod montre ou soumet.
function monde(on: On, init: { nuit?: string | null; boite?: string | null; session?: string } = {}) {
  const etat = {
    nuit: init.nuit ?? null,
    boite: init.boite ?? null,
    session: init.session ?? 'S1',
    reponses: {} as Record<string, Reponse>,
    brut: null as string | null,
    code: 0,
    stderr: '',
    panne: false,
    sessionEnPanne: false,
    refusPrompt: false,
    appels: [] as Appel[],
    soumis: [] as { text: string; context?: readonly string[]; origin: unknown }[],
    statuts: [] as (string | undefined)[],
    toasts: [] as string[],
    ouverts: [] as string[],
    titres: [] as string[],
    executees: [] as string[],
    commandes: [] as { name: string; description: string; argumentHint?: string }[],
    lectures: [] as string[],
  }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, ENV)
  on('session.start', (_$, e) => ({ cwd: `bas de chaîne : ${e.cwd}` }))
  on('command.register', (_$, e) => {
    etat.commandes.push({ name: e.name, description: e.description, argumentHint: e.argumentHint })
    return { value: { command: e.name } }
  })
  on('session.id', () => (etat.sessionEnPanne ? { deny: 'session introuvable' } : { value: etat.session }))
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    if (chemin === FICHIER_ETAT) return etat.nuit === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.nuit }
    if (chemin === FICHIER_BOITE) return etat.boite === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.boite }
    return { deny: `chemin inattendu : ${e.path}` }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const stdin = e.init?.stdin
    const entree = stdin === undefined ? {} : (JSON.parse(stdin) as Record<string, unknown>)
    const operation = argv[3] ?? ''
    etat.appels.push({ argv, operation, entree, delai: e.init?.timeoutMs })
    if (etat.panne) return { deny: 'spawn node ENOENT' }
    if (etat.brut !== null) return sortie(etat.brut, etat.code, etat.stderr)
    const r = etat.reponses[operation]
    const valeur = typeof r === 'function' ? (r as (entree: Record<string, unknown>) => unknown)(entree) : r
    return sortie(JSON.stringify(valeur ?? { refuser: false }), etat.code, etat.stderr)
  })
  on('prompt.submit', (_$, e) => {
    if (etat.refusPrompt) throw new Error('refused: no hooks module of that name is loaded')
    etat.soumis.push({ text: e.text, context: e.context, origin: e.origin })
    return { text: e.text, context: e.context }
  })
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    etat.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    etat.ouverts.push(e.id)
    etat.titres.push(e.title ?? '')
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('tool.call', (_$, e) => {
    etat.executees.push(e.tool)
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never
  })
  // Le bas de la chaîne marque sa réponse : un hook qui ne l'appelle pas (ou en perd le résultat) ne rend pas cette réponse.
  on('turn.complete', (_$, e) => ({ text: `${e.answer} [bas de chaîne]` }))
  on('prompt.compose', () => ({ sections: BASE }))
  const compter = (operation: string) => etat.appels.filter(a => a.operation === operation).length
  // Les messages que la mod soumet au modèle partent après le retour du hook qui les demande : l'horloge simulée les laisse partir.
  const soumisParLaMod = async () => {
    await horloge.settle()
    return etat.soumis.map(s => s.text)
  }
  return { etat, horloge, compter, soumisParLaMod }
}

describe('démarrage', () => {
  test('enregistre la commande /nuit ; sans fichier, aucune ligne de statut et aucun appel au noyau', async ($, on) => {
    const { etat } = monde(on)
    await $.session.start(DEMARRAGE)
    expect(etat.commandes).toHaveLength(1)
    expect(etat.commandes[0]?.name).toBe('nuit')
    expect(etat.commandes[0]?.description).toMatch(/^Nuit : questions en boîte/)
    expect(etat.commandes[0]?.argumentHint).toBe('[on | off | statut | recap | boite | ...]')
    expect(etat.statuts.at(-1)).toBeUndefined()
    expect(etat.appels).toEqual([])
  })

  test('une nuit active est dite dans la ligne de statut, avec les questions qui attendent', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1), entreeBoite(2, { statut: 'repondue', reponse: 'Nuit', traite: iso(DEBUT - MIN) })]) })
    await $.session.start(DEMARRAGE)
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 10 min : 3/60 enchaînements, 1 à décider')
  })

  test('hors nuit, les questions en boîte à décider sont annoncées', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif(), boite: boite([entreeBoite(1), entreeBoite(2)]) })
    await $.session.start(DEMARRAGE)
    expect(etat.statuts.at(-1)).toBe('Nuit : 2 à décider en boîte (/nuit boite)')
  })

  // PowerShell écrit volontiers un BOM en tête d'un fichier UTF-8 : les fichiers de la nuit doivent se lire avec.
  test('un BOM en tête des fichiers ne les rend pas illisibles', async ($, on) => {
    const { etat } = monde(on, { nuit: `${String.fromCharCode(0xfeff)}${etatActif()}`, boite: `${String.fromCharCode(0xfeff)}${boite([entreeBoite(1)])}` })
    await $.session.start(DEMARRAGE)
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 10 min : 3/60 enchaînements, 1 à décider')
    etat.reponses.question = { refuser: true, id: 1, texte: 'refus' }
    expect((await question($)).deny).toBe('refus')
  })

  test('des fichiers abîmés n empêchent pas le démarrage', async ($, on) => {
    const { etat } = monde(on, { nuit: '{pas du json', boite: '[]' })
    await $.session.start(DEMARRAGE)
    expect(etat.commandes).toHaveLength(1)
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('la ligne de statut suit les fichiers toutes les minutes', async ($, on) => {
    const { etat, horloge } = monde(on)
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.statuts.at(-1)).toBeUndefined()
    etat.nuit = etatActif({ depuis: iso(DEBUT) })
    await horloge.advance(59_000)
    expect(etat.statuts.at(-1)).toBeUndefined()
    await horloge.advance(1_000)
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 1 min : 3/60 enchaînements, 0 à décider')
  })
})

describe('chemin rapide : hors nuit, la mod ne coûte rien', () => {
  test('une question, une commande Bash ou PowerShell passent sans appeler le noyau', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif({ derniereActivite: iso(DEBUT - 5 * MIN) }) })
    expect((await question($)).deny).toBeUndefined()
    expect((await shell($, 'Bash', 'rm -rf dossier')).deny).toBeUndefined()
    expect((await shell($, 'PowerShell', 'Remove-Item -Recurse -Force x')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['AskUserQuestion', 'Bash', 'PowerShell'])
    expect(etat.appels).toEqual([])
  })

  test('sans fichier d état ou avec un état abîmé, rien n est détourné', async ($, on) => {
    const { etat } = monde(on, { nuit: null })
    expect((await question($)).deny).toBeUndefined()
    etat.nuit = '{pas du json'
    expect((await shell($, 'Bash', 'ls')).deny).toBeUndefined()
    expect(etat.appels).toEqual([])
  })

  test('l absence de l\'utilisateur depuis moins que le délai réglé ne compte pas ; au délai exact, elle compte', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif({ absenceMinutes: 90, derniereActivite: iso(DEBUT - 89 * MIN) }) })
    await question($)
    expect(etat.appels).toEqual([])
    etat.nuit = etatInactif({ absenceMinutes: 90, derniereActivite: iso(DEBUT - 90 * MIN) })
    await question($)
    expect(etat.appels).toHaveLength(1)
  })

  test('sans détection d absence réglée, l\'utilisateur peut être parti longtemps sans que le noyau soit appelé', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif({ absenceMinutes: null, derniereActivite: iso(DEBUT - 600 * MIN) }) })
    await question($)
    expect(etat.appels).toEqual([])
  })
})

describe('question refusée pendant la nuit', () => {
  test('la question est confiée au noyau avec l agent, la conversation et les questions ; son refus devient celui de la mod, et rien ne s exécute', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.question = { refuser: true, id: 1, texte: 'NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse.' }
    const r = await question($)
    expect(r.deny).toBe('NUIT : L\'utilisateur est absent, ta question ne peut pas attendre sa réponse.')
    expect(etat.executees).toEqual([])
    expect(etat.appels).toHaveLength(1)
    expect(etat.appels[0]).toEqual({ argv: ['node', CLI, 'nuit-hook', 'question'], operation: 'question', entree: { agent: 'claude', session: 'S1', tool_input: { questions: QUESTIONS } }, delai: 20_000 })
  })

  test('la conversation est celle de la session', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif(), session: 'S9' })
    await question($)
    expect(etat.appels[0]?.entree.session).toBe('S9')
  })

  test('quand le noyau ne refuse pas, la question est posée comme d habitude', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.question = { refuser: false }
    expect((await question($)).deny).toBeUndefined()
    expect(etat.executees).toEqual(['AskUserQuestion'])
  })

  test('un noyau en panne, muet, en erreur ou illisible ne bloque jamais la question', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.panne = true
    expect((await question($)).deny).toBeUndefined()
    etat.panne = false
    etat.brut = 'pas du json'
    expect((await question($)).deny).toBeUndefined()
    etat.brut = JSON.stringify({ refuser: true, texte: 'refus' })
    etat.code = 1
    expect((await question($)).deny).toBeUndefined()
    etat.code = 0
    etat.brut = JSON.stringify({ erreur: 'panne du noyau' })
    expect((await question($)).deny).toBeUndefined()
    etat.brut = JSON.stringify({ refuser: true })
    expect((await question($)).deny).toBeUndefined()
    etat.brut = JSON.stringify({ refuser: 'oui', texte: 'x' })
    expect((await question($)).deny).toBeUndefined()
    for (const texte of ['', 42, null, ['refus']]) {
      etat.brut = JSON.stringify({ refuser: true, texte })
      expect((await question($)).deny).toBeUndefined()
    }
    expect(etat.executees).toHaveLength(10)
  })

  test('un sous-agent qui pose une question est soumis à la même règle', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.question = { refuser: true, id: 2, texte: 'refus de la nuit' }
    expect((await question($, { agentId: 'sous-agent-1' })).deny).toBe('refus de la nuit')
  })

  test('l absence de l\'utilisateur suffit : le noyau est appelé même si la nuit n est pas encore notée active', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif({ derniereActivite: iso(DEBUT - 2 * HEURE) }) })
    etat.reponses.question = { refuser: true, id: 1, texte: 'refus de l absence' }
    expect((await question($)).deny).toBe('refus de l absence')
  })

  test('après un refus, la ligne de statut relit les fichiers du noyau', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.question = () => {
      etat.boite = boite([entreeBoite(1)])
      return { refuser: true, id: 1, texte: 'refus' }
    }
    await $.session.start(DEMARRAGE)
    await question($)
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 10 min : 3/60 enchaînements, 1 à décider')
  })
})

describe('arrêt de garde transformé en refus', () => {
  for (const tool of ['Bash', 'PowerShell'] as const) {
    test(`${tool} : la commande est confiée au noyau, et son refus avec alternative remplace l arrêt`, async ($, on) => {
      const { etat } = monde(on, { nuit: etatActif() })
      etat.reponses.garde = { refuser: true, genre: 'bloc', texte: 'NUIT : le garde de sécurité refuse cette commande (DANGER).' }
      const r = await shell($, tool, 'git reset --hard')
      expect(r.deny).toBe('NUIT : le garde de sécurité refuse cette commande (DANGER).')
      expect(etat.executees).toEqual([])
      expect(etat.appels[0]).toEqual({ argv: ['node', CLI, 'nuit-hook', 'garde'], operation: 'garde', entree: { agent: 'claude', session: 'S1', tool_name: tool, tool_input: { command: 'git reset --hard' } }, delai: 20_000 })
    })

    test(`${tool} : une commande que le garde laisse passer s exécute`, async ($, on) => {
      const { etat } = monde(on, { nuit: etatActif() })
      etat.reponses.garde = { refuser: false }
      expect((await shell($, tool, 'git status')).deny).toBeUndefined()
      expect(etat.executees).toEqual([tool])
    })
  }

  test('un noyau en panne ou en erreur ne bloque jamais une commande', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.panne = true
    expect((await shell($, 'Bash', 'ls')).deny).toBeUndefined()
    etat.panne = false
    etat.brut = JSON.stringify({ erreur: 'garde introuvable' })
    expect((await shell($, 'PowerShell', 'ls')).deny).toBeUndefined()
    expect(etat.executees).toEqual(['Bash', 'PowerShell'])
  })

  test('une demande d accord notée en boîte rafraîchit la ligne de statut', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.garde = () => {
      etat.boite = boite([entreeBoite(1, { type: 'action', titre: 'Commande en attente d\'accord : git push' })])
      return { refuser: true, genre: 'ask', id: 1, texte: 'refus de la demande' }
    }
    await shell($, 'Bash', 'git push')
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 10 min : 3/60 enchaînements, 1 à décider')
  })
})

describe('message de l\'utilisateur et réveil', () => {
  test('un message tapé au clavier date l activité de l\'utilisateur auprès du noyau, et passe tel quel', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif() })
    etat.reponses.activite = { reveil: false }
    await message($, 'bonjour')
    expect(etat.appels).toHaveLength(1)
    expect(etat.appels[0]).toEqual({ argv: ['node', CLI, 'nuit-hook', 'activite'], operation: 'activite', entree: { agent: 'claude', session: 'S1' }, delai: 20_000 })
    expect(etat.soumis.map(s => ({ text: s.text, context: s.context }))).toEqual([{ text: 'bonjour', context: undefined }])
    expect(etat.toasts).toEqual([])
    expect(etat.ouverts).toEqual([])
  })

  test('un message de Remote Control compte aussi comme un message de l\'utilisateur', async ($, on) => {
    const { compter } = monde(on, { nuit: etatInactif() })
    await message($, 'depuis le téléphone', 'bridge')
    expect(compter('activite')).toBe(1)
  })

  test('les messages qui ne sont pas de l\'utilisateur ne le réveillent pas', async ($, on) => {
    const { etat, compter } = monde(on, { nuit: etatActif() })
    for (const kind of ['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'sdk', 'coordinator', 'unclassified']) await message($, `message ${kind}`, kind)
    expect(compter('activite')).toBe(0)
    expect(etat.soumis).toHaveLength(7)
  })

  test('une commande /nuit n est pas un réveil : elle gère la nuit elle-même', async ($, on) => {
    const { compter } = monde(on, { nuit: etatActif() })
    await message($, '/nuit off')
    await message($, '  /NUIT recap')
    await message($, '/nuit')
    expect(compter('activite')).toBe(0)
    await message($, 'une phrase sur la nuit')
    expect(compter('activite')).toBe(1)
    await message($, '/nuitage')
    expect(compter('activite')).toBe(2)
    await message($, 'tape /nuit off demain')
    expect(compter('activite')).toBe(3)
  })

  test('le réveil prévient, ouvre le panneau et donne le récap au modèle avec le message', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    etat.reponses.activite = { reveil: true, recap: 'NUIT : récap.\nDurée : 7 h 22 min (nuit).' }
    await message($, 'je suis réveillé')
    expect(etat.toasts).toEqual(['Nuit terminée : le récap est dans le panneau Nuit (/nuit recap).'])
    expect(etat.ouverts).toEqual(['nuit'])
    expect(etat.titres).toEqual(['Nuit'])
    expect(etat.soumis.map(s => ({ text: s.text, context: s.context }))).toEqual([{ text: 'je suis réveillé', context: ['NUIT : récap.\nDurée : 7 h 22 min (nuit).'] }])
  })

  test('le message de l\'utilisateur arrive au modèle avec son origine, intact', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.activite = { reveil: true, recap: 'NUIT : récap.' }
    await message($, 'salut', 'bridge')
    expect(etat.soumis[0]?.origin).toEqual({ kind: 'bridge' })
    expect(etat.soumis[0]?.text).toBe('salut')
  })

  test('le réveil garde le contexte qu un autre plugin avait attaché au message', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.activite = { reveil: true, recap: 'NUIT : récap.' }
    await $.prompt.submit({ text: 'salut', origin: { kind: 'composer' }, wait: false, context: ['contexte d un autre plugin'] } as never)
    expect(etat.soumis[0]?.context).toEqual(['contexte d un autre plugin', 'NUIT : récap.'])
  })

  test('un noyau en panne, en erreur ou illisible laisse passer le message', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.panne = true
    await message($, 'un')
    etat.panne = false
    etat.brut = 'pas du json'
    await message($, 'deux')
    etat.brut = JSON.stringify({ erreur: 'x' })
    await message($, 'trois')
    etat.brut = JSON.stringify({ reveil: true })
    await message($, 'quatre')
    for (const [i, reponse] of [{ reveil: 'oui', recap: 'NUIT : récap.' }, { reveil: true, recap: '' }, { reveil: true, recap: 42 }, { reveil: false, recap: 'NUIT : récap.' }].entries()) {
      etat.brut = JSON.stringify(reponse)
      await message($, `essai ${i}`)
    }
    expect(etat.soumis.map(s => s.text)).toEqual(['un', 'deux', 'trois', 'quatre', 'essai 0', 'essai 1', 'essai 2', 'essai 3'])
    expect(etat.toasts).toEqual([])
    expect(etat.soumis.every(s => s.context === undefined)).toBe(true)
    expect(etat.ouverts).toEqual([])
  })
})

describe('enchaînement à la fin du tour', () => {
  test('nuit active, tour terminé : le noyau décide, et un ordre de continuer est soumis comme prompt', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatActif() })
    etat.reponses.continuer = { continuer: true, texte: 'NUIT : L\'utilisateur est absent. Continue avec la ligne suivante : C-0001 « A ».', ligne: { id: 'C-0001', texte: 'A' }, restantes: 2 }
    await fini($)
    expect(etat.appels).toHaveLength(1)
    expect(etat.appels[0]).toEqual({ argv: ['node', CLI, 'nuit-hook', 'continuer'], operation: 'continuer', entree: { agent: 'claude', session: 'S1', reason: 'answer' }, delai: 20_000 })
    expect(await soumisParLaMod()).toEqual(['NUIT : L\'utilisateur est absent. Continue avec la ligne suivante : C-0001 « A ».'])
  })

  test('la raison de fin du tour est transmise telle quelle : c est le noyau qui juge', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatActif() })
    for (const reason of ['aborted', 'error', 'refusal'] as const) await fini($, reason)
    expect(etat.appels.map(a => a.entree.reason)).toEqual(['aborted', 'error', 'refusal'])
    expect(await soumisParLaMod()).toEqual([])
  })

  test('quand le noyau ne veut pas continuer, rien n est soumis', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatActif() })
    etat.reponses.continuer = { continuer: false, motif: 'termine' }
    await fini($)
    expect(await soumisParLaMod()).toEqual([])
  })

  test('un noyau en panne, en erreur ou illisible ne soumet rien', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatActif() })
    etat.panne = true
    await fini($)
    etat.panne = false
    etat.brut = 'pas du json'
    await fini($)
    etat.brut = JSON.stringify({ erreur: 'x' })
    await fini($)
    etat.brut = JSON.stringify({ continuer: true })
    await fini($)
    etat.brut = JSON.stringify({ continuer: 'oui', texte: 'x' })
    await fini($)
    expect(await soumisParLaMod()).toEqual([])
  })

  test('hors nuit, ou à la fin du tour d un sous-agent, le noyau n est pas appelé', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif() })
    await fini($)
    etat.nuit = etatActif()
    await fini($, 'answer', 'sous-agent-1')
    expect(etat.appels).toEqual([])
  })

  test('la fin du tour est rendue telle quelle, et la ligne de statut relit les fichiers', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.continuer = () => {
      etat.nuit = etatActif({ tours: 4 })
      return { continuer: true, texte: 'NUIT : continue.' }
    }
    const r = await fini($)
    expect(r.text).toBe('Terminé. [bas de chaîne]')
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 10 min : 4/60 enchaînements, 0 à décider')
  })

  test('l absence atteinte suffit à enchaîner', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatInactif({ derniereActivite: iso(DEBUT - 3 * HEURE) }) })
    etat.reponses.continuer = { continuer: true, texte: 'NUIT : continue.' }
    await fini($)
    expect(await soumisParLaMod()).toEqual(['NUIT : continue.'])
  })

  test('les messages de la mod arrivent cadrés comme ceux du plugin, jamais comme les mots de l\'utilisateur', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatActif() })
    etat.reponses.continuer = { continuer: true, texte: 'NUIT : continue.' }
    await fini($)
    await soumisParLaMod()
    const origine = etat.soumis[0]?.origin as { kind?: string; asUser?: unknown } | undefined
    expect(origine?.kind).toBe('plugin')
    expect(origine?.asUser).toBeUndefined()
  })
})

describe('commande /nuit', () => {
  test('confie les arguments au noyau et dit sa réponse', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif() })
    etat.reponses.commande = { message: 'Nuit : active. Les questions bloquantes iront en boîte.', effet: 'active' }
    const r = await commande($, 'nuit', 'on')
    expect(r.text).toBe('Nuit : active. Les questions bloquantes iront en boîte.')
    expect(etat.appels[0]).toEqual({ argv: ['node', CLI, 'nuit-hook', 'commande'], operation: 'commande', entree: { agent: 'claude', session: 'S1', args: 'on' }, delai: 20_000 })
  })

  test('sans argument, c est l état : args vide', async ($, on) => {
    const { etat } = monde(on)
    etat.reponses.commande = { message: 'Nuit : inactive.' }
    expect((await commande($, 'nuit')).text).toBe('Nuit : inactive.')
    expect(etat.appels[0]?.entree.args).toBe('')
  })

  test('les arguments sont rognés avant d être confiés au noyau', async ($, on) => {
    const { etat } = monde(on)
    etat.reponses.commande = { message: 'ok' }
    await commande($, 'nuit', '  repondre 2 Oui  ')
    await commande($, 'nuit', '   ')
    expect(etat.appels.map(a => a.entree.args)).toEqual(['repondre 2 Oui', ''])
  })

  test('un échec du noyau ou une erreur de la commande n ouvrent jamais le panneau', async ($, on) => {
    const { etat } = monde(on)
    etat.panne = true
    await commande($, 'nuit', 'boite')
    etat.panne = false
    etat.reponses.commande = { erreur: 'Usage : /nuit [on | off | ...]' }
    await commande($, 'nuit', 'recap')
    etat.reponses.commande = { effet: 'reveil' }
    await commande($, 'nuit', 'boite')
    expect(etat.ouverts).toEqual([])
  })

  test('une erreur du noyau (usage, boîte, écriture) est dite telle quelle', async ($, on) => {
    const { etat } = monde(on)
    etat.reponses.commande = { erreur: 'Usage : /nuit [on | off | ...]' }
    expect((await commande($, 'nuit', 'demain')).text).toBe('Usage : /nuit [on | off | ...]')
  })

  // Le noyau écrit les fichiers, pas la mod : après une panne elle ne sait pas ce qui a été écrit, et ne le prétend pas.
  test('un noyau en panne, muet ou illisible est dit, avec la cause quand on la connaît, sans rien affirmer sur l état des fichiers', async ($, on) => {
    const { etat } = monde(on)
    etat.panne = true
    expect((await commande($, 'nuit', 'on')).text).toMatch(/^Nuit : le noyau ne répond pas \(.*spawn node ENOENT\)\.$/)
    etat.panne = false
    etat.brut = 'pas du json'
    expect((await commande($, 'nuit', 'on')).text).toBe('Nuit : réponse illisible du noyau.')
    etat.brut = JSON.stringify({ autre: 'chose' })
    expect((await commande($, 'nuit', 'on')).text).toBe('Nuit : réponse illisible du noyau.')
    etat.brut = ''
    etat.code = 3
    etat.stderr = '  boum du noyau\n'
    expect((await commande($, 'nuit', 'on')).text).toBe('Nuit : boum du noyau')
    etat.stderr = ' \n '
    expect((await commande($, 'nuit', 'on')).text).toBe('Nuit : code de sortie 3.')
    etat.stderr = ''
    expect((await commande($, 'nuit', 'on')).text).toBe('Nuit : code de sortie 3.')
  })

  test('une réponse JSON qui n est pas un objet est illisible, même si elle est valide', async ($, on) => {
    const { etat } = monde(on)
    for (const brut of ['null', '[]', '[{"message":"x"}]', '42', '"texte"', 'true']) {
      etat.brut = brut
      expect((await commande($, 'nuit', 'on')).text).toBe('Nuit : réponse illisible du noyau.')
    }
  })

  test('une erreur de 160 caractères exactement est dite entière, une de 161 est tronquée', async ($, on) => {
    const { etat } = monde(on)
    etat.brut = ''
    etat.code = 1
    etat.stderr = 'y'.repeat(160)
    expect((await commande($, 'nuit', 'on')).text).toBe(`Nuit : ${'y'.repeat(160)}`)
    etat.stderr = 'y'.repeat(161)
    expect((await commande($, 'nuit', 'on')).text).toBe(`Nuit : ${'y'.repeat(157)}...`)
  })

  test('l erreur d un noyau qui plante est dite sur une ligne, bornée', async ($, on) => {
    const { etat } = monde(on)
    etat.brut = ''
    etat.code = 1
    etat.stderr = `Error: boum\n    at ${'x'.repeat(300)}`
    const texte = (await commande($, 'nuit', 'on')).text ?? ''
    expect(texte).toBe(`Nuit : Error: boum at ${'x'.repeat(142)}...`)
    expect(texte).not.toContain('\n')
  })

  test('une réponse notée est transmise au modèle comme un prompt', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    etat.reponses.commande = { message: 'Boîte : réponse notée pour la question n° 1.', effet: 'reponse', prompt: 'NUIT : réponse de l\'utilisateur à la question n° 1 : Veilleur. Applique-la maintenant.' }
    const r = await commande($, 'nuit', 'repondre 1 Veilleur')
    expect(r.text).toBe('Boîte : réponse notée pour la question n° 1.')
    expect(await soumisParLaMod()).toEqual(['NUIT : réponse de l\'utilisateur à la question n° 1 : Veilleur. Applique-la maintenant.'])
  })

  test('une réponse notée sans texte à transmettre, ou une autre commande, ne soumet rien au modèle', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on)
    etat.reponses.commande = { message: 'ok', effet: 'reponse' }
    await commande($, 'nuit', 'repondre 1 A')
    etat.reponses.commande = { message: 'ok', effet: 'reponse', prompt: '' }
    await commande($, 'nuit', 'repondre 1 A')
    etat.reponses.commande = { message: 'ok', effet: 'active', prompt: 'NUIT : ne part pas' }
    await commande($, 'nuit', 'on')
    expect(await soumisParLaMod()).toEqual([])
  })

  test('mettre fin à la nuit donne le récap et ouvre le panneau', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.reponses.commande = { message: 'NUIT : récap.', effet: 'reveil' }
    const r = await commande($, 'nuit', 'off')
    expect(r.text).toBe('NUIT : récap.')
    expect(etat.ouverts).toEqual(['nuit'])
  })

  test('commencer la nuit, écarter une question ou une simple lecture n ouvrent rien et ne soumettent rien', async ($, on) => {
    const { etat, soumisParLaMod } = monde(on)
    for (const effet of ['active', 'ecartee', null]) {
      etat.reponses.commande = { message: 'ok', effet }
      await commande($, 'nuit', 'x')
    }
    expect(etat.ouverts).toEqual([])
    expect(await soumisParLaMod()).toEqual([])
  })

  test('après une commande, la ligne de statut relit les fichiers', async ($, on) => {
    const { etat } = monde(on)
    etat.reponses.commande = () => {
      etat.nuit = etatActif({ depuis: iso(DEBUT), tours: 0 })
      return { message: 'Nuit : active.', effet: 'active' }
    }
    await commande($, 'nuit', 'on')
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis moins d\'une minute : 0/60 enchaînements, 0 à décider')
  })
})

describe('rappel dans le prompt', () => {
  test('pendant la nuit, le prompt reçoit une section de session avec le rappel', async ($, on) => {
    monde(on, { nuit: etatActif() })
    const r = await $.prompt.compose({ ...COMPOSE })
    expect(r.sections).toHaveLength(2)
    expect(r.sections[0]).toEqual(BASE[0])
    expect(r.sections[1]?.id).toBe('nuit:rappel')
    expect(r.sections[1]?.scope).toBe('session')
    expect(r.sections[1]?.text).toMatch(/^NUIT EN COURS \(nuit\) : L'utilisateur est absent\. Ne lui pose aucune question/)
  })

  test('hors nuit, ou avec un état abîmé, le prompt reste celui du moteur', async ($, on) => {
    const { etat } = monde(on, { nuit: etatInactif({ derniereActivite: iso(DEBUT - 5 * HEURE) }) })
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
    etat.nuit = '{pas du json'
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
    etat.nuit = null
    expect((await $.prompt.compose({ ...COMPOSE })).sections).toEqual(BASE)
  })

  test('le texte ne change pas d une composition à l autre tant que la nuit ne change pas : le prompt reste en cache', async ($, on) => {
    monde(on, { nuit: etatActif() })
    const a = await $.prompt.compose({ ...COMPOSE })
    const b = await $.prompt.compose({ ...COMPOSE })
    expect(a.sections.map(s => s.id)).toEqual(['intro', 'nuit:rappel'])
    expect(b).toEqual(a)
  })

  test('le rappel dit quand l enchaînement est arrêté', async ($, on) => {
    monde(on, { nuit: etatActif({ arret: 'quota' }) })
    const texte = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(texte).toContain('Enchaînement arrêté : le Garde-quota a atteint son seuil critique.')
  })
})

describe('panneau Nuit', () => {
  const monter = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => $.ui.mount({ plugin: 'nuit', surface, component: 'Pane', requestId: 'nuit', props: PANNEAU })
  const RECAP_ENTETE = 'NUIT : récap (nuit en cours).'

  test('montre le récap de la nuit, sur terminal et desktop', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await monter($, surface)
      expect(await ui.find({ type: 'Text', text: RECAP_ENTETE })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Durée : 10 min \(nuit\)\. 3 enchaînements sur 60 au plus\.$/ })).toBeDefined()
      await ui.unmount()
    }
    expect(etat.lectures).toContain(FICHIER_BOITE)
  })

  test('une seule question est détaillée à la fois, chaque entrée restant sélectionnable', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1), entreeBoite(2, { titre: 'Autre question ?', options: [] })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    for (const surface of SURFACES) {
      const ui = await monter($, surface)
      await ui.select({ key: 'entree', value: '1' })
      expect(await ui.find({ type: 'Text', text: '1. [question] Quel nom pour le mod ?' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rep-1-0' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rep-1-1' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rep-1-2' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'ecarter-1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2. [question] Autre question ?' })).toBeUndefined()
      await ui.select({ key: 'entree', value: '2' })
      expect(await ui.find({ type: 'Text', text: '2. [question] Autre question ?' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rep-2-0' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'ecarter-2' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('presser une option répond à la question par le noyau et transmet la réponse au modèle', async ($, on) => {
    const { etat, horloge, soumisParLaMod } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.reponses.commande = () => {
      etat.boite = boite([entreeBoite(1, { statut: 'repondue', reponse: 'Veilleur (Recommended)', traite: iso(DEBUT) })])
      return { message: 'Boîte : réponse notée pour la question n° 1.', effet: 'reponse', prompt: 'NUIT : réponse de l\'utilisateur à la question n° 1 (« Quel nom pour le mod ? ») : Veilleur (Recommended). Applique-la maintenant.' }
    }
    const ui = await monter($)
    await ui.press({ key: 'rep-1-0' })
    expect(etat.appels.filter(a => a.operation === 'commande').map(a => a.entree.args)).toEqual(['repondre 1 Veilleur (Recommended)'])
    expect(await soumisParLaMod()).toEqual(['NUIT : réponse de l\'utilisateur à la question n° 1 (« Quel nom pour le mod ? ») : Veilleur (Recommended). Applique-la maintenant.'])
    expect(etat.statuts.at(-1)).toBe('Nuit active depuis 10 min : 3/60 enchaînements, 0 à décider')
    await ui.unmount()
  })

  test('presser Écarter écarte la question, sans rien transmettre au modèle', async ($, on) => {
    const { etat, horloge, soumisParLaMod } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.reponses.commande = { message: 'Boîte : question n° 1 écartée.', effet: 'ecartee' }
    const ui = await monter($)
    await ui.press({ key: 'ecarter-1' })
    expect(etat.appels.filter(a => a.operation === 'commande').map(a => a.entree.args)).toEqual(['ecarter 1'])
    expect(await soumisParLaMod()).toEqual([])
    await ui.unmount()
  })

  test('une commande à valider a ses deux boutons : Autoriser et Refuser', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(4, { type: 'action', titre: 'Commande en attente d\'accord : git push origin main', options: [{ label: 'Autoriser', description: '' }, { label: 'Refuser', description: '' }] })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.reponses.commande = { message: 'ok', effet: 'reponse', prompt: 'NUIT : décision de l\'utilisateur sur la commande n° 4 : Refuser. Ne la lance pas.' }
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: '4. [action] Commande en attente d\'accord : git push origin main' })).toBeDefined()
    await ui.press({ key: 'rep-4-1' })
    expect(etat.appels.filter(a => a.operation === 'commande').map(a => a.entree.args)).toEqual(['repondre 4 Refuser'])
    await ui.unmount()
  })

  test('sans question à décider, le panneau le dit et ne montre aucun bouton de réponse', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1, { statut: 'repondue', reponse: 'Nuit', traite: iso(DEBUT - MIN) })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: 'Rien à décider en boîte.' })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'entree' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'ecarter-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^À décider/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^1\. \[/ })).toBeUndefined()
    await ui.unmount()
  })

  test('le récap garde toutes ses lignes avant la liste à décider, et cette liste n est dessinée qu une fois, en gras', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif({ refus: { question: 2, garde: 1, action: 0 }, arret: 'plafond' }), boite: boite([entreeBoite(1)]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: /^Refus pendant l'absence : 2 questions mises en boîte/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Enchaînement arrêté : le plafond de 60 enchaînements est atteint\.$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: '1 à traiter, 0 en historique' })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /Rien à décider/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Nuit : lecture en cours' })).toBeUndefined()
    await ui.unmount()
  })

  test('le panneau ne montre que ce que la mod sait : pas de nombre de lignes ouvertes au réveil', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif({ lignesAuDebut: 4 }) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: RECAP_ENTETE })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Lignes ouvertes/ })).toBeUndefined()
    await ui.unmount()
  })

  test('les boutons portent leur libellé : chaque option, Écarter et Rafraîchir', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect((await ui.find({ type: 'Button', key: 'rep-1-0' }))?.props.label).toBe('Veilleur (Recommended)')
    expect((await ui.find({ type: 'Button', key: 'rep-1-1' }))?.props.label).toBe('Nuit')
    expect((await ui.find({ type: 'Button', key: 'ecarter-1' }))?.props.label).toBe('Écarter')
    expect((await ui.find({ type: 'Button', key: 'rafraichir' }))?.props.label).toBe('Rafraîchir')
    await ui.unmount()
  })

  test('le bouton Rafraîchir relit les fichiers du noyau', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatInactif() })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: 'NUIT : récap.' })).toBeDefined()
    etat.nuit = etatActif()
    await ui.press({ key: 'rafraichir' })
    expect(await ui.find({ type: 'Text', text: RECAP_ENTETE })).toBeDefined()
    await ui.unmount()
  })

  test('les commandes /nuit boite et /nuit recap ouvrent le panneau, quelle que soit la casse ; les autres lectures non', async ($, on) => {
    const { etat } = monde(on)
    etat.reponses.commande = { message: 'Boîte de la nuit : vide.', effet: null }
    await commande($, 'nuit', 'boite')
    expect(etat.ouverts).toEqual(['nuit'])
    await commande($, 'nuit', '  RECAP ')
    expect(etat.ouverts).toEqual(['nuit', 'nuit'])
    await commande($, 'nuit', 'statut')
    await commande($, 'nuit', '')
    await commande($, 'nuit', 'boites')
    await commande($, 'nuit', 'repondre 1 boite')
    await commande($, 'nuit', 'repondre 1 recap')
    expect(etat.ouverts).toEqual(['nuit', 'nuit'])
    expect(etat.titres).toEqual(['Nuit', 'Nuit'])
  })

  test('le panneau ne répète pas la liste du récap', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1), entreeBoite(2, { titre: 'Autre ?' })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: '2 à traiter, 0 en historique' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2. [question] Autre ?' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Options :/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Et \d+ autres? : \/nuit boite\.$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('toutes les questions à décider restent accessibles sans afficher leurs détails ensemble', async ($, on) => {
    const entrees = Array.from({ length: 13 }, (_, i) => entreeBoite(i + 1, { titre: `Question ${i + 1} ?` }))
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite(entrees) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: '13 à traiter, 0 en historique' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '13. [question] Question 13 ?' })).toBeUndefined()
    await ui.select({ key: 'entree', value: '13' })
    expect(await ui.find({ type: 'Text', text: '13. [question] Question 13 ?' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rep-13-0' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'ecarter-13' })).toBeDefined()
    await ui.unmount()
  })

  test('le détail d une question est montré sous son titre, seulement quand il existe', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1, { details: 'Contexte : le nom sert au dossier.' }), entreeBoite(2, { titre: 'Sans détail ?' })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    const detail = await ui.find({ type: 'Text', text: 'Contexte : le nom sert au dossier.' })
    expect(detail).toBeDefined()
    expect(detail?.props.dimColor).toBe(true)
    await ui.select({ key: 'entree', value: '2' })
    expect(await ui.find({ type: 'Text', text: 'Contexte : le nom sert au dossier.' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '2. [question] Sans détail ?' })).toBeDefined()
    await ui.unmount()
  })

  test('une question sans détail n ajoute aucune ligne vide', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(2, { titre: 'Sans détail ?' })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: /^\s*$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('avant la première lecture des fichiers, le panneau le dit', async ($, on) => {
    monde(on, { nuit: etatActif() })
    const ui = await monter($)
    expect(await ui.find({ type: 'Text', text: 'Nuit : lecture en cours' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rafraichir' })).toBeDefined()
    await ui.unmount()
  })

  test('un bouton dit le résultat par un toast : la réponse notée, la question écartée, ou la raison d un échec', async ($, on) => {
    const { etat, horloge, soumisParLaMod } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1), entreeBoite(2, { titre: 'Autre ?' })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    etat.reponses.commande = { message: 'Boîte : question n° 2 écartée.', effet: 'ecartee' }
    await ui.select({ key: 'entree', value: '2' })
    await ui.press({ key: 'ecarter-2' })
    expect(etat.toasts).toEqual(['Boîte : question n° 2 écartée.'])
    etat.reponses.commande = { erreur: 'Boîte : la question n° 1 est déjà traitée.' }
    await ui.select({ key: 'entree', value: '1' })
    await ui.press({ key: 'ecarter-1' })
    expect(etat.toasts.at(-1)).toBe('Boîte : la question n° 1 est déjà traitée.')
    etat.panne = true
    await ui.press({ key: 'rep-1-0' })
    expect(etat.toasts.at(-1)).toMatch(/^Nuit : le noyau ne répond pas \(.*spawn node ENOENT\)\.$/)
    expect(await soumisParLaMod()).toEqual([])
    await ui.unmount()
  })

  test('une question accepte une réponse libre bornée, une action ne propose aucun champ libre', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1), entreeBoite(2, { type: 'action', options: [{ label: 'Autoriser' }, { label: 'Refuser' }] })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    etat.reponses.commande = { message: 'Boîte : réponse notée.', effet: 'reponse' }
    const ui = await monter($)
    await ui.input({ key: 'reponse-libre', text: 'Ma réponse libre' })
    expect(etat.appels.filter(a => a.operation === 'commande').map(a => a.entree.args)).toEqual(['repondre 1 Ma réponse libre'])
    await ui.input({ key: 'reponse-libre', text: 'x'.repeat(601) })
    expect(etat.appels.filter(a => a.operation === 'commande')).toHaveLength(1)
    await ui.select({ key: 'entree', value: '2' })
    expect(await ui.find({ type: 'Input', key: 'reponse-libre' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'rep-2-0' })).toBeDefined()
    await ui.unmount()
  })

  test('l historique est consultable mais sans contrôle de décision', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatInactif(), boite: boite([
      entreeBoite(1, { statut: 'repondue', reponse: 'Nuit', traite: iso(DEBUT - MIN) }),
      entreeBoite(2, { statut: 'ecartee', traite: iso(DEBUT - MIN) }),
    ]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    await ui.select({ key: 'filtre', value: 'historique' })
    expect(await ui.find({ type: 'Text', text: /^Réponse : Nuit/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rep-1-0' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'ecarter-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'reponse-libre' })).toBeUndefined()
    await ui.select({ key: 'entree', value: '2' })
    expect(await ui.find({ type: 'Text', text: /^Écartée/ })).toBeDefined()
    await ui.unmount()
  })

  test('la sélection survit à une actualisation et retombe sur une entrée existante', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatInactif(), boite: boite([entreeBoite(1), entreeBoite(2, { titre: 'Deux ?' })]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    await ui.select({ key: 'entree', value: '2' })
    await ui.press({ key: 'rafraichir' })
    expect(await ui.find({ type: 'Text', text: '2. [question] Deux ?' })).toBeDefined()
    etat.boite = boite([entreeBoite(1)])
    await ui.press({ key: 'rafraichir' })
    expect(await ui.find({ type: 'Text', text: '1. [question] Quel nom pour le mod ?' })).toBeDefined()
    await ui.unmount()
  })

  test('cinquante entrées restent navigables avec un seul détail', async ($, on) => {
    const { horloge } = monde(on, { nuit: etatInactif(), boite: boite(Array.from({ length: 50 }, (_, i) => entreeBoite(i + 1, { titre: `Question ${i + 1}` }))) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    const ui = await monter($)
    expect((await ui.find({ type: 'Select', key: 'entree' }))?.props.options).toHaveLength(50)
    expect(await ui.find({ type: 'Button', key: 'rep-50-0' })).toBeUndefined()
    await ui.select({ key: 'entree', value: '50' })
    expect(await ui.find({ type: 'Text', text: '50. [question] Question 50' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rep-50-0' })).toBeDefined()
    await ui.unmount()
  })
})


// Une action lancée « en l'air » peut finir quand la mod est déjà déchargée : l'écriture de l'état ou l'envoi d'un message est alors refusé et
// l'action rejette. Aucune ne doit laisser un rejet non géré (le runner le signale en fin de fichier). Le refus est simulé PENDANT le test :
// le rejet réel d'une action encore en vol à la fin du fichier dépend de la vitesse du runner, il ne sert donc pas de preuve.
describe('rejets après le déchargement', () => {
  test('une relecture de la minuterie dont l écriture d état est refusée', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatActif() })
    let refuse = false
    on('state.set', (_$, e, next) => (refuse ? ({ deny: 'refused: no hooks module of that name is loaded' } as never) : next(e)))
    await $.session.start(DEMARRAGE)
    const lecturesAvant = etat.lectures.length
    refuse = true
    await horloge.advance(60_000)
    await horloge.settle()
    expect(etat.lectures.length).toBeGreaterThan(lecturesAvant) // la relecture de la minuterie a eu lieu, et son écriture d'état a été refusée
  })

  test('un message au modèle que le moteur refuse', async ($, on) => {
    const { etat, horloge } = monde(on, { nuit: etatActif() })
    etat.reponses.continuer = { continuer: true, texte: 'NUIT : continue.' }
    etat.refusPrompt = true
    await fini($)
    await horloge.settle()
    expect(etat.soumis).toEqual([])
  })
})

describe('autres chemins du moteur', () => {
  test('la dernière lecture gardée dans l état est normalisée : un fichier mal formé ne dépose rien d invalide', async ($, on) => {
    monde(on, { nuit: JSON.stringify({ actif: true, tours: 'x', maxTours: 99999, mode: 'autre' }), boite: JSON.stringify({ prochain: 'x', entrees: [{ id: 'a' }, entreeBoite(3)] }) })
    const ecrites: NuitSuivi[] = []
    on('state.set', (_$, e) => {
      ecrites.push(e.value as NuitSuivi)
      return { value: { isSet: true, version: ecrites.length } } as never
    })
    await $.session.start(DEMARRAGE)
    const gardee = ecrites.at(-1)
    expect(gardee?.etat).toMatchObject({ actif: true, tours: 0, maxTours: 60, mode: 'nuit' })
    expect(gardee?.boite.entrees.map(x => x.id)).toEqual([3])
    expect(gardee?.boite.prochain).toBe(4)
  })

  test('le démarrage rend le résultat du bas de la chaîne : la mod ne coupe jamais la chaîne', async ($, on) => {
    monde(on)
    const r = await $.session.start(DEMARRAGE)
    expect(r.cwd).toBe('bas de chaîne : C:/x')
  })

  test('le réveil rafraîchit la ligne de statut : la nuit n y est plus, la boîte oui', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif(), boite: boite([entreeBoite(1)]) })
    etat.reponses.activite = () => {
      etat.nuit = etatInactif({ derniereActivite: iso(DEBUT) })
      return { reveil: true, recap: 'NUIT : récap.' }
    }
    await message($, 'bonjour')
    expect(etat.statuts.at(-1)).toBe('Nuit : 1 à décider en boîte (/nuit boite)')
  })

  test('sans identifiant de conversation, les décisions silencieuses laissent tout passer et la commande dit la panne', async ($, on) => {
    const { etat } = monde(on, { nuit: etatActif() })
    etat.sessionEnPanne = true
    etat.reponses.question = { refuser: true, id: 1, texte: 'refus' }
    expect((await question($)).deny).toBeUndefined()
    expect((await shell($, 'Bash', 'ls')).deny).toBeUndefined()
    expect((await commande($, 'nuit', 'on')).text).toMatch(/^Nuit : le noyau ne répond pas \(.*\)\.$/)
    expect(etat.appels).toEqual([])
  })
})
