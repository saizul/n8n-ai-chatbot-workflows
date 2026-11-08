#!/usr/bin/env node
/*
 * Validates exported n8n workflow JSON files.
 *
 * Checks, for every *.json file in the repository (excluding node_modules/.git):
 *   1. The file parses as JSON.
 *   2. It has a non-empty "nodes" array, and each node has name, type,
 *      position ([x, y]) and a unique name.
 *   3. Every entry in "connections" refers to existing node names
 *      (both the source and every target).
 *   4. Every non-trigger node takes part in at least one connection
 *      (AI sub-nodes such as chat models connect outward, so either direction counts).
 *   5. No credential-looking secrets are embedded (API keys, bearer tokens,
 *      private keys, long hard-coded passwords). Credential *references*
 *      (the "credentials" block with id/name) are fine.
 *
 * Usage: node scripts/validate-workflows.js [directory]
 * Exit code is 1 if any error is found. No dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json', 'composer.json', 'tsconfig.json']);

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style API key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/\bEAA[A-Za-z0-9]{40,}/, 'Facebook/Meta access token'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'Bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];
const SECRET_KEY_RE = /^(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token|token)$/i;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json') && !SKIP_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Values that are clearly placeholders or n8n expressions, not real secrets.
function isPlaceholder(v) {
  return (
    v === '' ||
    /^=?\s*\{\{.*\}\}\s*$/s.test(v) ||
    /^=/.test(v) ||
    /YOUR[_ -]|<.*>|REPLACE|PLACEHOLDER|CHANGE[_ -]?ME|EXAMPLE|xxx/i.test(v)
  );
}

function scanSecrets(value, trail, report) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanSecrets(v, `${trail}[${i}]`, report));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && SECRET_KEY_RE.test(k) && v.length >= 12 && !isPlaceholder(v)) {
        report(`${trail}.${k}: hard-coded value for secret-like field`);
      }
      scanSecrets(v, `${trail}.${k}`, report);
    }
  } else if (typeof value === 'string' && !isPlaceholder(value)) {
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(value)) report(`${trail}: looks like a ${label}`);
    }
  }
}

function validate(file) {
  const errors = [];
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { errors: [`invalid JSON: ${e.message}`], skipped: false };
  }
  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
    return { errors: [], skipped: true };
  }
  if (wf.nodes.length === 0) errors.push('"nodes" array is empty');

  const names = new Set();
  wf.nodes.forEach((n, i) => {
    const label = `nodes[${i}]${n && n.name ? ` (${n.name})` : ''}`;
    if (!n || typeof n !== 'object') return errors.push(`${label}: not an object`);
    if (typeof n.name !== 'string' || !n.name) errors.push(`${label}: missing "name"`);
    if (typeof n.type !== 'string' || !n.type) errors.push(`${label}: missing "type"`);
    if (!Array.isArray(n.position) || n.position.length !== 2 || !n.position.every(Number.isFinite)) {
      errors.push(`${label}: "position" must be [x, y]`);
    }
    if (n.parameters !== undefined && (typeof n.parameters !== 'object' || n.parameters === null)) {
      errors.push(`${label}: "parameters" must be an object`);
    }
    if (typeof n.name === 'string') {
      if (names.has(n.name)) errors.push(`${label}: duplicate node name "${n.name}"`);
      names.add(n.name);
    }
  });

  const conns = wf.connections;
  if (conns !== undefined && (typeof conns !== 'object' || conns === null || Array.isArray(conns))) {
    errors.push('"connections" must be an object');
  } else if (conns) {
    for (const [source, types] of Object.entries(conns)) {
      if (!names.has(source)) errors.push(`connections: source node "${source}" does not exist`);
      for (const [connType, outputs] of Object.entries(types || {})) {
        if (!Array.isArray(outputs)) {
          errors.push(`connections.${source}.${connType}: expected an array`);
          continue;
        }
        outputs.forEach((targets, idx) => {
          (targets || []).forEach((t) => {
            if (!t || !names.has(t.node)) {
              errors.push(`connections.${source}.${connType}[${idx}]: target node "${t && t.node}" does not exist`);
            }
          });
        });
      }
    }
  }

  // Orphan check: any node that is not a trigger/note must be a connection source or target.
  const incoming = new Set(Object.keys(conns || {}));
  for (const types of Object.values(conns || {})) {
    for (const outputs of Object.values(types || {})) {
      (Array.isArray(outputs) ? outputs : []).forEach((targets) =>
        (targets || []).forEach((t) => t && incoming.add(t.node)));
    }
  }
  wf.nodes.forEach((n) => {
    if (!n || typeof n.type !== 'string' || typeof n.name !== 'string') return;
    const isEntry = /(trigger|webhook|stickyNote|manualTrigger|cron|start|errorTrigger|formTrigger)$/i.test(n.type);
    if (!isEntry && !incoming.has(n.name)) {
      errors.push(`node "${n.name}" (${n.type}) is not connected to anything (orphaned)`);
    }
  });

  scanSecrets(wf, '$', (m) => errors.push(`possible secret: ${m}`));
  return { errors, skipped: false, nodeCount: wf.nodes.length };
}

const files = walk(root, []).sort();
let failed = 0;
let checked = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const { errors, skipped, nodeCount } = validate(file);
  if (skipped) {
    console.log(`SKIP  ${rel} (not an n8n workflow)`);
    continue;
  }
  checked++;
  if (errors.length) {
    failed++;
    console.log(`FAIL  ${rel}`);
    errors.forEach((e) => console.log(`        - ${e}`));
  } else {
    console.log(`OK    ${rel} (${nodeCount} nodes)`);
  }
}
if (checked === 0) {
  console.log('No n8n workflow files found.');
  process.exit(1);
}
console.log(`\n${checked - failed}/${checked} workflow file(s) valid.`);
process.exit(failed ? 1 : 0);
