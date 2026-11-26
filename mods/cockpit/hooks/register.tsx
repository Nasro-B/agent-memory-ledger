import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CockpitInstantane } from '../types'
import { sections } from './detail'
import { cheminScript } from './emplacements-logique.mjs'

// La mod ne calcule rien : elle appelle le noyau commun (scripts/cockpit.js du plugin, aussi lu par Codex) et dessine sa réponse. Le script est celui de
// AML_PLUGIN_DIR, ou celui du plugin installé à côté du module (voir emplacements-logique.mjs) ; introuvable, la bande le dit.
const NOM_CLI = 'cockpit.js'
const PANNEAU = 'cockpit'
const PERIODE_MS = 30_000
const GIT_TOUS_LES_TICKS = 10 // la mesure git est lente (disque dur) : toutes les 5 minutes
const DELAI_MESURE_MS = 20_000
const DELAI_GIT_MS = 180_000
const LARGEUR_ERREUR = 160

const snapshot = atom({ plugin: 'cockpit', key: 'snapshot' } as const, null)
const erreur = atom({ plugin: 'cockpit', key: 'erreur' } as const, null)
const panneau = atom({ plugin: 'cockpit', key: 'panneau' } as const, {
  vue: 'apercu' as const,
  modeleGlobal: '', modeleGlobalPerso: '', typeNom: '', modeleType: '', modeleTypePerso: '',
  worktreeSelection: '', worktreeNom: '', worktreeChemin: '', confirmerRetrait: false,
})

type EtatPanneau = NonNullable<Awaited<ReturnType<typeof lirePanneau>>>
type Vue = EtatPanneau['vue']
const VUES: { value: Vue; label: string }[] = [
  { value: 'apercu', label: "Vue d'ensemble" }, { value: 'agents', label: 'Agents' },
  { value: 'projets', label: 'Projets' }, { value: 'plans', label: 'Plans' }, { value: 'reglages', label: 'Réglages' },
]
const CHOIX_MODELES = [
  { value: 'heritage', label: 'Hériter' }, { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' },
  { value: 'personnalise', label: 'Identifiant personnalisé' },
]
const VUES_SECTIONS: Record<Vue, string[]> = {
  apercu: ['Mesure', 'Ledger', 'Agents', 'Nuit', 'Quota'],
  agents: ['Agents', 'File', 'Consignes', 'Pause'],
  projets: ['Ledger', 'Git'], plans: ['Plans'], reglages: ['Réglages'],
}

async function lirePanneau($: EngineInterface) { return read($, panneau) }
async function changerPanneau($: EngineInterface, valeurs: Partial<EtatPanneau>): Promise<void> {
  await update($, panneau, avant => ({ ...avant, ...valeurs }))
}

function choixModele(valeur: string | null | undefined): string {
  return valeur === null || valeur === undefined ? 'heritage' : CHOIX_MODELES.some(x => x.value === valeur && valeur !== 'personnalise') ? valeur : 'personnalise'
}

function modeleValide(valeur: string): boolean {
  return valeur.length > 0 && valeur.length <= 128 && !/\s|[\x00-\x1f\x7f]/u.test(valeur)
}

function typeValide(valeur: string): boolean {
  return valeur.length > 0 && valeur.length <= 80 && !/\s|[\x00-\x1f\x7f]/u.test(valeur) && !['__proto__', 'constructor', 'prototype'].includes(valeur)
}

// Ces deux compteurs ne servent qu'à rythmer les mesures : les perdre à un rechargement est sans effet sur l'affichage.
let tick = 0
let gitEnCours = false

function court(texte: string): string {
  const t = texte.replace(/\s+/g, ' ').trim()
  return t.length > LARGEUR_ERREUR ? `${t.slice(0, LARGEUR_ERREUR - 3)}...` : t
}

function texteBande(snap: CockpitInstantane | null, err: string | null): string {
  if (snap === null) return err === null ? 'Cockpit : mesure en cours' : `Cockpit indisponible : ${err}`
  return err === null ? snap.ligne : `${snap.ligne} (mesure ancienne : ${err})`
}

async function mesurer($: EngineInterface): Promise<void> {
  try {
    const r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'instantane', '--json'], { timeoutMs: DELAI_MESURE_MS })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `code de sortie ${r.exitCode}`)
    let mesure: CockpitInstantane
    try {
      mesure = JSON.parse(r.stdout) as CockpitInstantane
    } catch {
      throw new Error('réponse illisible du noyau')
    }
    await update($, snapshot, () => mesure)
    await update($, erreur, () => null)
  } catch (e) {
    const raison = court(e instanceof Error ? e.message : String(e))
    await update($, erreur, () => raison)
  }
}

