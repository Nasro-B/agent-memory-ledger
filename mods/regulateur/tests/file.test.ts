import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import * as logiqueFile from '../hooks/file-logique.mjs'

// Délai de 30 s par test (5 s par défaut) : l'horloge est simulée, seule la saturation de la machine peut ralentir un test.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

// Le dossier d'état du Cockpit et le dossier du plugin que le moteur de test donne au module par COCKPIT_DIR et AML_PLUGIN_DIR (emplacements-logique.mjs).
const DOSSIER = 'C:/travail/cockpit'
const ENV = { COCKPIT_DIR: DOSSIER, AML_PLUGIN_DIR: 'C:/outils/ledger' }
const POLITIQUE = `${DOSSIER}/politique-agents.json`
const FILE = `${DOSSIER}/file-agents.json`
const DEBUT = Date.parse('2026-03-03T20:00:00.000Z')
const MIN = 60 * 1000
const normal = (chemin: string) => chemin.replace(/\\/g, '/')
const DEMARRAGE = { cwd: 'C:/x', surface: 'terminal' as const, isInteractive: true }
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [] as string[], outputStyle: null, traits: [] }

type Agent = { id: string; status: string }
const agent = (status: string, i = 0): Agent => ({ id: `a${i}`, status })
// Le moteur de test ne transmet pas `subagentType` quand c'est une mod qui lance l'agent : le banc ne le compare pas ici ;
// la construction des arguments est prouvée par file-logique.test.js (argumentsDeLancement).
type Lancement = { prompt: string; description: string; model?: string; name?: string; cwd?: string }

// La politique : plafond max, file activée, relance. pause en 4e.
const politique = (max: number | null, file = true, relance = false, pause = false) => JSON.stringify({ max, pause, relance, file, maj: '2026-03-03T19:00:00.000Z' })
const SPAWN = (n = 1, extra: object = {}) => ({ prompt: `Fais le travail ${n}`, description: `travail ${n}`, subagentType: 'general-purpose', ...extra })
const entree = (id: number, n: number, extra: object = {}) => ({
  id, agent: 'claude', session: 'S1', ajoute: new Date(DEBUT).toISOString(), description: `travail ${n}`,
  demande: { prompt: `Fais le travail ${n}`, description: `travail ${n}`, subagentType: 'general-purpose' },
  essais: 0, statut: 'en-attente', ordre: null, ...extra,
})
const fichierFile = (entrees: object[], prochain = 100) => JSON.stringify({ prochain, entrees, relances: {} })

