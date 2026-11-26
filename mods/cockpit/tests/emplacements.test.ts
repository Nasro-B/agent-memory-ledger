import { describe, expect, mock, test as testMoteur } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { INSTANTANE_PAUSE } from './fixture'

// Où le module lance le noyau : scripts/cockpit.js du plugin, trouvé par AML_PLUGIN_DIR ou à côté du module (emplacements-logique.mjs). Le module ne lit
// ni n'écrit aucun fichier d'état lui-même : tout passe par ce script, qui lit et écrit le dossier d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit).
// Introuvable, la bande, la commande et les boutons le disent.
const test = (nom: string, corps: ($: Engine, on: On) => unknown) => testMoteur(nom, { timeoutMs: 30_000 }, corps)

const DEBUT = Date.parse('2026-03-02T20:00:12.000Z')
const BANDE = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const PANNEAU = { title: 'Cockpit', isFocused: false, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const sortie = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// Le monde simulé : les variables d'environnement, le disque (rien n'existe), le noyau (il répond si on le lance) et ce que le moteur répond au démarrage.
function monde(on: On, variables: Record<string, string | undefined>) {
  const etat = { appels: [] as string[][], toasts: [] as string[] }
  const horloge = mock.clock(on, { now: DEBUT })
  on('env.get', (_$, e) => ({ value: variables[e.name] }) as never) // comme mock.env, mais les variables restent modifiables pendant le test
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ deny: 'ENOENT: dossier absent' }))
  on('process.run', (_$, e) => {
    etat.appels.push([...e.argv])
    return sortie(e.argv[2] === 'instantane' ? JSON.stringify(INSTANTANE_PAUSE) : 'ok\n')
  })
  on('ui.toast', (_$, e) => {
    etat.toasts.push(e.text)
    return { value: undefined }
  })
  return Object.assign(etat, { horloge })
}

const demarrer = ($: Engine) => $.session.start({ cwd: 'C:/travail', surface: 'terminal', isInteractive: true })
const commande = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never)
const INTROUVABLE = /cockpit\.js introuvable : poser AML_PLUGIN_DIR/

describe('script du noyau', () => {
  test('est scripts/cockpit.js du plugin : AML_PLUGIN_DIR, avec ou sans séparateur final', async ($, on) => {
    const etat = monde(on, { AML_PLUGIN_DIR: 'C:/outils/ledger/' })
    await demarrer($)
    await etat.horloge.settle()
    expect(etat.appels.map(a => a.slice(0, 3))).toContainEqual(['node', 'C:/outils/ledger/scripts/cockpit.js', 'instantane'])
    expect(etat.appels.every(a => a[1] === 'C:/outils/ledger/scripts/cockpit.js')).toBe(true)
  })

  test('introuvable : la bande le dit avec la cause, et rien n est lancé', async ($, on) => {
    const etat = monde(on, {})
    await demarrer($)
    await etat.horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BANDE })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^Cockpit indisponible : cockpit\.js introuvable : poser AML_PLUGIN_DIR/)
    expect(etat.appels).toEqual([])
    await ui.unmount()
  })

  test('introuvable : /cockpit config le dit, sans planter', async ($, on) => {
    const etat = monde(on, {})
    await demarrer($)
    await etat.horloge.settle()
    expect((await commande($, 'cockpit', 'config afficher')).text).toMatch(/^Réglages : cockpit\.js introuvable : poser AML_PLUGIN_DIR/)
    expect(etat.appels).toEqual([])
  })
})

describe('boutons sans le script', () => {
  test('un bouton de pause dit que le script est introuvable', async ($, on) => {
    // Le script est trouvé au démarrage (la mesure porte la pause), puis disparaît : la variable est retirée avant la pression.
    const variables: Record<string, string | undefined> = { AML_PLUGIN_DIR: 'C:/outils/ledger' }
    const etat = monde(on, variables)
    await demarrer($)
    await etat.horloge.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: PANNEAU })
    await ui.select({ key: 'vue', value: 'agents' })
    delete variables.AML_PLUGIN_DIR
    await ui.press({ key: 'pause-tout' })
    await etat.horloge.settle()
    expect(etat.toasts).toHaveLength(1)
    expect(etat.toasts[0]).toMatch(INTROUVABLE)
    expect(etat.toasts[0]).toMatch(/^Pause : /)
    await ui.unmount()
  })
})
