'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.resolve(process.argv[2] || path.join(projectRoot, 'node_modules/ccusage'));
const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
const projectPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = projectPackage.devDependencies.ccusage;
if (sourcePackage.name !== 'ccusage' || sourcePackage.version !== version) {
  throw new Error(`Expected official ccusage ${version}; received ${sourcePackage.name} ${sourcePackage.version}. Install the pinned version or pass its isolated package directory.`);
}

const original = JSON.parse(fs.readFileSync(path.join(sourceDir, 'config-schema.json'), 'utf8'));
const definitions = {};
const shared = new Map();
const validationKeys = ['type', 'enum', 'minimum', 'required', 'pattern'];
const annotationKeys = new Set(['description', 'markdownDescription', 'default', 'format', 'title', 'examples', '$comment']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function shrink(schema) {
  // Refuse newly introduced rules rather than silently discarding validation.
  for (const key of Object.keys(schema)) {
    if (![...validationKeys, 'properties', 'items', 'additionalProperties'].includes(key) && !annotationKeys.has(key)) {
      throw new Error(`Unsupported schema keyword ${key}; update the generator and Go validator before upgrading ccusage.`);
    }
  }
  const rule = {};
  for (const key of validationKeys) if (Object.hasOwn(schema, key)) rule[key] = schema[key];
  if (schema.properties) rule.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, shrink(child)]));
  if (schema.items) rule.items = shrink(schema.items);
  if (Object.hasOwn(schema, 'additionalProperties')) {
    rule.additionalProperties = typeof schema.additionalProperties === 'object' ? shrink(schema.additionalProperties) : schema.additionalProperties;
  }
  const signature = JSON.stringify(canonical(rule));
  if (!shared.has(signature)) {
    const name = `rule${shared.size}`;
    shared.set(signature, name);
    definitions[name] = rule;
  }
  return { $ref: `#/definitions/${shared.get(signature)}` };
}

if (!original.$ref?.startsWith('#/definitions/')) throw new Error('Expected a local root schema reference');
const rootRule = original.definitions[original.$ref.slice('#/definitions/'.length)];
if (!rootRule) throw new Error('Root configuration schema is missing');
const rootRef = shrink(rootRule);
const generated = {
  ccusageVersion: version,
  $comment: `Validation rules derived from ccusage ${version} config-schema.json, MIT license, https://github.com/ccusage/ccusage. Annotations removed; identical rules shared. Regenerate with scripts/update-ccusage-schema.js when upgrading ccusage.`,
  $ref: rootRef.$ref,
  definitions
};
const destination = path.join(projectRoot, 'internal/app/ccusage_config_schema.json');
fs.writeFileSync(destination, JSON.stringify(generated, null, 2) + '\n');
console.log(`Generated ccusage ${version} schema (${shared.size} shared rules): ${destination}`);
