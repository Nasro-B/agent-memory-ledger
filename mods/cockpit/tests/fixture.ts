import type { CockpitDepot, CockpitInstantane } from '../types'

const CONSTATS_OK = { propre: true, egalMain: true, egalDistant: true, mainEgalDistant: true, distantEgalMainDistant: true }

export const DEPOT_A: CockpitDepot = {
  nom: 'WA',
  chemin: 'C:/travail/wa',
  branche: 'travail/integration',
  upstream: 'origin/travail/integration',
  sale: 0,
  vsMain: { ahead: 0, behind: 0 },
  vsDistant: { ahead: 15, behind: 0 },
  constats: { ...CONSTATS_OK, egalDistant: false, mainEgalDistant: false },
  erreurs: [],
}

export const DEPOT_B: CockpitDepot = {
  nom: 'WB',
  chemin: 'C:/travail/wb',
  branche: 'travail/fondation',
  upstream: 'origin/travail/fondation',
  sale: 3,
  vsMain: { ahead: 2, behind: 1 },
  vsDistant: { ahead: 2, behind: 0 },
  constats: { ...CONSTATS_OK, propre: false, egalMain: false, egalDistant: false },
  erreurs: [],
}

export const INSTANTANE: CockpitInstantane = {
  ligne: 'Cockpit | ledger 2 ouvertes, 1 bloquée | agents 1 en cours, 1 échoué | WA propre, = main, +15 distant, main non poussé | WB 3 modif, +2/-1 main, +2 distant | plans 50 % (2/4) | quota claude 7 j 71 %',
  mesureA: '2026-03-02T20:00:00.000Z',
  config: { worktrees: [{ nom: 'WA', chemin: DEPOT_A.chemin }, { nom: 'WB', chemin: DEPOT_B.chemin }], plans: { dossier: 'C:/travail/plans', exclure: [], profondeur: 2 } },
  modelesAgents: { defaut: 'sonnet', parType: { Explore: 'haiku', 'general-purpose': null } },
  erreurModeles: null,
  ledger: {
    totaux: { ouvertes: 2, bloquees: 1, aTrier: 0, agentsEnCours: 1, agentsObsoletes: 0, agentsATraiter: 1, agentsEchoues: 1 },
    agents: {
      claude: {
        P1: {
          lignesOuvertes: [
            { id: 'C-0001', texte: 'travail A', statut: 'ouvert', note: null },
            { id: 'C-0002', texte: 'travail B', statut: 'en-cours', note: null },
          ],
          lignesBloquees: [{ id: 'C-0003', texte: 'attend la décision de l\'utilisateur sur le push', statut: 'bloque-utilisateur', note: 'attend l\'utilisateur' }],
          demandesATrier: [],
          agents: {
            enCours: [{ ligne: 'C-0010', nom: 'A', genre: 'general-purpose', id: 'id-a', note: 'agent en cours depuis 06:04', statutFin: null }],
            obsoletes: [],
            aTraiter: [{ ligne: 'C-0011', nom: 'B', genre: 'general-purpose', id: 'id-b', note: 'TERMINÉ (completed)', statutFin: 'completed' }],
            echoues: [{ ligne: 'C-0012', nom: 'C', genre: 'general-purpose', id: 'id-c', note: 'TERMINÉ (failed)', statutFin: 'failed' }],
          },
        },
      },
    },
    erreurs: [],
  },
  git: { mesureA: '2026-03-02T19:59:30.000Z', ageS: 30, depots: [DEPOT_A, DEPOT_B] },
  plans: {
    total: 4,
    cochees: 2,
    pct: 50,
    fichiers: [
      { fichier: 'A.md', total: 3, cochees: 1 },
      { fichier: 'sous\\B.md', total: 1, cochees: 1 },
    ],
  },
  quota: { claude: { fenetres: [{ nom: '7 j', pct: 71 }] }, codex: null },
}

// Deux sessions ouvertes : la première en pause (son agent « revue » arrêté avec elle), la seconde active avec un agent actif et un agent en pause seul.
export const INSTANTANE_PAUSE: CockpitInstantane = {
  ...INSTANTANE,
  pause: {
    sessions: 2,
    sessionsEnPause: 1,
    agentsArretes: 2,
    liste: [
      {
        id: 'aaaa1111-2222-3333', court: 'aaaa1111', titre: 'atelier', vu: '2026-03-02T19:59:50.000Z', pause: true, depuis: '2026-03-02T19:57:12.000Z',
        agents: [{ id: 'ag-1', nom: 'revue', statut: 'running', propre: false, arrete: true, depuis: null }],
      },
      {
        id: 'bbbb2222-3333-4444', court: 'bbbb2222', titre: 'projet', vu: '2026-03-02T19:59:55.000Z', pause: false, depuis: null,
        agents: [
          { id: 'ag-2', nom: 'tests', statut: 'running', propre: false, arrete: false, depuis: null },
          { id: 'ag-3', nom: 'doc', statut: 'idle', propre: true, arrete: true, depuis: '2026-03-02T19:59:12.000Z' },
        ],
      },
    ],
  },
}
