import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PauseSuivi } from '../types'
import { doitAttendre, normaliserEtat, texteAttente, texteBande } from './pause-logique.mjs'
import { cheminScript, dossierEtat } from './emplacements-logique.mjs'

// Toute la décision est dans le noyau commun (scripts/lib/pause-core.js, appelé par `scripts/cockpit.js pause-hook`, aussi utilisé par la ligne de
// commande et le Cockpit) : la mod relit pause.json pour savoir si une boucle doit attendre (aucun processus tant que rien n'est en
// pause), demande au noyau d'attendre quand il le faut, et dessine sa bande. Elle n'écrit jamais ce fichier.
// Le fichier est celui du noyau, dans le dossier d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit : voir emplacements-logique.mjs) ; le script est
// scripts/cockpit.js du plugin (AML_PLUGIN_DIR, ou trouvé à côté du module). Les deux sont cherchés à chaque appel.
// La pause est coopérative : une boucle retenue s'arrête avant sa prochaine requête au modèle (turn.step) ou son prochain outil
// (tool.call) ; une réponse en cours d'écriture ou un outil déjà lancé va jusqu'au bout. Seul le bouton Stop de l'application coupe net.
// L'attente passe par un processus du noyau (`$.process.run`) : le temps d'un appel de ce genre ne compte pas dans les dix secondes que
// le moteur laisse à un hook, alors qu'une attente par `$.clock.sleep` les consommerait et ferait perdre la pause au bout de dix secondes.
const NOM_CLI = 'cockpit.js'
const NOM_ETAT = 'pause.json'
const PERIODE_LECTURE_MS = 10_000
const PERIODE_BATTEMENT_MS = 30_000
// Une tranche d'attente : assez courte pour qu'un Stop ou une reprise la ramène vite, assez longue pour ne pas lancer un processus à
// chaque instant (la reprise, elle, rend la main au bout d'une demi-seconde au plus).
const TRANCHE_MS = 20_000
const DELAI_TRANCHE_MS = TRANCHE_MS + 10_000
const DELAI_NOYAU_MS = 20_000
const LARGEUR_ERREUR = 160
const ILLISIBLE = 'Pause : réponse illisible du noyau.'

const suivi = atom({ plugin: 'pause', key: 'suivi' } as const, null)

// Combien de boucles de cette session attendent en ce moment : tant qu'il y en a, la ligne de statut dit pourquoi elles attendent et le
// rafraîchissement périodique n'y touche pas. Dernier texte de la bande posé (null : rien de posé, la prochaine lecture pose le sien).
let retenues = 0
let dernierTexte: string | null = null

// Une action « en l'air » ne doit laisser aucun rejet derrière elle (la mod peut être déchargée avant qu'elle ne finisse).
function enFond(travail: Promise<unknown>): void {
  travail.catch(() => {})
}

function court(texte: string): string {
  const t = texte.replace(/\s+/g, ' ').trim()
  return t.length > LARGEUR_ERREUR ? `${t.slice(0, LARGEUR_ERREUR - 3)}...` : t
}

