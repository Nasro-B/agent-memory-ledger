import type { NuitBoite, NuitEntree } from '../types'

export type FiltreBoite = 'attente' | 'historique' | 'toutes'
export function compteursBoite(boite: NuitBoite): { attente: number; traitees: number; total: number }
export function filtrerBoite(boite: NuitBoite, filtre: FiltreBoite): NuitEntree[]
export function choisirEntree(visibles: NuitEntree[], id: number | null): NuitEntree | null
export function optionsEntrees(visibles: NuitEntree[]): { value: string; label: string }[]
export function normaliserTexteLibre(texte: string): { valeur: string; erreur: string | null }
export function commandeReponse(entree: NuitEntree | null, option: string | null, texteLibre: string): string[] | null
