// Contrat de la mod Cockpit : la forme de ce que `node scripts/cockpit.js instantane --json` rend
// (noyau : scripts/lib/cockpit-core.js) et les valeurs que la mod garde dans $.state.

export type CockpitLigne = { id: string; texte: string; statut: string; note: string | null }

export type CockpitAgent = {
  ligne: string
  nom: string
  genre: string
  id: string
  note: string
  statutFin: string | null
}

export type CockpitProjet = {
  lignesOuvertes: CockpitLigne[]
  lignesBloquees: CockpitLigne[]
  demandesATrier: string[]
  /** `obsoletes` : agents « en cours » sans nouvelle depuis plus de trois heures (ou sans date), leur fin n'est jamais venue. */
  agents: { enCours: CockpitAgent[]; obsoletes: CockpitAgent[]; aTraiter: CockpitAgent[]; echoues: CockpitAgent[] }
}

export type CockpitEcart = { ahead: number; behind: number }

export type CockpitDepot = {
  nom: string
  chemin: string
  branche: string | null
  upstream: string | null
  sale: number | null
  vsMain: CockpitEcart | null
  vsDistant: CockpitEcart | null
  constats: {
    propre: boolean | null
    egalMain: boolean | null
    egalDistant: boolean | null
    mainEgalDistant: boolean | null
    distantEgalMainDistant: boolean | null
  }
  erreurs: string[]
}

export type CockpitQuota = {
  fenetres: { nom: string; pct: number | null; resetsAt?: string }[]
  mesureA?: string
  source?: string
}

export type CockpitPolitique = { max: number | null; pause: boolean; relance: boolean }

export type CockpitConsigne = { id: number; texte: string; actif: boolean; verrou: string | null }

/** Les consignes en vigueur (mod Consignes) : `illisible` quand consignes.json est abîmé (elles ne sont alors ni rappelées ni appliquées). */
export type CockpitConsignes = { illisible: boolean; actives: number; verrouillees: number; consignes: CockpitConsigne[] }

/** La file d'attente des agents (Régulateur), toutes conversations confondues ; `plusAncienne` : la date de la demande la plus ancienne. */
export type CockpitFile = { enAttente: number; ordonnees: number; plusAncienne: string | null }

/** La nuit (mod Nuit et hooks Codex) : `arret` est la cause de l'arrêt de l'enchaînement (plafond, termine, pause, quota, repetition), `aDecider` le nombre de questions en boîte. */
export type CockpitNuit = {
  actif: boolean
  mode: 'nuit' | 'absence' | null
  depuis: string | null
  tours: number
  maxTours: number
  arret: string | null
  aDecider: number
}

/** Un agent d'une session ouverte, vu par la pause : `propre` s'il a sa propre pause, `arrete` s'il est arrêté (par la sienne ou par celle de sa session). */
export type CockpitPauseAgent = { id: string; nom: string; statut: string; propre: boolean; arrete: boolean; depuis: string | null }

/** Une session ouverte (mod Pause) ; `court` : les huit premiers caractères de son identifiant. */
export type CockpitPauseSession = { id: string; court: string; titre: string; vu: string | null; pause: boolean; depuis: string | null; agents: CockpitPauseAgent[] }

/** La pause (mod Pause, ligne de commande, Cockpit) : les sessions ouvertes (sans battement depuis cinq minutes, une session est morte) et leurs agents. */
export type CockpitPause = { sessions: number; sessionsEnPause: number; agentsArretes: number; liste: CockpitPauseSession[] }

/** Les réglages du Cockpit en vigueur (config.json, sinon les valeurs par défaut) : les worktrees mesurés et le dossier des plans. */
export type CockpitConfig = {
  worktrees: { nom: string; chemin: string }[]
  plans: { dossier: string; exclure: string[]; profondeur: number }
}

export type CockpitModelesAgents = { defaut: string | null; parType: Record<string, string | null> }

export type CockpitInstantane = {
  ligne: string
  mesureA: string
  /** Les réglages en vigueur ; null quand le noyau ne peut pas les lire. */
  config?: CockpitConfig | null
  modelesAgents?: CockpitModelesAgents | null
  erreurModeles?: string | null
  /** La politique du Régulateur d'agents ; null tant que personne n'a rien décidé. */
  politiqueAgents?: CockpitPolitique | null
  /** Les consignes en vigueur ; null tant qu'aucune n'est active (et que le fichier n'est pas abîmé). */
  consignes?: CockpitConsignes | null
  /** La file d'attente des agents ; null tant qu'elle est vide. */
  file?: CockpitFile | null
  /** La nuit ; null tant qu'elle est inactive et que rien n'attend en boîte. */
  nuit?: CockpitNuit | null
  /** La pause ; null tant qu'aucune session n'est ouverte. */
  pause?: CockpitPause | null
  ledger: {
    totaux: {
      ouvertes: number
      bloquees: number
      aTrier: number
      agentsEnCours: number
      agentsObsoletes: number
      agentsATraiter: number
      agentsEchoues: number
    }
    agents: Record<string, Record<string, CockpitProjet>>
    erreurs: string[]
  }
  git: { mesureA: string; ageS: number | null; depots: CockpitDepot[] } | null
  plans: {
    total: number
    cochees: number
    pct: number | null
    fichiers: { fichier: string; total: number; cochees: number }[]
    erreur?: string
  }
  quota: Record<string, CockpitQuota | null>
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      snapshot: CockpitInstantane | null
      erreur: string | null
      panneau: {
        vue: 'apercu' | 'agents' | 'projets' | 'plans' | 'reglages'
        modeleGlobal: string
        modeleGlobalPerso: string
        typeNom: string
        modeleType: string
        modeleTypePerso: string
        worktreeSelection: string
        worktreeNom: string
        worktreeChemin: string
        confirmerRetrait: boolean
      }
    }
  }
}
