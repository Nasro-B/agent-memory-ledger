import type { EngineInterface, Register } from 'claude-code'

import {
  alertes, analyserCommande, consigne, consigneRemise, decisionAgent, normaliserConfig, normaliserFenetres,
  remiseRecente, suivreHauts, texteAlerte, texteStatut,
} from './quota-logique.mjs'
import { dossierEtat } from './emplacements-logique.mjs'

// Toute la logique est dans quota-logique.mjs (la même, octet pour octet, que celle de Codex). Ici : les fichiers partagés avec
// Codex et le Cockpit, et les branchements dans Claude Code.
// Les fichiers sont ceux des noyaux et de la ligne de commande (scripts/lib/quota-core.js, scripts/cockpit.js), dans le dossier d'état du Cockpit
// (COCKPIT_DIR, sinon <maison>/cockpit : voir emplacements-logique.mjs), relus à chaque appel.
const NOM_CONFIG = 'garde-quota.json' // les réglages de l'utilisateur (/quota) ; hors du nom quota-<agent>.json, réservé aux mesures
const NOM_QUOTA = 'quota-claude.json' // la dernière mesure, lue par le Cockpit et par Codex
const RELAIS = { autre: 'Codex', nom: 'relais-codex.md' } // l'autre agent, et le fichier où l'agent écrit son prompt de relais pour lui
const DELAI_SON_MS = 10_000
const DUREE_TOAST_MS = 15_000

type Fenetre = { nom: string; pct: number | null; resetsAt?: string }
type Remise = { noms: string[]; ts: number }

// Un fichier du dossier d'état du Cockpit.
async function fichier($: EngineInterface, nom: string): Promise<string> {
  return `${await dossierEtat($)}/${nom}`
}

// Fichier absent ou abîmé : réglages par défaut (80 % puis 90 %, blocage, consigne et son actifs).
async function lireConfig($: EngineInterface) {
  try {
    return normaliserConfig(JSON.parse(await $.fs.read(await fichier($, NOM_CONFIG))))
  } catch {
    return normaliserConfig(null)
  }
}

// Les fenêtres telles que le moteur les a mesurées à l'instant (vides hors abonnement ou avant la première lecture).
async function fenetresActuelles($: EngineInterface): Promise<Fenetre[]> {
  try {
    return normaliserFenetres((await $.session.usage()).rateLimits)
  } catch {
    return []
  }
}

// Un son ou une écriture lancés « en l'air » peuvent finir après le déchargement de la mod : aucun rejet ne doit en rester.
function enFond(travail: Promise<unknown>): void {
  travail.catch(() => {})
}

// Les sons du système (Windows : `$.audio.play` ne joue rien sur un terminal Windows).
async function jouerSon($: EngineInterface, son: 'Asterisk' | 'Exclamation' | 'Hand'): Promise<void> {
  await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `[System.Media.SystemSounds]::${son}.Play(); Start-Sleep -Milliseconds 1500`], { timeoutMs: DELAI_SON_MS })
}

// Aucune fenêtre (hors abonnement, avant la première lecture) : on ne remplace pas la dernière mesure par du vide.
async function ecrireQuota($: EngineInterface, fenetres: Fenetre[], maintenant: number): Promise<void> {
  if (fenetres.length === 0) return
  try {
    await $.fs.write(await fichier($, NOM_QUOTA), JSON.stringify({ fenetres, mesureA: new Date(maintenant).toISOString(), source: 'garde-quota' }, null, 2))
  } catch {
    // le Cockpit dira que la mesure est ancienne
  }
}

// Le relais vers l'autre agent : son nom, et le fichier où l'agent écrit son prompt (dans le dossier d'état, comme quota-core.js le fait pour Codex).
// Sans dossier d'état connu : le nom seul, la consigne ne cite alors aucun fichier.
async function relais($: EngineInterface): Promise<{ autre: string; fichier?: string }> {
  try {
    return { autre: RELAIS.autre, fichier: await fichier($, RELAIS.nom) }
  } catch {
    return { autre: RELAIS.autre }
  }
}

async function mesurer($: EngineInterface, brut: unknown): Promise<void> {
  const maintenant = await $.clock.now()
  const config = await lireConfig($)
  const fenetres: Fenetre[] = normaliserFenetres(brut)
  await ecrireQuota($, fenetres, maintenant)
  $.ui.status(texteStatut(fenetres, config, maintenant))

  const annonces = alertes(fenetres, config, maintenant, await $.store.get('deja'))
  await $.store.set('deja', annonces.deja)
  for (const a of annonces.nouvelles) {
    $.ui.toast(texteAlerte(a, maintenant, config), { timeoutMs: DUREE_TOAST_MS })
    if (config.son) enFond(jouerSon($, a.niveau === 'critique' ? 'Hand' : 'Exclamation'))
  }

  const suivi = suivreHauts(await $.store.get('hauts'), fenetres, config, maintenant)
  await $.store.set('hauts', suivi.hauts)
  if (suivi.remises.length > 0) {
    await $.store.set('remise', { noms: suivi.remises, ts: maintenant })
    $.ui.toast(`Quota remis à zéro : ${suivi.remises.join(', ')}`, { timeoutMs: DUREE_TOAST_MS })
    if (config.son) enFond(jouerSon($, 'Asterisk'))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quota', description: 'Garde-quota : seuils, blocage des agents, consigne, son (/quota 80 90, /quota bloquer off)' })
    $.ui.status(texteStatut(await fenetresActuelles($), await lireConfig($), await $.clock.now()))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await mesurer($, e.rateLimits)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const decision = decisionAgent(await fenetresActuelles($), await lireConfig($), await $.clock.now())
    if (!decision.autorise) return { deny: decision.raison }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composition = await next(e)
    const config = await lireConfig($)
    const maintenant = await $.clock.now()
    const ajouts: { id: string; text: string; scope: 'session' }[] = []

    const critique = consigne(await fenetresActuelles($), config, maintenant, await relais($))
    if (critique !== null) ajouts.push({ id: 'garde-quota:critique', text: critique, scope: 'session' })

    const remise = (await $.store.get('remise')) as Remise | undefined
    const retour = config.consigne && remiseRecente(remise, maintenant) ? consigneRemise(remise?.noms) : null
    if (retour !== null) ajouts.push({ id: 'garde-quota:remise', text: retour, scope: 'session' })

    return ajouts.length === 0 ? composition : { sections: [...composition.sections, ...ajouts] }
  })

  on('command.run', { command: 'quota' }, async ($, e) => {
    let fichierConfig: string
    try {
      fichierConfig = await fichier($, NOM_CONFIG)
    } catch (erreur) {
      return { text: erreur instanceof Error ? erreur.message : String(erreur) }
    }
    const avant = await lireConfig($)
    const analyse = analyserCommande(e.args, avant)
    if (analyse.erreur !== undefined) return { text: analyse.erreur }
    if (JSON.stringify(analyse.config) !== JSON.stringify(avant)) {
      const maj = new Date(await $.clock.now()).toISOString()
      await $.fs.write(fichierConfig, JSON.stringify({ ...analyse.config, maj }, null, 2))
    }
    const statut = texteStatut(await fenetresActuelles($), analyse.config, await $.clock.now())

    return { text: statut === undefined ? analyse.message : `${analyse.message}\n${statut}` }
  })
}
