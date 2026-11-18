'use strict';

// Review rounds. When the diff changes, the previous round (diff, breakdown,
// feedback, replies) is archived under .diffdeck/rounds/<n>/. If the new diff is
// for the same PR, branch or commit, the parts that still apply are carried
// over: cards whose hunks are unchanged keep their place and their approval,
// cards whose code changed are marked stale for the agent to update, and
// refresh.md lists what the agent has to do.

const fs = require('fs');
const path = require('path');

const ROUND_FILES = ['diff.json', 'diff.patch', 'breakdown.json', 'feedback.json', 'feedback.md', 'replies.json'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Identifies what is being reviewed, so a new diff of the same target can
// inherit the previous round.
function targetKey(m) {
  if (!m) return null;
  if (m.source === 'pr') return `pr:${m.prUrl || m.prNumber}`;
  if (m.source === 'branch') return `branch:${m.branch}`;
  if (m.source === 'commit') return `commit:${m.commitSha}`;
  if (m.source === 'range') return `range:${m.branch}`;
  return m.source || null;
}

// Only the changed lines identify a hunk: its context lines shift when code
// next to it is edited.
function changeKey(h) {
  return h.lines.filter((l) => l.t !== 'ctx').map((l) => (l.t === 'add' ? '+' : '-') + l.s).join('\n');
}

// "path#oldIndex" -> newIndex for hunks whose changed lines are identical.
function mapHunks(oldFiles, newFiles) {
  const map = new Map();
  const byPath = new Map(newFiles.map((f) => [f.path, f]));
  for (const of of oldFiles) {
    const nf = byPath.get(of.path);
    if (!nf) continue;
    const used = new Set();
    for (const h of of.hunks) {
      const key = changeKey(h);
      const m = nf.hunks.find((x) => !used.has(x.index) && changeKey(x) === key);
      if (m) { used.add(m.index); map.set(`${of.path}#${h.index}`, m.index); }
    }
  }
  return map;
}

// Maps a new-side line number of the old diff to the new diff, or null when
// the line was rewritten. Lines inside a carried hunk move with the hunk;
// unchanged lines are mapped through the base file, which must be the same in
// both rounds.
function mapLine(oldFile, newFile, hunkMap, line, sameBase) {
  for (const h of oldFile.hunks) {
    const l = h.lines.find((x) => x.t !== 'del' && x.n === line);
    if (!l) continue;
    const ni = hunkMap.get(`${oldFile.path}#${h.index}`);
    if (ni != null) return line + (newFile.hunks[ni].newStart - h.newStart);
    if (l.t === 'add' || !sameBase) return null;
    return baseToNew(newFile, l.o);
  }
  if (!sameBase) return null;
  let delta = 0;
  for (const h of oldFile.hunks) if (h.newStart + h.newLines - 1 < line) delta += h.newLines - h.oldLines;
  return baseToNew(newFile, line - delta);
}

function baseToNew(newFile, base) {
  let delta = 0;
  for (const h of newFile.hunks) {
    const l = h.lines.find((x) => x.t !== 'add' && x.o === base);
    if (l) return l.t === 'del' ? null : l.n;
    if (h.oldStart + h.oldLines - 1 < base) delta += h.newLines - h.oldLines;
  }
  return base + delta;
}

// Rewrites a flow step's ref for the new diff; returns false when it no longer
// points at the same code.
function remapStep(ref, oldByPath, newByPath, hunkMap, sameBase) {
  const of = oldByPath.get(ref.file);
  const nf = newByPath.get(ref.file);
  if (!of || !nf || !Array.isArray(ref.lines)) return false;
  if (ref.side === 'old') return sameBase;
  const a = mapLine(of, nf, hunkMap, ref.lines[0], sameBase);
  const b = mapLine(of, nf, hunkMap, ref.lines[1], sameBase);
  if (a == null || b == null || b < a) return false;
  ref.lines = [a, b];
  return true;
}

// The new hunk that rewrote an old one: an unclaimed hunk overlapping the same
// lines of the base file. The base must be the same for this to be meaningful,
// but a wrong guess only puts a hunk in a card that is marked stale anyway.
function reworkedHunk(oldHunk, newFile, claimed) {
  if (!oldHunk || !newFile) return null;
  const a = oldHunk.oldStart;
  const b = oldHunk.oldStart + Math.max(oldHunk.oldLines - 1, 0);
  const h = newFile.hunks.find((x) => !claimed.has(`${newFile.path}#${x.index}`)
    && x.oldStart <= b && x.oldStart + Math.max(x.oldLines - 1, 0) >= a);
  if (!h) return null;
  claimed.add(`${newFile.path}#${h.index}`);
  return h.index;
}

function archive(dir, round) {
  const dest = path.join(dir, 'rounds', String(round));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ROUND_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dest, f));
  }
  return dest;
}

