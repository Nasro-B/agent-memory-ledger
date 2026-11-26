// Types de quota-logique.mjs (copie de scripts/lib/quota-logique.mjs, voir scripts/synchroniser-mods.js --nom).
// À tenir à jour à la main avec les exports du .mjs : un test compare les noms (tests/synchroniser-mods.test.js).

export type Config = { attention: number; critique: number; bloquerAgents: boolean; consigne: boolean; son: boolean }
export type Fenetre = { nom: string; pct: number | null; resetsAt?: string }
export type Niveau = 'ok' | 'attention' | 'critique'
export type Alerte = { fenetre: string; niveau: 'attention' | 'critique'; pct: number; resetsAt: string | undefined; cle: string }
export type Haut = { nom: string; resetsAt?: string }
export type Relais = { autre?: string; fichier?: string | null }

export function configParDefaut(): Config
export function normaliserConfig(brut: unknown): Config
export function normaliserFenetres(brut: unknown): Fenetre[]
export function assainirFenetres(brut: unknown): Fenetre[]
export function normaliserFenetresCodex(brut: unknown): Fenetre[]

export function niveau(pct: unknown, config: Config): Niveau
export function actives(fenetres: unknown, maintenant: number): Fenetre[]
export function niveauGlobal(fenetres: unknown, config: Config, maintenant: number): Niveau
export function dureeCourte(ms: number): string

export function alertes(fenetres: Fenetre[], config: Config, maintenant: number, deja: unknown): { nouvelles: Alerte[]; deja: string[] }
export function hautsActuels(fenetres: Fenetre[], config: Config, maintenant: number): Haut[]
export function remisesAZero(hauts: unknown, fenetres: Fenetre[], config: Config, maintenant: number): string[]
export function suivreHauts(anciens: unknown, fenetres: Fenetre[], config: Config, maintenant: number): { hauts: Haut[]; remises: string[] }

export const DUREE_REMISE_MS: number
export function remiseRecente(remise: unknown, maintenant: number): boolean

export function decisionAgent(fenetres: Fenetre[], config: Config, maintenant: number): { autorise: true } | { autorise: false; raison: string }
export function consigne(fenetres: Fenetre[], config: Config, maintenant: number, relais?: Relais): string | null
export function consigneRemise(noms: unknown): string | null
export function texteStatut(fenetres: Fenetre[], config: Config, maintenant: number): string | undefined
export function texteAlerte(alerte: Alerte, maintenant: number, config?: Config): string

export function analyserCommande(
  args: unknown,
  configBrute: unknown,
): { config: Config; message: string; erreur?: undefined } | { erreur: string; config?: undefined; message?: undefined }
