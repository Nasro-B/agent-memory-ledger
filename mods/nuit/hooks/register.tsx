import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NuitSuivi } from '../types'
import { REPONSE_AUTORISER, estActive, normaliserBoite, normaliserEtat, texteBande, texteRappel, texteRecap } from './nuit-logique.mjs'
import { choisirEntree, commandeReponse, compteursBoite, filtrerBoite, normaliserTexteLibre, optionsEntrees } from './nuit-vue-logique.mjs'
import type { FiltreBoite } from './nuit-vue-logique.mjs'
import { cheminScript, dossierEtat } from './emplacements-logique.mjs'

// Toute la décision est dans le noyau commun (scripts/lib/nuit-core.js, appelé par `scripts/cockpit.js nuit-hook`, aussi utilisé par Codex et le
// Cockpit) : la mod relit les deux fichiers de la nuit pour savoir si elle est active, appelle le noyau pour chaque décision, et dessine
// sa réponse. Elle n'écrit jamais ces fichiers : après une panne du noyau elle ne sait donc pas ce qui a été écrit, et ne le prétend pas.
// Les fichiers sont ceux du noyau, dans le dossier d'état du Cockpit (COCKPIT_DIR, sinon <maison>/cockpit : voir emplacements-logique.mjs) ; le script est
// scripts/cockpit.js du plugin (AML_PLUGIN_DIR, ou trouvé à côté du module). Les deux sont cherchés à chaque appel.
const NOM_CLI = 'cockpit.js'
const NOM_ETAT = 'nuit.json'
const NOM_BOITE = 'nuit-boite.json'
const AGENT = 'claude'
const PANNEAU = 'nuit'
const PERIODE_MS = 60_000
const DELAI_NOYAU_MS = 20_000
const LARGEUR_ERREUR = 160
const ORIGINES_UTILISATEUR: readonly string[] = ['composer', 'bridge']
const COMMANDES_DU_PANNEAU: readonly string[] = ['boite', 'recap']
const COMMANDE_NUIT = /^\s*\/nuit(\s|$)/i
const ILLISIBLE = 'Nuit : réponse illisible du noyau.'

const suivi = atom({ plugin: 'nuit', key: 'suivi' } as const, null)
const filtre = atom({ plugin: 'nuit', key: 'filtre' } as const, 'attente' as FiltreBoite)
const entreeSelectionnee = atom({ plugin: 'nuit', key: 'entreeSelectionnee' } as const, null as number | null)
const reponseLibre = atom({ plugin: 'nuit', key: 'reponseLibre' } as const, '')
const erreurReponse = atom({ plugin: 'nuit', key: 'erreurReponse' } as const, null as string | null)

// Les commandes que L'UTILISATEUR a autorisées lui-même dans cette session (bouton du panneau, ou /nuit repondre tapé par lui) : numéro de
// l'entrée et empreinte de la commande. Gardées dans la mémoire du moteur, jamais dans un fichier : un agent peut écrire la boîte ou
// lancer `cockpit.js nuit repondre N Autoriser` dans son shell, il ne peut pas écrire ici. Le noyau ne laisse passer une commande
// autorisée que si elle est attestée par cette liste (voir autorisationValable dans nuit-logique.mjs). Perdue au rechargement de la
// mod : l'autorisation redevient alors une simple note, comme avant.
type Accord = { id: number; empreinte: string }
const MAX_ACCORDS = 50
const accords = new Map<number, string>()

function retenirAccord(accord: Accord): void {
  accords.set(accord.id, accord.empreinte)
  for (const id of accords.keys()) {
    if (accords.size <= MAX_ACCORDS) break
    accords.delete(id)
  }
}

// L'accord que porte la réponse du noyau à une commande /nuit : une action répondue exactement « Autoriser », avec son empreinte.
function accordDe(valeur: Record<string, unknown>): Accord | null {
  const reponse = valeur.reponse as { id?: unknown; texte?: unknown; entree?: { type?: unknown; empreinte?: unknown } } | undefined
  if (valeur.effet !== 'reponse' || reponse === undefined || reponse === null || typeof reponse !== 'object') return null
  const entree = reponse.entree
  if (typeof reponse.id !== 'number' || reponse.texte !== REPONSE_AUTORISER || entree === undefined || entree === null) return null

  return entree.type === 'action' && typeof entree.empreinte === 'string' ? { id: reponse.id, empreinte: entree.empreinte } : null
}

