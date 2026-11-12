'use strict';
/*
 * Runs the JavaScript of an n8n Code node outside n8n, so its logic can be unit tested.
 * Supports the subset of the Code node API these templates use:
 *   $input.all(), $input.first(), $json, $('Other Node').first()/.all()/.item
 * `now` freezes Date so time-based logic is deterministic.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadWorkflow(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function codeOf(file, nodeName) {
  const node = loadWorkflow(file).nodes.find((n) => n.name === nodeName);
  if (!node || typeof node.parameters.jsCode !== 'string') {
    throw new Error(`${file}: no Code node named "${nodeName}"`);
  }
  return node.parameters.jsCode;
}

function frozenDate(nowMs) {
  const Real = Date;
  class FrozenDate extends Real {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }
  return FrozenDate;
}

async function runCode(file, nodeName, { items = [], nodes = {}, now } = {}) {
  const wrap = (list) => list.map((json) => ({ json }));
  const input = wrap(items);
  const context = {
    $input: { all: () => input, first: () => input[0], last: () => input[input.length - 1] },
    $json: input[0] ? input[0].json : {},
    $: (name) => {
      if (!(name in nodes)) throw new Error(`test did not provide output for node "${name}"`);
      const out = wrap(nodes[name]);
      return { first: () => out[0], all: () => out, item: out[0] };
    },
    console,
    Date: now === undefined ? Date : frozenDate(Date.parse(now)),
  };
  const script = new vm.Script(`(async function () {\n${codeOf(file, nodeName)}\n})()`);
  const result = await script.runInNewContext(context);
  // JSON round-trip: objects from the vm realm have foreign prototypes.
  return JSON.parse(JSON.stringify((result || []).map((r) => r.json)));
}

module.exports = { loadWorkflow, codeOf, runCode, ROOT };