// Le moteur donne aux hooks le chemin Windows natif : on compare en barres obliques.
// Le monde simulé sous la mod : la politique, la file, la liste des agents, le lancement, ce que la mod dit au modèle.
function monde(on: On, init: { politique?: string | null; file?: string | null; agents?: Agent[] | 'panne'; session?: string } = {}) {
  const etat = {
    politique: init.politique ?? null,
    file: init.file ?? null,
    agents: init.agents ?? ([] as Agent[] | 'panne'),
    session: init.session ?? 'S1',
    ecritures: [] as { path: string; text: string }[],
    lancements: [] as Lancement[],
    soumis: [] as string[],
    statuts: [] as (string | undefined)[],
    toasts: [] as string[],
    refusSpawn: null as string | null,
    refusPrompt: false,
    ecritureFileEchoue: false,
    sessionPanne: false,
    commandes: [] as string[],
    lectures: [] as string[],
    listes: 0,
  }
  const horloge = mock.clock(on, { now: DEBUT })
  mock.env(on, ENV)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    etat.commandes.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.id', () => (etat.sessionPanne ? { deny: 'session indisponible' } : { value: etat.session }))
  on('fs.read', (_$, e) => {
    const chemin = normal(e.path)
    etat.lectures.push(chemin)
    if (chemin === POLITIQUE) return etat.politique === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.politique }
    if (chemin === FILE) return etat.file === null ? { deny: 'ENOENT: fichier absent' } : { value: etat.file }
    return { deny: `chemin inattendu : ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    const chemin = normal(e.path)
    if (chemin === FILE && etat.ecritureFileEchoue) return { deny: 'disque plein' }
    etat.ecritures.push({ path: chemin, text: e.text })
    if (chemin === POLITIQUE) etat.politique = e.text
    if (chemin === FILE) etat.file = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const { operation, args } = JSON.parse(e.argv[2] ?? '{}')
    let avant
    try { avant = logiqueFile.normaliserEtat(JSON.parse((etat.file ?? 'null').replace(/^\uFEFF/, ''))) } catch { avant = logiqueFile.etatParDefaut() }
    let apres = avant, value: unknown
    if (operation === 'lireFile') value = avant
    else if (operation === 'mettreEnFile') {
      const demande = args[0]
      const r = logiqueFile.mettreEnFile(logiqueFile.purger(avant, demande.maintenant).etat, demande)
      apres = r.etat ?? avant
      value = r.refus !== undefined ? { refus: r.refus } : { entree: r.entree, position: r.position, total: logiqueFile.enAttente(apres, demande.agent, demande.session).length, deja: r.deja }
    } else if (operation === 'purgerFile') {
      const r = logiqueFile.purger(avant, args[0]); apres = r.etat; value = r.retirees
    } else if (operation === 'retirerReconnue') {
      const trouvee = logiqueFile.reconnaitre(avant, args[0], args[1], args[2]); value = trouvee !== null
      if (trouvee !== null) apres = logiqueFile.retirer(avant, trouvee.id)
    } else if (operation === 'viderFile') {
      const r = logiqueFile.vider(avant, args[0], args[1]); apres = r.etat; value = r.retirees
    } else return { deny: 'operation inconnue' }
    if (JSON.stringify(avant) !== JSON.stringify(apres)) {
      if (etat.ecritureFileEchoue) return { deny: 'disque plein' }
      const text = JSON.stringify({ ...apres, maj: new Date(DEBUT).toISOString() })
      etat.file = text; etat.ecritures.push({ path: FILE, text })
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ value }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => {
    etat.listes++
    return etat.agents === 'panne' ? { deny: 'liste indisponible' } : { value: etat.agents as never }
  })
  on('agent.spawn', (_$, e) => {
    if (etat.refusSpawn !== null) return { deny: etat.refusSpawn }
    etat.lancements.push({ prompt: e.prompt, description: e.description, model: e.model, name: e.name, cwd: e.cwd })
    const id = `n${etat.lancements.length}`
    if (Array.isArray(etat.agents)) etat.agents.push({ id, status: 'running' })
    return { model: 'm', agentId: id }
  })
  on('prompt.submit', (_$, e) => {
    if (etat.refusPrompt) throw new Error('refused: no hooks module of that name is loaded')
    etat.soumis.push(e.text)
    return { text: e.text }
  })
  on('ui.status', (_$, e) => {
    etat.statuts.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    etat.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Tu es Claude.', scope: 'shared' as const }] }))
  const fileCourante = () => (etat.file === null ? null : (JSON.parse(etat.file) as { prochain: number; entrees: { id: number; description: string; essais: number; statut: string; demande: Record<string, unknown> }[]; relances: Record<string, number> }))
  return { etat, horloge, fileCourante }
}

const lancement = ($: Engine, n = 1, extra: object = {}) => $.agent.spawn(SPAWN(n, extra) as never)
const fini = ($: Engine, agentId: string, reason: 'answer' | 'aborted' | 'error' | 'refusal' = 'answer', answer = 'Travail terminé.') =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: reason === 'aborted', turnId: 'tour-1', agentId, reason, ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}) } as never)
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const plein = (n: number): Agent[] => Array.from({ length: n }, (_, i) => agent('running', i))

describe('refus et mise en file', () => {
  test('au maximum avec la file activée, le lancement est refusé avec la position, et la demande est mise en file', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(2), agents: plein(2) })
    const r = await lancement($, 1, { model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' })
    expect(r.deny).toMatch(/^Régulateur d'agents : maximum atteint\. Cet agent est mis en file \(n° 1 sur 1\) et sera lancé automatiquement dès qu'un créneau se libère/)
    expect(r.deny).toMatch(/sa réponse t'arrivera comme un message\. Ne le relance pas/)
    expect(etat.lancements).toHaveLength(0)
    const f = fileCourante()
    expect(f?.entrees).toHaveLength(1)
    expect(f?.entrees[0]).toEqual(entree(1, 1, { demande: { prompt: 'Fais le travail 1', description: 'travail 1', subagentType: 'general-purpose', model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' } }))
    expect(f?.prochain).toBe(2)
    expect(etat.ecritures.every(e => e.path === FILE)).toBe(true)
    expect(JSON.parse(etat.file ?? '{}').maj).toBe(new Date(DEBUT).toISOString())
  })

  test('la demande ne garde que ce qui est défini : pas de model, name ni cwd inventés', async ($, on) => {
    const { fileCourante } = monde(on, { politique: politique(1), agents: plein(1) })
    await lancement($, 1)
    expect(Object.keys(fileCourante()?.entrees[0]?.demande ?? {}).sort()).toEqual(['description', 'prompt', 'subagentType'])
  })

  test('les positions suivent l ordre d arrivée, et la même demande ne se met pas deux fois en file', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(1), agents: plein(1) })
    expect((await lancement($, 1)).deny).toMatch(/\(n° 1 sur 1\)/)
    expect((await lancement($, 2)).deny).toMatch(/\(n° 2 sur 2\)/)
    const ecrituresAvant = etat.ecritures.length
    expect((await lancement($, 1)).deny).toMatch(/\(n° 1 sur 2\)/)
    expect(etat.ecritures).toHaveLength(ecrituresAvant)
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([1, 2])
  })

  test('sans la file, le refus est celui d avant et rien n est écrit', async ($, on) => {
    const { etat } = monde(on, { politique: politique(2, false), agents: plein(2) })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : 2 agents en cours sur 2 /)
    expect(etat.ecritures).toEqual([])
    expect(etat.file).toBeNull()
  })

  test('en pause, le refus est celui de la pause et rien ne se met en file', async ($, on) => {
    const { etat } = monde(on, { politique: politique(2, true, false, true), agents: [] })
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : en pause\./)
    expect(etat.file).toBeNull()
  })

  test('un fork, un coéquipier ou une demande sans prompt ne se mettent pas en file', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: plein(1) })
    for (const extra of [{ fork: true }, { isTeammate: true }]) {
      const r = await lancement($, 1, extra)
      expect(r.deny).toMatch(/^Régulateur d'agents : maximum atteint, et cette demande ne peut pas être mise en file\. Ne lance pas celui-ci maintenant/)
    }
    const vide = await $.agent.spawn({ prompt: '', description: 'x', subagentType: 'general-purpose' } as never)
    expect(vide.deny).toMatch(/ne peut pas être mise en file/)
    const blanc = await $.agent.spawn({ prompt: '  \n ', description: 'x', subagentType: 'general-purpose' } as never)
    expect(blanc.deny).toMatch(/ne peut pas être mise en file/)
    expect(etat.file).toBeNull()
  })

  test('une file pleine ou une demande trop grande donnent un refus qui dit pourquoi', async ($, on) => {
    const pleine = Array.from({ length: 50 }, (_, i) => entree(i + 1, i + 100))
    const { etat } = monde(on, { politique: politique(1), agents: plein(1), file: fichierFile(pleine) })
    expect((await lancement($, 1)).deny).toMatch(/^Régulateur d'agents : maximum atteint, et la file est pleine \(50 agents\)\./)
    etat.file = null
    const grande = await $.agent.spawn({ prompt: 'x'.repeat(60000), description: 'x', subagentType: 'general-purpose' } as never)
    expect(grande.deny).toMatch(/^Régulateur d'agents : maximum atteint, et cette demande est trop grande pour la file \(60000 caractères au plus\)\./)
  })

  test('si la file ne peut pas être écrite, le refus le dit au lieu de promettre une mise en file', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: plein(1) })
    etat.ecritureFileEchoue = true
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : maximum atteint, et la file d'attente ne peut pas être écrite\. Ne lance pas celui-ci maintenant/)
    expect(r.deny).not.toMatch(/mis en file/)
  })

  test('la file d une autre session ou d un autre agent n entre pas dans la position', async ($, on) => {
    const autres = [entree(1, 7, { session: 'AUTRE' }), entree(2, 8, { agent: 'codex' })]
    monde(on, { politique: politique(1), agents: plein(1), file: fichierFile(autres) })
    expect((await lancement($, 1)).deny).toMatch(/\(n° 1 sur 1\)/)
  })

  test('un lancement autorisé passe et ne touche pas à la file', async ($, on) => {
    const { etat } = monde(on, { politique: politique(3), agents: plein(2) })
    expect((await lancement($)).deny).toBeUndefined()
    expect(etat.lancements).toHaveLength(1)
    expect(etat.file).toBeNull()
  })
})

describe('lancement du suivant', () => {
  test('quand un agent finit, la première demande de la file est lancée avec exactement ses arguments, et quitte la file', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(2), agents: [agent('running', 0), agent('running', 1)] })
    await lancement($, 1, { model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' })
    await lancement($, 2)
    etat.agents = [agent('running', 0)]
    await fini($, 'a1')
    expect(etat.lancements).toEqual([{ prompt: 'Fais le travail 1', description: 'travail 1', model: 'haiku', name: 'audit', cwd: 'C:/travail/wt' }])
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([2])
  })

  test('l agent qui vient de finir ne tient plus de créneau, même si la liste le montre encore en cours', async ($, on) => {
    const { etat } = monde(on, { politique: politique(2), agents: [agent('running', 0), agent('running', 1)] })
    await lancement($, 1)
    await fini($, 'a1')
    expect(etat.lancements).toHaveLength(1)
  })

  test('plusieurs créneaux libres lancent plusieurs demandes, dans l ordre, sans dépasser le maximum', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(3), agents: plein(3) })
    for (const n of [1, 2, 3, 4]) await lancement($, n)
    etat.agents = [agent('running', 0)]
    await fini($, 'a2')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1', 'travail 2'])
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([3, 4])
    expect(etat.agents).toHaveLength(3)
  })

  test('sans créneau libre, rien n est lancé et la file reste intacte', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(2), agents: plein(2) })
    await lancement($, 1)
    await fini($, 'inconnu')
    expect(etat.lancements).toHaveLength(0)
    expect(fileCourante()?.entrees).toHaveLength(1)
    expect(etat.ecritures.filter(e => e.path === FILE)).toHaveLength(1)
  })

  test('deux fins simultanées ne dépassent jamais le maximum', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(2), agents: [agent('running', 0), agent('running', 1)] })
    for (const n of [1, 2, 3]) await lancement($, n)
    etat.agents = []
    await Promise.all([fini($, 'a0'), fini($, 'a1')])
    expect(etat.lancements).toHaveLength(2)
    expect(etat.agents).toHaveLength(2)
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([3])
  })

  test('en pause ou avec la file désactivée, rien n est lancé même s il reste des demandes', async ($, on) => {
    const m = monde(on, { politique: politique(2), agents: plein(2) })
    await lancement($, 1)
    m.etat.agents = []
    m.etat.politique = politique(2, true, false, true)
    await fini($, 'a0')
    expect(m.etat.lancements).toHaveLength(0)
    m.etat.politique = politique(2, false)
    await fini($, 'a0')
    expect(m.etat.lancements).toHaveLength(0)
    expect(m.fileCourante()?.entrees).toHaveLength(1)
  })

  test('une demande d une autre session ou d un autre agent n est jamais lancée par cette session', async ($, on) => {
    const autres = [entree(1, 7, { session: 'AUTRE' }), entree(2, 8, { agent: 'codex' })]
    const { etat, fileCourante } = monde(on, { politique: politique(2), agents: [agent('running', 0)], file: fichierFile(autres) })
    await fini($, 'a0')
    expect(etat.lancements).toHaveLength(0)
    expect(fileCourante()?.entrees).toHaveLength(2)
  })

  test('sans maximum (libre), les demandes restantes sont lancées', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(null), agents: [], file: fichierFile([entree(1, 1), entree(2, 2)]) })
    await fini($, 'a0')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1', 'travail 2'])
    expect(fileCourante()?.entrees).toEqual([])
  })

  test('si un autre plugin refuse le lancement, la demande revient en tête de la file avec ses essais, et la raison est dite une fois', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(3), agents: [], file: fichierFile([entree(1, 1, { essais: 1 }), entree(2, 2)]) })
    etat.refusSpawn = 'Consigne 4 de l\'utilisateur, verrou agent : aucun nouvel agent.'
    await fini($, 'a0')
    await fini($, 'a0')
    expect(etat.lancements).toHaveLength(0)
    expect(fileCourante()?.entrees.map(e => [e.id, e.essais])).toEqual([[1, 1], [2, 0]])
    expect(etat.toasts.filter(t => t.includes('verrou agent'))).toHaveLength(1)
    expect(etat.toasts[0]).toBe("Régulateur d'agents : un agent de la file n'a pas pu être lancé (Consigne 4 de l'utilisateur, verrou agent : aucun nouvel agent.). Il reste en tête de la file.")
  })

  test('une raison de refus différente est dite de nouveau, la même après un succès aussi', async ($, on) => {
    const { etat } = monde(on, { politique: politique(3), agents: [], file: fichierFile([entree(1, 1)]) })
    etat.refusSpawn = 'raison A'
    await fini($, 'a0')
    etat.refusSpawn = 'raison B'
    await fini($, 'a0')
    expect(etat.toasts.map(t => t.match(/\((raison [AB])\)/)?.[1])).toEqual(['raison A', 'raison B'])
    etat.refusSpawn = null
    await fini($, 'a0')
    etat.file = fichierFile([entree(5, 5)])
    etat.refusSpawn = 'raison B'
    await fini($, 'a0')
    expect(etat.toasts.map(t => t.match(/\((raison [AB])\)/)?.[1]).filter(Boolean)).toEqual(['raison A', 'raison B', 'raison B'])
  })

  test('la liste des agents indisponible : rien n est lancé (on ne suppose pas de créneau libre) et la demande reste', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(2), agents: 'panne', file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    expect(etat.lancements).toHaveLength(0)
    expect(fileCourante()?.entrees).toHaveLength(1)
  })

  test('la minuterie de trente secondes lance aussi, au cas où la fin d un agent aurait échappé à la mod', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(2), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await $.session.start(DEMARRAGE)
    await horloge.settle()
    expect(etat.lancements).toHaveLength(1)
    etat.file = fichierFile([entree(2, 2)])
    etat.agents = [agent('running', 0)]
    await horloge.advance(29_999)
    expect(etat.lancements).toHaveLength(1)
    await horloge.advance(1)
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1', 'travail 2'])
  })

  test('un nouveau créneau après /plafond (maximum relevé, libre, reprise, file activée) lance tout de suite', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: plein(1), file: fichierFile([entree(1, 1), entree(2, 2)]) })
    await commande($, 'plafond', '2')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1'])
    await commande($, 'plafond', 'libre')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1', 'travail 2'])
    etat.file = fichierFile([entree(3, 3)])
    await commande($, 'plafond', 'pause')
    expect(etat.lancements).toHaveLength(2)
    await commande($, 'plafond', 'reprendre')
    expect(etat.lancements).toHaveLength(3)
    etat.politique = politique(null, false)
    etat.file = fichierFile([entree(4, 4)])
    await commande($, 'plafond', 'file on')
    expect(etat.lancements).toHaveLength(4)
  })

  test('une file vide ne lit rien d inutile : la liste des agents n est pas demandée', async ($, on) => {
    const { etat } = monde(on, { politique: politique(2), agents: plein(1) })
    await fini($, 'a0')
    expect(etat.listes).toBe(0)
  })
})

describe('ce que le modèle apprend', () => {
  // Un message que le moteur refuse (la mod est déjà déchargée) rejette l'appel : ce rejet ne doit pas rester sans gestionnaire.
  // Simulé PENDANT le test : le rejet réel d'une action encore en vol à la fin du fichier dépend de la vitesse du runner.
  test('un message au modèle que le moteur refuse ne laisse aucun rejet non géré', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(1), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    etat.refusPrompt = true
    await fini($, 'n1', 'answer', 'Rapport : 3 fichiers corrigés.')
    await horloge.settle()
    expect(etat.soumis).toEqual([])
  })

  test('un agent lancé depuis la file qui termine renvoie sa réponse au modèle, comme un message', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(1), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    expect(etat.lancements).toHaveLength(1)
    await fini($, 'n1', 'answer', 'Rapport : 3 fichiers corrigés.')
    await horloge.settle()
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » (mis en file puis lancé automatiquement) a terminé. Sa réponse :\nRapport : 3 fichiers corrigés."])
  })

  test('un agent lancé par le modèle lui-même ne renvoie rien : le canal normal s en charge', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3), agents: [] })
    const r = await lancement($)
    await fini($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.soumis).toEqual([])
  })

  test('un agent lancé depuis la file qui est interrompu le dit, sans relance', async ($, on) => {
    const { etat, horloge, fileCourante } = monde(on, { politique: politique(1, true, true), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    await fini($, 'n1', 'aborted')
    await horloge.settle()
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » a été interrompu. Il n'est pas relancé."])
    expect(etat.lancements).toHaveLength(1)
    expect(fileCourante()?.entrees).toEqual([])
  })

  test('un agent inconnu de la mod qui finit ne déclenche aucun message', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(2) })
    await fini($, 'inconnu')
    await fini($, 'inconnu2', 'error')
    await horloge.settle()
    expect(etat.soumis).toEqual([])
  })

  test('chaque agent terminé produit son propre message, dans l ordre des fins', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3), agents: [agent('running', 0)], file: fichierFile([entree(1, 1), entree(2, 2)]) })
    await fini($, 'a0')
    await fini($, 'n2', 'answer', 'deux')
    await fini($, 'n1', 'answer', 'un')
    await horloge.settle()
    expect(etat.soumis.map(t => t.split('\n')[1])).toEqual(['deux', 'un'])
    expect(etat.soumis.map(t => t.match(/« (.*?) »/)?.[1])).toEqual(['travail 2', 'travail 1'])
  })
})

describe('relance des échoués', () => {
  const echec = async ($: Engine, id: string, reason: 'error' | 'refusal' = 'error') => fini($, id, reason, '')

  test('un agent de la file qui échoue est relancé en tête de la file avec un essai de plus, et le modèle en est informé', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(1, true, true), agents: [agent('running', 0)], file: fichierFile([entree(1, 1), entree(2, 2)]) })
    await fini($, 'a0')
    etat.agents = (etat.agents as Agent[]).filter(a => a.id !== 'a0')
    await echec($, 'n1')
    await horloge.settle()
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1', 'travail 1'])
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » a échoué. Il est relancé automatiquement (relance 1 sur 2)."])
  })

  test('un agent lancé par le modèle est relancé aussi, depuis la demande gardée au lancement', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($, 1, { model: 'haiku' })
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.lancements).toEqual([
      { prompt: 'Fais le travail 1', description: 'travail 1', model: 'haiku' },
      { prompt: 'Fais le travail 1', description: 'travail 1', model: 'haiku' },
    ])
  })

  test('un refus du modèle (refusal) est un échec comme une erreur', async ($, on) => {
    const { etat } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    await echec($, r.agentId ?? 'x', 'refusal')
    expect(etat.lancements).toHaveLength(2)
  })

  test('deux relances au plus : au troisième échec, l agent est abandonné et le modèle le sait', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    await echec($, r.agentId ?? 'x')
    await echec($, 'n2')
    await echec($, 'n3')
    await horloge.settle()
    expect(etat.lancements).toHaveLength(3)
    expect(etat.soumis).toEqual([
      "Régulateur d'agents : l'agent « travail 1 » a échoué. Il est relancé automatiquement (relance 1 sur 2).",
      "Régulateur d'agents : l'agent « travail 1 » a échoué. Il est relancé automatiquement (relance 2 sur 2).",
      "Régulateur d'agents : l'agent « travail 1 » a échoué 3 fois (le premier lancement et 2 relances). Il n'est plus relancé : reprends-le toi-même si besoin.",
    ])
    await echec($, 'n3')
    expect(etat.lancements).toHaveLength(3)
  })

  test('une relance qui réussit renvoie la réponse comme un agent de la file', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    await echec($, r.agentId ?? 'x')
    await fini($, 'n2', 'answer', 'enfin')
    await horloge.settle()
    expect(etat.soumis.at(-1)).toBe("Régulateur d'agents : l'agent « travail 1 » (mis en file puis lancé automatiquement) a terminé. Sa réponse :\nenfin")
  })

  test('la relance passe avant les autres demandes de la file', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(1, true, true), agents: [agent('running', 0)], file: fichierFile([entree(1, 1), entree(2, 2)]) })
    await fini($, 'a0')
    etat.agents = (etat.agents as Agent[]).filter(a => a.id !== 'a0')
    await echec($, 'n1')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1', 'travail 1'])
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([2])
  })

  test('relance désactivée : un agent de la file qui échoue est dit échoué, sans relance ; un agent du modèle ne dit rien', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, false), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    await echec($, 'n1')
    await horloge.settle()
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » a échoué. Il n'est pas relancé automatiquement : reprends-le toi-même si besoin."])
    const r = await lancement($, 2)
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.soumis).toHaveLength(1)
    expect(etat.lancements).toHaveLength(2)
  })

  test('file désactivée : aucune relance automatique, même avec la relance activée', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, false, true), agents: [] })
    const r = await lancement($)
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.lancements).toHaveLength(1)
    expect(etat.soumis).toEqual([])
  })

  test('un fork ou un coéquipier qui échoue n est jamais relancé : il n est pas suivi', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($, 1, { fork: true })
    await echec($, r.agentId ?? 'x')
    const t = await lancement($, 2, { isTeammate: true })
    await echec($, t.agentId ?? 'x')
    await horloge.settle()
    expect(etat.lancements).toHaveLength(2)
    expect(etat.soumis).toEqual([])
  })

  test('un agent qui termine deux fois n est traité qu une fois', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(2, true, true), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    await fini($, 'n1', 'answer', 'un')
    await fini($, 'n1', 'answer', 'deux')
    await echec($, 'n1')
    await horloge.settle()
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » (mis en file puis lancé automatiquement) a terminé. Sa réponse :\nun"])
    expect(etat.lancements).toHaveLength(1)
  })

  test('un agent du modèle interrompu ne dit rien : le canal normal s en charge', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    await fini($, r.agentId ?? 'x', 'aborted')
    await horloge.settle()
    expect(etat.soumis).toEqual([])
    expect(etat.lancements).toHaveLength(1)
  })

  test('la file coupée entre le lancement et l échec : l agent n est pas relancé et rien n est dit', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    etat.politique = politique(3, false, true)
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.lancements).toHaveLength(1)
    expect(etat.soumis).toEqual([])
  })

  test('une relance qui ne peut pas être mise en file (écriture impossible) est dite sans relance, et la file n est pas touchée', async ($, on) => {
    const { etat, horloge } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    etat.ecritureFileEchoue = true
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.lancements).toHaveLength(1)
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » a échoué. Il n'est pas relancé automatiquement : reprends-le toi-même si besoin."])
    expect(etat.file).toBeNull()
  })

  test('une relance qui trouve la file pleine de demandes récentes la laisse intacte et est dite sans relance', async ($, on) => {
    const pleine = Array.from({ length: 50 }, (_, i) => entree(i + 1, i + 100))
    const { etat, horloge, fileCourante } = monde(on, { politique: politique(1, true, true), agents: [] })
    const r = await lancement($)
    etat.agents = [agent('running', 7)]
    etat.file = fichierFile(pleine)
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » a échoué. Il n'est pas relancé automatiquement : reprends-le toi-même si besoin."])
    expect(fileCourante()?.entrees).toHaveLength(50)
    expect(etat.ecritures.filter(e => e.path === FILE)).toHaveLength(0)
  })

  test('une relance retire d abord les demandes de plus de six heures : une file pleine de vieilles demandes accepte la relance', async ($, on) => {
    const vieilles = Array.from({ length: 50 }, (_, i) => entree(i + 1, i + 100, { ajoute: new Date(DEBUT - 7 * 60 * MIN).toISOString() }))
    const { etat, horloge } = monde(on, { politique: politique(1, true, true), agents: [] })
    const r = await lancement($)
    etat.agents = [agent('running', 7)]
    etat.file = fichierFile(vieilles)
    await echec($, r.agentId ?? 'x')
    await horloge.settle()
    expect(etat.soumis).toEqual(["Régulateur d'agents : l'agent « travail 1 » a échoué. Il est relancé automatiquement (relance 1 sur 2)."])
    expect(JSON.parse(etat.file ?? '{}').entrees).toHaveLength(1)
  })

  test('une relance qui n a pas de créneau attend en tête de la file', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(1, true, true), agents: [] })
    const r = await lancement($)
    etat.agents = [agent('running', 7)]
    await echec($, r.agentId ?? 'x')
    expect(etat.lancements).toHaveLength(1)
    expect(fileCourante()?.entrees.map(e => [e.id, e.essais])).toEqual([[1, 1]])
    expect(etat.statuts.at(-1)).toBe('File : 1 en attente')
    etat.agents = []
    await fini($, 'a7')
    expect(etat.lancements).toHaveLength(2)
  })
})

describe('commande /plafond et état', () => {
  test('file on et file off passent par la politique partagée', async ($, on) => {
    const { etat } = monde(on, { politique: politique(3, false) })
    expect((await commande($, 'plafond', 'file on')).text).toBe("Agents : file d'attente activée.")
    expect(JSON.parse(etat.politique ?? '{}').file).toBe(true)
    expect((await commande($, 'plafond', 'file off')).text).toBe("Agents : file d'attente désactivée.")
    expect(JSON.parse(etat.politique ?? '{}').file).toBe(false)
  })

  test('file vider ne retire que les demandes de cette session et de cet agent, et dit combien', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(2), file: fichierFile([entree(1, 1), entree(2, 2), entree(3, 3, { session: 'AUTRE' }), entree(4, 4, { agent: 'codex' })]) })
    expect((await commande($, 'plafond', 'file vider')).text).toBe("Agents : file d'attente vidée (2 agents retirés).")
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([3, 4])
    expect((await commande($, 'plafond', 'file vider')).text).toBe("Agents : la file d'attente est déjà vide.")
    expect(etat.ecritures.filter(e => e.path === FILE)).toHaveLength(1)
  })

  test('l état dit si la file est activée', async ($, on) => {
    monde(on, { politique: politique(5, true) })
    expect((await commande($, 'plafond', '')).text).toBe('Agents : maximum 5, 0 en cours (5 créneaux libres). Relance des échoués : non. File : oui.')
  })

  test('une commande invalide donne l usage avec la file', async ($, on) => {
    monde(on, { politique: politique(5) })
    expect((await commande($, 'plafond', 'file')).text).toBe('Usage : /plafond [N (1 à 50) | libre | pause | reprendre | relance on|off | file on|off|vider]')
  })
})

describe('ligne de statut', () => {
  test('au démarrage, la ligne dit combien de demandes attendent ; sans demande, elle est effacée', async ($, on) => {
    const { etat } = monde(on, { politique: politique(2), file: fichierFile([entree(1, 1), entree(2, 2), entree(3, 3, { session: 'AUTRE' })]) })
    await $.session.start(DEMARRAGE)
    expect(etat.statuts.at(-1)).toBe('File : 2 en attente')
    etat.file = null
    etat.statuts.length = 0
    await $.session.start(DEMARRAGE)
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('la ligne suit la mise en file, le lancement et le vidage', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: plein(1) })
    await lancement($, 1)
    expect(etat.statuts.at(-1)).toBe('File : 1 en attente')
    await lancement($, 2)
    expect(etat.statuts.at(-1)).toBe('File : 2 en attente')
    etat.agents = []
    await fini($, 'a0')
    expect(etat.statuts.at(-1)).toBe('File : 1 en attente')
    await commande($, 'plafond', 'file vider')
    expect(etat.statuts.at(-1)).toBeUndefined()
  })

  test('un lancement depuis la file est annoncé par un message discret', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: [agent('running', 0)], file: fichierFile([entree(1, 1)]) })
    await fini($, 'a0')
    expect(etat.toasts).toEqual(["Régulateur d'agents : « travail 1 » lancé depuis la file."])
  })
})

describe('résilience', () => {
  test('une file illisible est lue comme vide, et une mise en file la réécrit proprement', async ($, on) => {
    const { etat, fileCourante } = monde(on, { politique: politique(1), agents: plein(1), file: '{pas du json' })
    expect((await lancement($)).deny).toMatch(/\(n° 1 sur 1\)/)
    expect(fileCourante()?.entrees).toHaveLength(1)
    expect(etat.file).not.toBe('{pas du json')
  })

  test('une politique absente ou illisible ne lance ni ne met rien en file', async ($, on) => {
    const { etat } = monde(on, { agents: plein(5), file: fichierFile([entree(1, 1)]) })
    for (const p of [null, '{pas du json', '[]']) {
      etat.politique = p
      expect((await lancement($)).deny).toBeUndefined()
      await fini($, 'a0')
    }
    expect(etat.lancements.filter(l => l.description === 'travail 1' && l.prompt === 'Fais le travail 1').length).toBe(3)
  })

  test('le prompt système suit la file : le texte de rappel annonce le lancement automatique', async ($, on) => {
    monde(on, { politique: politique(4, true, true) })
    const t = (await $.prompt.compose({ ...COMPOSE })).sections[1]?.text ?? ''
    expect(t).toContain('Un agent refusé par le maximum est mis en file par le Régulateur et lancé automatiquement dès qu\'un créneau se libère')
    expect(t).toContain('le Régulateur relance lui-même un agent échoué')
  })

  test('une panne du moteur pendant la mise en file se dit comme une demande qui ne peut pas être mise en file', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: plein(1) })
    etat.sessionPanne = true
    const r = await lancement($)
    expect(r.deny).toMatch(/^Régulateur d'agents : maximum atteint, et cette demande ne peut pas être mise en file\./)
    expect(etat.file).toBeNull()
  })

  test('une panne du moteur à la fin d un agent ne casse pas la fin de son tour', async ($, on) => {
    const { etat } = monde(on, { politique: politique(3, true, true), agents: [] })
    const r = await lancement($)
    etat.sessionPanne = true
    const fin = await fini($, r.agentId ?? 'x', 'error', 'raté')
    expect(fin.text).toBe('raté')
    expect(etat.lancements).toHaveLength(1)
  })

  test('un BOM en tête du fichier de la file est toléré', async ($, on) => {
    const bom = String.fromCharCode(0xfeff)
    const { etat, fileCourante } = monde(on, { politique: politique(3), agents: [], file: `${bom}${fichierFile([entree(1, 1)])}` })
    await fini($, 'a0')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 1'])
    expect(fileCourante()?.entrees).toEqual([])
  })

  test('deux cents agents suivis au plus : le plus ancien est oublié au deux cent unième', async ($, on) => {
    const { etat } = monde(on, { politique: politique(null, true, true), agents: [] })
    for (let i = 1; i <= 200; i++) await lancement($, i)
    await fini($, 'n1', 'error', '') // n1 est le premier des deux cents : encore suivi, donc relancé (n201)
    expect(etat.lancements).toHaveLength(201)
    await lancement($, 201) // n202 : le deux cent unième suivi fait oublier le plus ancien, n2
    await fini($, 'n2', 'error', '')
    expect(etat.lancements).toHaveLength(202)
    await fini($, 'n202', 'error', '')
    expect(etat.lancements).toHaveLength(203)
  })

  test('la mise en file retire d abord les entrées de plus de six heures : une file pleine de vieilles demandes accepte', async ($, on) => {
    const vieilles = Array.from({ length: 50 }, (_, i) => entree(i + 1, i + 100, { ajoute: new Date(DEBUT - 7 * 60 * MIN).toISOString() }))
    const { fileCourante } = monde(on, { politique: politique(1), agents: plein(1), file: fichierFile(vieilles) })
    const r = await lancement($, 1)
    expect(r.deny).toMatch(/\(n° 1 sur 1\)/)
    expect(fileCourante()?.entrees).toHaveLength(1)
  })

  test('une demande de plus de six heures est retirée du fichier même quand aucun créneau n est libre', async ($, on) => {
    const vieille = entree(1, 1, { ajoute: new Date(DEBUT - 7 * 60 * MIN).toISOString() })
    const { etat, fileCourante } = monde(on, { politique: politique(1), agents: plein(1), file: fichierFile([vieille, entree(2, 2)]) })
    await fini($, 'inconnu')
    expect(etat.lancements).toHaveLength(0)
    expect(fileCourante()?.entrees.map(e => e.id)).toEqual([2])
  })

  test('une panne du moteur pendant /plafond ne casse pas la commande', async ($, on) => {
    const { etat } = monde(on, { politique: politique(1), agents: [], file: fichierFile([entree(1, 1)]) })
    etat.sessionPanne = true
    const r = await commande($, 'plafond', '3')
    expect(r.text).toBe('Agents : maximum 3 en parallèle.')
    expect(etat.lancements).toHaveLength(0)
  })

  test('les entrées de plus de six heures ne sont jamais lancées : elles sont retirées', async ($, on) => {
    const vieille = entree(1, 1, { ajoute: new Date(DEBUT - 7 * 60 * MIN).toISOString() })
    const { etat, fileCourante } = monde(on, { politique: politique(3), agents: [], file: fichierFile([vieille, entree(2, 2)]) })
    await fini($, 'a0')
    expect(etat.lancements.map(l => l.description)).toEqual(['travail 2'])
    expect(fileCourante()?.entrees).toEqual([])
  })
})
