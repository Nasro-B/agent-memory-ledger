import type { EngineInterface, Register } from 'claude-code'

import { valeursJetons } from './config-logique.mjs'
import type { Valeurs } from './config-logique.mjs'
import { analyserCommande, decisionAgent, decisionCommande, normaliserEtat, texteInjection, texteStatut } from './consignes-logique.mjs'
import type { Etat } from './consignes-logique.mjs'
import { dossierEtat } from './emplacements-logique.mjs'

// Toute la logique est dans consignes-logique.mjs (la même, octet pour octet, que celle de Codex). Ici : le fichier des consignes
// partagé avec Codex et le Cockpit, les réglages du Cockpit dont les jetons {worktrees} et {plans} citent les valeurs, et les
// branchements dans Claude Code.
// Les deux fichiers sont ceux des noyaux et de la ligne de commande (scripts/lib/consignes-core.js, scripts/cockpit.js) : dans le dossier d'état du
// Cockpit (COCKPIT_DIR, sinon <maison>/cockpit : voir emplacements-logique.mjs), relus à chaque appel.
const NOM_FICHIER = 'consignes.json'
const NOM_CONFIG = 'config.json'
const cheminConsignes = async ($: EngineInterface): Promise<string> => `${await dossierEtat($)}/${NOM_FICHIER}`
const cheminConfig = async ($: EngineInterface): Promise<string> => `${await dossierEtat($)}/${NOM_CONFIG}`

type Lecture = { etat: Etat; illisible: boolean }

// Fichier absent : aucune consigne. Fichier illisible : aucune consigne appliquée (un fichier abîmé ne bloque pas le travail),
// mais /consignes refuse d'écrire par-dessus, pour ne rien détruire.
async function lire($: EngineInterface): Promise<Lecture> {
  let brut: string
  try {
    brut = await $.fs.read(await cheminConsignes($))
  } catch {
    return { etat: normaliserEtat(null), illisible: false }
  }
  try {
    return { etat: normaliserEtat(JSON.parse(brut.replace(/^\uFEFF/, ''))), illisible: false }
  } catch {
    return { etat: normaliserEtat(null), illisible: true }
  }
}

// Ce que valent les jetons {worktrees} et {plans} : les réglages du Cockpit (config.json), sinon ses valeurs par défaut.
async function lireValeurs($: EngineInterface): Promise<Valeurs> {
  try {
    return valeursJetons(JSON.parse((await $.fs.read(await cheminConfig($))).replace(/^\uFEFF/, '')))
  } catch {
    return valeursJetons(null)
  }
}

// La raison du refus d'une commande de shell, ou undefined si elle passe. Les réglages ne sont lus que pour un refus : la plupart des
// commandes passent, et chacune ne coûte alors qu'une lecture.
async function raisonCommande($: EngineInterface, commande: string): Promise<string | undefined> {
  const { etat } = await lire($)
  if (decisionCommande(etat, commande).autorise) return undefined
  const decision = decisionCommande(etat, commande, await lireValeurs($))

  return decision.autorise ? undefined : decision.raison
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'consignes', description: 'Consignes en vigueur : ordres permanents, rappelés à chaque requête (/consignes ajouter, verrou, pause, retirer)' })
    $.ui.status(texteStatut((await lire($)).etat))

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const raison = await raisonCommande($, e.command)

    return raison === undefined ? next(e) : { deny: raison }
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const raison = await raisonCommande($, e.command)

    return raison === undefined ? next(e) : { deny: raison }
  })

  on('agent.spawn', async ($, e, next) => {
    const { etat } = await lire($)
    if (!decisionAgent(etat).autorise) {
      const decision = decisionAgent(etat, await lireValeurs($))
      if (!decision.autorise) return { deny: decision.raison }
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composition = await next(e)
    const { etat } = await lire($)
    $.ui.status(texteStatut(etat))
    const texte = texteInjection(etat, await lireValeurs($))

    return texte === null ? composition : { sections: [...composition.sections, { id: 'consignes:en-vigueur', text: texte, scope: 'session' as const }] }
  })

  on('command.run', { command: 'consignes' }, async ($, e) => {
    let fichier: string
    try {
      fichier = await cheminConsignes($)
    } catch (erreur) {
      return { text: erreur instanceof Error ? erreur.message : String(erreur) }
    }
    const { etat, illisible } = await lire($)
    if (illisible) return { text: `${fichier} est illisible : corrige-le ou supprime-le, puis recommence (rien n'a été écrit).` }
    const analyse = analyserCommande(e.args, etat, await lireValeurs($))
    if (analyse.erreur !== undefined) return { text: analyse.erreur }
    if (JSON.stringify(analyse.etat) !== JSON.stringify(etat)) {
      const maj = new Date(await $.clock.now()).toISOString()
      try {
        await $.fs.write(fichier, JSON.stringify({ ...analyse.etat, maj }, null, 2))
      } catch (erreur) {
        return { text: `Écriture impossible dans ${fichier} (${erreur instanceof Error ? erreur.message : String(erreur)}) : rien n'a changé.` }
      }
      $.ui.status(texteStatut(analyse.etat))
    }

    return { text: analyse.message }
  })
}
