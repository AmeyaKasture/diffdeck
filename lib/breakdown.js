'use strict';

// Loads breakdown.json, checks it against the diff and resolves refs into
// concrete (file, hunk) pairs. Lightweight checks only; no schema library.

const fs = require('fs');
const path = require('path');

const KINDS = ['feature', 'fix', 'refactor', 'perf', 'test', 'config', 'docs', 'chore'];
const RISKS = ['low', 'medium', 'high'];

function readJson(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: `${path.basename(file)} is not valid JSON: ${e.message}` };
  }
}

function checkOption(o, where, errors) {
  if (!o || typeof o !== 'object') { errors.push(`${where}: must be an object`); return; }
  if (typeof o.label !== 'string' || !o.label) errors.push(`${where}.label: required string`);
  if (typeof o.description !== 'string') errors.push(`${where}.description: required string`);
  for (const k of ['pros', 'cons']) {
    if (!Array.isArray(o[k]) || o[k].some((x) => typeof x !== 'string')) errors.push(`${where}.${k}: required array of strings`);
  }
}

const CHANGES = ['added', 'modified', 'removed', 'unchanged'];

// Shared checks for a diagram: unique node ids, edges between known nodes.
function checkGraph(flow, where, errors, nodeCheck) {
  if (!flow || typeof flow !== 'object') { errors.push(`${where}: must be an object`); return; }
  if (!Array.isArray(flow.nodes) || flow.nodes.length < 2) { errors.push(`${where}.nodes: at least two nodes required`); return; }
  const ids = new Set();
  flow.nodes.forEach((n, i) => {
    const nw = `${where}.nodes[${i}]`;
    if (!n || typeof n.id !== 'string' || !n.id) { errors.push(`${nw}.id: required string`); return; }
    if (ids.has(n.id)) errors.push(`${nw}.id: duplicate "${n.id}"`);
    ids.add(n.id);
    if (typeof n.label !== 'string' || !n.label) errors.push(`${nw}.label: required string`);
    if (n.change !== undefined && !CHANGES.includes(n.change)) errors.push(`${nw}.change: one of ${CHANGES.join(', ')}`);
    nodeCheck(n, nw);
  });
  (Array.isArray(flow.edges) ? flow.edges : []).forEach((e, i) => {
    const ew = `${where}.edges[${i}]`;
    if (!e || !ids.has(e.from)) errors.push(`${ew}.from: unknown node "${e && e.from}"`);
    if (!e || !ids.has(e.to)) errors.push(`${ew}.to: unknown node "${e && e.to}"`);
    if (e && e.change !== undefined && !CHANGES.includes(e.change)) errors.push(`${ew}.change: one of ${CHANGES.join(', ')}`);
  });
  if (!Array.isArray(flow.edges)) errors.push(`${where}.edges: required array`);
}

