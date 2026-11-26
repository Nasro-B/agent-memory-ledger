// Types de consignes-logique.mjs (copie de scripts/lib/consignes-logique.mjs, voir scripts/synchroniser-mods.js --nom).
// À tenir à jour à la main avec les exports du .mjs : un test compare les noms (tests/synchroniser-mods.test.js).

export type Verrou = 'push' | 'deploiement' | 'rebuild' | 'agent'
export type Consigne = { id: number; texte: string; actif: boolean; verrou: Verrou | null }
export type Etat = { prochain: number; consignes: Consigne[] }

export const MAX_CONSIGNES: number
export const MAX_TEXTE: number
export const VERROUS: readonly Verrou[]

export function etatParDefaut(): Etat
export function normaliserEtat(brut: unknown): Etat
export function consignesActives(etat: unknown): Consigne[]

// `valeurs` : ce que valent les jetons {worktrees} et {plans} (voir config-logique.valeursJetons) ; absent, ils se lisent « (non configuré) ».
export function texteInjection(etat: unknown, valeurs?: unknown): string | null
export function texteListe(etat: unknown, valeurs?: unknown): string
export function texteStatut(etat: unknown): string | undefined

export function decisionCommande(etat: unknown, commande: unknown, valeurs?: unknown): { autorise: true } | { autorise: false; raison: string; id: number; verrou: Verrou }
export function decisionAgent(etat: unknown, valeurs?: unknown): { autorise: true } | { autorise: false; raison: string; id: number; verrou: 'agent' }

export function analyserCommande(
  args: unknown,
  etat: unknown,
  valeurs?: unknown,
): { etat: Etat; message: string; erreur?: undefined } | { erreur: string; etat?: undefined; message?: undefined }
