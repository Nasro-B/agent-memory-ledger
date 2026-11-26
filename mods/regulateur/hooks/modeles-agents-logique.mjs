// Politique pure des modeles des prochains sous-agents Claude.
const estObjet = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const validerModele = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/\s|[\x00-\x1f\x7f]/u.test(v);
export const validerType = v => typeof v === 'string' && v.length > 0 && v.length <= 80 && !/\s|[\x00-\x1f\x7f]/u.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);

export function normaliserRegles(brut) {
  if (brut === null || brut === undefined) return { defaut: null, parType: {} };
  if (!estObjet(brut)) return null;
  const defaut = brut.defaut === undefined ? null : brut.defaut;
  if (defaut !== null && !validerModele(defaut)) return null;
  const types = brut.parType === undefined ? {} : brut.parType;
  if (!estObjet(types)) return null;
  const parType = {};
  for (const [type, modele] of Object.entries(types)) {
    if (!validerType(type) || (modele !== null && !validerModele(modele))) return null;
    Object.defineProperty(parType, type, { value: modele, enumerable: true, writable: true, configurable: true });
  }
  return { defaut, parType };
}

export function modelePourSpawn(spawn, regles) {
  if (!estObjet(spawn) || spawn.fork || spawn.workflow || spawn.isTeammate === true || spawn.model !== undefined) return null;
  const politique = normaliserRegles(regles);
  if (politique === null) return null;
  return Object.hasOwn(politique.parType, spawn.subagentType) ? politique.parType[spawn.subagentType] : politique.defaut;
}
