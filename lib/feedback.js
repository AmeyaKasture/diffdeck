'use strict';

// Turns the UI's feedback state into feedback.md, the hand-off file that any
// coding agent reads to implement the review.

const { APPLY_TASK } = require('./agent');

function emptyFeedback() {
  return { version: 1, general: '', cards: {}, decisions: {}, lines: [] };
}

function sanitize(input) {
  const fb = emptyFeedback();
  if (!input || typeof input !== 'object') return fb;
  fb.general = String(input.general || '').slice(0, 20000);
  for (const [id, c] of Object.entries(input.cards || {})) {
    if (!c) continue;
    fb.cards[id] = {
      status: ['approved', 'changes'].includes(c.status) ? c.status : '',
      comment: String(c.comment || '').slice(0, 20000),
    };
  }
  for (const [key, d] of Object.entries(input.decisions || {})) {
    if (!d) continue;
    fb.decisions[key] = {
      preferred: Number.isInteger(d.preferred) ? d.preferred : -1,
      comment: String(d.comment || '').slice(0, 20000),
    };
  }
  fb.lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 2000).map((l) => ({
    id: String(l.id || ''),
    cardId: String(l.cardId || ''),
    file: String(l.file || ''),
    side: l.side === 'old' ? 'old' : 'new',
    line: Number(l.line) || 0,
    code: String(l.code || '').slice(0, 500),
    comment: String(l.comment || '').slice(0, 20000),
    kind: l.kind === 'question' ? 'question' : 'change',
  })).filter((l) => l.comment.trim());
  fb.updatedAt = new Date().toISOString();
  return fb;
}

// replies.json is written by the agent: { "<comment id>": "answer" } or a list
// of answers. It is a separate file so the page never overwrites it.
function sanitizeReplies(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [id, v] of Object.entries(input)) {
    const list = (Array.isArray(v) ? v : [v]).map((r) => (typeof r === 'string' ? { text: r } : r && typeof r === 'object' ? { text: String(r.text || ''), at: r.at ? String(r.at) : undefined } : null))
      .filter((r) => r && r.text.trim()).map((r) => ({ ...r, text: r.text.slice(0, 20000) }));
    if (list.length) out[String(id)] = list;
  }
  return out;
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : '');

function quote(text) {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

// Returns { markdown, actionable } for the given cards and feedback.
function lineItem(l, replies) {
  const answers = replies[l.id] || [];
  return [
    `- **\`${l.file}:${l.line}\`** (${l.side === 'old' ? 'removed line, numbered in the old version' : 'line in the new version'}; comment id \`${l.id}\`):`,
    l.code.trim() ? `  \`${l.code.trim().replace(/`/g, "'")}\`` : null,
    `  ${l.comment.trim().replace(/\n/g, '\n  ')}`,
    ...answers.map((r) => `  - Agent replied: ${r.text.trim().replace(/\n/g, '\n    ')}`),
  ].filter(Boolean).join('\n');
}