function nextRound(dir) {
  try {
    const nums = fs.readdirSync(path.join(dir, 'rounds')).map(Number).filter(Number.isInteger);
    return nums.length ? Math.max(...nums) + 1 : 1;
  } catch { return 1; }
}

// Called by prepare before the new diff is written. Archives the previous
// round and returns a function that carries it into the new one.
function begin(dir) {
  const prevDiff = readJson(path.join(dir, 'diff.json'));
  const prevBreakdown = readJson(path.join(dir, 'breakdown.json'));
  const prevFeedback = readJson(path.join(dir, 'feedback.json'));
  const hasWork = !!(prevBreakdown || prevFeedback);
  const round = prevDiff && hasWork ? nextRound(dir) : null;
  if (round) archive(dir, round);
  for (const f of ['breakdown.json', 'feedback.json', 'feedback.md', 'replies.json', 'refresh.md']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* none */ }
  }

  return function carry(meta, files) {
    meta.round = round ? round + 1 : 1;
    const same = prevDiff && targetKey(prevDiff.meta) === targetKey(meta);
    if (!round || !same || !prevBreakdown || !Array.isArray(prevBreakdown.cards)) return { round: meta.round, carried: false };
    meta.previousRound = round;

    const oldFiles = prevDiff.files || [];
    const oldByPath = new Map(oldFiles.map((f) => [f.path, f]));
    const newByPath = new Map(files.map((f) => [f.path, f]));
    const hunkMap = mapHunks(oldFiles, files);
    const sameBase = !!(prevDiff.meta.baseSha && prevDiff.meta.baseSha === meta.baseSha);

    // New hunks that carried cards already own exactly.
    const claimed = new Set([...hunkMap].map(([k, ni]) => `${k.slice(0, k.lastIndexOf('#'))}#${ni}`));
    const kept = [];
    const stale = [];
    const removed = [];
    const cards = [];
    for (const card of prevBreakdown.cards) {
      if (!card || !Array.isArray(card.refs)) continue;
      // The card's hunks in the old diff, resolved the way breakdown.js does.
      const oldHunks = [];
      for (const ref of card.refs) {
        const f = ref && oldByPath.get(ref.file);
        if (!f) continue;
        let idxs;
        if (Array.isArray(ref.hunks)) idxs = ref.hunks;
        else if (Array.isArray(ref.lines) && ref.lines.length === 2) {
          const [a, b] = ref.lines;
          idxs = f.hunks.filter((h) => h.newStart <= b && h.newStart + Math.max(h.newLines - 1, 0) >= a).map((h) => h.index);
        } else idxs = f.hunks.map((h) => h.index);
        if (!f.hunks.length) oldHunks.push({ file: f.path, hunk: null });
        for (const i of idxs) if (f.hunks[i]) oldHunks.push({ file: f.path, hunk: i });
      }
      const refs = new Map();
      let lost = 0;
      let reworked = 0;
      for (const h of oldHunks) {
        let ni = null;
        if (h.hunk == null) {
          const nf = newByPath.get(h.file);
          if (nf && !nf.hunks.length && nf.status === oldByPath.get(h.file).status) ni = 'file';
        } else if (hunkMap.has(`${h.file}#${h.hunk}`)) {
          ni = hunkMap.get(`${h.file}#${h.hunk}`);
        } else {
          // The hunk was edited: follow it to the new hunk covering the same
          // lines of the base file, if there is one.
          ni = reworkedHunk(oldByPath.get(h.file).hunks[h.hunk], newByPath.get(h.file), claimed);
          if (ni != null) reworked++;
        }
        if (ni == null) { lost++; continue; }
        if (!refs.has(h.file)) refs.set(h.file, []);
        if (ni !== 'file' && !refs.get(h.file).includes(ni)) refs.get(h.file).push(ni);
      }
      if (!refs.size) { removed.push(card); continue; }

      const next = JSON.parse(JSON.stringify(card));
      next.refs = [...refs].map(([file, hunks]) => (hunks.length ? { file, hunks } : { file }));
      const reasons = [];
      if (reworked) reasons.push(`${reworked} of its ${oldHunks.length} hunk(s) were edited`);
      if (lost) reasons.push(`${lost} of its ${oldHunks.length} hunk(s) were removed`);
      if (next.flow && Array.isArray(next.flow.nodes)) {
        for (const n of next.flow.nodes) {
          if (n && n.ref && !remapStep(n.ref, oldByPath, newByPath, hunkMap, sameBase)) {
            reasons.push(`flow step "${n.label}" points at code that changed`);
            delete n.ref;
          }
        }
      }
      delete next.carried;
      if (reasons.length || card.stale) {
        // A card the agent has not updated yet stays stale.
        next.stale = reasons.length ? `Changed since round ${round}: ${reasons.join('; ')}.` : card.stale;
        stale.push(next);
      } else {
        delete next.stale;
        next.carried = round;
        kept.push(next);
      }
      cards.push(next);
    }
    if (!cards.length) return { round: meta.round, carried: false, removed };

    const breakdown = { ...prevBreakdown, cards };
    if (breakdown.flow && Array.isArray(breakdown.flow.nodes)) {
      const ids = new Set(cards.map((c) => c.id));
      for (const n of breakdown.flow.nodes) if (n && n.card && !ids.has(n.card)) delete n.card;
    }
    fs.writeFileSync(path.join(dir, 'breakdown.json'), JSON.stringify(breakdown, null, 2));

    // Approvals stand for cards whose code is byte-for-byte the same.
    const approvals = {};
    for (const c of kept) {
      const st = prevFeedback && prevFeedback.cards && prevFeedback.cards[c.id];
      if (st && st.status === 'approved') approvals[c.id] = { status: 'approved', comment: '' };
    }
    if (Object.keys(approvals).length) {
      fs.writeFileSync(path.join(dir, 'feedback.json'), JSON.stringify({ version: 1, general: '', cards: approvals, decisions: {}, lines: [], updatedAt: new Date().toISOString() }, null, 2));
    }

    fs.writeFileSync(path.join(dir, 'refresh.md'), refreshNotes(round, kept, stale, removed));
    return { round: meta.round, carried: true, kept, stale, removed, approvals: Object.keys(approvals) };
  };
}

