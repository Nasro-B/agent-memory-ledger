import type { EngineInterface, Register } from 'claude-code'

import { argumentsDeLancement, demandeDeLancement, MAX_FILE, MAX_RELANCES, prochaines, texteFinAgent, texteRefus, texteRefusSansFile, texteStatut, texteVidee } from './file-logique.mjs'
import type { Demande, Etat } from './file-logique.mjs'
import { modelePourSpawn, normaliserRegles } from './modeles-agents-logique.mjs'
import { analyserCommande, creneauxOccupes, decisionLancement, normaliserPolitique, rappelStable } from './regulateur-logique.mjs'
import type { Politique } from './regulateur-logique.mjs'
import { cheminScript, dossierEtat } from './emplacements-logique.mjs'

// Toute la logique est dans regulateur-logique.mjs et file-logique.mjs (les mêmes, octet pour octet, que celles de Codex). Ici : les
// fichiers partagés avec Codex et le Cockpit (la politique, la file) et les branchements dans Claude Code.
// La politique et les modèles sont ceux des noyaux et de la ligne de commande (scripts/lib/regulateur-core.js, scripts/cockpit.js), dans le dossier
// d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit : voir emplacements-logique.mjs), relus à chaque appel. La file passe par
// scripts/regulateur-file.js du plugin : ses opérations se font sous le verrou de la file, pour tous les processus.
const NOM_FICHIER = 'politique-agents.json'
const NOM_MODELES = 'modeles-agents.json'
const NOM_CLI_FILE = 'regulateur-file.js'
const AGENT = 'claude'
const PLUGIN = 'regulateur'
const PERIODE_MS = 30_000
const MAX_SUIVIS = 200

type Suivi = { description: string; demande: Demande; essais: number; viaFile: boolean }
type Spawn = { prompt: string; description: string; subagentType: string; model?: string; name?: string; cwd?: string; fork: boolean; isTeammate?: true; workflow?: object }

// Les agents que la mod a lancés ou vus lancer, par identifiant : de quoi relancer un échoué avec sa demande d'origine. Perdus à un
// rechargement de la mod (un agent d'avant le rechargement n'est pas relancé).
const suivis = new Map<string, Suivi>()
// Le lancement de la file en cours : l'identifiant de l'agent n'arrive que dans le hook agent.spawn (l'appel $.agent.spawn le rend
// parfois sans identifiant), qui le suit avec ces informations. Un seul à la fois : le dépilage est exclusif.
let lancementPropre: Suivi | null = null
// La dernière raison de refus dite à l'utilisateur : la même raison n'est pas répétée à chaque minuterie.
let derniereRaison: string | null = null
// Un seul dépilage à la fois : deux fins simultanées ne doivent pas se partager le même créneau.
let verrou: Promise<void> = Promise.resolve()

function exclusif(travail: () => Promise<void>): Promise<void> {
  const suite = verrou.then(travail, travail)
  verrou = suite.then(() => undefined, () => undefined)

  return suite
}

// Une action « en l'air » (message au modèle) ne doit laisser aucun rejet derrière elle.
function enFond(travail: Promise<unknown>): void {
  travail.catch(() => {})
}

// Un fichier du dossier d'état du Cockpit.
async function fichier($: EngineInterface, nom: string): Promise<string> {
  return `${await dossierEtat($)}/${nom}`
}

// Fichier absent ou abîmé : politique inerte (le Régulateur ne gêne jamais tant que l'utilisateur n'a rien décidé).
async function lirePolitique($: EngineInterface): Promise<Politique> {
  try {
    return normaliserPolitique(JSON.parse(await $.fs.read(await fichier($, NOM_FICHIER))))
  } catch {
    return normaliserPolitique(null)
  }
}

async function modeleChoisi($: EngineInterface, e: Spawn): Promise<string | null> {
  if (e.fork || e.workflow || e.isTeammate === true || e.model !== undefined) return null
  try {
    return modelePourSpawn(e, normaliserRegles(JSON.parse(await $.fs.read(await fichier($, NOM_MODELES)))))
  } catch {
    return null
  }
}

// Liste des agents indisponible : compte inconnu (null). La décision le lit comme zéro (une panne de comptage ne doit pas
// bloquer le travail), la commande /plafond ne prétend pas savoir.
async function agentsOccupes($: EngineInterface): Promise<number | null> {
  try {
    return creneauxOccupes(await $.agent.list())
  } catch {
    return null
  }
}

async function lireFile($: EngineInterface): Promise<Etat> {
  return operationFile<Etat>($, 'lireFile', [])
}

async function operationFile<T>($: EngineInterface, operation: string, args: unknown[]): Promise<T> {
  const r = await $.process.run(['node', await cheminScript($, NOM_CLI_FILE), JSON.stringify({ operation, args })], { timeoutMs: 10_000 })
  if (r.exitCode !== 0 || r.isStdoutTruncated) throw new Error('Transaction de file impossible')
  return JSON.parse(r.stdout).value as T
}