// Le lot d'une entrée (les questions posées ensemble portent le même), tel qu'il s'affiche après son type ; vide sans lot.
function lotDe(entree: unknown): string {
  const lot = (entree as { lot?: unknown }).lot

  return typeof lot === 'number' ? `, lot ${lot}` : ''
}

// Une action « en l'air » ne doit laisser aucun rejet derrière elle (la mod peut être déchargée avant qu'elle ne finisse).
function enFond(travail: Promise<unknown>): void {
  travail.catch(() => {})
}

// Le message au modèle part juste après le retour du hook qui le demande, jamais depuis lui : observé dans le banc de la mod, une
// soumission lancée pendant `command.run` n'atteint jamais le bas de la chaîne, alors qu'une soumission lancée d'une minuterie y arrive.
// Non vérifié dans le moteur réel (hors de l'app, aucune session n'est disponible) : la forme différée vaut pour tous les chemins.
function soumettre($: EngineInterface, text: string): void {
  $.clock.after(0, () => enFond($.prompt.submit({ text })))
}

function court(texte: string): string {
  const t = texte.replace(/\s+/g, ' ').trim()
  return t.length > LARGEUR_ERREUR ? `${t.slice(0, LARGEUR_ERREUR - 3)}...` : t
}

// Ce que le noyau a répondu, lu comme un objet : une sortie illisible ou un JSON qui n'est pas un objet se lisent comme un objet sans les
// clés que les décisions cherchent (refuser, reveil, continuer...), qui n'en tirent alors rien. Seule la commande /nuit dit ILLISIBLE.
function lireObjet(texte: string): Record<string, unknown> {
  try {
    return (JSON.parse(texte) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

// `echec` : pourquoi l'appel du noyau a échoué (démarrage impossible, délai dépassé, code de sortie), sinon null. `valeur` est alors vide.
// Les décisions silencieuses (question, garde, réveil, enchaînement) ne regardent que `valeur` : une panne du noyau ne bloque rien.
type Retour = { valeur: Record<string, unknown>; echec: string | null }

async function appeler($: EngineInterface, operation: string, entree: Record<string, unknown>): Promise<Retour> {
  let r
  try {
    r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'nuit-hook', operation], { stdin: JSON.stringify({ agent: AGENT, session: await $.session.id(), ...entree }), timeoutMs: DELAI_NOYAU_MS })
  } catch (e) {
    return { valeur: {}, echec: `Nuit : le noyau ne répond pas (${court(e instanceof Error ? e.message : String(e))}).` }
  }
  if (r.exitCode !== 0) {
    const stderr = court(r.stderr)

    return { valeur: {}, echec: stderr === '' ? `Nuit : code de sortie ${r.exitCode}.` : `Nuit : ${stderr}` }
  }

  return { valeur: lireObjet(r.stdout), echec: null }
}

// Un fichier de la nuit, dans le dossier d'état du Cockpit. Dossier inconnu, fichier absent ou abîmé : rien (la nuit n'est alors pas active).
async function lireNuit($: EngineInterface, nom: string): Promise<unknown> {
  let dossier: string
  try {
    dossier = await dossierEtat($)
  } catch {
    return undefined
  }

  return lireJson($, `${dossier}/${nom}`)
}

// Fichier absent ou abîmé : on le lit comme vide (la nuit n'est alors pas active, et la mod ne gêne rien).
async function lireJson($: EngineInterface, chemin: string): Promise<unknown> {
  try {
    return JSON.parse((await $.fs.read(chemin)).replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

async function nuitActive($: EngineInterface): Promise<boolean> {
  return estActive(await lireNuit($, NOM_ETAT), await $.clock.now())
}

// Relit les deux fichiers du noyau : la dernière lecture sert au panneau, la ligne de statut en est le résumé.
async function rafraichir($: EngineInterface): Promise<void> {
  const lu: NuitSuivi = { etat: normaliserEtat(await lireNuit($, NOM_ETAT)), boite: normaliserBoite(await lireNuit($, NOM_BOITE)) }
  await update($, suivi, () => lu)
  $.ui.status(texteBande(lu.etat, lu.boite, await $.clock.now()))
}

// La demande d'une décision silencieuse (question, garde) au noyau : le texte du refus, ou undefined pour laisser passer. Un refus a pu
// ajouter une entrée à la boîte : la ligne de statut la relit.
async function refus($: EngineInterface, operation: string, entree: Record<string, unknown>): Promise<string | undefined> {
  const r = await appeler($, operation, entree)
  if (r.valeur.refuser !== true || typeof r.valeur.texte !== 'string' || r.valeur.texte === '') return undefined
  await rafraichir($)

  return r.valeur.texte
}

async function refusGarde($: EngineInterface, tool: 'Bash' | 'PowerShell', commande: string): Promise<string | undefined> {
  if (!(await nuitActive($))) return undefined
  // Les accords de l'utilisateur ne sont joints que s'il y en a : le noyau consomme celui qui vaut pour cette commande exacte, une seule fois.
  const autorisees = [...accords].map(([id, empreinte]) => ({ id, empreinte }))
  const r = await appeler($, 'garde', { tool_name: tool, tool_input: { command: commande }, ...(autorisees.length === 0 ? {} : { autorisees }) })
  if (typeof r.valeur.autorisee === 'number') accords.delete(r.valeur.autorisee)
  if (r.valeur.refuser !== true || typeof r.valeur.texte !== 'string' || r.valeur.texte === '') return undefined
  await rafraichir($)

  return r.valeur.texte
}

// Un tour vient de finir : si la nuit est active, le noyau décide de l'enchaînement, et son ordre est soumis comme prompt.
async function enchainer($: EngineInterface, reason: string): Promise<void> {
  if (!(await nuitActive($))) return
  const r = await appeler($, 'continuer', { reason })
  await rafraichir($)
  if (r.valeur.continuer === true && typeof r.valeur.texte === 'string' && r.valeur.texte !== '') soumettre($, r.valeur.texte)
}

const premierMot = (args: string): string => /^\S+/.exec(args)?.[0].toLowerCase() ?? ''

// Une commande /nuit par le noyau, que ce soit l'utilisateur qui la tape ou un bouton du panneau qui la lance : le texte à dire, et si le
// panneau doit s'ouvrir. La réponse de l'utilisateur à une question de la boîte part ici au modèle, comme un prompt.
// `accord` : la commande que cette réponse autorise (voir accordDe), que l'appelant ne retient que si c'est L'UTILISATEUR qui a répondu.
async function executer($: EngineInterface, brut: string): Promise<{ texte: string; ouvrir: boolean; accord: Accord | null }> {
  const args = brut.trim()
  const r = await appeler($, 'commande', { args })
  if (r.echec !== null) return { texte: r.echec, ouvrir: false, accord: null }
  await rafraichir($)
  const { message, erreur, effet, prompt } = r.valeur
  if (typeof erreur === 'string') return { texte: erreur, ouvrir: false, accord: null }
  if (typeof message !== 'string') return { texte: ILLISIBLE, ouvrir: false, accord: null }
  if (effet === 'reponse' && typeof prompt === 'string' && prompt !== '') soumettre($, prompt)

  return { texte: message, ouvrir: effet === 'reveil' || COMMANDES_DU_PANNEAU.includes(premierMot(args)), accord: accordDe(r.valeur) }
}

// Le récap sans sa liste « À décider » : le panneau dessine lui-même les questions à décider, chacune avec ses boutons.
function lignesDuRecap(recap: string): string[] {
  const lignes = recap.split('\n')
  const i = lignes.findIndex(l => l.startsWith('À décider ('))

  return i < 0 ? lignes : lignes.slice(0, i)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nuit',
      description: "Nuit : questions en boîte, arrêts de garde en refus avec alternative, enchaînement des lignes du ledger, récap au réveil (/nuit on, off, statut, recap, boite, ...)",
      argumentHint: '[on | off | statut | recap | boite | ...]',
    })
    $.clock.every(PERIODE_MS, () => enFond(rafraichir($)))
    await rafraichir($)

    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await nuitActive($))) return next(e)
    const texte = await refus($, 'question', { tool_input: { questions: e.questions } })

    return texte === undefined ? next(e) : { deny: texte }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const texte = await refusGarde($, 'Bash', e.command)

    return texte === undefined ? next(e) : { deny: texte }
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const texte = await refusGarde($, 'PowerShell', e.command)

    return texte === undefined ? next(e) : { deny: texte }
  })

  // Un message de l'utilisateur (Enter au clavier ou Remote Control) date son activité, et met fin à une nuit active : c'est le réveil. Le
  // récap est alors donné au modèle avec le message. Les notifications, les déclencheurs et les autres plugins ne sont pas l'utilisateur, et
  // une commande /nuit gère la nuit elle-même.
  on('prompt.submit', async ($, e, next) => {
    if (!ORIGINES_UTILISATEUR.includes(e.origin.kind) || COMMANDE_NUIT.test(e.text)) return next(e)
    const r = await appeler($, 'activite', {})
    if (r.valeur.reveil !== true || typeof r.valeur.recap !== 'string' || r.valeur.recap === '') return next(e)
    const recap = r.valeur.recap
    $.ui.toast('Nuit terminée : le récap est dans le panneau Nuit (/nuit recap).')
    await rafraichir($)
    await $.ui.open({ id: PANNEAU, title: 'Nuit' })

    return next({ ...e, context: [...(e.context ?? []), recap] })
  })

  // Le résultat du tour est pris avant l'enchaînement : selon la documentation du moteur (TraceOutcome `kept`), un hook qui échoue après
  // `next` laisse ce résultat en place. Aucune panne n'est avalée ici.
  on('turn.complete', async ($, e, next) => {
    const resultat = await next(e)
    if (e.agentId === undefined) await enchainer($, e.reason)

    return resultat
  })

  on('prompt.compose', async ($, e, next) => {
    const composition = await next(e)
    const texte = texteRappel(await lireNuit($, NOM_ETAT))

    return texte === null ? composition : { sections: [...composition.sections, { id: 'nuit:rappel', text: texte, scope: 'session' as const }] }
  })

  on('command.run', { command: 'nuit' }, async ($, e) => {
    const { texte, ouvrir, accord } = await executer($, e.args)
    // Seule une commande tapée par l'utilisateur (clavier ou Remote Control) atteste un accord : pas celle d'un plugin, du SDK ou d'un déclencheur.
    if (accord !== null && ORIGINES_UTILISATEUR.includes(e.origin.kind)) retenirAccord(accord)
    if (ouvrir) await $.ui.open({ id: PANNEAU, title: 'Nuit' })

    return { text: texte }
  })

  on('ui.render', { component: 'Pane', requestId: PANNEAU }, async ($, e) => {
    const lu = await read($, suivi)
    const maintenant = await $.clock.now()
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return <Box flexDirection="column"><Button key="rafraichir" label="Rafraîchir" onPress={() => rafraichir($)} /><Text>{lu === null ? 'Nuit : lecture en cours' : texteBande(lu.etat, lu.boite, maintenant) ?? 'Nuit inactive'}</Text></Box>
    }
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const filtreCourant = await read($, filtre)
    const selection = await read($, entreeSelectionnee)
    const libre = await read($, reponseLibre)
    const erreurLibre = await read($, erreurReponse)
    const visibles = lu === null ? [] : filtrerBoite(lu.boite, filtreCourant)
    const active = choisirEntree(visibles, selection)
    const comptes = lu === null ? null : compteursBoite(lu.boite)
    const valide = normaliserTexteLibre(libre)

    const decider = async (id: number, option: string | null, texte: string): Promise<void> => {
      await rafraichir($)
      const courante = (await read($, suivi))?.boite.entrees.find(x => x.id === id) ?? null
      const mots = commandeReponse(courante, option, texte)
      if (mots === null) {
        const erreur = option === null && courante?.type === 'question' ? normaliserTexteLibre(texte).erreur : null
        $.ui.toast(erreur ?? 'Entrée absente, déjà traitée ou option invalide.')
        await update($, erreurReponse, () => erreur)
        return
      }
      // Un bouton du panneau n'est pressé que par l'utilisateur : son « Autoriser » est un accord attesté.
      const fait = await executer($, mots.join(' '))
      if (fait.accord !== null) retenirAccord(fait.accord)
      $.ui.toast(fait.texte)
      await update($, reponseLibre, () => '')
      await update($, erreurReponse, () => null)
    }
    const ecarter = async (id: number): Promise<void> => {
      await rafraichir($)
      const courante = (await read($, suivi))?.boite.entrees.find(x => x.id === id)
      if (courante?.statut !== 'en-attente') { $.ui.toast('Entrée absente ou déjà traitée.'); return }
      $.ui.toast((await executer($, `ecarter ${id}`)).texte)
    }

    return (
      <Box flexDirection="column">
        <Button key="rafraichir" label="Rafraîchir" onPress={() => rafraichir($)} />
        {lu === null && <Text>Nuit : lecture en cours</Text>}
        {lu !== null &&
          lignesDuRecap(texteRecap(lu.etat, lu.boite, { maintenant, lignesMaintenant: null })).filter(ligne => !ligne.startsWith('Rien à décider')).map(ligne => (
            <Text>{ligne}</Text>
          ))}
        {comptes && <Text bold>{`${comptes.attente} à traiter, ${comptes.traitees} en historique`}</Text>}
        <Select key="filtre" label="Afficher" options={[{ value: 'attente', label: 'À traiter' }, { value: 'historique', label: 'Historique' }, { value: 'toutes', label: 'Toutes' }]} value={filtreCourant} onSelect={async value => { await update($, filtre, () => value as FiltreBoite); await update($, entreeSelectionnee, () => null); await update($, reponseLibre, () => '') }} />
        {visibles.length > 0 && active !== null && <Select key="entree" label="Entrée" options={optionsEntrees(visibles)} value={String(active.id)} onSelect={async value => { await update($, entreeSelectionnee, () => Number(value)); await update($, reponseLibre, () => ''); await update($, erreurReponse, () => null) }} />}
        {visibles.length === 0 && <Text>{filtreCourant === 'attente' ? 'Rien à décider en boîte.' : 'Aucune entrée dans cette vue.'}</Text>}
        {active !== null && <Box flexDirection="column" marginTop={1}>
          <Text bold>{`${active.id}. [${active.type}${lotDe(active)}] ${active.titre}`}</Text>
          <Text dimColor>{`Ajoutée le ${active.ajoute} par ${active.agent}`}</Text>
          {active.details !== '' && <Text dimColor>{active.details}</Text>}
          {active.statut !== 'en-attente' && <Text>{active.statut === 'repondue' ? `Réponse : ${active.reponse}` : 'Écartée'}{active.traite ? ` le ${active.traite}` : ''}</Text>}
          {active.statut === 'en-attente' && <Box flexDirection="column">
            <Box>{active.options.map((option, i) => <Button key={`rep-${active.id}-${i}`} label={option.label} onPress={() => decider(active.id, option.label, '')} />)}</Box>
            {active.type === 'question' && <Input key="reponse-libre" label="Réponse libre" value={libre} onInput={value => { enFond(update($, reponseLibre, () => value)); enFond(update($, erreurReponse, () => normaliserTexteLibre(value).valeur.length > 600 ? 'La réponse dépasse 600 caractères.' : null)) }} onSubmit={value => decider(active.id, null, value)} />}
            {active.type === 'question' && valide.erreur === null && <Button key="envoyer-reponse" label="Envoyer la réponse" onPress={() => decider(active.id, null, libre)} />}
            {erreurLibre && <Text>{erreurLibre}</Text>}
            <Button key={`ecarter-${active.id}`} label="Écarter" onPress={() => ecarter(active.id)} />
          </Box>}
        </Box>}
      </Box>
    )
  })
}
