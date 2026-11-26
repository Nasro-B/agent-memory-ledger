import type { CockpitAgent, CockpitDepot, CockpitEcart, CockpitInstantane, CockpitLigne, CockpitPolitique } from '../types'

// Le contenu du panneau Cockpit, en texte : fonctions pures, sans interface, testées seules.

// Un bouton d'une ligne de section : `sens` et `mots` sont les arguments de `cockpit.js pause|reprendre` que le panneau lance à la pression.
export type BoutonPause = { ligne: number; cle: string; libelle: string; sens: 'pause' | 'reprendre'; mots: string[] }

export type Section = { titre: string; lignes: string[]; boutons?: BoutonPause[] }

const MAX_BLOQUEES = 8
const MAX_AGENTS = 6
const MAX_PLANS = 5
const LARGEUR_TEXTE = 100

const accord = (n: number, un: string, plusieurs: string): string => `${n} ${n === 1 ? un : plusieurs}`

const court = (texte: string, largeur: number): string => {
  const t = texte.replace(/\s+/g, ' ').trim()
  return t.length > largeur ? `${t.slice(0, largeur - 3)}...` : t
}

export const duree = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} j`
}

const age = (iso: string, maintenant: number, avant: string, inconnu: string): string => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? `${avant} il y a ${duree(maintenant - t)}` : inconnu
}

const mesure = (s: CockpitInstantane, maintenant: number): Section => ({
  titre: 'Mesure',
  lignes: [
    age(s.mesureA, maintenant, 'mesure', 'mesure à une date inconnue'),
    s.git ? age(s.git.mesureA, maintenant, 'git mesuré', 'git mesuré à une date inconnue') : 'git jamais mesuré',
  ],
})

type Bloquee = CockpitLigne & { projet: string }
type AgentDuProjet = CockpitAgent & { projet: string }

const parProjet = (s: CockpitInstantane) =>
  Object.values(s.ledger.agents).flatMap(projets => Object.entries(projets))

const ledger = (s: CockpitInstantane): Section => {
  const t = s.ledger.totaux
  const lignes = [`${accord(t.ouvertes, 'ouverte', 'ouvertes')}, ${accord(t.bloquees, 'bloquée', 'bloquées')}, ${t.aTrier} à trier`]
  const bloquees: Bloquee[] = parProjet(s).flatMap(([projet, p]) => p.lignesBloquees.map(l => ({ ...l, projet })))
  for (const b of bloquees.slice(0, MAX_BLOQUEES)) lignes.push(`bloquée : ${b.projet}/${b.id} : ${court(b.texte, LARGEUR_TEXTE)}`)
  if (bloquees.length > MAX_BLOQUEES) lignes.push(`+${bloquees.length - MAX_BLOQUEES} autres bloquées`)
  return { titre: 'Ledger', lignes }
}

const politique = (p: CockpitPolitique | null | undefined): string | null => {
  if (!p) return null
  const etat = p.pause ? (p.max !== null ? `en pause (maximum ${p.max})` : 'en pause') : p.max !== null ? `maximum ${p.max}` : 'libre'
  return `politique : ${etat}, relance : ${p.relance ? 'oui' : 'non'}`
}

const agents = (s: CockpitInstantane): Section => {
  const t = s.ledger.totaux
  // Une mesure faite avant les obsolètes (gardée d'un rechargement) n'a pas leur clé : on ne montre alors rien d'inventé.
  const nbObsoletes = t.agentsObsoletes
  const comptes = [`${t.agentsEnCours} en cours`, ...(nbObsoletes ? [accord(nbObsoletes, 'obsolète', 'obsolètes')] : []), `${t.agentsATraiter} à traiter`, accord(t.agentsEchoues, 'échoué', 'échoués')]
  const lignes = [comptes.join(', ')]
  const reglage = politique(s.politiqueAgents)
  if (reglage !== null) lignes.push(reglage)
  const echoues: AgentDuProjet[] = parProjet(s).flatMap(([projet, p]) => p.agents.echoues.map(a => ({ ...a, projet })))
  const aTraiter: AgentDuProjet[] = parProjet(s).flatMap(([projet, p]) => p.agents.aTraiter.map(a => ({ ...a, projet })))
  const obsoletes: AgentDuProjet[] = parProjet(s).flatMap(([projet, p]) => (p.agents.obsoletes ?? []).map(a => ({ ...a, projet })))
  for (const a of echoues.slice(0, MAX_AGENTS)) lignes.push(`échoué : ${a.nom} (${a.statutFin ?? 'fin inconnue'}) ligne ${a.projet}/${a.ligne}`)
  if (echoues.length > MAX_AGENTS) lignes.push(`+${echoues.length - MAX_AGENTS} autres échoués`)
  for (const a of aTraiter.slice(0, MAX_AGENTS)) lignes.push(`à traiter : ${a.nom} ligne ${a.projet}/${a.ligne}`)
  if (aTraiter.length > MAX_AGENTS) lignes.push(`+${aTraiter.length - MAX_AGENTS} autres à traiter`)
  for (const a of obsoletes.slice(0, MAX_AGENTS)) lignes.push(`obsolète : ${a.nom} ligne ${a.projet}/${a.ligne}`)
  if (obsoletes.length > MAX_AGENTS) lignes.push(`+${obsoletes.length - MAX_AGENTS} autres obsolètes`)
  return { titre: 'Agents', lignes }
}

const consignes = (s: CockpitInstantane): Section => {
  const c = s.consignes
  if (!c) return { titre: 'Consignes', lignes: ['aucune consigne active'] }
  if (c.illisible) return { titre: 'Consignes', lignes: ['consignes.json illisible : les consignes ne sont plus rappelées ni appliquées'] }
  return {
    titre: 'Consignes',
    lignes: [
      `${accord(c.actives, 'active', 'actives')} sur ${c.consignes.length}, ${accord(c.verrouillees, 'verrouillée', 'verrouillées')}`,
      ...c.consignes.map(x => `${x.id}. [${x.actif ? 'actif' : 'pause'}] ${court(x.texte, LARGEUR_TEXTE)}${x.verrou ? ` [verrou : ${x.verrou}]` : ''}`),
    ],
  }
}

const file = (s: CockpitInstantane, maintenant: number): Section => {
  const f = s.file
  if (!f) return { titre: 'File', lignes: ["aucun agent en file d'attente"] }
  const lignes = [`${f.enAttente} en attente, ${accord(f.ordonnees, 'ordonné', 'ordonnés')}`]
  if (f.plusAncienne !== null) lignes.push(age(f.plusAncienne, maintenant, 'la plus ancienne :', 'ancienneté inconnue'))
  return { titre: 'File', lignes }
}

const CAUSES_ARRET: Record<string, string> = {
  plafond: "le plafond d'enchaînements est atteint",
  termine: 'toutes les lignes ouvertes de la conversation sont traitées',
  pause: "le Régulateur d'agents est en pause",
  quota: 'le Garde-quota a atteint son seuil critique',
  repetition: "des lignes n'avançaient pas, laissées de côté",
}

const nuit = (s: CockpitInstantane, maintenant: number): Section => {
  const n = s.nuit
  if (!n) return { titre: 'Nuit', lignes: ['inactive, rien à décider en boîte'] }
  const boite = n.aDecider > 0 ? `${n.aDecider} à décider en boîte (/nuit boite)` : 'rien à décider en boîte'
  if (!n.actif) return { titre: 'Nuit', lignes: ['inactive', boite] }
  const depuis = age(n.depuis ?? '', maintenant, 'depuis', 'début inconnu')
  const lignes = [`active (${n.mode === 'absence' ? 'absence' : 'nuit'}), ${depuis}`, `${accord(n.tours, 'enchaînement', 'enchaînements')} sur ${n.maxTours} au plus`]
  if (n.arret !== null) lignes.push(`enchaînement arrêté : ${CAUSES_ARRET[n.arret] ?? n.arret}`)
  lignes.push(boite)
  return { titre: 'Nuit', lignes }
}

const enPauseDepuis = (depuis: string | null, maintenant: number): string => age(depuis ?? '', maintenant, 'en pause depuis', 'en pause, date inconnue')

const LARGEUR_ID_COURT = 8

// Les sessions ouvertes, chacune avec ses agents, et un bouton par ligne qui a une action : Pause ou Reprendre pour une session, Pause pour un
// agent actif, Reprendre pour un agent qui a sa propre pause. Un agent arrêté par sa session seule n'a pas de bouton : on reprend la session.
const pause = (s: CockpitInstantane, maintenant: number): Section => {
  const p = s.pause
  if (!p) return { titre: 'Pause', lignes: ['aucune session ouverte'] }
  const lignes = [`${accord(p.sessions, 'session ouverte', 'sessions ouvertes')}, ${p.sessionsEnPause} en pause, ${accord(p.agentsArretes, 'agent arrêté', 'agents arrêtés')}`]
  const boutons: BoutonPause[] = [
    { ligne: 0, cle: 'pause-tout', libelle: 'Tout mettre en pause', sens: 'pause', mots: ['tout'] },
    { ligne: 0, cle: 'reprendre-tout', libelle: 'Tout reprendre', sens: 'reprendre', mots: ['tout'] },
  ]
  for (const x of p.liste) {
    lignes.push(`${x.court}${x.titre === '' ? '' : ` « ${x.titre} »`} : ${x.pause ? enPauseDepuis(x.depuis, maintenant) : 'active'}`)
    boutons.push(
      x.pause
        ? { ligne: lignes.length - 1, cle: `reprendre-session-${x.id}`, libelle: 'Reprendre', sens: 'reprendre', mots: ['--session', x.id] }
        : { ligne: lignes.length - 1, cle: `pause-session-${x.id}`, libelle: 'Pause', sens: 'pause', mots: ['--session', x.id] },
    )
    for (const a of x.agents) {
      const nom = a.nom === '' ? a.id.slice(0, LARGEUR_ID_COURT) : a.nom
      const etat = a.propre ? enPauseDepuis(a.depuis, maintenant) : a.arrete ? 'arrêté par sa session' : 'actif'
      lignes.push(`  agent ${nom}${a.statut === '' ? '' : ` (${a.statut})`} : ${etat}`)
      const mots = ['--session', x.id, 'agent', a.id]
      if (a.propre) boutons.push({ ligne: lignes.length - 1, cle: `reprendre-agent-${x.id}-${a.id}`, libelle: 'Reprendre', sens: 'reprendre', mots })
      else if (!a.arrete) boutons.push({ ligne: lignes.length - 1, cle: `pause-agent-${x.id}-${a.id}`, libelle: 'Pause', sens: 'pause', mots })
    }
  }
  return { titre: 'Pause', lignes, boutons }
}

const ecart = (v: CockpitEcart | null): string => {
  if (!v) return 'inconnu'
  if (!v.ahead && !v.behind) return 'identique'
  const a = v.ahead ? `+${v.ahead}` : ''
  const b = v.behind ? `-${v.behind}` : ''
  return a && b ? `${a}/${b}` : a || b
}

const egal = (v: boolean | null, oui: string, non: string): string => (v === null ? 'inconnu' : v ? oui : non)

const lignesDepot = (d: CockpitDepot): string[] => {
  if (d.constats.propre === null && d.erreurs.length) return [`${d.nom} : illisible (${d.erreurs[0]})`]
  const arbre = d.sale === null ? 'inconnu' : d.sale === 0 ? 'propre' : accord(d.sale, 'fichier modifié ou non suivi', 'fichiers modifiés ou non suivis')
  const distant = !d.upstream ? 'pas de distant' : d.vsDistant ? ecart(d.vsDistant) : 'non mesuré'
  return [
    `${d.nom} : ${d.branche ?? 'branche inconnue'}`,
    `  arbre : ${arbre}`,
    `  contre main : ${ecart(d.vsMain)}`,
    `  contre son distant : ${distant}`,
    `  main local : ${egal(d.constats.mainEgalDistant, 'égal à son distant', 'différent de son distant')}`,
    `  branche distante : ${egal(d.constats.distantEgalMainDistant, 'égale à main distant', 'différente de main distant')}`,
  ]
}

const git = (s: CockpitInstantane): Section => ({
  titre: 'Git',
  lignes: s.git ? ['+N : commits en avance, -N : commits en retard', ...s.git.depots.flatMap(lignesDepot)] : ['jamais mesuré'],
})

const plans = (s: CockpitInstantane): Section => {
  const p = s.plans
  if (p.erreur) return { titre: 'Plans', lignes: [`erreur : ${p.erreur}`] }
  if (p.pct === null) return { titre: 'Plans', lignes: ['aucune case trouvée'] }
  const restants = p.fichiers
    .map(f => ({ ...f, reste: f.total - f.cochees }))
    .sort((a, b) => b.reste - a.reste || (a.fichier < b.fichier ? -1 : 1))
    .slice(0, MAX_PLANS)
  return {
    titre: 'Plans',
    lignes: [
      `${p.pct} % (${p.cochees}/${p.total}) dans ${accord(p.fichiers.length, 'fichier', 'fichiers')}`,
      ...restants.map(f => `${f.fichier} : ${accord(f.reste, 'restante', 'restantes')} (${f.cochees}/${f.total})`),
    ],
  }
}

const quota = (s: CockpitInstantane): Section => ({
  titre: 'Quota',
  lignes: Object.entries(s.quota).map(([agent, q]) =>
    q && Array.isArray(q.fenetres) && q.fenetres.length
      ? `${agent} : ${q.fenetres.map(f => `${f.nom} ${f.pct === null ? '?' : Math.round(f.pct)} %`).join(', ')}`
      : `${agent} : jamais mesuré`),
})

const reglages = (s: CockpitInstantane): Section => {
  const c = s.config
  if (!c) return { titre: 'Réglages', lignes: ['réglages non lus par le noyau'] }
  return {
    titre: 'Réglages',
    lignes: [
      c.worktrees.length === 0 ? 'aucun worktree mesuré' : `worktrees mesurés (${c.worktrees.length})`,
      ...c.worktrees.map(w => `  ${w.nom} : ${w.chemin}`),
      `dossier des plans : ${c.plans.dossier}`,
      `plans : profondeur ${c.plans.profondeur}, exclus : ${c.plans.exclure.length === 0 ? 'aucun' : c.plans.exclure.join(', ')}`,
      '/cockpit config : afficher, worktree ajouter <nom> <chemin>, worktree retirer <nom>, plans <dossier>',
    ],
  }
}

export const sections = (s: CockpitInstantane, maintenant: number): Section[] => [
  mesure(s, maintenant),
  ledger(s),
  agents(s),
  file(s, maintenant),
  consignes(s),
  nuit(s, maintenant),
  pause(s, maintenant),
  git(s),
  plans(s),
  quota(s),
  reglages(s),
]
