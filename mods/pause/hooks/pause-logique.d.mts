// Types de pause-logique.mjs (la même logique, octet pour octet, que celle du noyau et du Cockpit : scripts/lib/pause-logique.mjs).
// Écrits à la main : le moteur n'importe que du JavaScript, `tsc` veut des types. Un test vérifie que les noms exportés restent ceux de la source.

export type AgentEtat = { nom: string; statut: string; pause: boolean; depuis: string | null }
export type SessionEtat = { titre: string; vu: string | null; pause: boolean; depuis: string | null; agents: Record<string, AgentEtat> }
export type Etat = { sessions: Record<string, SessionEtat> }
export type FicheAgent = { id: string; nom?: string; statut?: string }
export type Fiche = { session?: string; titre?: string; agents?: FicheAgent[] }
export type Attente = { attendre: false } | { attendre: true; cible: 'session' | 'agent'; depuis: string | null }
export type AgentResume = { id: string; nom: string; statut: string; propre: boolean; arrete: boolean; depuis: string | null }
export type Resume = {
  sessions: number
  sessionsEnPause: number
  agentsArretes: number
  cette: { pause: boolean; depuis: string | null; titre: string; agents: AgentResume[] } | null
}
export type SessionListee = { id: string; court: string; titre: string; vu: string | null; pause: boolean; depuis: string | null; agents: AgentResume[] }
export type ContexteCommande = { session?: string; cible?: string; maintenant?: number; fiche?: { titre?: string; agents?: FicheAgent[] } }
export type ResultatCommande = { etat: Etat; message: string } | { erreur: string }

export const AGE_SESSION_MORTE_MS: number
export const MAX_SESSIONS: number
export const MAX_AGENTS: number
export const PREFIXE_MIN: number

export function etatParDefaut(): Etat
export function normaliserEtat(brut: unknown): Etat
export function purger(etat: unknown, maintenant: number): { etat: Etat; retirees: number }
export function inscrire(etat: unknown, fiche: unknown, maintenant: number): Etat
export function doitAttendre(etat: unknown, session: string, agentId?: string): Attente
export function texteDuree(ms: number): string
export function resume(etat: unknown, session: string | null): Resume
export function listeSessions(etat: unknown): SessionListee[]
export function texteBande(etat: unknown, session: string | null, maintenant: number): string | undefined
export function texteAttente(cible: string, depuis: string | null, maintenant: number): string
export function texteStatut(etat: unknown, session: string | null, maintenant: number): string
export function trouverSession(etat: unknown, ref: unknown): { id: string } | { erreur: string }
export function appliquerCommande(sens: string, args: unknown, etat: unknown, contexte?: ContexteCommande): ResultatCommande