async function dire($: EngineInterface, etat: Etat): Promise<void> {
  $.ui.status(texteStatut(etat, AGENT, await $.session.id()))
}

function suivre(agentId: string | undefined, suivi: Suivi): void {
  if (agentId === undefined) return
  suivis.set(agentId, suivi)
  if (suivis.size > MAX_SUIVIS) {
    const plusAncien = suivis.keys().next().value
    if (plusAncien !== undefined) suivis.delete(plusAncien)
  }
}

function informer($: EngineInterface, texte: string): void {
  enFond($.prompt.submit({ text: texte }))
}

// Le refus d'un lancement au maximum quand la file est activée : la demande est mise en file, et le texte dit où elle en est. Si elle ne
// peut pas l'être (fork, file pleine, écriture impossible), le refus le dit : on ne promet jamais une mise en file qui n'a pas eu lieu.
async function refuserEnFile($: EngineInterface, e: Spawn): Promise<string> {
  if (e.fork || e.isTeammate === true || e.prompt.trim() === '') return texteRefusSansFile('invalide')
  let transaction = false
  try {
    const session = await $.session.id()
    const maintenant = await $.clock.now()
    transaction = true
    const r = await operationFile<{ refus?: string; position: number; total: number }>($, 'mettreEnFile', [{ agent: AGENT, session, description: e.description, demande: demandeDeLancement(e), maintenant }])
    if (r.refus !== undefined) return texteRefusSansFile(r.refus)
    await dire($, await lireFile($))

    return texteRefus({ position: r.position, total: r.total, mode: 'code' })
  } catch {
    return texteRefusSansFile(transaction ? 'ecriture' : 'invalide')
  }
}

// Les créneaux libres : le maximum moins les agents en cours (sans celui qui vient de finir, que la liste montre parfois encore).
// null quand la liste est indisponible : on ne suppose jamais un créneau libre pour lancer un agent.
async function creneauxLibres($: EngineInterface, politique: Politique, termine: string | undefined): Promise<number | null> {
  if (politique.max === null) return Number.MAX_SAFE_INTEGER
  try {
    const agents = (await $.agent.list()).filter(a => a.id !== termine)

    return politique.max - creneauxOccupes(agents)
  } catch {
    return null
  }
}

function signalerRefus($: EngineInterface, raison: string): void {
  if (raison === derniereRaison) return
  derniereRaison = raison
  void $.ui.toast(`Régulateur d'agents : un agent de la file n'a pas pu être lancé (${raison}). Il reste en tête de la file.`)
}

// Lance les demandes de la file tant qu'il y a un créneau libre. Ne fait rien quand la file est désactivée, en pause, vide, ou quand
// la liste des agents est indisponible. Une demande refusée par un autre plugin (consigne, quota) reste en tête, intacte.
function depiler($: EngineInterface, termine?: string): Promise<void> {
  return exclusif(async () => {
    try {
      const politique = await lirePolitique($)
      if (!politique.file || politique.pause) return
      const session = await $.session.id()
      const maintenant = await $.clock.now()
      const retirees = await operationFile<number>($, 'purgerFile', [maintenant])
      let etat = await lireFile($)
      if (retirees > 0) await dire($, etat)
      // Une passe lance au plus la file entière : une entrée qui ne partirait pas de la file ne doit jamais faire boucler le hook sans fin.
      for (let lances = 0; lances < MAX_FILE && prochaines(etat, AGENT, session, 1, maintenant).length > 0; lances++) {
        const libres = await creneauxLibres($, politique, termine)
        if (libres === null || libres < 1) return
        const entree = prochaines(etat, AGENT, session, 1, maintenant)[0]
        if (entree === undefined) return
        lancementPropre = { description: entree.description, demande: entree.demande, essais: entree.essais, viaFile: true }
        let r
        try {
          r = await $.agent.spawn(argumentsDeLancement(entree.demande))
        } finally {
          lancementPropre = null
        }
        if (r.deny !== undefined) {
          signalerRefus($, r.deny)

          return
        }
        derniereRaison = null
        await operationFile<boolean>($, 'retirerReconnue', [AGENT, session, entree.demande])
        etat = await lireFile($)
        await dire($, etat)
        void $.ui.toast(`Régulateur d'agents : « ${entree.description} » lancé depuis la file.`)
      }
    } catch {
      // une panne du dépilage ne bloque jamais le travail : la minuterie réessaie
    }
  })
}