function refreshNotes(round, kept, stale, removed) {
  const out = [
    `# diffdeck: update the breakdown for round ${round + 1}`,
    '',
    `The code changed since round ${round}. \`breakdown.json\` was carried over from`,
    `that round (archived in \`rounds/${round}/\`), so only the parts below need work.`,
    '',
    '1. For each stale card, update `summary`, `why`, `risk`, `decisions` and `flow`',
    '   to match the new code, then delete its `"stale"` field.',
    '2. Put every hunk that `diffdeck validate` reports as uncovered into a fitting',
    '   card, or into a new card.',
    '3. Run `diffdeck validate` until it passes, then `diffdeck serve`.',
    '',
    'Do not rewrite cards that are not listed as stale: their code did not change.',
    '',
  ];
  out.push(`## Stale cards (${stale.length})`, '');
  out.push(stale.length ? stale.map((c) => `- \`${c.id}\` ${c.title}: ${c.stale}`).join('\n') : '_None._');
  out.push('', `## Removed cards (${removed.length})`, '');
  out.push(removed.length ? removed.map((c) => `- \`${c.id}\` ${c.title}: all of its code changed; describe the new code in a new card if needed`).join('\n') : '_None._');
  out.push('', `## Unchanged cards (${kept.length})`, '');
  out.push(kept.length ? kept.map((c) => `- \`${c.id}\` ${c.title}`).join('\n') : '_None._');
  out.push('');
  return out.join('\n');
}

function list(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'rounds')).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  } catch { return []; }
}

module.exports = { begin, list, mapHunks, mapLine, targetKey };
