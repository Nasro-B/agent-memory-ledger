// Contrat de la mod Pause : la valeur que la mod garde dans $.state. L'état de la pause vit dans un fichier (COCKPIT_DIR/pause.json) que le
// noyau commun (scripts/lib/pause-core.js) écrit et que la ligne de commande et le Cockpit relisent : la mod ne l'écrit pas, elle
// en garde la dernière lecture pour dessiner la bande.
// Le contrat est autonome (aucun import) : ses types reprennent ceux de hooks/pause-logique.d.mts, que `tsc` contrôle à l'usage.

export type PauseAgent = { nom: string; statut: string; pause: boolean; depuis: string | null }

export type PauseSession = { titre: string; vu: string | null; pause: boolean; depuis: string | null; agents: Record<string, PauseAgent> }

export type PauseEtat = { sessions: Record<string, PauseSession> }

export type PauseSuivi = { session: string; etat: PauseEtat }

declare module 'claude-code' {
  interface PluginState {
    pause: {
      suivi: PauseSuivi | null
    }
  }
}
