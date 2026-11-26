// Types de regulateur-logique.mjs (copie de scripts/lib/regulateur-logique.mjs, voir scripts/synchroniser-mods.js).
// À tenir à jour à la main avec les exports du .mjs : un test compare les noms (tests/synchroniser-mods.test.js).

export type Politique = { max: number | null; pause: boolean; relance: boolean; file: boolean }

export const PLAFOND_MAX: number

export function politiqueParDefaut(): Politique
export function normaliserPolitique(brut: unknown): Politique
export function creneauxOccupes(agents: unknown): number
export function decisionLancement(politique: unknown, occupes: number | null): { autorise: true } | { autorise: false; raison: string; mettreEnFile: boolean }

export function analyserCommande(
  args: unknown,
  politique: unknown,
  occupes: number | null,
): { politique: Politique; message: string; viderFile?: true; erreur?: undefined } | { erreur: string; politique?: undefined; message?: undefined; viderFile?: undefined }

export function rappelStable(politique: unknown): string | null
export function rappel(politique: unknown, etatCourant: { occupes?: number | null; echoues?: unknown[] } | null | undefined): string | null
