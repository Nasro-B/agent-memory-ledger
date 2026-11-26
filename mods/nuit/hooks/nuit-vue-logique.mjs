const MAX_TITRE = 60
const MAX_REPONSE = 600

const entreesDe = boite => Array.isArray(boite?.entrees) ? boite.entrees : []

export function compteursBoite(boite) {
  const entrees = entreesDe(boite)
  const attente = entrees.filter(e => e.statut === 'en-attente').length
  return { attente, traitees: entrees.length - attente, total: entrees.length }
}

export function filtrerBoite(boite, filtre) {
  const entrees = entreesDe(boite)
  const visibles = filtre === 'attente' ? entrees.filter(e => e.statut === 'en-attente')
    : filtre === 'historique' ? entrees.filter(e => e.statut !== 'en-attente') : entrees
  return [...visibles].sort((a, b) => (filtre === 'toutes' ? Number(a.statut !== 'en-attente') - Number(b.statut !== 'en-attente') : 0) || a.id - b.id)
}

export function choisirEntree(visibles, id) {
  return visibles.find(e => e.id === id) ?? visibles[0] ?? null
}

export function optionsEntrees(visibles) {
  return visibles.map(e => {
    const titre = String(e.titre).replace(/\s+/g, ' ').trim()
    const court = titre.length > MAX_TITRE ? `${titre.slice(0, MAX_TITRE - 3)}...` : titre
    return { value: String(e.id), label: `${e.id}. ${court}` }
  })
}

export function normaliserTexteLibre(texte) {
  const valeur = typeof texte === 'string' ? texte.replace(/\s+/g, ' ').trim() : ''
  if (!valeur) return { valeur, erreur: 'La réponse est vide.' }
  if (valeur.length > MAX_REPONSE) return { valeur, erreur: 'La réponse dépasse 600 caractères.' }
  return { valeur, erreur: null }
}

export function commandeReponse(entree, option, texteLibre) {
  if (!entree || entree.statut !== 'en-attente') return null
  if (option !== null && option !== undefined) {
    if (!entree.options.some(o => o.label === option)) return null
    return ['repondre', String(entree.id), option]
  }
  if (entree.type === 'action') return null
  const texte = normaliserTexteLibre(texteLibre)
  return texte.erreur ? null : ['repondre', String(entree.id), texte.valeur]
}
