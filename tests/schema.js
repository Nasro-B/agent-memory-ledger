'use strict';
// Validation des sorties de hooks contre les schémas JSON de codex-cli (sous-ensemble utilisé par ces schémas :
// type, const, enum, properties, required, additionalProperties, allOf, $ref vers #/definitions, schémas booléens).
const fs = require('node:fs');
const path = require('node:path');

const SCHEMAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas-hooks-codex-0.155.json'), 'utf8')).schemas;
const KEBAB = {
  PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', UserPromptSubmit: 'user-prompt-submit', SessionStart: 'session-start',
  Stop: 'stop', PreCompact: 'pre-compact', PostCompact: 'post-compact', SubagentStart: 'subagent-start', SubagentStop: 'subagent-stop',
};

function valider(schema, v, racine, ou = '$') {
  if (schema === true) return [];
  if (schema === false) return [`${ou} : interdit`];
  const err = [];
  if (schema.$ref) {
    const cible = (racine.definitions || {})[schema.$ref.replace('#/definitions/', '')];
    if (!cible) return [`${ou} : $ref introuvable ${schema.$ref}`];
    err.push(...valider(cible, v, racine, ou));
  }
  for (const s of schema.allOf || []) err.push(...valider(s, v, racine, ou));
  if ('const' in schema && v !== schema.const) err.push(`${ou} : attendu ${JSON.stringify(schema.const)}, reçu ${JSON.stringify(v)}`);
  if (schema.enum && !schema.enum.includes(v)) err.push(`${ou} : ${JSON.stringify(v)} hors enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
    if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) err.push(`${ou} : type ${t}, attendu ${types.join('|')}`);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (!(r in v)) err.push(`${ou} : champ requis absent ${r}`);
    for (const [k, x] of Object.entries(v)) {
      if (k in props) err.push(...valider(props[k], x, racine, `${ou}.${k}`));
      else if (schema.additionalProperties === false) err.push(`${ou} : champ en trop ${k}`);
    }
  }
  return err;
}

// Erreurs de la sortie (texte JSON) d'un hook Codex pour cet événement ; tableau vide = conforme. Sortie vide = conforme.
function erreursSortieCodex(evenement, sortie) {
  if (!sortie) return [];
  let obj;
  try { obj = JSON.parse(sortie); } catch (e) { return ['sortie non JSON : ' + String(sortie).slice(0, 120)]; }
  const s = SCHEMAS[`${KEBAB[evenement]}.command.output`];
  return s ? valider(s, obj, s) : [`schéma de sortie absent pour ${evenement}`];
}

module.exports = { SCHEMAS, KEBAB, valider, erreursSortieCodex };