async function mesurerGit($: EngineInterface): Promise<void> {
  if (gitEnCours) return
  gitEnCours = true
  try {
    await $.process.run(['node', await cheminScript($, NOM_CLI), 'rafraichir-git'], { timeoutMs: DELAI_GIT_MS })
  } catch {
    // l'âge de la mesure git, affiché dans le panneau, dit qu'elle n'a pas eu lieu
  } finally {
    gitEnCours = false
  }
  await mesurer($)
}

// Une mesure lancée « en l'air » peut finir après le déchargement de la mod (rechargement à chaud, fin de session) : il n'y a
// alors plus rien à mettre à jour, et elle ne doit laisser aucun rejet derrière elle.
function enFond(travail: Promise<void>): void {
  travail.catch(() => {})
}

async function toutRafraichir($: EngineInterface): Promise<void> {
  enFond(mesurerGit($))
  await mesurer($)
}

// `/cockpit config ...` : les réglages (worktrees mesurés, dossier des plans) se changent par le noyau, qui contrôle et écrit.
// Sa réponse est dite telle quelle ; une réponse sans erreur relance les mesures en fond, pour que la bande et le panneau suivent.
async function reglages($: EngineInterface, mots: string[]): Promise<{ succes: boolean; texte: string }> {
  let r
  try {
    r = await $.process.run(['node', await cheminScript($, NOM_CLI), 'config', ...mots], { timeoutMs: DELAI_MESURE_MS })
  } catch (e) {
    return { succes: false, texte: `Réglages : ${court(e instanceof Error ? e.message : String(e))}` }
  }
  if (r.exitCode !== 0) return { succes: false, texte: r.stderr.trim() || `Réglages : code de sortie ${r.exitCode}` }
  enFond(toutRafraichir($))

  return { succes: true, texte: r.stdout.trim() }
}

async function modifierDepuisPanneau($: EngineInterface, mots: string[]): Promise<boolean> {
  const resultat = await reglages($, mots)
  $.ui.toast(court(resultat.texte))
  if (resultat.succes) await mesurer($)
  return resultat.succes
}

async function enregistrerModele($: EngineInterface, portee: 'defaut' | 'type'): Promise<void> {
  const ui = await lirePanneau($)
  const courant = (await read($, snapshot))?.modelesAgents
  const choix = portee === 'defaut' ? ui.modeleGlobal : ui.modeleType
  const existant = portee === 'defaut' ? courant?.defaut : courant?.parType[ui.typeNom]
  const effectif = choix || choixModele(existant)
  const modele = effectif === 'personnalise' ? (portee === 'defaut' ? ui.modeleGlobalPerso || existant : ui.modeleTypePerso || existant)?.trim() ?? '' : effectif
  if (modele !== 'heritage' && !modeleValide(modele)) { $.ui.toast('Identifiant de modèle invalide (1 à 128 caractères sans espace).'); return }
  if (portee === 'type' && !typeValide(ui.typeNom)) { $.ui.toast('Nom de type invalide (1 à 80 caractères sans espace).'); return }
  const mots = portee === 'defaut' ? ['modeles', 'defaut', modele] : ['modeles', 'type', ui.typeNom, modele]
  if (await modifierDepuisPanneau($, mots)) await changerPanneau($, portee === 'defaut' ? { modeleGlobal: '' } : { modeleType: '' })
}

async function enregistrerWorktree($: EngineInterface, snap: CockpitInstantane): Promise<void> {
  const ui = await lirePanneau($)
  if (ui.worktreeSelection !== '' && !snap.config?.worktrees.some(w => w.nom === ui.worktreeSelection)) {
    $.ui.toast('Ce worktree n est plus suivi. Actualise la sélection.')
    return
  }
  const nouveau = ui.worktreeSelection === ''
  if (nouveau && (snap.config?.worktrees.length ?? 0) >= 8) { $.ui.toast('Limite de 8 worktrees atteinte.'); return }
  const nom = nouveau ? ui.worktreeNom.trim() : ui.worktreeSelection
  const chemin = ui.worktreeChemin.trim()
  if (!nom || !chemin) { $.ui.toast('Nom et chemin du worktree requis.'); return }
  if (await modifierDepuisPanneau($, ['worktree', 'ajouter', nom, chemin])) {
    await changerPanneau($, { worktreeSelection: nom, worktreeNom: nom, worktreeChemin: chemin, confirmerRetrait: false })
  }
}

