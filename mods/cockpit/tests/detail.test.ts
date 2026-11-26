import { describe, expect, test } from 'claude-code/testing'

import { duree, sections } from '../hooks/detail'
import type { CockpitAgent, CockpitInstantane } from '../types'
import { INSTANTANE, DEPOT_A } from './fixture'

const MAINTENANT = Date.parse('2026-03-02T20:00:12.000Z')
const trouver = (titre: string, instantane = INSTANTANE, maintenant = MAINTENANT) =>
  sections(instantane, maintenant).find(s => s.titre === titre)

describe('sections du panneau', () => {
  test('les sections sont dans l ordre Mesure, Ledger, Agents, File, Consignes, Nuit, Pause, Git, Plans, Quota, Réglages', () => {
    expect(sections(INSTANTANE, MAINTENANT).map(s => s.titre)).toEqual(['Mesure', 'Ledger', 'Agents', 'File', 'Consignes', 'Nuit', 'Pause', 'Git', 'Plans', 'Quota', 'Réglages'])
  })

  test('Réglages : les worktrees mesurés, le dossier des plans, et la commande pour les changer', () => {
    const reglages: CockpitInstantane = {
      ...INSTANTANE,
      config: { worktrees: [{ nom: 'WA', chemin: 'C:/travail/wa' }, { nom: 'WB', chemin: 'C:/travail/wb' }], plans: { dossier: 'C:/travail/plans', exclure: ['Exclus', 'Vieux'], profondeur: 3 } },
    }
    expect(trouver('Réglages', reglages)?.lignes).toEqual([
      'worktrees mesurés (2)',
      '  WA : C:/travail/wa',
      '  WB : C:/travail/wb',
      'dossier des plans : C:/travail/plans',
      'plans : profondeur 3, exclus : Exclus, Vieux',
      '/cockpit config : afficher, worktree ajouter <nom> <chemin>, worktree retirer <nom>, plans <dossier>',
    ])
  })

  test('Réglages : aucun worktree et aucun dossier exclu sont dits tels quels', () => {
    const vides: CockpitInstantane = { ...INSTANTANE, config: { worktrees: [], plans: { dossier: 'C:/travail/p', exclure: [], profondeur: 1 } } }
    const lignes = trouver('Réglages', vides)?.lignes ?? []
    expect(lignes[0]).toBe('aucun worktree mesuré')
    expect(lignes).toContain('plans : profondeur 1, exclus : aucun')
    expect(lignes).not.toContain('worktrees mesurés (0)')
  })

  test('Réglages : un seul worktree, sans pluriel', () => {
    const un: CockpitInstantane = { ...INSTANTANE, config: { worktrees: [{ nom: 'A', chemin: 'C:/travail/a' }], plans: { dossier: 'C:/travail/p', exclure: [], profondeur: 2 } } }
    expect(trouver('Réglages', un)?.lignes.slice(0, 2)).toEqual(['worktrees mesurés (1)', '  A : C:/travail/a'])
  })

  test('Réglages : le noyau n en rend pas (réglages illisibles, ou mesure d avant les réglages)', () => {
    expect(trouver('Réglages', { ...INSTANTANE, config: undefined })?.lignes).toEqual(['réglages non lus par le noyau'])
    expect(trouver('Réglages', { ...INSTANTANE, config: null })?.lignes).toEqual(['réglages non lus par le noyau'])
  })

  test('File : aucun agent en file quand le noyau n en rend pas (mesure d avant la file comprise)', () => {
    expect(trouver('File')?.lignes).toEqual(["aucun agent en file d'attente"])
    expect(trouver('File', { ...INSTANTANE, file: null })?.lignes).toEqual(["aucun agent en file d'attente"])
  })

  test('File : les comptes accordés, et l âge de la plus ancienne demande', () => {
    const file = (enAttente: number, ordonnees: number, plusAncienne: string | null): CockpitInstantane => ({ ...INSTANTANE, file: { enAttente, ordonnees, plusAncienne } })
    expect(trouver('File', file(3, 1, '2026-03-02T18:00:12.000Z'))?.lignes).toEqual(['3 en attente, 1 ordonné', 'la plus ancienne : il y a 2 h'])
    expect(trouver('File', file(1, 2, '2026-03-02T19:59:00.000Z'))?.lignes).toEqual(['1 en attente, 2 ordonnés', 'la plus ancienne : il y a 1 min'])
    expect(trouver('File', file(2, 0, '2026-03-02T19:59:12.000Z'))?.lignes[0]).toBe('2 en attente, 0 ordonnés')
  })

  test('File : sans date lisible, l ancienneté est dite inconnue ; sans date du tout, rien n est inventé', () => {
    const file = (plusAncienne: string | null): CockpitInstantane => ({ ...INSTANTANE, file: { enAttente: 1, ordonnees: 0, plusAncienne } })
    expect(trouver('File', file('pas une date'))?.lignes).toEqual(['1 en attente, 0 ordonnés', 'ancienneté inconnue'])
    expect(trouver('File', file(null))?.lignes).toEqual(['1 en attente, 0 ordonnés'])
  })

  test('Nuit : inactive et rien en boîte quand le noyau n en rend pas', () => {
    expect(trouver('Nuit')?.lignes).toEqual(['inactive, rien à décider en boîte'])
    expect(trouver('Nuit', { ...INSTANTANE, nuit: null })?.lignes).toEqual(['inactive, rien à décider en boîte'])
  })

  test('Nuit : active, sa durée, ses enchaînements et ce qui attend en boîte', () => {
    const nuit = (extra: Partial<NonNullable<CockpitInstantane['nuit']>>): CockpitInstantane => ({ ...INSTANTANE, nuit: { actif: true, mode: 'nuit', depuis: '2026-03-02T17:00:12.000Z', tours: 3, maxTours: 60, arret: null, aDecider: 2, ...extra } })
    expect(trouver('Nuit', nuit({}))?.lignes).toEqual(['active (nuit), depuis il y a 3 h', '3 enchaînements sur 60 au plus', '2 à décider en boîte (/nuit boite)'])
    expect(trouver('Nuit', nuit({ mode: 'absence', tours: 1, aDecider: 1 }))?.lignes).toEqual(['active (absence), depuis il y a 3 h', '1 enchaînement sur 60 au plus', '1 à décider en boîte (/nuit boite)'])
    expect(trouver('Nuit', nuit({ mode: null, aDecider: 0 }))?.lignes).toEqual(['active (nuit), depuis il y a 3 h', '3 enchaînements sur 60 au plus', 'rien à décider en boîte'])
    expect(trouver('Nuit', nuit({ depuis: null }))?.lignes[0]).toBe('active (nuit), début inconnu')
  })

  test('Nuit : l arrêt de l enchaînement est dit avec sa cause', () => {
    const arret = (cause: string): string | undefined =>
      trouver('Nuit', { ...INSTANTANE, nuit: { actif: true, mode: 'nuit', depuis: '2026-03-02T19:00:12.000Z', tours: 60, maxTours: 60, arret: cause, aDecider: 0 } })?.lignes[2]
    expect(arret('plafond')).toBe("enchaînement arrêté : le plafond d'enchaînements est atteint")
    expect(arret('termine')).toBe('enchaînement arrêté : toutes les lignes ouvertes de la conversation sont traitées')
    expect(arret('pause')).toBe("enchaînement arrêté : le Régulateur d'agents est en pause")
    expect(arret('quota')).toBe('enchaînement arrêté : le Garde-quota a atteint son seuil critique')
    expect(arret('repetition')).toBe("enchaînement arrêté : des lignes n'avançaient pas, laissées de côté")
    expect(arret('inconnu-futur')).toBe('enchaînement arrêté : inconnu-futur')
  })

  test('Nuit : inactive avec des questions en boîte, elle le dit sans durée ni enchaînements', () => {
    const inactive: CockpitInstantane = { ...INSTANTANE, nuit: { actif: false, mode: 'nuit', depuis: '2026-03-02T01:00:00.000Z', tours: 12, maxTours: 60, arret: 'termine', aDecider: 3 } }
    expect(trouver('Nuit', inactive)?.lignes).toEqual(['inactive', '3 à décider en boîte (/nuit boite)'])
  })

  test('Pause : aucune session ouverte quand le noyau n en rend pas (mesure d avant la pause comprise), et pas de bouton', () => {
    expect(trouver('Pause')?.lignes).toEqual(['aucune session ouverte'])
    expect(trouver('Pause', { ...INSTANTANE, pause: null })?.lignes).toEqual(['aucune session ouverte'])
    expect(trouver('Pause')?.boutons ?? []).toEqual([])
  })

  const pauseDe = (liste: NonNullable<CockpitInstantane['pause']>['liste'], extra: Partial<NonNullable<CockpitInstantane['pause']>> = {}): CockpitInstantane => ({
    ...INSTANTANE,
    pause: { sessions: liste.length, sessionsEnPause: liste.filter(x => x.pause).length, agentsArretes: liste.reduce((n, x) => n + x.agents.filter(a => a.arrete).length, 0), liste, ...extra },
  })
  const SESSION_A = { id: 'aaaa1111-2222-3333', court: 'aaaa1111', titre: 'atelier', vu: '2026-03-02T19:59:50.000Z', pause: true, depuis: '2026-03-02T19:57:12.000Z' }
  const SESSION_B = { id: 'bbbb2222-3333-4444', court: 'bbbb2222', titre: 'projet', vu: '2026-03-02T19:59:55.000Z', pause: false, depuis: null }
  const AGENT_REVUE = { id: 'ag-1', nom: 'revue', statut: 'running', propre: false, arrete: true, depuis: null }
  const AGENT_TESTS = { id: 'ag-2', nom: 'tests', statut: 'running', propre: false, arrete: false, depuis: null }
  const AGENT_DOC = { id: 'ag-3', nom: 'doc', statut: 'idle', propre: true, arrete: true, depuis: '2026-03-02T19:59:12.000Z' }

  test('Pause : le compte, puis chaque session avec son état et ses agents', () => {
    const p = pauseDe([{ ...SESSION_A, agents: [AGENT_REVUE] }, { ...SESSION_B, agents: [AGENT_TESTS, AGENT_DOC] }])
    expect(trouver('Pause', p)?.lignes).toEqual([
      '2 sessions ouvertes, 1 en pause, 2 agents arrêtés',
      'aaaa1111 « atelier » : en pause depuis il y a 3 min',
      '  agent revue (running) : arrêté par sa session',
      'bbbb2222 « projet » : active',
      '  agent tests (running) : actif',
      '  agent doc (idle) : en pause depuis il y a 1 min',
    ])
  })

  test('Pause : un seul agent arrêté se dit au singulier', () => {
    expect(trouver('Pause', pauseDe([{ ...SESSION_A, agents: [AGENT_REVUE] }]))?.lignes[0]).toBe('1 session ouverte, 1 en pause, 1 agent arrêté')
  })

  test('Pause : une seule session ouverte, sans pluriel ; sans titre, sans nom ni statut, rien n est inventé', () => {
    const p = pauseDe([{ ...SESSION_B, titre: '', agents: [{ ...AGENT_TESTS, nom: '', statut: '' }] }])
    expect(trouver('Pause', p)?.lignes).toEqual(['1 session ouverte, 0 en pause, 0 agents arrêtés', 'bbbb2222 : active', '  agent ag-2 : actif'])
  })

  test('Pause : une pause sans date lisible est dite sans durée inventée', () => {
    const p = pauseDe([{ ...SESSION_A, depuis: 'pas une date', agents: [{ ...AGENT_DOC, depuis: null }] }])
    expect(trouver('Pause', p)?.lignes.slice(1)).toEqual(['aaaa1111 « atelier » : en pause, date inconnue', '  agent doc (idle) : en pause, date inconnue'])
  })

  test('Pause : un bouton Tout mettre en pause et un bouton Tout reprendre, sur la ligne du compte', () => {
    const boutons = trouver('Pause', pauseDe([{ ...SESSION_B, agents: [] }]))?.boutons ?? []
    expect(boutons.filter(b => b.ligne === 0)).toEqual([
      { ligne: 0, cle: 'pause-tout', libelle: 'Tout mettre en pause', sens: 'pause', mots: ['tout'] },
      { ligne: 0, cle: 'reprendre-tout', libelle: 'Tout reprendre', sens: 'reprendre', mots: ['tout'] },
    ])
  })

  test('Pause : un bouton par session (Reprendre si elle est en pause, Pause sinon) et par agent', () => {
    const p = pauseDe([{ ...SESSION_A, agents: [AGENT_REVUE] }, { ...SESSION_B, agents: [AGENT_TESTS, AGENT_DOC] }])
    expect(trouver('Pause', p)?.boutons?.filter(b => b.ligne > 0)).toEqual([
      { ligne: 1, cle: 'reprendre-session-aaaa1111-2222-3333', libelle: 'Reprendre', sens: 'reprendre', mots: ['--session', 'aaaa1111-2222-3333'] },
      { ligne: 3, cle: 'pause-session-bbbb2222-3333-4444', libelle: 'Pause', sens: 'pause', mots: ['--session', 'bbbb2222-3333-4444'] },
      { ligne: 4, cle: 'pause-agent-bbbb2222-3333-4444-ag-2', libelle: 'Pause', sens: 'pause', mots: ['--session', 'bbbb2222-3333-4444', 'agent', 'ag-2'] },
      { ligne: 5, cle: 'reprendre-agent-bbbb2222-3333-4444-ag-3', libelle: 'Reprendre', sens: 'reprendre', mots: ['--session', 'bbbb2222-3333-4444', 'agent', 'ag-3'] },
    ])
  })

  test('Pause : un agent arrêté par sa session n a pas de bouton, on reprend la session', () => {
    const p = pauseDe([{ ...SESSION_A, agents: [AGENT_REVUE] }])
    const boutons = trouver('Pause', p)?.boutons ?? []
    expect(boutons.some(b => b.ligne === 2)).toBe(false)
  })

  test('Pause : un agent qui a sa propre pause dans une session en pause garde son bouton Reprendre', () => {
    const p = pauseDe([{ ...SESSION_A, agents: [AGENT_DOC] }])
    expect(trouver('Pause', p)?.boutons?.filter(b => b.ligne === 2)).toEqual([
      { ligne: 2, cle: 'reprendre-agent-aaaa1111-2222-3333-ag-3', libelle: 'Reprendre', sens: 'reprendre', mots: ['--session', 'aaaa1111-2222-3333', 'agent', 'ag-3'] },
    ])
  })

  test('Pause : aucun tiret cadratin dans ce que la section affiche', () => {
    const p = pauseDe([{ ...SESSION_A, agents: [AGENT_REVUE, AGENT_DOC] }, { ...SESSION_B, agents: [AGENT_TESTS] }])
    const section = trouver('Pause', p)
    const texte = [section?.titre, ...(section?.lignes ?? []), ...(section?.boutons ?? []).map(b => b.libelle)].join('\n')
    expect(texte.includes(String.fromCharCode(0x2014))).toBe(false)
  })

  test('Consignes : aucune consigne active quand le noyau n en rend pas (mesure d avant les consignes comprise)', () => {
    expect(trouver('Consignes')?.lignes).toEqual(['aucune consigne active'])
    expect(trouver('Consignes', { ...INSTANTANE, consignes: null })?.lignes).toEqual(['aucune consigne active'])
  })

  test('Consignes : le compte, puis chaque consigne avec son identifiant, son état et son verrou', () => {
    const consignes: CockpitInstantane = {
      ...INSTANTANE,
      consignes: {
        illisible: false,
        actives: 2,
        verrouillees: 1,
        consignes: [
          { id: 1, texte: 'Pas de push sans mon ordre', actif: true, verrou: 'push' },
          { id: 3, texte: 'Réponds en français', actif: true, verrou: null },
          { id: 5, texte: 'Pas de rebuild APK', actif: false, verrou: 'rebuild' },
        ],
      },
    }
    expect(trouver('Consignes', consignes)?.lignes).toEqual([
      '2 actives sur 3, 1 verrouillée',
      '1. [actif] Pas de push sans mon ordre [verrou : push]',
      '3. [actif] Réponds en français',
      '5. [pause] Pas de rebuild APK [verrou : rebuild]',
    ])
  })

  test('Consignes : une seule active et aucune verrouillée, accordées', () => {
    const une: CockpitInstantane = { ...INSTANTANE, consignes: { illisible: false, actives: 1, verrouillees: 0, consignes: [{ id: 2, texte: 'Français', actif: true, verrou: null }] } }
    expect(trouver('Consignes', une)?.lignes[0]).toBe('1 active sur 1, 0 verrouillées')
  })

  test('Consignes : un fichier illisible est dit, avec ce que cela change', () => {
    const abime: CockpitInstantane = { ...INSTANTANE, consignes: { illisible: true, actives: 0, verrouillees: 0, consignes: [] } }
    expect(trouver('Consignes', abime)?.lignes).toEqual(['consignes.json illisible : les consignes ne sont plus rappelées ni appliquées'])
  })

  test('Consignes : un texte long est coupé à cent caractères', () => {
    const long: CockpitInstantane = { ...INSTANTANE, consignes: { illisible: false, actives: 1, verrouillees: 0, consignes: [{ id: 1, texte: 'x'.repeat(240), actif: true, verrou: null }] } }
    const ligne = trouver('Consignes', long)?.lignes[1] ?? ''
    expect(ligne).toBe(`1. [actif] ${'x'.repeat(97)}...`)
  })

  test('Mesure : âge de la mesure et de la mesure git, ou git jamais mesuré', () => {
    expect(trouver('Mesure')?.lignes).toEqual(['mesure il y a 12 s', 'git mesuré il y a 42 s'])
    expect(trouver('Mesure', { ...INSTANTANE, git: null })?.lignes).toEqual(['mesure il y a 12 s', 'git jamais mesuré'])
    const plusTard = Date.parse('2026-03-02T23:30:00.000Z')
    expect(trouver('Mesure', INSTANTANE, plusTard)?.lignes[0]).toBe('mesure il y a 3 h')
  })

  test('Ledger : totaux avec accords, puis chaque ligne bloquée nommée avec son projet', () => {
    const l = trouver('Ledger')
    expect(l?.lignes[0]).toBe('2 ouvertes, 1 bloquée, 0 à trier')
    expect(l?.lignes[1]).toBe('bloquée : P1/C-0003 : attend la décision de l\'utilisateur sur le push')
    expect(l?.lignes).toHaveLength(2)
  })

  test('Ledger : au plus huit lignes bloquées, le reste compté, les textes longs coupés', () => {
    const p = INSTANTANE.ledger.agents.claude!.P1!
    const bloquees = Array.from({ length: 11 }, (_, i) => ({ id: `C-${1000 + i}`, texte: 'x'.repeat(200), statut: 'bloque-utilisateur', note: null }))
    const grand = { ...INSTANTANE, ledger: { ...INSTANTANE.ledger, agents: { claude: { P1: { ...p, lignesBloquees: bloquees } } } } }
    const l = trouver('Ledger', grand)
    expect(l?.lignes.filter(x => x.startsWith('bloquée : '))).toHaveLength(8)
    expect(l?.lignes[l.lignes.length - 1]).toBe('+3 autres bloquées')
    expect(l?.lignes[1]?.length).toBeLessThanOrEqual(130)
  })

  test('Agents : comptes, puis chaque agent échoué ou à traiter avec sa ligne', () => {
    const a = trouver('Agents')
    expect(a?.lignes[0]).toBe('1 en cours, 1 à traiter, 1 échoué')
    expect(a?.lignes).toContain('échoué : C (failed) ligne P1/C-0012')
    expect(a?.lignes).toContain('à traiter : B ligne P1/C-0011')
  })

  // Une fiche « en cours » que le noyau a écartée : plus de trois heures sans nouvelle de l'agent, sa fin n'est jamais venue.
  const obsolete = (nom: string, ligne: string): CockpitAgent => ({ ligne, nom, genre: 'default', id: `id-${nom}`, note: 'agent en cours depuis 2026-03-01 08:00', statutFin: null })
  const avecObsoletes = (obsoletes: CockpitAgent[]): CockpitInstantane => {
    const p = INSTANTANE.ledger.agents.claude!.P1!
    return {
      ...INSTANTANE,
      ledger: {
        ...INSTANTANE.ledger,
        totaux: { ...INSTANTANE.ledger.totaux, agentsObsoletes: obsoletes.length },
        agents: { claude: { P1: { ...p, agents: { ...p.agents, obsoletes } } } },
      },
    }
  }

  test('Agents : les agents obsolètes sont comptés à part puis nommés avec leur ligne, après les échoués et les à traiter', () => {
    expect(trouver('Agents', avecObsoletes([obsolete('X', 'C-0020'), obsolete('Y', 'C-0021')]))?.lignes).toEqual([
      '1 en cours, 2 obsolètes, 1 à traiter, 1 échoué',
      'échoué : C (failed) ligne P1/C-0012',
      'à traiter : B ligne P1/C-0011',
      'obsolète : X ligne P1/C-0020',
      'obsolète : Y ligne P1/C-0021',
    ])
  })

  test('Agents : un obsolète s écrit au singulier, et au plus six sont nommés, le reste compté', () => {
    expect(trouver('Agents', avecObsoletes([obsolete('X', 'C-0020')]))?.lignes[0]).toBe('1 en cours, 1 obsolète, 1 à traiter, 1 échoué')
    const huit = Array.from({ length: 8 }, (_, i) => obsolete(`O${i}`, `C-${2000 + i}`))
    const a = trouver('Agents', avecObsoletes(huit))?.lignes ?? []
    expect(a.filter(l => l.startsWith('obsolète : '))).toHaveLength(6)
    expect(a[a.length - 1]).toBe('+2 autres obsolètes')
  })

  test('Agents : une mesure faite avant les obsolètes (sans leur clé) ne montre ni undefined ni NaN', () => {
    const { agentsObsoletes: _compte, ...totaux } = INSTANTANE.ledger.totaux
    const p = INSTANTANE.ledger.agents.claude!.P1!
    const { obsoletes: _liste, ...agents } = p.agents
    const ancien = { ...INSTANTANE, ledger: { ...INSTANTANE.ledger, totaux, agents: { claude: { P1: { ...p, agents } } } } } as unknown as CockpitInstantane
    const a = trouver('Agents', ancien)?.lignes ?? []
    expect(a[0]).toBe('1 en cours, 1 à traiter, 1 échoué')
    expect(a.join('\n')).not.toMatch(/undefined|NaN/)
  })

  test('Agents : la politique du Régulateur est dite juste après les comptes, ou rien quand elle n existe pas', () => {
    const avec = (politiqueAgents: { max: number | null; pause: boolean; relance: boolean } | null) => trouver('Agents', { ...INSTANTANE, politiqueAgents })?.lignes ?? []
    expect(avec(null)[1]).toBe('échoué : C (failed) ligne P1/C-0012')
    expect(avec(null).some(l => l.startsWith('politique'))).toBe(false)
    expect(avec({ max: null, pause: false, relance: false })[1]).toBe('politique : libre, relance : non')
    expect(avec({ max: 5, pause: false, relance: false })[1]).toBe('politique : maximum 5, relance : non')
    expect(avec({ max: 5, pause: true, relance: true })[1]).toBe('politique : en pause (maximum 5), relance : oui')
    expect(avec({ max: null, pause: true, relance: false })[1]).toBe('politique : en pause, relance : non')
    expect(avec({ max: 5, pause: false, relance: true })[0]).toBe('1 en cours, 1 à traiter, 1 échoué')
  })

  test('Git : légende, puis par dépôt l arbre, main, le distant, main local et la branche distante', () => {
    const g = trouver('Git')?.lignes ?? []
    expect(g[0]).toBe('+N : commits en avance, -N : commits en retard')
    expect(g).toContain('WA : travail/integration')
    expect(g).toContain('  arbre : propre')
    expect(g).toContain('  contre main : identique')
    expect(g).toContain('  contre son distant : +15')
    expect(g).toContain('  main local : différent de son distant')
    expect(g).toContain('WB : travail/fondation')
    expect(g).toContain('  arbre : 3 fichiers modifiés ou non suivis')
    expect(g).toContain('  contre main : +2/-1')
    expect(g).toContain('  main local : égal à son distant')
    expect(g).toContain('  branche distante : égale à main distant')
  })

  test('Git : pas de distant, distant non mesuré et dépôt illisible sont dits tels quels', () => {
    const base = INSTANTANE.git!.depots[0]!
    const sansDistant = { ...base, nom: 'A', upstream: null, vsDistant: null, constats: { ...base.constats, egalDistant: null, mainEgalDistant: null, distantEgalMainDistant: null } }
    const nonMesure = { ...base, nom: 'B', vsDistant: null }
    const illisible = { ...base, nom: 'C', branche: null, sale: null, vsMain: null, vsDistant: null, upstream: null, erreurs: ['git : fatal'], constats: { propre: null, egalMain: null, egalDistant: null, mainEgalDistant: null, distantEgalMainDistant: null } }
    const g = trouver('Git', { ...INSTANTANE, git: { ...INSTANTANE.git!, depots: [sansDistant, nonMesure, illisible] } })?.lignes ?? []
    expect(g).toContain('A : travail/integration')
    expect(g).toContain('  contre son distant : pas de distant')
    expect(g).toContain('  main local : inconnu')
    expect(g).toContain('B : travail/integration')
    expect(g).toContain('  contre son distant : non mesuré')
    expect(g).toContain('C : illisible (git : fatal)')
  })

  test('Git : jamais mesuré quand le cache git est absent', () => {
    expect(trouver('Git', { ...INSTANTANE, git: null })?.lignes).toEqual(['jamais mesuré'])
  })

  test('Plans : pourcentage et fichiers qui ont le plus de cases restantes, coupés à cinq', () => {
    const p = trouver('Plans')
    expect(p?.lignes[0]).toBe('50 % (2/4) dans 2 fichiers')
    expect(p?.lignes[1]).toBe('A.md : 2 restantes (1/3)')
    expect(p?.lignes[2]).toBe('sous\\B.md : 0 restantes (1/1)')
    const fichiers = Array.from({ length: 9 }, (_, i) => ({ fichier: `F${i}.md`, total: 10 + i, cochees: 0 }))
    const grand = trouver('Plans', { ...INSTANTANE, plans: { total: 99, cochees: 0, pct: 0, fichiers } })
    expect(grand?.lignes).toHaveLength(6)
    expect(grand?.lignes[1]).toBe('F8.md : 18 restantes (0/18)')
  })

  test('Mesure : une date illisible est dite, sans NaN', () => {
    const l = trouver('Mesure', { ...INSTANTANE, mesureA: 'pas une date', git: { ...INSTANTANE.git!, mesureA: '' } })?.lignes
    expect(l).toEqual(['mesure à une date inconnue', 'git mesuré à une date inconnue'])
  })

  test('Plans : aucune case trouvée est dit, sans pourcentage', () => {
    expect(trouver('Plans', { ...INSTANTANE, plans: { total: 0, cochees: 0, pct: null, fichiers: [] } })?.lignes).toEqual(['aucune case trouvée'])
  })

  test('Plans : une erreur du noyau est dite, sans pourcentage', () => {
    const p = trouver('Plans', { ...INSTANTANE, plans: { total: 0, cochees: 0, pct: null, fichiers: [], erreur: 'dossier de plans introuvable : X' } })
    expect(p?.lignes).toEqual(['erreur : dossier de plans introuvable : X'])
  })

  test('Quota : une ligne par agent, jamais mesuré pour un agent sans mesure', () => {
    expect(trouver('Quota')?.lignes).toEqual(['claude : 7 j 71 %', 'codex : jamais mesuré'])
  })

  test('Quota : une entrée qui n est pas une mesure ne fait pas planter le panneau, elle est dite jamais mesurée', () => {
    const bizarre = { claude: { fenetres: [{ nom: '5 h', pct: 12 }] }, garde: { attention: 80, critique: 90 }, vide: null, liste: [] } as unknown as CockpitInstantane['quota']
    expect(trouver('Quota', { ...INSTANTANE, quota: bizarre })?.lignes).toEqual(['claude : 5 h 12 %', 'garde : jamais mesuré', 'vide : jamais mesuré', 'liste : jamais mesuré'])
  })

  test('duree : secondes, minutes, heures, jours, jamais négative', () => {
    expect([duree(5_000), duree(59_999), duree(60_000), duree(300_000), duree(3_599_000), duree(3_600_000), duree(7_200_000), duree(86_399_000), duree(86_400_000), duree(2 * 86_400_000), duree(-5_000)])
      .toEqual(['5 s', '59 s', '1 min', '5 min', '59 min', '1 h', '2 h', '23 h', '1 j', '2 j', '0 s'])
  })

  test('Git : une comparaison à main qui n a pas pu être mesurée est dite inconnue', () => {
    const sansMain = { ...DEPOT_A, nom: 'M', vsMain: null, erreurs: ['rev-list main : fatal'] }
    const g = trouver('Git', { ...INSTANTANE, git: { ...INSTANTANE.git!, depots: [sansMain] } })?.lignes ?? []
    expect(g).toContain('  contre main : inconnu')
    expect(g).toContain('  arbre : propre')
  })

  test('Git : des erreurs partielles n empêchent pas d afficher ce qui a été mesuré', () => {
    const partiel = { ...DEPOT_A, nom: 'P', erreurs: ['rev-list distant : timeout'] }
    const g = trouver('Git', { ...INSTANTANE, git: { ...INSTANTANE.git!, depots: [partiel] } })?.lignes ?? []
    expect(g).toContain('P : travail/integration')
    expect(g).toContain('  arbre : propre')
    expect(g.some(x => x.includes('illisible'))).toBe(false)
  })

  test('Git : un dépôt seulement en retard sur main s écrit -N', () => {
    const enRetard = { ...DEPOT_A, nom: 'R', vsMain: { ahead: 0, behind: 3 } }
    const g = trouver('Git', { ...INSTANTANE, git: { ...INSTANTANE.git!, depots: [enRetard] } })?.lignes ?? []
    expect(g).toContain('  contre main : -3')
  })

  test('Git : un seul fichier modifié s écrit au singulier', () => {
    const un = { ...DEPOT_A, nom: 'U', sale: 1 }
    const g = trouver('Git', { ...INSTANTANE, git: { ...INSTANTANE.git!, depots: [un] } })?.lignes ?? []
    expect(g).toContain('  arbre : 1 fichier modifié ou non suivi')
  })

  test('Agents : au plus six par catégorie, le reste compté', () => {
    const p = INSTANTANE.ledger.agents.claude!.P1!
    const fiche = (n: number, statutFin: string) => ({ ligne: `C-${2000 + n}`, nom: `N${n}`, genre: 'general-purpose', id: `id-${n}`, note: '', statutFin })
    const echoues = Array.from({ length: 9 }, (_, i) => fiche(i, 'failed'))
    const aTraiter = Array.from({ length: 8 }, (_, i) => fiche(100 + i, 'completed'))
    const grand = { ...INSTANTANE, ledger: { ...INSTANTANE.ledger, agents: { claude: { P1: { ...p, agents: { enCours: [], obsoletes: [], aTraiter, echoues } } } } } }
    const l = trouver('Agents', grand)?.lignes ?? []
    expect(l.filter(x => x.startsWith('échoué : '))).toHaveLength(6)
    expect(l).toContain('+3 autres échoués')
    expect(l.filter(x => x.startsWith('à traiter : '))).toHaveLength(6)
    expect(l).toContain('+2 autres à traiter')
  })

  test('Agents : une fin sans statut est dite fin inconnue', () => {
    const p = INSTANTANE.ledger.agents.claude!.P1!
    const sans = { ligne: 'C-0099', nom: 'Z', genre: 'x', id: 'id-z', note: '', statutFin: null }
    const l = trouver('Agents', { ...INSTANTANE, ledger: { ...INSTANTANE.ledger, agents: { claude: { P1: { ...p, agents: { ...p.agents, echoues: [sans] } } } } } })?.lignes ?? []
    expect(l).toContain('échoué : Z (fin inconnue) ligne P1/C-0099')
  })

  test('Plans : à reste égal, l ordre est alphabétique', () => {
    const fichiers = [{ fichier: 'b.md', total: 5, cochees: 0 }, { fichier: 'a.md', total: 5, cochees: 0 }, { fichier: 'c.md', total: 5, cochees: 0 }]
    const p = trouver('Plans', { ...INSTANTANE, plans: { total: 15, cochees: 0, pct: 0, fichiers } })?.lignes ?? []
    expect(p.slice(1)).toEqual(['a.md : 5 restantes (0/5)', 'b.md : 5 restantes (0/5)', 'c.md : 5 restantes (0/5)'])
  })

  test('Quota : pourcentage arrondi, point d interrogation quand il est illisible', () => {
    const quota = { claude: { fenetres: [{ nom: '5 h', pct: 40.4 }, { nom: '7 j', pct: 71.6 }, { nom: 'x', pct: null }] } }
    expect(trouver('Quota', { ...INSTANTANE, quota })?.lignes).toEqual(['claude : 5 h 40 %, 7 j 72 %, x ? %'])
  })

  test('Ledger : un message long est coupé à cent caractères avec des points de suspension', () => {
    const p = INSTANTANE.ledger.agents.claude!.P1!
    const longue = { id: 'C-0500', texte: `${'a'.repeat(60)} ${'b'.repeat(60)}`, statut: 'bloque-utilisateur', note: null }
    const l = trouver('Ledger', { ...INSTANTANE, ledger: { ...INSTANTANE.ledger, agents: { claude: { P1: { ...p, lignesBloquees: [longue] } } } } })?.lignes ?? []
    expect(l[1]).toBe(`bloquée : P1/C-0500 : ${'a'.repeat(60)} ${'b'.repeat(36)}...`)
  })

  test('aucune section ne contient de tiret cadratin', () => {
    const tout = sections(INSTANTANE, MAINTENANT).flatMap(s => [s.titre, ...s.lignes]).join('\n')
    expect(/\u{2014}/u.test(tout)).toBe(false)
  })
})
