// Contrat de la mod Nuit : les valeurs que la mod garde dans $.state. L'état de la nuit et la boîte vivent dans des fichiers
// (COCKPIT_DIR/nuit.json et nuit-boite.json) que le noyau commun (scripts/lib/nuit-core.js) écrit et que les hooks
// Codex et le Cockpit relisent : la mod ne les écrit pas, elle en garde la dernière lecture pour dessiner la bande et le panneau.
// Le contrat est autonome (aucun import) : ses types reprennent ceux de hooks/nuit-logique.d.mts, que `tsc` contrôle à l'usage.

export type NuitRefus = { question: number; garde: number; action: number }

export type NuitEtat = {
  actif: boolean
  mode: 'nuit' | 'absence' | null
  depuis: string | null
  fin: string | null
  tours: number
  maxTours: number
  absenceMinutes: number | null
  derniereActivite: string | null
  derniereLigne: string | null
  repetition: number
  sautees: string[]
  arret: 'plafond' | 'termine' | 'pause' | 'quota' | 'repetition' | null
  refus: NuitRefus
  lignesAuDebut: number | null
}

export type NuitOption = { label: string; description: string }

export type NuitEntree = {
  id: number
  agent: string
  session: string
  type: 'question' | 'action'
  ajoute: string
  titre: string
  details: string
  options: NuitOption[]
  statut: 'en-attente' | 'repondue' | 'ecartee'
  reponse: string | null
  traite: string | null
}

export type NuitBoite = { prochain: number; entrees: NuitEntree[] }

export type NuitSuivi = { etat: NuitEtat; boite: NuitBoite }

declare module 'claude-code' {
  interface PluginState {
    nuit: {
      suivi: NuitSuivi | null
      filtre: 'attente' | 'historique' | 'toutes'
      entreeSelectionnee: number | null
      reponseLibre: string
      erreurReponse: string | null
    }
  }
}