// Un bouton de la section Pause : le noyau contrôle et écrit (`cockpit.js pause|reprendre ...`), son résultat est dit par un toast, et la
// mesure est relancée pour que le panneau suive.
async function agirPause($: EngineInterface, sens: 'pause' | 'reprendre', mots: string[]): Promise<void> {
  let texte: string
  try {
    const r = await $.process.run(['node', await cheminScript($, NOM_CLI), sens, ...mots], { timeoutMs: DELAI_MESURE_MS })
    texte = r.exitCode === 0 ? r.stdout.trim() : r.stderr.trim() || `Pause : code de sortie ${r.exitCode}`
  } catch (e) {
    texte = `Pause : ${court(e instanceof Error ? e.message : String(e))}`
  }
  $.ui.toast(texte)
  await mesurer($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cockpit', description: 'Ouvre le panneau Cockpit (état du travail) ; /cockpit config : réglages (worktrees mesurés, dossier des plans)', argumentHint: '[config ...]' })
    $.clock.every(PERIODE_MS, () => {
      tick += 1
      enFond(mesurer($))
      if (tick % GIT_TOUS_LES_TICKS === 0) enFond(mesurerGit($))
    })
    enFond(mesurer($))
    enFond(mesurerGit($))

    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const [premier = '', ...reste] = e.args.trim().split(/\s+/)
    if (premier.toLowerCase() === 'config') return { text: (await reglages($, reste)).texte }
    await $.ui.open({ id: PANNEAU, title: 'Cockpit' })
    const snap = await read($, snapshot)

    return { text: snap === null ? 'Cockpit : mesure en cours' : snap.ligne }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    const err = await read($, erreur)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {texteBande(snap, err)}
        </Text>
        <Button key="detail" label="Détail" onPress={() => $.ui.open({ id: PANNEAU, title: 'Cockpit' })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANNEAU }, async ($, e) => {
    const snap = await read($, snapshot)
    const err = await read($, erreur)
    const ui = await lirePanneau($)
    const maintenant = await $.clock.now()
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return <Box flexDirection="column"><Button key="rafraichir" label="Rafraîchir" onPress={() => toutRafraichir($)} /><Text>{snap?.ligne ?? texteBande(snap, err)}</Text></Box>
    }
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const worktrees = snap?.config?.worktrees ?? []
    const worktree = worktrees.find(w => w.nom === ui.worktreeSelection)
    const modeleGlobal = snap?.modelesAgents?.defaut ?? null
    const modelesTypes = snap?.modelesAgents?.parType ?? {}
    const typePresent = Object.hasOwn(modelesTypes, ui.typeNom)
    const typeEnregistre = typePresent ? modelesTypes[ui.typeNom] : undefined
    const choixGlobal = ui.modeleGlobal || choixModele(modeleGlobal)
    const choixType = ui.modeleType || choixModele(typeEnregistre)
    const sectionsVisibles = snap === null ? [] : sections(snap, maintenant).filter(s => VUES_SECTIONS[ui.vue].includes(s.titre))

    return (
      <Box flexDirection="column">
        <Button key="rafraichir" label="Rafraîchir" onPress={() => toutRafraichir($)} />
        {snap === null && <Text>{texteBande(snap, err)}</Text>}
        {snap !== null && err !== null && <Text dimColor>{`mesure ancienne : ${err}`}</Text>}
        <Select key="vue" label="Vue" options={VUES} value={ui.vue} onSelect={value => changerPanneau($, { vue: value as Vue })} />
        {sectionsVisibles.map(s => (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{s.titre}</Text>
              {s.lignes.map((ligne, i) => {
                const boutons = (s.boutons ?? []).filter(b => b.ligne === i)

                return boutons.length === 0 ? (
                  <Text>{ligne}</Text>
                ) : (
                  <Box>
                    <Text>{ligne}</Text>
                    {boutons.map(b => (
                      <Button key={b.cle} label={b.libelle} onPress={() => agirPause($, b.sens, b.mots)} />
                    ))}
                  </Box>
                )
              })}
            </Box>
          ))}
        {snap !== null && ui.vue === 'reglages' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Modèles des prochains sous-agents</Text>
            {snap.erreurModeles && <Text>{`Politique illisible : ${court(snap.erreurModeles)}`}</Text>}
            <Text>{`Défaut enregistré : ${modeleGlobal ?? 'héritage natif'}`}</Text>
            <Select key="modele-global" label="Modèle global" options={CHOIX_MODELES} value={choixGlobal} onSelect={value => changerPanneau($, { modeleGlobal: value })} />
            {choixGlobal === 'personnalise' && <Input key="modele-global-perso" label="Identifiant" value={ui.modeleGlobalPerso || modeleGlobal || ''} onInput={value => enFond(changerPanneau($, { modeleGlobalPerso: value }))} onSubmit={value => enFond(changerPanneau($, { modeleGlobalPerso: value }))} />}
            <Button key="sauver-modele-global" label="Enregistrer le modèle global" onPress={() => enregistrerModele($, 'defaut')} />
            <Text>{typePresent ? `Type ${ui.typeNom} : ${typeEnregistre ?? 'héritage natif'}` : 'Aucun type sélectionné'}</Text>
            <Select key="type-existant" label="Types enregistrés" options={[{ value: '', label: 'Nouveau type' }, ...Object.keys(modelesTypes).sort().map(value => ({ value, label: value }))]} value={typePresent ? ui.typeNom : ''} onSelect={value => changerPanneau($, { typeNom: value, modeleType: '', modeleTypePerso: '', })} />
            <Input key="type-nom" label="Nom exact du type" value={ui.typeNom} onInput={value => enFond(changerPanneau($, { typeNom: value, modeleType: '' }))} onSubmit={value => enFond(changerPanneau($, { typeNom: value, modeleType: '' }))} />
            <Select key="modele-type" label="Modèle pour ce type" options={CHOIX_MODELES} value={choixType} onSelect={value => changerPanneau($, { modeleType: value })} />
            {choixType === 'personnalise' && <Input key="modele-type-perso" label="Identifiant" value={ui.modeleTypePerso || typeEnregistre || ''} onInput={value => enFond(changerPanneau($, { modeleTypePerso: value }))} onSubmit={value => enFond(changerPanneau($, { modeleTypePerso: value }))} />}
            <Button key="sauver-modele-type" label="Enregistrer pour ce type" onPress={() => enregistrerModele($, 'type')} />
            {typePresent && <Button key="retirer-modele-type" label="Retirer la règle" onPress={async () => { if (await modifierDepuisPanneau($, ['modeles', 'retirer', ui.typeNom])) await changerPanneau($, { typeNom: '', modeleType: '' }) }} />}
          </Box>
        )}
        {snap !== null && ui.vue === 'reglages' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{`Worktrees suivis : ${worktrees.length}/8`}</Text>
            <Select key="worktree" label="Worktree" options={[{ value: '', label: 'Nouveau worktree' }, ...worktrees.map(w => ({ value: w.nom, label: w.nom }))]} value={worktree?.nom ?? ''} onSelect={value => { const choisi = worktrees.find(w => w.nom === value); return changerPanneau($, { worktreeSelection: value, worktreeNom: choisi?.nom ?? '', worktreeChemin: choisi?.chemin ?? '', confirmerRetrait: false }) }} />
            {worktree ? <Text>{`Nom : ${worktree.nom}`}</Text> : <Input key="worktree-nom" label="Nom" value={ui.worktreeNom} onInput={value => enFond(changerPanneau($, { worktreeNom: value }))} onSubmit={value => enFond(changerPanneau($, { worktreeNom: value }))} />}
            <Input key="worktree-chemin" label="Chemin du dépôt Git" value={ui.worktreeChemin} onInput={value => enFond(changerPanneau($, { worktreeChemin: value }))} onSubmit={value => enFond(changerPanneau($, { worktreeChemin: value }))} />
            {(!worktree && worktrees.length < 8 || worktree) && <Button key="sauver-worktree" label={worktree ? 'Enregistrer le chemin' : 'Ajouter au suivi'} onPress={() => enregistrerWorktree($, snap)} />}
            {!worktree && worktrees.length >= 8 && <Text>Limite de huit atteinte.</Text>}
            {worktree && !ui.confirmerRetrait && <Button key="demander-retrait" label="Retirer du suivi" onPress={() => changerPanneau($, { confirmerRetrait: true })} />}
            {worktree && ui.confirmerRetrait && <Box><Text>{`Retirer ${worktree.nom} du suivi sans toucher aux fichiers ?`}</Text><Button key="confirmer-retrait" label="Confirmer le retrait" onPress={async () => { if (await modifierDepuisPanneau($, ['worktree', 'retirer', worktree.nom])) await changerPanneau($, { worktreeSelection: '', worktreeNom: '', worktreeChemin: '', confirmerRetrait: false }) }} /><Button key="annuler-retrait" label="Annuler" onPress={() => changerPanneau($, { confirmerRetrait: false })} /></Box>}
          </Box>
        )}
      </Box>
    )
  })
}