// Un agent vient de finir son tour. Un agent suivi qui réussit renvoie sa réponse au modèle (s'il a été lancé par la file : le modèle ne
// la reçoit pas autrement) ; un agent qui échoue est relancé en tête de la file, deux fois au plus, si la file et la relance sont
// activées. Puis la file est dépilée : un créneau vient de se libérer.
async function apresFin($: EngineInterface, agentId: string, reason: string, reponse: string): Promise<void> {
  const politique = await lirePolitique($)
  const suivi = suivis.get(agentId)
  if (suivi !== undefined) {
    suivis.delete(agentId)
    if (reason === 'answer') {
      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'termine', reponse }))
    } else if (reason === 'aborted') {
      if (suivi.viaFile) informer($, texteFinAgent({ description: suivi.description, issue: 'interrompu' }))
    } else if (politique.file && politique.relance && suivi.essais < MAX_RELANCES) {
      const relance = await mettreEnFileEnTete($, suivi)
      informer($, texteFinAgent({ description: suivi.description, issue: relance ? 'echec' : 'echec-final', essai: suivi.essais + 1 }))
    } else if (politique.file && politique.relance) {
      informer($, texteFinAgent({ description: suivi.description, issue: 'abandon' }))
    } else if (suivi.viaFile) {
      informer($, texteFinAgent({ description: suivi.description, issue: 'echec-final' }))
    }
  }
  await depiler($, agentId)
}

async function mettreEnFileEnTete($: EngineInterface, suivi: Suivi): Promise<boolean> {
  const session = await $.session.id()
  const maintenant = await $.clock.now()
  try {
    const r = await operationFile<{ refus?: string }>($, 'mettreEnFile', [{ agent: AGENT, session, description: suivi.description, demande: suivi.demande, maintenant, essais: suivi.essais + 1, enTete: true }])
    if (r.refus !== undefined) return false
    await dire($, await lireFile($))
    return true
  } catch { return false }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'plafond', description: "Plafond d'agents en parallèle : /plafond N, pause, reprendre, libre, relance on|off, file on|off|vider" })
    $.clock.every(PERIODE_MS, () => enFond(depiler($)))
    try {
      await dire($, await lireFile($))
    } catch {
      // le script de la file est introuvable ou en panne : pas de ligne de statut, le dépilage réessaie à chaque minuterie
    }
    enFond(depiler($))

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // Un lancement de la mod elle-même (le dépilage) repasse par ce hook : le créneau a déjà été compté, le plafond ne s'y applique pas.
    if (next.origin.plugin === PLUGIN) {
      const propre = await next(e)
      if (lancementPropre !== null) suivre(propre.agentId, lancementPropre)

      return propre
    }
    const choisi = await modeleChoisi($, e)
    const lancement = choisi === null ? e : { ...e, model: choisi }
    const politique = await lirePolitique($)
    if (politique.pause || politique.max !== null) {
      const decision = decisionLancement(politique, await agentsOccupes($))
      if (!decision.autorise) return { deny: decision.mettreEnFile ? await refuserEnFile($, lancement) : decision.raison }
    }
    const lance = await next(lancement)
    if (politique.file && !e.fork && e.isTeammate !== true) suivre(lance.agentId, { description: e.description, demande: demandeDeLancement(lancement), essais: 0, viaFile: false })

    return lance
  })

  on('turn.complete', async ($, e, next) => {
    const resultat = await next(e)
    if (e.agentId !== undefined) {
      try {
        await apresFin($, e.agentId, e.reason, e.answer)
      } catch {
        // rien à défaire : la minuterie reprend le dépilage, et la fin de l'agent est déjà passée
      }
    }

    return resultat
  })

  on('prompt.compose', async ($, e, next) => {
    const composition = await next(e)
    const texte = rappelStable(await lirePolitique($))

    return texte === null ? composition : { sections: [...composition.sections, { id: 'regulateur:politique', text: texte, scope: 'session' as const }] }
  })

  on('command.run', { command: 'plafond' }, async ($, e) => {
    let fichierPolitique: string
    try {
      fichierPolitique = await fichier($, NOM_FICHIER)
    } catch (erreur) {
      return { text: erreur instanceof Error ? erreur.message : String(erreur) }
    }
    const avant = await lirePolitique($)
    const analyse = analyserCommande(e.args, avant, await agentsOccupes($))
    if (analyse.erreur !== undefined) return { text: analyse.erreur }
    if (JSON.stringify(analyse.politique) !== JSON.stringify(avant)) {
      const maj = new Date(await $.clock.now()).toISOString()
      await $.fs.write(fichierPolitique, JSON.stringify({ ...analyse.politique, maj }, null, 2))
    }
    if (analyse.viderFile === true) {
      try {
        const session = await $.session.id()
        const retirees = await operationFile<number>($, 'viderFile', [AGENT, session])
        await dire($, await lireFile($))

        return { text: texteVidee(retirees) }
      } catch (erreur) {
        return { text: `Régulateur d'agents : la file n'a pas pu être vidée (${erreur instanceof Error ? erreur.message : String(erreur)}).` }
      }
    }
    await depiler($)

    return { text: analyse.message }
  })
}
