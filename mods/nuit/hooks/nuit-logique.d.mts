// Types de nuit-logique.mjs (la même logique, octet pour octet, que celle des hooks Codex : scripts/lib/nuit-logique.mjs).
// Écrits à la main : le moteur n'importe que du JavaScript, `tsc` veut des types. Un test vérifie que les noms exportés restent ceux de la source.

export type Refus = { question: number; garde: number; action: number }
export type Arret = 'plafond' | 'termine' | 'pause' | 'quota' | 'repetition'
export type Etat = {
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
  arret: Arret | null
  refus: Refus
  lignesAuDebut: number | null
  passages: Record<string, number>
}
export type Option = { label: string; description: string }
export type EntreeBoite = {
  id: number
  agent: string
  session: string
  type: 'question' | 'action'
  ajoute: string
  titre: string
  details: string
  options: Option[]
  statut: 'en-attente' | 'repondue' | 'ecartee'
  reponse: string | null
  traite: string | null
  lot?: number
  empreinte?: string
  consommee?: string
}
export type Boite = { prochain: number; entrees: EntreeBoite[] }
export type Ligne = { id: string; texte: string }
export type Commande = { etat: Etat; boite: Boite; message: string; effet: 'active' | 'reveil' | 'reponse' | 'ecartee' | null; reponse?: { id: number; texte: string; entree: EntreeBoite } } | { erreur: string }
export type Decision = { continuer: false; motif: string; etat: Etat } | { continuer: true; ligne: Ligne; restantes: number; texte: string; etat: Etat }

export const MAX_BOITE: number
export const MAX_TOURS_DEFAUT: number
export const MAX_TOURS_LIMITE: number
export const ABSENCE_DEFAUT_MIN: number
export const ABSENCE_LIMITE_MIN: number
export const REPETITION_MAX: number
export const PREFIXE_CONTINUATION: string
export const DUREE_AUTORISATION_MS: number
export const REPONSE_AUTORISER: string

export function etatParDefaut(): Etat
export function normaliserEtat(brut: unknown): Etat
export function activer(etat: unknown, options?: { mode?: string; maintenant?: number; lignesOuvertes?: number }): Etat
export function desactiver(etat: unknown, maintenant: number): Etat
export function noterActivite(etat: unknown, maintenant: number): { etat: Etat; reveil: boolean }
export function absenceAtteinte(etat: unknown, maintenant: number): boolean
export function estActive(etat: unknown, maintenant: number): boolean
export function activerSiAbsent(etat: unknown, maintenant: number, lignesOuvertes?: number): { etat: Etat; active: boolean }
export function compterRefus(etat: unknown, genre: string): Etat
export function boiteParDefaut(): Boite
export function normaliserBoite(brut: unknown): Boite
export function enAttente(boite: unknown): EntreeBoite[]
export function ajouterEntree(boite: unknown, entree?: { agent?: string; session?: string; type?: string; titre?: string; details?: string; options?: unknown; maintenant?: number; lot?: number | 'soi'; empreinte?: string }): { boite: Boite; entree: EntreeBoite; deja: boolean; evincee?: EntreeBoite } | { refus: 'invalide' | 'pleine' }
export function repondre(boite: unknown, id: unknown, texte: unknown, maintenant: number): { boite: Boite; entree: EntreeBoite } | { erreur: string }
export function ecarter(boite: unknown, id: unknown, maintenant: number): { boite: Boite; entree: EntreeBoite } | { erreur: string }
export function autorisationValable(boite: unknown, demande?: { agent?: string; session?: string; empreinte?: string; maintenant?: number; attestees?: unknown }): EntreeBoite | null
export function consommerAutorisation(boite: unknown, id: unknown, maintenant: number): { boite: Boite; entree: EntreeBoite } | null
export function questionsDeOutil(entree: unknown): { titre: string; details: string; options: Option[] }
export function entreesDeQuestions(entree: unknown): { titre: string; details: string; options: Option[] }[]
export function optionRecommandee(options: unknown): string | null
export type CauseNonNotee = 'pleine' | 'verrou' | 'ecriture' | 'invalide'
export function texteRefusQuestion(options?: { id?: number | null; enAttente?: number; options?: unknown; cause?: CauseNonNotee; lot?: number | null; questions?: { id: number | null; titre: string; options?: unknown; cause?: CauseNonNotee }[] }): string
export function texteReponse(entree: unknown): string | null
export function analyserSortieGarde(sortie: unknown): { genre: 'bloc' | 'ask'; raison: string } | null
export function alternativePourGarde(raison: unknown): string
export function texteRefusGarde(options?: { genre?: string; raison?: string; id?: number | null; cause?: CauseNonNotee }): string
export function commandeEntiere(commande: unknown): string
export function actionDeGarde(options?: { commande?: string; raison?: string }): { titre: string; details: string; options: Option[] }
export function lignesCandidates(lignes: unknown, session: unknown): Ligne[]
export function texteContinuation(options: { ligne: Ligne; restantes: number; tours: number; maxTours: number }): string
export function decisionContinuation(options?: { etat?: unknown; reason?: string; lignes?: unknown; session?: string; pause?: boolean; quotaCritique?: boolean }): Decision
export function texteDuree(ms: number): string
export function texteBoite(boite: unknown): string
export function texteBande(etat: unknown, boite: unknown, maintenant: number): string | undefined
export function texteRappel(etat: unknown): string | null
export function texteStatut(etat: unknown, boite: unknown, maintenant: number): string
export function texteRecap(etat: unknown, boite: unknown, options?: { maintenant?: number; lignesMaintenant?: number | null }): string
export function analyserCommande(args: unknown, etat: unknown, boite: unknown, options?: { maintenant?: number; lignesOuvertes?: number | null }): Commande