function render(meta, cards, fb, replies = {}) {
  const out = [];
  let actionable = 0;
  const approved = [];
  const questions = [];

  out.push(`# Review feedback — ${meta.title || meta.label}`);
  out.push('');
  out.push(`- Source: ${meta.label}${meta.url ? ` (${meta.url})` : ''}`);
  if (meta.base) out.push(`- Base: \`${meta.base}\`${meta.baseSha && short(meta.baseSha) !== meta.base ? ` @ \`${short(meta.baseSha)}\`` : ''}`);
  if (meta.head || meta.branch) out.push(`- Head: ${meta.branch && meta.branch !== 'HEAD' ? `\`${meta.branch}\` ` : ''}${meta.head ? `@ \`${meta.head}\`` : ''}`.trim());
  if (meta.round > 1) out.push(`- Round: ${meta.round}${meta.previousRound ? ` (earlier rounds are archived in \`.diffdeck/rounds/\`)` : ''}`);
  out.push(`- Updated: ${fb.updatedAt || new Date().toISOString()}`);
  out.push('');

  if (fb.general.trim()) {
    out.push('## Overall comments', '', quote(fb.general), '');
    actionable++;
  }

  const sections = [];
  for (const card of cards) {
    const c = fb.cards[card.id] || {};
    const items = [];

    (card.decisions || []).forEach((d, di) => {
      const df = fb.decisions[`${card.id}::${di}`];
      if (!df) return;
      const alt = df.preferred >= 0 ? d.alternatives[df.preferred] : null;
      if (alt) {
        const lines = [
          `- **Change design decision:** ${d.question}`,
          `  - Current: **${d.chosen.label}** — ${d.chosen.description}`,
          `  - Switch to: **${alt.label}** — ${alt.description}`,
        ];
        if (alt.pros.length) lines.push(`  - Expected benefits: ${alt.pros.join('; ')}`);
        if (alt.cons.length) lines.push(`  - Accepted trade-offs: ${alt.cons.join('; ')}`);
        if (df.comment.trim()) lines.push(`  - Reviewer note: ${df.comment.trim().replace(/\n/g, ' ')}`);
        items.push(lines.join('\n'));
      } else if (df.comment.trim()) {
        items.push(`- **On decision "${d.question}"** (keep **${d.chosen.label}**): ${df.comment.trim().replace(/\n/g, ' ')}`);
      }
    });

    const lineNotes = fb.lines.filter((l) => l.cardId === card.id);
    for (const l of lineNotes) {
      const text = lineItem(l, replies);
      if (l.kind === 'question') questions.push({ card, text });
      else items.push(text);
    }

    if (c.comment && c.comment.trim()) items.push(`- **Card comment:** ${c.comment.trim().replace(/\n/g, '\n  ')}`);

    if (items.length || c.status === 'changes') {
      const files = [...new Set(card.hunks.map((h) => h.file))];
      sections.push([
        `### ${card.title}  \`${card.id}\``,
        `Files: ${files.map((f) => `\`${f}\``).join(', ')}`,
        '',
        items.length ? items.join('\n') : '- Reviewer marked this card as needing changes without details; ask what they want.',
        '',
      ].join('\n'));
      actionable += Math.max(items.length, 1);
    } else if (c.status === 'approved') {
      approved.push(`- ${card.title} \`${card.id}\``);
    }
  }

  // Line comments whose card no longer exists (breakdown regenerated).
  const known = new Set(cards.map((c) => c.id));
  const orphans = fb.lines.filter((l) => !known.has(l.cardId));
  const orphanChanges = orphans.filter((l) => l.kind !== 'question');
  for (const l of orphans) if (l.kind === 'question') questions.push({ card: null, text: lineItem(l, replies) });
  if (orphanChanges.length) {
    sections.push(['### Other line comments', '', ...orphanChanges.map((l) => lineItem(l, replies)), ''].join('\n'));
    actionable += orphanChanges.length;
  }

  out.push(`## Requested changes (${actionable ? sections.length : 0} card${sections.length === 1 ? '' : 's'})`, '');
  out.push(sections.length ? sections.join('\n') : '_None._\n');
  if (questions.length) {
    out.push(`## Questions (${questions.length})`, '');
    out.push('Answer these in `.diffdeck/replies.json` as `{ "<comment id>": "<answer>" }`. Do not change code for a question unless it also asks for a change.', '');
    let last;
    for (const q of questions) {
      const head = q.card ? `### ${q.card.title}  \`${q.card.id}\`` : '### Other questions';
      if (head !== last) { out.push(head, ''); last = head; }
      out.push(q.text);
    }
    out.push('');
  }
  out.push('## Approved — do not change', '');
  out.push(approved.length ? approved.join('\n') : '_None._');
  out.push('');
  out.push('---', '', APPLY_TASK.replace(/^# .*\n/, '## Instructions for the implementing agent\n'));

  return { markdown: out.join('\n'), actionable, questions: questions.length };
}

module.exports = { emptyFeedback, sanitize, sanitizeReplies, render };
