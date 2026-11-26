// Types de config-logique.mjs (copie de scripts/lib/config-logique.mjs, voir scripts/synchroniser-mods.js --nom).
// À tenir à jour à la main avec les exports du .mjs : un test compare les noms (tests/synchroniser-mods.test.js).

export type Worktree = { nom: string; chemin: string }
export type Plans = { dossier: string; exclure: string[]; profondeur: number }
export type Reglages = { worktrees: Worktree[]; plans: Plans }
export type Valeurs = { worktrees: string; plans: string }
export type Verification = { dossierExiste?: (chemin: string) => boolean; estDepot?: (chemin: string) => boolean }

export const MAX_WORKTREES: number
export const DEFAUTS: Readonly<Reglages>

export function normaliserConfig(brut: unknown): Reglages
export function valeursJetons(brut: unknown): Valeurs
export function texteReglages(brut: unknown): string
export function analyserCommande(
  args: unknown,
  brut: unknown,
  verif?: Verification,
): { config: Reglages; message: string; erreur?: undefined } | { erreur: string; config?: undefined; message?: undefined }
