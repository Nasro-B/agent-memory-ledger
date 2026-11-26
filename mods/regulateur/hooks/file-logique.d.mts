// Types de file-logique.mjs (copie de scripts/lib/file-logique.mjs, voir scripts/synchroniser-mods.js --nom).
// À tenir à jour à la main avec les exports du .mjs : un test compare les noms (tests/synchroniser-mods.test.js).

export type Statut = 'en-attente' | 'ordonne'
export type Demande = Record<string, unknown>
export type Entree = { id: number; agent: string; session: string; ajoute: string; description: string; demande: Demande; essais: number; statut: Statut; ordre: string | null }
export type Etat = { prochain: number; entrees: Entree[]; relances: Record<string, number> }
export type Refus = 'invalide' | 'trop-grande' | 'pleine'
export type Issue = 'termine' | 'echec' | 'abandon' | 'echec-final' | 'interrompu'
export type Resume = { enAttente: number; ordonnees: number; plusAncienne: string | null }

export const MAX_FILE: number
export const MAX_DEMANDE: number
export const MAX_RELANCES: number
export const DELAI_ORDRE_MS: number
export const AGE_MAX_ENTREE_MS: number
export const MAX_PAR_ORDRE: number

export function signature(demande: unknown): string
export function etatParDefaut(): Etat
export function normaliserEtat(brut: unknown): Etat
export function enAttente(etat: unknown, agent: string, session: string): Entree[]

export function mettreEnFile(
  etat: unknown,
  entree?: { agent?: unknown; session?: unknown; description?: unknown; demande?: unknown; maintenant?: unknown; essais?: number; enTete?: boolean },
): { refus: Refus; etat?: undefined; entree?: undefined; position?: undefined; deja?: undefined } | { refus?: undefined; etat: Etat; entree: Entree; position: number; deja: boolean }

export function prochaines(etat: unknown, agent: string, session: string, n: number, maintenant: number): Entree[]
export function ordonner(etat: unknown, ids: unknown, maintenant: number): Etat
export function reconnaitre(etat: unknown, agent: string, session: string, demande: unknown): Entree | null
export function retirer(etat: unknown, id: number): Etat
export function vider(etat: unknown, agent?: string | null, session?: string | null): { etat: Etat; retirees: number }
export function purger(etat: unknown, maintenant: number): { etat: Etat; retirees: number }

export function relancesFaites(etat: unknown, cle: unknown): number
export function peutRelancer(etat: unknown, cle: unknown): boolean
export function compterRelance(etat: unknown, cle: unknown): Etat
export function oublierRelances(etat: unknown, cle: unknown): Etat

export function texteRefus(args: { position: number; total: number; mode: 'code' | 'modele' }): string
export function texteRefusSansFile(raison: string): string
export function choisirPourOrdre(entrees: Entree[], libres: number): Entree[]
export function texteOrdre(entrees: Entree[], libres: number): string | null
export function texteRelance(echoues: { nom: unknown; essai: number }[]): string | null
export function texteVidee(retirees: number): string
export function texteStatut(etat: unknown, agent: string, session: string): string | undefined
export function resume(etat: unknown, agent?: string | null): Resume
export function texteFinAgent(args: { description?: unknown; issue?: string; reponse?: unknown; essai?: number }): string

export type Lancement = { prompt?: unknown; description?: unknown; subagentType?: unknown; model?: unknown; name?: unknown; cwd?: unknown }
export type ArgumentsLancement = { prompt: string; description?: string; subagentType?: string; model?: string; name?: string; cwd?: string }
export function demandeDeLancement(lancement: Lancement | null | undefined): Demande
export function argumentsDeLancement(demande: unknown): ArgumentsLancement
