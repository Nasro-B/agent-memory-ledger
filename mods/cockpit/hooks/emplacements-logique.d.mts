// Types de emplacements-logique.mjs (copie de scripts/lib/emplacements-logique.mjs, voir scripts/synchroniser-mods.js --nom).
// À tenir à jour à la main avec les exports du .mjs : un test compare les noms (tests/mods-structure.test.js).
// `Moteur` : la part de l'interface du moteur que ce fichier lit (variables d'environnement, existence et liste de fichiers, dossier du module).

export type Moteur = {
  env: { get: (nom: string) => Promise<string | undefined> }
  fs: { exists: (chemin: string) => Promise<boolean>; list: (chemin?: string) => Promise<{ name: string }[]> }
  plugin: { root: string }
}

export function dossierEtat($: Moteur): Promise<string>
export function versionsRecentes(noms: readonly string[]): string[]
export function cheminScript($: Moteur, nom: string): Promise<string>