// Ce que le noyau a répondu, lu comme un objet : une sortie illisible ou un JSON qui n'est pas un objet se lisent comme un objet sans les
// clés que les décisions cherchent (enPause, message...), qui n'en tirent alors rien. Seules les commandes disent ILLISIBLE.
function lireObjet(texte: string): Record<string, unknown> {
  try {
    return (JSON.parse(texte) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

// La session de cette mod : sans identifiant, le noyau ne peut ni inscrire ni retenir personne, et la mod ne gêne rien.
async function idSession($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

// `echec` : pourquoi l'appel du noyau a échoué (démarrage impossible, délai dépassé, code de sortie), sinon null. `valeur` est alors vide.
// Les décisions silencieuses (attente, battement) ne regardent que `valeur` : une panne du noyau ne retient personne.
type Retour = { valeur: Record<string, unknown>; echec: string | null }

async function appeler($: EngineInterface, operation: string, entree: Record<string, unknown>, delai = DELAI_NOYAU_MS): Promise<Retour> {
  let r
  try {
    r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'pause-hook', operation], { stdin: JSON.stringify({ session: await idSession($), ...entree }), timeoutMs: delai })
  } catch (e) {
    return { valeur: {}, echec: `Pause : le noyau ne répond pas (${court(e instanceof Error ? e.message : String(e))}).` }
  }
  if (r.exitCode !== 0) {
    const stderr = court(r.stderr)

    return { valeur: {}, echec: stderr === '' ? `Pause : code de sortie ${r.exitCode}.` : `Pause : ${stderr}` }
  }

  return { valeur: lireObjet(r.stdout), echec: null }
}

// Fichier absent ou abîmé : on le lit comme vide (rien n'est alors en pause, et la mod ne retient personne).
async function lireJson($: EngineInterface, chemin: string): Promise<unknown> {
  try {
    return JSON.parse((await $.fs.read(chemin)).replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

// L'état de la pause dans le dossier d'état du Cockpit. Dossier inconnu, fichier absent ou abîmé : rien (la mod ne retient alors personne).
async function lireEtat($: EngineInterface): Promise<unknown> {
  try {
    return await lireJson($, `${await dossierEtat($)}/${NOM_ETAT}`)
  } catch {
    return undefined
  }
}

const dossierDe = (chemin: string): string => chemin.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

// Ce que le noyau inscrit de cette session : son titre (le dossier où elle travaille, le moteur n'en donne pas d'autre) et ses agents.
async function fiche($: EngineInterface): Promise<{ titre: string; agents: { id: string; nom: string; statut: string }[] }> {
  let titre = ''
  let agents: { id: string; nom: string; statut: string }[] = []
  try {
    titre = dossierDe(await $.session.cwd())
  } catch {
    // sans titre : le noyau garde celui qu'il connaît
  }
  try {
    agents = (await $.agent.list()).map(a => ({ id: a.id, nom: a.name ?? (a.description === '' ? a.type : a.description), statut: String(a.status) }))
  } catch {
    // sans agents : la liste de la session se vide au prochain battement
  }

  return { titre, agents }
}

// Le battement : le noyau note que cette session est vivante (sans battement depuis cinq minutes, elle sort de l'état, sa pause avec).
async function battre($: EngineInterface): Promise<void> {
  await appeler($, 'battre', await fiche($))
}

// Relit le fichier du noyau : la dernière lecture sert à la bande, la ligne de statut en est le résumé. Rien n'est redessiné si le texte
// de la bande (qui porte une durée, à la minute) n'a pas changé : lui seul est visible.
async function rafraichir($: EngineInterface): Promise<void> {
  const session = await idSession($)
  const lu: PauseSuivi = { session, etat: normaliserEtat(await lireEtat($)) }
  const texte = texteBande(lu.etat, session, await $.clock.now())
  if ((texte ?? '') === dernierTexte) return
  dernierTexte = texte ?? ''
  await update($, suivi, () => lu)
  if (retenues === 0) $.ui.status(texte)
}

// Retient la boucle d'une session ou d'un agent tant que sa pause dure. Rien ne se lance si le fichier ne demande pas d'attendre ; sinon le
// noyau attend à notre place, une tranche à la fois, et rend la main dès que la pause est levée. Une panne du noyau, un Stop ou la fin
// du dispatch (le signal) libèrent la boucle : la pause ne doit jamais coincer une session.
async function retenir($: EngineInterface, agentId: string | undefined, signal: AbortSignal): Promise<void> {
  const session = await idSession($)
  let attente = doitAttendre(await lireEtat($), session, agentId)
  if (!attente.attendre) return
  retenues += 1
  try {
    while (attente.attendre && !signal.aborted) {
      $.ui.status(texteAttente(attente.cible, attente.depuis, await $.clock.now()))
      const r = await appeler($, 'attendre', { agentId, dureeMs: TRANCHE_MS }, DELAI_TRANCHE_MS)
      if (r.valeur.enPause !== true) break
      // Une pause longue ne doit pas faire croire que la session est morte.
      enFond(battre($))
      attente = doitAttendre(await lireEtat($), session, agentId)
    }
  } finally {
    retenues -= 1
  }
  dernierTexte = null
  enFond(rafraichir($))
}

// Une commande /pause ou /reprendre par le noyau, que ce soit l'utilisateur qui la tape ou un bouton de la bande qui la lance : le texte à dire.
async function executer($: EngineInterface, sens: 'pause' | 'reprendre', args: string): Promise<string> {
  const r = await appeler($, 'commande', { sens, args: args.trim(), fiche: await fiche($) })
  if (r.echec !== null) return r.echec
  // Le message de la commande ne dépend pas de la bande : une relecture qui échoue (module en cours de déchargement) ne le prive de rien.
  await rafraichir($).catch(() => {})
  const { message, erreur } = r.valeur
  if (typeof erreur === 'string') return erreur

  return typeof message === 'string' ? message : ILLISIBLE
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pause',
      description: "Pause : retient cette session (ou une autre, un agent, toutes) avant sa prochaine étape ; Stop reste l'arrêt immédiat (/pause tout, session <id>, agent <nom>, agents, statut)",
      argumentHint: '[tout | session [id] | agent <nom> | agents | statut]',
    })
    await $.command.register({
      name: 'reprendre',
      description: "Reprise : relance ce que /pause a retenu (/reprendre tout, session <id>, agent <nom>, agents, statut)",
      argumentHint: '[tout | session [id] | agent <nom> | agents | statut]',
    })
    $.clock.every(PERIODE_LECTURE_MS, () => enFond(rafraichir($)))
    $.clock.every(PERIODE_BATTEMENT_MS, () => enFond(battre($)))
    enFond(battre($).then(() => rafraichir($)))

    return next(e)
  })

  // Avant chaque requête au modèle, de la session ou d'un de ses agents (e.agentId absent sur la boucle principale).
  on('turn.step', async function* ($, e, next) {
    await retenir($, e.agentId, next.signal)

    return yield* next(e)
  })

  // Avant chaque outil, de la session ou d'un de ses agents.
  on('tool.call', async ($, e, next) => {
    await retenir($, e.agentId, next.signal)

    return next(e)
  })

  on('command.run', { command: 'pause' }, async ($, e) => ({ text: await executer($, 'pause', e.args) }))

  on('command.run', { command: 'reprendre' }, async ($, e) => ({ text: await executer($, 'reprendre', e.args) }))

  // La bande au-dessus du prompt s'ajoute à celle qu'un autre plugin dessine en dessous (le Cockpit) : une seule instance, donc on compose.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const dessous = await next(e)
    if (e.props.hasSurvey) return dessous
    const { Box, Text, Button } = $.ui.resolve(e)
    const lu = await read($, suivi)
    const texte = lu === null ? undefined : texteBande(lu.etat, lu.session, await $.clock.now())
    // Un bouton lance la commande correspondante pour cette session : le noyau note la pause, et le résultat est dit par un toast.
    const agir = async (sens: 'pause' | 'reprendre'): Promise<void> => {
      $.ui.toast(await executer($, sens, ''))
    }

    return (
      <Box flexDirection="column">
        {dessous}
        <Box>
          {texte !== undefined && (
            <Text dimColor wrap="truncate-end">
              {texte}
            </Text>
          )}
          <Button key="pause" label="Pause" onPress={() => agir('pause')} />
          <Button key="reprendre" label="Reprendre" onPress={() => agir('reprendre')} />
        </Box>
      </Box>
    )
  })
}
