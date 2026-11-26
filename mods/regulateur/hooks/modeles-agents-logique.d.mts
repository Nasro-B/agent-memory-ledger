export type ReglesModeles = { defaut: string | null; parType: Record<string, string | null> }
export type SpawnModeles = { subagentType: string; fork?: boolean; workflow?: object; isTeammate?: true; model?: string }
export function validerModele(v: unknown): v is string
export function validerType(v: unknown): v is string
export function normaliserRegles(brut: unknown): ReglesModeles | null
export function modelePourSpawn(spawn: SpawnModeles, regles: ReglesModeles | null): string | null