function resolve(breakdown, files) {
  const errors = [];
  const warnings = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const owner = new Map(); // "path#idx" -> card id

  if (!breakdown || typeof breakdown !== 'object') return { errors: ['breakdown must be an object'], warnings, cards: [] };
  if (typeof breakdown.title !== 'string') errors.push('title: required string');
  if (typeof breakdown.summary !== 'string') errors.push('summary: required string');
  if (!Array.isArray(breakdown.cards) || !breakdown.cards.length) {
    errors.push('cards: required non-empty array');
    return { errors, warnings, cards: [] };
  }

  const ids = new Set();
  const cards = breakdown.cards.map((card, ci) => {
    const where = `cards[${ci}]${card && card.id ? ` (${card.id})` : ''}`;
    if (!card || typeof card !== 'object') { errors.push(`${where}: must be an object`); return null; }
    if (typeof card.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(card.id)) errors.push(`${where}.id: kebab-case string required`);
    else if (ids.has(card.id)) errors.push(`${where}.id: duplicate id`);
    ids.add(card.id);
    if (typeof card.title !== 'string' || !card.title) errors.push(`${where}.title: required`);
    if (typeof card.summary !== 'string') errors.push(`${where}.summary: required`);
    if (!KINDS.includes(card.kind)) errors.push(`${where}.kind: one of ${KINDS.join(', ')}`);
    if (!RISKS.includes(card.risk)) errors.push(`${where}.risk: one of ${RISKS.join(', ')}`);

    const hunks = [];
    if (!Array.isArray(card.refs) || !card.refs.length) errors.push(`${where}.refs: required non-empty array`);
    for (const [ri, ref] of (card.refs || []).entries()) {
      const rw = `${where}.refs[${ri}]`;
      const f = ref && byPath.get(ref.file);
      if (!f) { errors.push(`${rw}: file "${ref && ref.file}" is not in the diff`); continue; }
      let idxs;
      if (Array.isArray(ref.hunks)) {
        idxs = ref.hunks;
        for (const i of idxs) if (!f.hunks[i]) errors.push(`${rw}: ${f.path} has no hunk ${i} (has ${f.hunks.length})`);
      } else if (Array.isArray(ref.lines) && ref.lines.length === 2) {
        const [a, b] = ref.lines;
        idxs = f.hunks.filter((h) => h.newStart <= b && h.newStart + Math.max(h.newLines - 1, 0) >= a).map((h) => h.index);
        if (!idxs.length) errors.push(`${rw}: lines ${a}-${b} match no hunk in ${f.path}`);
      } else {
        idxs = f.hunks.map((h) => h.index);
      }
      if (!f.hunks.length) hunks.push({ file: f.path, hunk: null });
      for (const i of idxs) {
        if (!f.hunks[i]) continue;
        const key = `${f.path}#${i}`;
        if (owner.has(key) && owner.get(key) !== card.id) warnings.push(`${key} is in both "${owner.get(key)}" and "${card.id}"`);
        owner.set(key, card.id);
        if (!hunks.some((h) => h.file === f.path && h.hunk === i)) hunks.push({ file: f.path, hunk: i });
      }
    }

    for (const [di, d] of (card.decisions || []).entries()) {
      const dw = `${where}.decisions[${di}]`;
      if (typeof d.question !== 'string') errors.push(`${dw}.question: required`);
      checkOption(d.chosen, `${dw}.chosen`, errors);
      if (!Array.isArray(d.alternatives) || !d.alternatives.length) errors.push(`${dw}.alternatives: at least one required`);
      else d.alternatives.forEach((a, ai) => checkOption(a, `${dw}.alternatives[${ai}]`, errors));
    }
    if (card.flow !== undefined) {
      checkGraph(card.flow, `${where}.flow`, errors, (n, nw) => {
        if (!['start', 'end', 'step', 'decision', 'io'].includes(n.shape)) errors.push(`${nw}.shape: one of start, end, step, decision, io`);
        const step = `${where}.flow step "${n.label}"`;
        if (n.ref !== undefined) {
          const f = n.ref && byPath.get(n.ref.file);
          const lines = n.ref && n.ref.lines;
          if (!f) errors.push(`${nw}.ref.file: "${n.ref && n.ref.file}" is not in the diff`);
          if (!Array.isArray(lines) || lines.length !== 2 || !lines.every(Number.isInteger)) errors.push(`${nw}.ref.lines: [start, end] required`);
          else if (f) {
            const side = n.ref.side === 'old' ? 'old' : 'new';
            const hit = f.hunks.filter((h) => h.lines.some((l) => {
              const num = side === 'old' ? l.o : l.n;
              return num != null && num >= lines[0] && num <= lines[1] && (side === 'old' ? l.t !== 'add' : l.t !== 'del');
            })).map((h) => h.index);
            if (!hit.length) warnings.push(`${step}: ${f.path}:${lines[0]}-${lines[1]} is not in the diff (unchanged code), so clicking it shows the file instead of the change`);
            else if (!hit.some((i) => hunks.some((h) => h.file === f.path && h.hunk === i))) warnings.push(`${step}: ${f.path}:${lines[0]}-${lines[1]} is outside this card's hunks`);
          }
        } else if (!['start', 'end'].includes(n.shape) && n.decision === undefined && n.change !== 'removed') {
          warnings.push(`${step} has no ref, so clicking it does nothing; add ref: { file, lines }`);
        }
        if (n.decision !== undefined && !(card.decisions || [])[n.decision]) errors.push(`${nw}.decision: card has no decision ${n.decision}`);
      });
    }
    if (typeof card.stale === 'string' && card.stale) warnings.push(`${where} is stale. ${card.stale} Update it, then delete its "stale" field.`);
    return { ...card, decisions: card.decisions || [], hunks };
  }).filter(Boolean);

  if (breakdown.flow !== undefined) {
    checkGraph(breakdown.flow, 'flow', errors, (n, nw) => {
      if (!['actor', 'component', 'service', 'data', 'external'].includes(n.type)) errors.push(`${nw}.type: one of actor, component, service, data, external`);
      if (n.card !== undefined && !ids.has(n.card)) errors.push(`${nw}.card: no card with id "${n.card}"`);
    });
  }

  const uncovered = [];
  for (const f of files) {
    for (const h of f.hunks) if (!owner.has(`${f.path}#${h.index}`)) uncovered.push({ file: f.path, hunk: h.index });
  }
  if (uncovered.length) warnings.push(`${uncovered.length} hunk(s) are not in any card: ${uncovered.slice(0, 8).map((u) => `${u.file}#${u.hunk}`).join(', ')}${uncovered.length > 8 ? ', ...' : ''}`);

  return { errors, warnings, cards, uncovered };
}

function load(dir) {
  const diff = readJson(path.join(dir, 'diff.json'));
  if (diff.missing) throw new Error('No diff prepared yet. Run `diffdeck prepare` first.');
  if (diff.error) throw new Error(diff.error);
  const { meta, files } = diff.value;

  const raw = readJson(path.join(dir, 'breakdown.json'));
  let breakdown = null;
  let result = { errors: [], warnings: [], cards: [], uncovered: [] };
  if (raw.error) result.errors.push(raw.error);
  else if (!raw.missing) {
    breakdown = raw.value;
    result = resolve(breakdown, files);
  }
  return { meta, files, breakdown, ...result };
}

const KIND_BY_EXT = [
  [/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i, 'test'],
  [/\.(md|mdx|rst|txt)$/i, 'docs'],
  [/\.(json|ya?ml|toml|ini|cfg|lock)$|(^|\/)(Dockerfile|Makefile)$|^\.github\//i, 'config'],
];

function guessKind(p) {
  for (const [re, kind] of KIND_BY_EXT) if (re.test(p)) return kind;
  return 'chore';
}

// The cards the UI shows: the agent's cards plus a catch-all for uncovered
// hunks, or one card per file when no breakdown exists yet.
function deckCards(loaded) {
  const { files } = loaded;
  if (loaded.breakdown && !loaded.errors.length) {
    const cards = loaded.cards.slice();
    if (loaded.uncovered.length) {
      cards.push({
        id: 'unassigned', title: 'Changes not covered by the breakdown', group: 'Unassigned', kind: 'chore', risk: 'medium',
        summary: 'These hunks were not placed in any card by the agent. Review them directly.',
        decisions: [], hunks: loaded.uncovered, synthetic: true,
      });
    }
    return cards;
  }
  return files.map((f, i) => ({
    id: `file-${i + 1}`,
    title: f.path.split('/').pop(),
    group: f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : '(root)',
    kind: guessKind(f.path),
    risk: f.additions + f.deletions > 200 ? 'medium' : 'low',
    summary: `${f.status[0].toUpperCase()}${f.status.slice(1)} · ${f.path}`,
    decisions: [],
    hunks: f.hunks.length ? f.hunks.map((h) => ({ file: f.path, hunk: h.index })) : [{ file: f.path, hunk: null }],
    synthetic: true,
  }));
}

module.exports = { load, resolve, deckCards };
