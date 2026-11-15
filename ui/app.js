'use strict';

/* diffdeck UI: vanilla JS, no build step. Server API: GET /api/state,
   GET /api/version, POST /api/feedback. */

const S = {
  data: null,
  fb: null,
  filter: { status: 'all', kind: 'all', q: '' },
  openId: null,
  openOpt: {},          // "cardId::decisionIdx" -> option index being viewed (-1 = current)
  fullFiles: false,
  composer: null,       // { key, file, side, line, code, editId }
  markdown: '',
  actionable: 0,
  saveTimer: null,
  view: (() => { try { return localStorage.getItem('diffdeck.view') || 'flow'; } catch { return 'flow'; } })(),
  sheetTab: 'diff',     // 'flow' | 'diff' inside a card
  focus: null,          // { file, side, a, b, label } lines highlighted from a flow step
  pendingScroll: false,
  flashDecision: null,
  walk: null,           // index into walkthrough order
  vps: {},              // live Viewport per diagram name
  vpState: {},          // saved pan/zoom per diagram name: { key, k, x, y }
};

const $ = (sel, root = document) => root.querySelector(sel);

const ICON = {
  check: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
  alert: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 11h.01"/></svg>',
  dot: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2.4"/></svg>',
  chev: '<svg class="chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  left: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8 10 12.5"/></svg>',
  right: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  fork: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="3.5" r="1.6"/><circle cx="12" cy="3.5" r="1.6"/><circle cx="8" cy="12.5" r="1.6"/><path d="M4 5.1v1.4c0 1.4 1 2 2.2 2.4L8 9.5l1.8-.6C11 8.5 12 7.9 12 6.5V5.1M8 9.5v1.4"/></svg>',
  chat: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#9AA0A8" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="8.5" height="8.5" rx="2"/><path d="M3 10.5V4a1.5 1.5 0 011.5-1.5H11"/></svg>',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const kindVar = (k) => `--kind: var(--k-${esc(k || 'chore')})`;

/* ---------------- data helpers ---------------- */

function fileByPath(p) {
  return S.data.files.find((f) => f.path === p);
}

function cardStats(card) {
  let add = 0, del = 0;
  const files = [];
  for (const h of card.hunks) {
    if (!files.includes(h.file)) files.push(h.file);
    const f = fileByPath(h.file);
    const hk = f && h.hunk != null ? f.hunks[h.hunk] : null;
    if (hk) { add += hk.additions; del += hk.deletions; }
  }
  return { add, del, files };
}

function cardStatus(id) {
  return (S.fb.cards[id] && S.fb.cards[id].status) || '';
}

function switchedCount(card) {
  return card.decisions.filter((_, i) => {
    const d = S.fb.decisions[`${card.id}::${i}`];
    return d && d.preferred >= 0;
  }).length;
}

function lineCommentCount(card) {
  return S.fb.lines.filter((l) => l.cardId === card.id).length;
}

function visibleCards() {
  const { status, kind, q } = S.filter;
  const needle = q.trim().toLowerCase();
  return S.data.cards.filter((c) => {
    const st = cardStatus(c.id);
    if (status === 'todo' && st) return false;
    if (status === 'changes' && st !== 'changes') return false;
    if (status === 'approved' && st !== 'approved') return false;
    if (kind !== 'all' && c.kind !== kind) return false;
    if (needle) {
      const hay = [c.title, c.summary, c.why, ...c.hunks.map((h) => h.file), ...c.decisions.map((d) => d.question)].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/* ---------------- syntax + intra-line highlighting ---------------- */

const KW = 'abstract|as|async|await|break|case|catch|chan|class|const|continue|def|default|defer|del|do|elif|else|enum|except|export|extends|false|final|finally|fn|for|from|func|function|go|if|impl|implements|import|in|instanceof|interface|lambda|let|match|mod|mut|new|nil|None|null|package|pass|private|protected|pub|public|raise|range|return|select|self|static|struct|super|switch|this|throw|throws|trait|True|False|true|try|type|typeof|undefined|use|val|var|void|where|while|with|yield';
const HASH_LANGS = /\.(py|sh|bash|zsh|rb|ya?ml|toml|r|pl|conf|cfg|ini|mk)$|(^|\/)(Makefile|Dockerfile|\.gitignore|\.env[^/]*)$/i;
const DASH_LANGS = /\.(sql|lua|hs)$/i;
const NO_HL = /\.(md|mdx|txt|rst|json|lock|csv|svg|html?)$/i;
const reCache = new Map();

function tokenRe(path) {
  const mode = NO_HL.test(path) ? 'none' : HASH_LANGS.test(path) ? 'hash' : DASH_LANGS.test(path) ? 'dash' : 'slash';
  if (reCache.has(mode)) return reCache.get(mode);
  let re = null;
  if (mode !== 'none') {
    const com = mode === 'hash' ? '#.*$' : mode === 'dash' ? '--.*$' : '\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$)';
    re = new RegExp(`(${com})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.){0,200}'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d[\\d_.]*[a-fA-FxXnLlUu]*)\\b|\\b(${KW})\\b`, 'g');
  }
  reCache.set(mode, re);
  return re;
}

function highlight(text, re) {
  if (!re || text.length > 2000) return esc(text);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index));
    const cls = m[1] ? 't-com' : m[2] ? 't-str' : m[3] ? 't-num' : 't-kw';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// Pairs adjacent removed/added runs and returns the changed middle span per line.
function intraLine(lines) {
  const spans = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t !== 'del') { i++; continue; }
    const delStart = i;
    while (i < lines.length && lines[i].t === 'del') i++;
    const addStart = i;
    while (i < lines.length && lines[i].t === 'add') i++;
    const dels = lines.slice(delStart, addStart);
    const adds = lines.slice(addStart, i);
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const a = dels[k].s, b = adds[k].s;
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let s = 0;
      while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
      if (p + s === 0) continue; // fully different: no point marking
      spans.set(dels[k], [p, a.length - s]);
      spans.set(adds[k], [p, b.length - s]);
    }
  }
  return spans;
}

function renderCode(text, re, span) {
  if (!span || span[0] >= span[1]) return highlight(text, re) || ' ';
  return highlight(text.slice(0, span[0]), re) + '<mark>' + highlight(text.slice(span[0], span[1]), re) + '</mark>' + highlight(text.slice(span[1]), re);
}

/* ---------------- diagrams ---------------- */

const CHANGE_TAG = { added: 'NEW', modified: 'CHANGED', removed: 'REMOVED' };
const TYPE_ICON = {
  actor: '<path d="M0,-4.5a3,3 0 1,0 0.01,0M-5.5,6.5c0-3.5 2.5-5.5 5.5-5.5s5.5,2 5.5,5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  service: '<path d="M-5.5,3.5h10a3,3 0 0,0 -0.5,-6a4.2,4.2 0 0,0 -8,-0.6a3.2,3.2 0 0,0 -1.5,6.6z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  external: '<path d="M-5,-5h10v10h-10z M-5,-1h10" fill="none" stroke="currentColor" stroke-width="1.3"/>',
};

function overviewModel() {
  const d = S.data;
  const flow = d.breakdown && d.breakdown.flow;
  if (flow) {
    return {
      dir: flow.direction || 'LR', derived: false,
      nodes: flow.nodes.map((n) => ({ ...n, change: n.change || 'unchanged' })),
      edges: flow.edges.map((e) => ({ ...e, change: e.change || 'unchanged' })),
    };
  }
  const nodes = [];
  const edges = [];
  const fileChange = (f) => (!f ? 'modified' : f.status === 'added' ? 'added' : f.status === 'deleted' ? 'removed' : 'modified');
  if (d.breakdown) {
    // Cards on the left, the files they touch on the right.
    for (const c of d.cards) {
      nodes.push({ id: `card:${c.id}`, label: c.title, sub: c.kind, type: 'component', change: 'modified', card: c.id });
      for (const h of c.hunks) {
        const fid = `file:${h.file}`;
        if (!nodes.some((n) => n.id === fid)) {
          const slash = h.file.lastIndexOf('/');
          nodes.push({ id: fid, label: h.file.slice(slash + 1), sub: slash > 0 ? h.file.slice(0, slash) : '', type: 'data', change: fileChange(fileByPath(h.file)) });
        }
        if (!edges.some((e) => e.from === `card:${c.id}` && e.to === fid)) edges.push({ from: `card:${c.id}`, to: fid, change: 'unchanged', label: '' });
      }
    }
  } else {
    // Directory tree of changed files.
    for (const c of d.cards) {
      const f = fileByPath(c.hunks[0].file);
      const did = `dir:${c.group}`;
      if (!nodes.some((n) => n.id === did)) nodes.push({ id: did, label: c.group, type: 'external', change: 'unchanged' });
      nodes.push({ id: `card:${c.id}`, label: c.title, sub: f ? `+${f.additions} −${f.deletions}` : '', type: 'component', change: fileChange(f), card: c.id });
      edges.push({ from: did, to: `card:${c.id}`, change: 'unchanged' });
    }
  }
  return { dir: 'LR', derived: true, nodes, edges };
}

function textBlock(n) {
  const lh = 17, slh = 14.5;
  const total = n.lines.length * lh + (n.subLines.length ? n.subLines.length * slh + 3 : 0);
  let y = n.y - total / 2 + 12.5;
  let out = '';
  for (const l of n.lines) { out += `<text class="nl" x="${n.x}" y="${y}">${esc(l)}</text>`; y += lh; }
  y += 3;
  for (const l of n.subLines) { out += `<text class="ns" x="${n.x}" y="${y - 2}">${esc(l)}</text>`; y += slh; }
  return out;
}

function chip(x, y, text, cls) {
  const w = text.length * 6 + 12;
  return `<g class="chip ${cls}" transform="translate(${x - w},${y})"><rect width="${w}" height="16" rx="8"/><text x="${w / 2}" y="11.5">${esc(text)}</text></g>`;
}

function decisionChipText(card, i) {
  const d = card.decisions[i];
  if (!d) return '';
  const df = S.fb.decisions[`${card.id}::${i}`];
  const alt = df && df.preferred >= 0 ? d.alternatives[df.preferred] : null;
  return alt ? `→ ${alt.label}` : `◇ ${d.alternatives.length + 1} options`;
}

function nodeSvg(n, mode, card) {
  const w = n.dw || n.w, h = n.h, x = n.x - w / 2, y = n.y - h / 2;
  let shape;
  if (n.shape === 'pill') shape = `<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
  else if (n.shape === 'diamond') shape = `<polygon class="shape" points="${n.x},${y} ${x + w},${n.y} ${n.x},${y + h} ${x},${n.y}"/>`;
  else if (n.shape === 'io') shape = `<polygon class="shape" points="${x + 12},${y} ${x + w},${y} ${x + w - 12},${y + h} ${x},${y + h}"/>`;
  else if (n.type === 'data') shape = `<path class="shape" d="M${x},${y + 7} L${x},${y + h - 7} A${w / 2},7 0 0 0 ${x + w},${y + h - 7} L${x + w},${y + 7} Z"/><ellipse class="shape" cx="${n.x}" cy="${y + 7}" rx="${w / 2}" ry="7"/>`;
  else shape = `<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>`;

  let extras = '';
  const tag = CHANGE_TAG[n.change];
  if (tag) extras += chip(x + w - 4, y - 9, tag, `c-${n.change}`);
  if (mode === 'system' && n.card) {
    const ci = S.data.cards.findIndex((c) => c.id === n.card);
    if (ci >= 0) {
      const st = cardStatus(n.card);
      extras += `<g class="num" transform="translate(${x + 6},${y - 9})"><rect width="24" height="16" rx="5"/><text x="12" y="11.5">${pad2(ci + 1)}</text></g>`;
      if (st) extras += `<g class="stat-dot ${st}" transform="translate(${x + w},${y + h})"><circle r="8"/><text y="3.6">${st === 'approved' ? '✓' : '!'}</text></g>`;
      const k = S.data.cards[ci].kind;
      if (n.shape === 'box' && n.type !== 'data') extras += `<rect class="kind-strip" x="${x}" y="${y + 8}" width="3" height="${h - 16}" rx="1.5" style="fill:var(--k-${esc(k)})"/>`;
    }
  }
  if (n.type && TYPE_ICON[n.type]) extras += `<g class="ticon" transform="translate(${x + 14},${y + 14})">${TYPE_ICON[n.type]}</g>`;
  if (mode === 'logic' && Number.isInteger(n.decision) && card && card.decisions[n.decision]) {
    const d = card.decisions[n.decision];
    const df = S.fb.decisions[`${card.id}::${n.decision}`];
    const alt = df && df.preferred >= 0 ? d.alternatives[df.preferred] : null;
    const text = decisionChipText(card, n.decision);
    extras += chip(x + w + 8 + (text.length * 6 + 12), n.y - 8, text, alt ? 'c-pref' : 'c-opt');
  }
  if (mode === 'logic' && n.ref) extras += `<g class="codeicon" transform="translate(${x + w - (n.shape === 'diamond' ? w / 2 - 6 : 14)},${y + (n.shape === 'diamond' ? 12 : h / 2)})"><text>‹›</text></g>`;

  const clickable = mode === 'system' ? !!n.card : !!(n.ref || Number.isInteger(n.decision));
  return `<g class="gnode ch-${esc(n.change || 'unchanged')} sh-${n.shape} ty-${esc(n.type || 'none')}${clickable ? ' clickable' : ''}" data-act="gnode" data-node="${esc(n.id)}" tabindex="${clickable ? 0 : -1}" role="${clickable ? 'button' : 'img'}" aria-label="${esc(n.label)}">${shape}${textBlock(n)}${extras}</g>`;
}

function edgeSvg(e) {
  const ch = e.change || 'unchanged';
  let label = '';
  if (e.label) {
    const w = e.label.length * 6.1 + 12;
    label = `<g class="elabel"><rect x="${e.labelPos.x - w / 2}" y="${e.labelPos.y - 9}" width="${w}" height="18" rx="9"/><text x="${e.labelPos.x}" y="${e.labelPos.y + 4}">${esc(e.label)}</text></g>`;
  }
  return `<g class="gedge ch-${esc(ch)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><path d="${e.d}" marker-end="url(#ar-${esc(ch)})"/>${label}</g>`;
}

const MARKERS = ['unchanged', 'added', 'modified', 'removed', 'lit'].map((c) =>
  `<marker id="ar-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ar ar-${c}" d="M0,1 L9,5 L0,9 z"/></marker>`).join('');

function layoutDiagram(model, mode, chipFor) {
  const nodes = model.nodes.map((n) => {
    const shape = mode === 'logic' ? ({ start: 'pill', end: 'pill', decision: 'diamond', io: 'io' }[n.shape] || 'box') : n.type === 'actor' ? 'pill' : 'box';
    const m = Graph.measure(n.label, n.sub, shape, mode === 'logic' ? 22 : 22);
    const padW = mode === 'system' && n.type && TYPE_ICON[n.type] ? 20 : 0;
    // Decision chips sit to the right of the node; reserve that space on both sides so it stays centred.
    const dec = mode === 'logic' && Number.isInteger(n.decision) && chipFor ? chipFor(n) : '';
    const reserve = dec ? (dec.length * 6 + 20) * 2 : 0;
    return { ...n, shape, dw: m.w + padW, w: m.w + padW + reserve, h: m.h + (n.type === 'data' ? 12 : 0) + (mode === 'system' ? 6 : 0), lines: m.lines, subLines: m.subLines };
  });
  const lay = Graph.layout(nodes, model.edges, {
    dir: model.dir || 'TB',
    rankGap: mode === 'logic' ? 56 : 140,
    nodeGap: mode === 'logic' ? 34 : 30,
    pad: 34,
  });
  return lay;
}

function diagramHtml(name, model, mode, card, extraTools = '') {
  const lay = layoutDiagram(model, mode, card ? (n) => decisionChipText(card, n.decision) : null);
  S[`lay_${name}`] = lay;
  const legend = `
    <div class="legend">
      <span><i class="lg ch-added"></i>Added</span><span><i class="lg ch-modified"></i>Changed</span>
      <span><i class="lg ch-removed"></i>Removed</span><span><i class="lg ch-unchanged"></i>Unchanged</span>
    </div>`;
  return `
    <div class="canvas ${mode === 'logic' ? 'fill' : ''}" data-canvas="${name}">
      <svg class="gsvg" data-svg="${name}" role="img" aria-label="${mode === 'logic' ? 'Logic flowchart' : 'System flow diagram'}">
        <defs>${MARKERS}</defs>
        <g data-viewport>
          <g class="edges">${lay.edges.map(edgeSvg).join('')}</g>
          <g class="nodes">${lay.nodes.map((n) => nodeSvg(n, mode, card)).join('')}</g>
        </g>
      </svg>
      <div class="canvas-tools">
        ${extraTools}
        <div class="zoom">
          <button class="btn btn-icon btn-ghost" data-act="zoom" data-name="${name}" data-v="out" aria-label="Zoom out">−</button>
          <button class="btn btn-icon btn-ghost" data-act="zoom" data-name="${name}" data-v="fit" aria-label="Fit to screen">⤢</button>
          <button class="btn btn-icon btn-ghost" data-act="zoom" data-name="${name}" data-v="in" aria-label="Zoom in">+</button>
        </div>
      </div>
      ${legend}
      <div class="gtip" hidden></div>
      <div class="walkbar" hidden></div>
    </div>`;
}

function saveVp(name) {
  const vp = S.vps[name];
  if (vp && vp.svg.isConnected) S.vpState[name] = { key: vp.key, k: vp.k, x: vp.x, y: vp.y };
}

function mountDiagram(name, key, opts = {}) {
  const svg = document.querySelector(`[data-svg="${name}"]`);
  if (!svg) return;
  const lay = S[`lay_${name}`];
  const vp = new Graph.Viewport(svg, lay.width, lay.height, opts);
  vp.key = key;
  const saved = S.vpState[name];
  if (saved && saved.key === key) { vp.k = saved.k; vp.x = saved.x; vp.y = saved.y; vp.apply(); }
  S.vps[name] = vp;
  placeLabels(svg, lay);

  const canvas = svg.closest('.canvas');
  const tip = canvas.querySelector('.gtip');
  svg.querySelectorAll('.gnode').forEach((g) => {
    g.addEventListener('mouseenter', (e) => { if (S.walk == null || name !== 'overview') lightUp(svg, g.dataset.node); showTip(name, g.dataset.node, tip, canvas, e); });
    g.addEventListener('mousemove', (e) => placeTip(tip, canvas, e));
    g.addEventListener('mouseleave', () => { if (S.walk == null || name !== 'overview') lightUp(svg, null); tip.hidden = true; });
    g.addEventListener('focus', () => lightUp(svg, g.dataset.node));
    g.addEventListener('blur', () => lightUp(svg, null));
  });
}

// Slide each edge label along its own path until it clears nodes and other labels.
function placeLabels(svg, lay) {
  const boxes = lay.nodes.map((n) => ({ x: n.x - (n.dw || n.w) / 2 - 4, y: n.y - n.h / 2 - 12, w: (n.dw || n.w) + 8, h: n.h + 16 }));
  const hit = (a) => boxes.some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
  const ts = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  svg.querySelectorAll('.gedge').forEach((g) => {
    const label = g.querySelector('.elabel');
    if (!label) return;
    const path = g.querySelector('path');
    const rect = label.querySelector('rect');
    const text = label.querySelector('text');
    const w = Number(rect.getAttribute('width'));
    let len = 0;
    try { len = path.getTotalLength(); } catch { return; }
    let chosen = null;
    for (const t of ts) {
      const p = path.getPointAtLength(len * t);
      const box = { x: p.x - w / 2, y: p.y - 9, w, h: 18 };
      if (!hit(box)) { chosen = box; break; }
    }
    if (!chosen) { const p = path.getPointAtLength(len / 2); chosen = { x: p.x - w / 2, y: p.y - 9, w, h: 18 }; }
    boxes.push(chosen);
    rect.setAttribute('x', chosen.x);
    rect.setAttribute('y', chosen.y);
    text.setAttribute('x', chosen.x + w / 2);
    text.setAttribute('y', chosen.y + 13);
  });
}

function lightUp(svg, id) {
  svg.classList.toggle('focusing', !!id);
  svg.querySelectorAll('.lit').forEach((el) => el.classList.remove('lit'));
  if (!id) return;
  const ids = new Set([id]);
  svg.querySelectorAll('.gedge').forEach((e) => {
    if (e.dataset.from === id || e.dataset.to === id) {
      e.classList.add('lit');
      ids.add(e.dataset.from); ids.add(e.dataset.to);
    }
  });
  svg.querySelectorAll('.gnode').forEach((n) => { if (ids.has(n.dataset.node)) n.classList.add('lit'); });
}

function placeTip(tip, canvas, e) {
  const r = canvas.getBoundingClientRect();
  let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16;
  if (x + 300 > r.width) x = e.clientX - r.left - 316;
  if (y + tip.offsetHeight > r.height) y = e.clientY - r.top - tip.offsetHeight - 12;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function showTip(name, id, tip, canvas, e) {
  const lay = S[`lay_${name}`];
  const n = lay.nodes.find((x) => x.id === id);
  if (!n) return;
  let html = '';
  if (name === 'overview') {
    const card = n.card && S.data.cards.find((c) => c.id === n.card);
    if (!card) { if (!n.sub) return; html = `<b>${esc(n.label)}</b><p>${esc(n.sub)}</p>`; } else {
      const { add, del, files } = cardStats(card);
      html = `<div class="tip-top"><span class="kind" style="${kindVar(card.kind)}">${esc(card.kind)}</span><span class="risk ${esc(card.risk)}">${esc(card.risk)} risk</span></div>
        <b>${esc(card.title)}</b><p>${esc(card.summary.length > 220 ? card.summary.slice(0, 220) + '…' : card.summary)}</p>
        <div class="tip-foot"><span class="churn"><span class="add">+${add}</span><span class="del">−${del}</span></span><span>${files.length} file${files.length > 1 ? 's' : ''}</span>${card.decisions.length ? `<span>${card.decisions.length} decision${card.decisions.length > 1 ? 's' : ''}</span>` : ''}<span class="go">Click to open →</span></div>`;
    }
  } else {
    const card = S.data.cards.find((c) => c.id === S.openId);
    const bits = [];
    if (Number.isInteger(n.decision) && card && card.decisions[n.decision]) bits.push(`<p><b>Design decision:</b> ${esc(card.decisions[n.decision].question)}</p><div class="tip-foot"><span class="go">Click to compare alternatives →</span></div>`);
    else if (n.ref) bits.push(`<p class="mono">${esc(n.ref.file)}:${n.ref.lines[0]}–${n.ref.lines[1]}</p><div class="tip-foot"><span class="go">Click to see the code →</span></div>`);
    if (!bits.length) return;
    html = `<b>${esc(n.label)}</b>${CHANGE_TAG[n.change] ? ` <span class="chip-inline c-${esc(n.change)}">${CHANGE_TAG[n.change]}</span>` : ''}${bits.join('')}`;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  placeTip(tip, canvas, e);
}

function walkOrder() {
  const lay = S.lay_overview;
  if (!lay) return [];
  return S.data.cards.map((c) => lay.nodes.find((n) => n.card === c.id)).filter(Boolean);
}

function renderWalk() {
  const canvas = document.querySelector('[data-canvas="overview"]');
  if (!canvas) return;
  const bar = canvas.querySelector('.walkbar');
  const svg = canvas.querySelector('svg');
  const order = walkOrder();
  if (S.walk == null || !order.length) { bar.hidden = true; lightUp(svg, null); svg.querySelectorAll('.pulse').forEach((x) => x.classList.remove('pulse')); return; }
  const n = order[S.walk];
  const card = S.data.cards.find((c) => c.id === n.card);
  lightUp(svg, n.id);
  svg.querySelectorAll('.pulse').forEach((x) => x.classList.remove('pulse'));
  const g = svg.querySelector(`.gnode[data-node="${CSS.escape(n.id)}"]`);
  if (g) g.classList.add('pulse');
  S.vps.overview.centerOn(n.x, n.y);
  bar.innerHTML = `
    <div class="wb-step">${S.walk + 1}<span>/${order.length}</span></div>
    <div class="wb-body"><div class="wb-title"><span class="kind" style="${kindVar(card.kind)}">${esc(card.kind)}</span> ${esc(card.title)}</div><div class="wb-sum">${esc(card.summary)}</div></div>
    <div class="wb-actions">
      <button class="btn btn-icon btn-ghost" data-act="walk" data-v="prev" ${S.walk === 0 ? 'disabled' : ''} aria-label="Previous">${ICON.left}</button>
      <button class="btn btn-sm btn-primary" data-act="open" data-id="${esc(card.id)}">Open card</button>
      <button class="btn btn-icon btn-ghost" data-act="walk" data-v="next" ${S.walk === order.length - 1 ? 'disabled' : ''} aria-label="Next">${ICON.right}</button>
      <button class="btn btn-icon btn-ghost" data-act="walk" data-v="stop" aria-label="End walkthrough">${ICON.close}</button>
    </div>`;
  bar.hidden = false;
}

function renderOverview() {
  const model = overviewModel();
  if (!model.nodes.length) return `<div class="empty">Nothing to draw: the diff is empty.</div>`;
  const tools = `<button class="btn btn-sm" data-act="walk" data-v="start">▶ Walk through</button>`;
  return diagramHtml('overview', model, 'system', null, tools);
}

function onDiagramNode(name, id) {
  const lay = S[`lay_${name}`];
  const n = lay && lay.nodes.find((x) => x.id === id);
  if (!n) return;
  if (name === 'overview') { if (n.card) openCard(n.card); return; }
  const card = S.data.cards.find((c) => c.id === S.openId);
  if (Number.isInteger(n.decision) && card.decisions[n.decision]) {
    const key = `${card.id}::${n.decision}`;
    const df = S.fb.decisions[key];
    S.openOpt[key] = df && df.preferred >= 0 ? df.preferred : card.decisions[n.decision].alternatives.length ? 0 : -1;
    S.flashDecision = n.decision;
    renderSheet();
    return;
  }
  if (n.ref) focusLines(card, { file: n.ref.file, side: n.ref.side === 'old' ? 'old' : 'new', a: n.ref.lines[0], b: n.ref.lines[1], label: n.label });
}

function focusLines(card, focus) {
  const f = fileByPath(focus.file);
  if (!f) { toast('That file is not part of the diff'); return; }
  const inHunk = (h) => h.lines.some((l) => { const num = focus.side === 'old' ? l.o : l.n; return num != null && num >= focus.a && num <= focus.b && (focus.side === 'old' ? l.t !== 'add' : l.t !== 'del'); });
  const cardHunks = card.hunks.filter((h) => h.file === focus.file && h.hunk != null).map((h) => h.hunk);
  const inCard = f.hunks.some((h) => cardHunks.includes(h.index) && inHunk(h));
  const anywhere = f.hunks.some(inHunk);
  if (!anywhere) toast(`Lines ${focus.a}–${focus.b} are unchanged, so they are not in the diff`);
  if (!inCard && anywhere) S.fullFiles = true;
  if (!card.hunks.some((h) => h.file === focus.file)) S.fullFiles = true;
  S.focus = focus;
  S.sheetTab = 'diff';
  S.pendingScroll = true;
  renderSheet();
}

/* ---------------- page ---------------- */

function renderTopbar() {
  const { meta, cards } = S.data;
  $('#source-chip').textContent = `${meta.repo} · ${meta.label}`;
  const ok = cards.filter((c) => cardStatus(c.id) === 'approved').length;
  const ch = cards.filter((c) => cardStatus(c.id) === 'changes').length;
  const total = cards.length || 1;
  $('#progress').innerHTML = `
    <div class="progress-track"><span class="p-ok" style="width:${(ok / total) * 100}%"></span><span class="p-ch" style="width:${(ch / total) * 100}%"></span></div>
    <span>${ok + ch}/${cards.length} reviewed</span>`;
  const badge = $('#handoff-count');
  badge.hidden = !S.actionable;
  badge.textContent = S.actionable;
}

function renderHero() {
  const { meta, files, breakdown, cards } = S.data;
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const decisions = cards.reduce((n, c) => n + c.decisions.length, 0);
  const title = (breakdown && breakdown.title) || meta.title || meta.label;
  const summary = (breakdown && breakdown.summary) || meta.description || '';
  const metaBits = [];
  if (meta.branch) metaBits.push(`${ICON.fork} <b>${esc(meta.branch)}</b>${meta.base ? ` → ${esc(meta.base)}` : ''}`);
  if (meta.head) metaBits.push(`at <b class="mono">${esc(meta.head)}</b>`);
  if (meta.author) metaBits.push(`by <b>${esc(meta.author)}</b>`);
  if (meta.url) metaBits.push(`<a href="${esc(meta.url)}" target="_blank" rel="noopener">Open on GitHub ↗</a>`);
  metaBits.push(`prepared ${esc(new Date(meta.generatedAt).toLocaleString())}`);

  return `
    <section class="hero">
      <div>
        <div class="eyebrow">${esc(meta.label)}</div>
        <h1>${esc(title)}</h1>
        ${summary ? `<p>${esc(summary.length > 600 ? summary.slice(0, 600) + '…' : summary)}</p>` : ''}
        <div class="hero-meta">${metaBits.map((b) => `<span>${b}</span>`).join('')}</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${cards.length}</div><div class="l">cards</div></div>
        <div class="stat"><div class="v">${decisions}</div><div class="l">decisions</div></div>
        <div class="stat"><div class="v">${files.length}</div><div class="l">files</div></div>
        <div class="stat"><div class="v"><span class="add">+${add}</span> <span class="del">−${del}</span></div><div class="l">lines</div></div>
      </div>
    </section>`;
}

function renderCallouts() {
  const d = S.data;
  const out = [];
  if (d.errors.length) {
    out.push(`<div class="callout error">${ICON.alert}<div class="callout-body"><b>The agent's breakdown has problems</b>, so cards are shown per file instead. Ask the agent to run <code>diffdeck validate</code> and fix:
      <ul>${d.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>`);
  } else if (!d.breakdown) {
    out.push(`<div class="callout">${ICON.alert}<div class="callout-body"><b>No breakdown yet — showing one card per file.</b> For cards grouped by intent, with design decisions and their trade-offs, ask your agent:
      <code>/diffdeck-breakdown</code> or “follow .diffdeck/AGENT_TASK.md”. This page refreshes automatically when the breakdown lands.</div>
      <button class="btn btn-sm" data-act="copy" data-text="Follow .diffdeck/AGENT_TASK.md">${ICON.copy} Copy prompt</button></div>`);
  } else if (!d.breakdown.flow) {
    out.push(`<div class="callout">${ICON.fork}<div class="callout-body"><b>No system flow in this breakdown.</b> The diagram below links cards to files. Ask your agent to add <code>flow</code> (and <code>flow</code> per card) as described in <code>.diffdeck/AGENT_TASK.md</code> for an architecture and logic view.</div></div>`);
  } else if (d.breakdown.reviewOrder) {
    out.push(`<div class="callout">${ICON.fork}<div class="callout-body"><b>Suggested reading order.</b> ${esc(d.breakdown.reviewOrder)}</div></div>`);
  }
  if (d.files.length === 0) {
    out.push(`<div class="callout warn">${ICON.alert}<div class="callout-body">The prepared diff is empty. Run <code>diffdeck prepare &lt;base&gt;</code> or <code>diffdeck prepare --pr &lt;n&gt;</code>.</div></div>`);
  }
  if (d.meta.untracked && d.meta.untracked.length) {
    out.push(`<div class="callout warn">${ICON.alert}<div class="callout-body">${d.meta.untracked.length} untracked file(s) are not in this diff. Use <code>git add -N &lt;file&gt;</code> and prepare again to include them.</div></div>`);
  }
  return out.join('');
}

function renderToolbar() {
  const cards = S.data.cards;
  const count = (fn) => cards.filter(fn).length;
  const statuses = [
    ['all', 'All', cards.length],
    ['todo', 'To review', count((c) => !cardStatus(c.id))],
    ['changes', 'Needs changes', count((c) => cardStatus(c.id) === 'changes')],
    ['approved', 'Approved', count((c) => cardStatus(c.id) === 'approved')],
  ];
  const kinds = ['all', ...new Set(cards.map((c) => c.kind))];
  const viewSeg = `<div class="seg view-seg" role="tablist" aria-label="View">
      <button class="${S.view === 'flow' ? 'on' : ''}" data-act="view" data-v="flow" role="tab" aria-selected="${S.view === 'flow'}">◇ Flow diagram</button>
      <button class="${S.view === 'cards' ? 'on' : ''}" data-act="view" data-v="cards" role="tab" aria-selected="${S.view === 'cards'}">▦ Cards</button>
    </div>`;
  if (S.view === 'flow') {
    const hint = S.data.breakdown && S.data.breakdown.flow
      ? 'Hover to trace connections · click a node to open its change · drag to pan · pinch or ⌘-scroll to zoom'
      : 'Derived from the cards. Ask your agent for a system flow to see how the parts interact.';
    return `<div class="toolbar">${viewSeg}<span class="toolbar-hint">${hint}</span></div>`;
  }
  return `
    <div class="toolbar">
      ${viewSeg}
      <div class="seg" role="tablist">${statuses.map(([k, l, n]) => `<button class="${S.filter.status === k ? 'on' : ''}" data-act="filter-status" data-v="${k}">${l}<span class="n">${n}</span></button>`).join('')}</div>
      ${kinds.length > 2 ? `<div class="seg">${kinds.map((k) => `<button class="${S.filter.kind === k ? 'on' : ''}" data-act="filter-kind" data-v="${esc(k)}" style="text-transform:capitalize">${k === 'all' ? 'All kinds' : esc(k)}</button>`).join('')}</div>` : ''}
      <label class="search">${ICON.search}<input id="search" type="search" placeholder="Search cards, files, decisions" value="${esc(S.filter.q)}"><kbd>/</kbd></label>
    </div>`;
}

function churnBar(add, del) {
  const total = add + del;
  if (!total) return '';
  const blocks = 5;
  const a = Math.round((add / total) * blocks);
  return `<span class="churn-bar">${Array.from({ length: blocks }, (_, i) => `<i class="${i < a ? 'a' : 'd'}"></i>`).join('')}</span>`;
}

function statusBadge(id) {
  const st = cardStatus(id);
  if (st === 'approved') return `<span class="status approved">${ICON.check} Approved</span>`;
  if (st === 'changes') return `<span class="status changes">${ICON.alert} Changes</span>`;
  return `<span class="status todo">${ICON.dot} To review</span>`;
}

function renderCard(card) {
  const idx = S.data.cards.indexOf(card);
  const { add, del, files } = cardStats(card);
  const switched = switchedCount(card);
  const comments = lineCommentCount(card) + ((S.fb.cards[card.id] || {}).comment ? 1 : 0);
  const signals = [];
  if (card.decisions.length) signals.push(`<span class="signal">${ICON.fork} ${card.decisions.length} design decision${card.decisions.length > 1 ? 's' : ''}</span>`);
  if (switched) signals.push(`<span class="signal accent">${switched} alternative${switched > 1 ? 's' : ''} preferred</span>`);
  if (comments) signals.push(`<span class="signal warm">${ICON.chat} ${comments}</span>`);
  const shownFiles = files.slice(0, 2).map((f) => `<span class="file-chip" title="${esc(f)}">${esc(f.split('/').pop())}</span>`).join('');
  return `
    <button class="card st-${cardStatus(card.id) || 'todo'}" style="${kindVar(card.kind)}" data-act="open" data-id="${esc(card.id)}">
      <div class="card-top">
        <span class="card-num">${pad2(idx + 1)}</span>
        <span class="kind">${esc(card.kind)}</span>
        <span class="risk ${esc(card.risk)}">${esc(card.risk)} risk</span>
        ${statusBadge(card.id)}
      </div>
      <h3>${esc(card.title)}</h3>
      <p class="summary">${esc(card.summary)}</p>
      ${signals.length ? `<div class="card-signals">${signals.join('')}</div>` : ''}
      <div class="card-foot">
        <div class="files">${shownFiles}${files.length > 2 ? `<span class="file-chip">+${files.length - 2}</span>` : ''}</div>
        <span class="churn"><span class="add">+${add}</span><span class="del">−${del}</span>${churnBar(add, del)}</span>
      </div>
    </button>`;
}

function renderGrid() {
  const cards = visibleCards();
  if (!cards.length) return `<div class="empty">No cards match these filters.</div>`;
  const groups = [];
  for (const c of cards) {
    const name = c.group || '';
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, cards: [] }));
    g.cards.push(c);
  }
  return groups.map((g) => `
    <section class="group">
      ${g.name ? `<div class="group-head"><h2>${esc(g.name)}</h2><span>${g.cards.length} card${g.cards.length > 1 ? 's' : ''}</span></div>` : ''}
      <div class="grid">${g.cards.map(renderCard).join('')}</div>
    </section>`).join('');
}

function renderPage() {
  renderTopbar();
  const hadFocus = document.activeElement && document.activeElement.id === 'search';
  const caret = hadFocus ? document.activeElement.selectionStart : 0;
  saveVp('overview');
  $('#page').innerHTML = renderHero() + renderCallouts() + renderToolbar() + `<div id="grid">${renderBody()}</div>`;
  mountBody();
  if (hadFocus) { const s = $('#search'); s.focus(); s.setSelectionRange(caret, caret); }
}

function renderBody() {
  return S.view === 'flow' ? renderOverview() : renderGrid();
}

function mountBody() {
  if (S.view !== 'flow') return;
  mountDiagram('overview', `ov:${S.data.version}`, { maxFit: 1.1 });
  if (S.walk != null) renderWalk();
}

function renderGridOnly() {
  renderTopbar();
  const grid = $('#grid');
  if (!grid) return;
  saveVp('overview');
  grid.innerHTML = renderBody();
  mountBody();
}

/* ---------------- sheet (card detail) ---------------- */

function renderDecision(card, d, di) {
  const key = `${card.id}::${di}`;
  const df = S.fb.decisions[key] || { preferred: -1, comment: '' };
  const viewing = key in S.openOpt ? S.openOpt[key] : null;
  const options = [{ o: d.chosen, i: -1 }, ...d.alternatives.map((o, i) => ({ o, i }))];
  const body = options.map(({ o, i }) => {
    const open = viewing === i;
    const preferred = df.preferred === i;
    const tags = [];
    if (i === -1) tags.push('<span class="tag current">In this change</span>');
    if (preferred && i !== -1) tags.push('<span class="tag pref">Preferred</span>');
    if (o.effort && i !== -1) tags.push(`<span class="tag">${esc(o.effort)} effort</span>`);
    return `
      <div class="opt ${open ? 'open' : ''} ${preferred ? 'preferred' : ''}">
        <button class="opt-row" data-act="view-opt" data-key="${esc(key)}" data-i="${i}" aria-expanded="${open}">
          <span class="radio" aria-hidden="true"></span>
          <span class="opt-label">${esc(o.label)}</span>
          ${tags.join('')}
          ${ICON.chev}
        </button>
        ${open ? `
          <div class="opt-detail">
            <p class="desc">${esc(o.description)}</p>
            <div class="pc">
              <div class="pc-col pros"><h5>Pros</h5><ul>${(o.pros || []).map((p) => `<li>${esc(p)}</li>`).join('') || '<li>—</li>'}</ul></div>
              <div class="pc-col cons"><h5>Cons</h5><ul>${(o.cons || []).map((p) => `<li>${esc(p)}</li>`).join('') || '<li>—</li>'}</ul></div>
            </div>
            <div class="opt-actions">
              ${preferred
                ? `<span class="tag pref">${ICON.check} ${i === -1 ? 'Keeping current approach' : 'Agent will switch to this'}</span>`
                : `<button class="btn btn-sm ${i === -1 ? '' : 'btn-primary'}" data-act="prefer" data-key="${esc(key)}" data-i="${i}">${i === -1 ? 'Keep current approach' : 'Prefer this approach'}</button>`}
            </div>
          </div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="decision ${df.preferred >= 0 ? 'switched' : ''}${S.flashDecision === di ? ' flash' : ''}" id="dec-${di}">
      <div class="decision-q"><span class="qmark">?</span><span>${esc(d.question)}</span></div>
      ${body}
      <div class="decision-note" style="padding-top:10px">
        <textarea class="note" rows="2" data-input="decision" data-key="${esc(key)}" placeholder="Note on this decision for the agent (optional)">${esc(df.comment)}</textarea>
      </div>
    </div>`;
}

function renderSide(card) {
  const c = S.fb.cards[card.id] || { status: '', comment: '' };
  return `
    ${card.why ? `<div class="side-sec"><h4>Why</h4><p>${esc(card.why)}</p></div>` : ''}
    <div class="side-sec"><h4>What changed</h4><p>${esc(card.summary)}</p></div>
    ${card.riskNote ? `<div class="side-sec"><h4>Risk</h4><div class="risk-note"><span class="risk ${esc(card.risk)}">${esc(card.risk)}</span><span>${esc(card.riskNote)}</span></div></div>` : ''}
    ${card.decisions.length ? `<div class="side-sec"><h4>Design decisions <span class="n">${card.decisions.length}</span></h4>
      ${card.decisions.map((d, i) => renderDecision(card, d, i)).join('')}</div>` : ''}
    <div class="side-sec">
      <h4>Your verdict</h4>
      <div class="verdict">
        <button class="btn is-approve ${c.status === 'approved' ? 'active' : ''}" data-act="status" data-v="approved">${ICON.check} Approve</button>
        <button class="btn is-changes ${c.status === 'changes' ? 'active' : ''}" data-act="status" data-v="changes">${ICON.alert} Request changes</button>
      </div>
      <textarea class="note" rows="3" data-input="card" placeholder="Comment on this card as a whole…">${esc(c.comment)}</textarea>
    </div>`;
}

function commentsAt(file, side, line) {
  return S.fb.lines.filter((l) => l.file === file && l.side === side && l.line === line);
}

function renderCommentRows(card, file, side, line) {
  const key = `${file}|${side}|${line}`;
  let out = '';
  for (const l of commentsAt(file, side, line)) {
    if (S.composer && S.composer.editId === l.id) continue;
    out += `<tr class="cmt"><td colspan="4"><div class="cbox">
      <div class="who">Review note <span class="where">${esc(file)}:${line}</span></div>
      <div class="text">${esc(l.comment)}</div>
      <div class="actions"><button class="btn btn-sm btn-ghost" data-act="edit-c" data-cid="${esc(l.id)}">Edit</button><button class="btn btn-sm btn-ghost" data-act="del-c" data-cid="${esc(l.id)}">Delete</button></div>
    </div></td></tr>`;
  }
  if (S.composer && S.composer.key === key) {
    const existing = S.composer.editId ? S.fb.lines.find((l) => l.id === S.composer.editId) : null;
    out += `<tr class="cmt"><td colspan="4"><div class="cbox">
      <div class="who">${existing ? 'Edit note' : 'New note'} <span class="where">${esc(file)}:${line}</span></div>
      <textarea class="note" id="composer" rows="3" placeholder="What should change here? ⌘↵ to save">${esc(existing ? existing.comment : '')}</textarea>
      <div class="actions"><button class="btn btn-sm btn-primary" data-act="save-c">Save note</button><button class="btn btn-sm btn-ghost" data-act="cancel-c">Cancel</button></div>
    </div></td></tr>`;
  }
  return out;
}

function renderFileDiff(card, path, hunkIdxs) {
  const f = fileByPath(path);
  if (!f) return '';
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const head = `<div class="dfile-head"><span class="fstatus ${esc(f.status)}">${esc(f.status)}</span>
    <span class="path" title="${esc(path)}"><span class="dir">${esc(dir)}</span>${esc(path.slice(dir.length))}${f.status === 'renamed' && f.oldPath !== f.newPath ? ` <span class="dir">← ${esc(f.oldPath)}</span>` : ''}</span>
    <span class="churn"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></span></div>`;
  if (f.binary || !f.hunks.length) return `<div class="dfile">${head}<div class="binary">${f.binary ? 'Binary file — no textual diff.' : 'No content changes (mode or rename only).'}</div></div>`;

  const re = tokenRe(path);
  const idxs = S.fullFiles ? f.hunks.map((h) => h.index) : hunkIdxs;
  let rows = '';
  for (const i of idxs) {
    const h = f.hunks[i];
    if (!h) continue;
    const spans = intraLine(h.lines);
    rows += `<tr class="hunk"><td colspan="4">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ <span class="ctx">${esc(h.context)}</span></td></tr>`;
    for (const l of h.lines) {
      const side = l.t === 'del' ? 'old' : 'new';
      const num = side === 'old' ? l.o : l.n;
      const has = commentsAt(path, side, num).length ? ' has-c' : '';
      const fc = S.focus && S.focus.file === path && S.focus.side === side && num >= S.focus.a && num <= S.focus.b ? ' focus' : '';
      rows += `<tr class="line ${l.t}${has}${fc}" data-file="${esc(path)}" data-side="${side}" data-line="${num}">
        <td class="ln" data-act="comment">${l.t === 'add' ? '' : l.o}<button class="add-c" data-act="comment" tabindex="-1" aria-label="Comment on line">+</button></td>
        <td class="ln" data-act="comment">${l.t === 'del' ? '' : l.n}</td>
        <td class="sg">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</td>
        <td class="code">${renderCode(l.s, re, spans.get(l))}</td></tr>`;
      rows += renderCommentRows(card, path, side, num);
    }
  }
  return `<div class="dfile">${head}<table class="diff"><colgroup><col class="ln"><col class="ln"><col class="sg"><col></colgroup><tbody>${rows}</tbody></table></div>`;
}

function renderMain(card) {
  const byFile = new Map();
  for (const h of card.hunks) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    if (h.hunk != null) byFile.get(h.file).push(h.hunk);
  }
  if (S.focus && !byFile.has(S.focus.file)) byFile.set(S.focus.file, []);
  const partial = [...byFile].some(([p, idxs]) => { const f = fileByPath(p); return f && idxs.length < f.hunks.length; });
  const hasFlow = !!card.flow;
  const tab = hasFlow ? S.sheetTab : 'diff';
  const tabs = hasFlow ? `<div class="seg">
      <button class="${tab === 'flow' ? 'on' : ''}" data-act="tab" data-v="flow">◇ Logic flow</button>
      <button class="${tab === 'diff' ? 'on' : ''}" data-act="tab" data-v="diff">‹› Code diff</button>
    </div>` : '';
  if (tab === 'flow') {
    return `
      <div class="diff-toolbar">${tabs}<span class="hint">Click a step to jump to its code · click a ◇ decision to compare alternatives</span></div>
      <div class="diff-scroll flow-scroll">${diagramHtml('logic', { dir: 'TB', nodes: card.flow.nodes, edges: card.flow.edges }, 'logic', card)}</div>`;
  }
  const focusBar = S.focus ? `<div class="focus-bar"><span class="fb-dot"></span><span>Step <b>${esc(S.focus.label || '')}</b> · <span class="mono">${esc(S.focus.file)}:${S.focus.a}–${S.focus.b}</span></span>
      ${hasFlow ? `<button class="btn btn-sm" data-act="tab" data-v="flow">${ICON.left} Back to flow</button>` : ''}<button class="btn btn-sm btn-ghost" data-act="clear-focus">Clear</button></div>` : '';
  return `
    <div class="diff-toolbar">
      ${tabs}
      <div class="seg">
        <button class="${S.fullFiles ? '' : 'on'}" data-act="full" data-v="0">This card's changes</button>
        <button class="${S.fullFiles ? 'on' : ''}" data-act="full" data-v="1" ${partial ? '' : 'disabled title="This card already covers whole files"'}>Whole files</button>
      </div>
      <span class="hint">Click a line number to leave a note · ← → switch cards</span>
    </div>
    <div class="diff-scroll">${focusBar}${[...byFile].map(([p, idxs]) => renderFileDiff(card, p, idxs)).join('')}</div>`;
}

function renderSheet() {
  const sheet = $('#sheet');
  const card = S.data.cards.find((c) => c.id === S.openId);
  if (!card) { closeSheet(); return; }
  const side = $('.sheet-side', sheet);
  const main = $('.diff-scroll', sheet);
  const sideTop = side ? side.scrollTop : 0;
  const mainTop = main ? main.scrollTop : 0;
  const sameCard = sheet.dataset.card === card.id;

  const order = S.data.cards;
  const idx = order.indexOf(card);
  saveVp('logic');
  sheet.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(card.title)}" style="${kindVar(card.kind)}">
      <div class="sheet-head">
        <div class="titles">
          <div class="row"><span class="card-num">${pad2(idx + 1)}</span><span class="kind">${esc(card.kind)}</span><span class="risk ${esc(card.risk)}">${esc(card.risk)} risk</span>${statusBadge(card.id)}</div>
          <h2>${esc(card.title)}</h2>
        </div>
        <div class="sheet-nav">
          <button class="btn btn-icon btn-ghost" data-act="prev" ${idx === 0 ? 'disabled' : ''} aria-label="Previous card">${ICON.left}</button>
          <span class="pos">${idx + 1} / ${order.length}</span>
          <button class="btn btn-icon btn-ghost" data-act="next" ${idx === order.length - 1 ? 'disabled' : ''} aria-label="Next card">${ICON.right}</button>
          <button class="btn btn-icon btn-ghost" data-act="close" aria-label="Close">${ICON.close}</button>
        </div>
      </div>
      <div class="sheet-body">
        <div class="sheet-side">${renderSide(card)}</div>
        <div class="sheet-main">${renderMain(card)}</div>
      </div>
    </div>`;
  sheet.dataset.card = card.id;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  if (sameCard) {
    $('.sheet-side', sheet).scrollTop = sideTop;
    $('.diff-scroll', sheet).scrollTop = mainTop;
  }
  if ($('[data-svg="logic"]', sheet)) mountDiagram('logic', `card:${card.id}:${S.data.version}`, { maxFit: 1 });
  if (S.pendingScroll) {
    S.pendingScroll = false;
    const row = $('tr.focus', sheet);
    if (row) row.scrollIntoView({ block: 'center' });
  }
  if (S.flashDecision != null) {
    const el = $(`#dec-${S.flashDecision}`, sheet);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    S.flashDecision = null;
  }
  const comp = $('#composer');
  if (comp) { comp.focus(); comp.setSelectionRange(comp.value.length, comp.value.length); }
}

function openCard(id) {
  const card = S.data.cards.find((c) => c.id === id);
  S.openId = id;
  S.composer = null;
  S.focus = null;
  S.sheetTab = card && card.flow ? 'flow' : 'diff';
  history.replaceState(null, '', `#card=${encodeURIComponent(id)}`);
  $('#sheet').dataset.card = '';
  renderSheet();
}

function closeSheet() {
  S.openId = null;
  S.composer = null;
  $('#sheet').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
  history.replaceState(null, '', location.pathname);
  renderGridOnly();
}

function step(delta) {
  const order = S.data.cards;
  const i = order.findIndex((c) => c.id === S.openId);
  const next = order[i + delta];
  if (next) openCard(next.id);
}

/* ---------------- finish drawer: agent hand-off or GitHub ---------------- */

const GH = { tab: 'agent', loading: false, status: null, preview: null, login: null, event: null, ack: false, force: false, result: null, error: null, poll: null };
const EVENT_LABEL = { COMMENT: 'Comment', REQUEST_CHANGES: 'Request changes', APPROVE: 'Approve' };

function agentPanel() {
  const generic = 'Read .diffdeck/feedback.md and implement every requested change; leave approved cards untouched.';
  const prompts = [['Claude Code', '/diffdeck-apply'], ['Cursor', '/diffdeck-apply'], ['OpenCode', '/diffdeck-apply'], ['Any agent', generic]];
  return `
    <h4>Tell your agent</h4>
    ${prompts.map(([a, p]) => `<div class="prompt-row"><span class="agent">${a}</span><code title="${esc(p)}">${esc(p)}</code><button class="btn btn-sm" data-act="copy" data-text="${esc(p)}">${ICON.copy} Copy</button></div>`).join('')}
    <p class="muted-note">Slash commands need <code>diffdeck init</code> once per repo. Feedback is saved continuously to <code>${esc(S.data.paths.feedback)}</code>.</p>
    <h4>feedback.md preview</h4>
    <pre class="md" id="md-preview">${esc(S.markdown || 'Saving…')}</pre>`;
}

function copyRow(label, cmd) {
  return `<div class="prompt-row"><span class="agent">${esc(label)}</span><code title="${esc(cmd)}">${esc(cmd)}</code><button class="btn btn-sm" data-act="copy" data-text="${esc(cmd)}">${ICON.copy} Copy</button></div>`;
}

function githubPanel() {
  if (GH.result) {
    return `<div class="gh-card ok"><div class="gh-big">✓ Review posted</div>
      <p>${esc(EVENT_LABEL[GH.result.event])} with ${GH.result.inline} inline comment${GH.result.inline === 1 ? '' : 's'}${GH.result.unplaced ? ` and ${GH.result.unplaced} note${GH.result.unplaced === 1 ? '' : 's'} in the summary` : ''}.</p>
      <a class="btn btn-primary" href="${esc(GH.result.url)}" target="_blank" rel="noopener">Open on GitHub ↗</a>
      <button class="btn btn-ghost" data-act="gh-reset">Done</button></div>`;
  }
  if (GH.loading && !GH.status) return `<div class="gh-card"><span class="spinner"></span> Checking GitHub…</div>`;
  const st = GH.status;
  if (!st) return `<div class="gh-card"><button class="btn" data-act="gh-check">Check GitHub</button></div>`;
  const err = GH.error ? `<div class="callout error"><div class="callout-body">${esc(GH.error)}</div></div>` : '';

  if (!st.auth.installed) {
    return `${err}<div class="gh-card"><div class="gh-step">Setup</div><b>Install the GitHub CLI</b>
      <p>diffdeck posts through <code>gh</code>, so your token never passes through diffdeck. Install it, then come back here.</p>
      ${copyRow('macOS', 'brew install gh')}${copyRow('Windows', 'winget install --id GitHub.cli')}${copyRow('Linux', 'https://github.com/cli/cli#installation')}
      <button class="btn" data-act="gh-check">I've installed it — check again</button></div>`;
  }
  if (!st.auth.loggedIn) {
    if (GH.login && GH.login.code) {
      return `${err}<div class="gh-card"><div class="gh-step">Log in · one-time code</div>
        <p>Enter this one-time code on GitHub to connect your account:</p>
        <div class="gh-code">${esc(GH.login.code)}</div>
        <button class="btn btn-primary" data-act="gh-open-device" data-url="${esc(GH.login.url)}" data-code="${esc(GH.login.code)}">Copy code &amp; open GitHub ↗</button>
        <p class="muted-note"><span class="spinner"></span> Waiting for you to authorize… this page continues automatically.</p>
        <button class="btn btn-ghost btn-sm" data-act="gh-cancel-login">Cancel</button></div>`;
    }
    return `${err}<div class="gh-card"><div class="gh-step">Not connected</div><b>Log in to GitHub</b>
      <p>One click starts GitHub's secure device login. You approve it in your browser; diffdeck never sees your password or token.</p>
      <button class="btn btn-primary" data-act="gh-login">${ICON.fork} Log in with GitHub</button>
      <p class="muted-note">Prefer the terminal? Run <code>gh auth login</code>, then <button class="linkish" data-act="gh-check">check again</button>.</p></div>`;
  }
  if (!st.pr) {
    const pe = st.prError || {};
    return `${err}<div class="gh-card"><div class="gh-step">Signed in as @${esc(st.auth.user)}</div><b>No pull request to comment on</b>
      <p>${esc(pe.message || 'Could not find a pull request.')}</p>
      ${pe.error === 'no-remote' ? `<p>Publish the repository to GitHub, then open a PR:</p>${copyRow('Terminal', 'gh repo create --source . --push --private')}` : ''}
      ${pe.error === 'no-pr' ? `<p>Push the branch and open a PR, then check again:</p>${copyRow('Terminal', 'git push -u origin HEAD && gh pr create --fill')}<p>Or review an existing PR:</p>${copyRow('Terminal', 'diffdeck review --pr <number>')}` : ''}
      <button class="btn" data-act="gh-check">Check again</button></div>`;
  }

  const pv = GH.preview;
  const pr = st.pr;
  const head = `<div class="gh-target"><div><div class="gh-step">Posting as @${esc(st.auth.user)}</div>
      <a href="${esc(pr.url)}" target="_blank" rel="noopener"><b>#${pr.number} ${esc(pr.title)}</b> ↗</a>
      <div class="muted-note">${esc(pr.headRefName)} → ${esc(pr.baseRefName)}${pr.isDraft ? ' · draft' : ''}</div></div>
      <button class="btn btn-sm btn-ghost" data-act="gh-check" title="Refresh">↻ Refresh</button></div>`;
  const warns = (st.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
  if (!pv) return `${err}${head}<div class="gh-card"><span class="spinner"></span> Building the review…</div>`;
  if (pv.error) return `${err}${head}<div class="callout error"><div class="callout-body">${esc(pv.error)}</div></div>`;
  const rv = pv.review;
  const empty = !rv.body.trim() && !rv.inline.length;
  const event = GH.event && pv.allowedEvents.includes(GH.event) ? GH.event : rv.suggestedEvent;
  const dup = pv.alreadyPosted;
  const canPost = !empty && GH.ack && (!dup || GH.force) && pr.state === 'OPEN';
  return `${err}${head}
    ${warns ? `<div class="callout warn"><div class="callout-body"><ul>${warns}</ul></div></div>` : ''}
    <h4>Review type</h4>
    <div class="seg gh-events">${['COMMENT', 'REQUEST_CHANGES', 'APPROVE'].map((e) => {
      const ok = pv.allowedEvents.includes(e);
      return `<button class="${event === e ? 'on' : ''}" data-act="gh-event" data-v="${e}" ${ok ? '' : 'disabled title="GitHub does not allow this on your own pull request"'}>${EVENT_LABEL[e]}</button>`;
    }).join('')}</div>
    ${st.selfReview ? '<p class="muted-note">This is your own PR, so GitHub only allows comments.</p>' : ''}
    <h4>Inline comments <span class="n">${rv.inline.length}</span></h4>
    ${rv.inline.length ? `<ul class="gh-list">${rv.inline.map((c) => `<li><code>${esc(c.path)}:${c.line}</code> ${esc(c.body.length > 90 ? c.body.slice(0, 90) + '…' : c.body)}</li>`).join('')}</ul>` : '<p class="muted-note">No line notes yet. Click a line number in a card’s code to add one.</p>'}
    ${rv.unplaced.length ? `<p class="muted-note">⚠ ${rv.unplaced.length} note${rv.unplaced.length === 1 ? '' : 's'} refer${rv.unplaced.length === 1 ? 's' : ''} to lines that are not in the PR's current diff, so ${rv.unplaced.length === 1 ? 'it goes' : 'they go'} into the summary.</p>` : ''}
    <h4>Summary comment</h4>
    <pre class="md">${esc(rv.body || '(empty)')}</pre>
    ${dup ? `<div class="callout warn"><div class="callout-body">You already posted this exact review on ${esc(new Date(dup.postedAt).toLocaleString())}. <a href="${esc(dup.url)}" target="_blank" rel="noopener">View it ↗</a>
      <label class="check"><input type="checkbox" data-act="gh-force" ${GH.force ? 'checked' : ''}> Post it again anyway</label></div></div>` : ''}
    ${empty ? '<p class="muted-note">Nothing to post yet: add notes, pick alternatives or approve cards first.</p>' : `
    <label class="check gh-ack"><input type="checkbox" data-act="gh-ack" ${GH.ack ? 'checked' : ''}> I understand this posts publicly on PR #${pr.number} as @${esc(st.auth.user)}.</label>
    <button class="btn btn-primary gh-post" data-act="gh-post" ${canPost ? '' : 'disabled'}>Post ${EVENT_LABEL[event].toLowerCase()} to GitHub</button>`}`;
}

function renderDrawer() {
  const drawer = $('#drawer');
  if (drawer.hidden) return;
  const cards = S.data.cards;
  const approved = cards.filter((c) => cardStatus(c.id) === 'approved').length;
  const todo = cards.filter((c) => !cardStatus(c.id)).length;
  const body = $('.drawer-body', drawer);
  const top = body ? body.scrollTop : 0;
  drawer.innerHTML = `
    <div class="drawer-head"><h3>${GH.tab === 'github' ? 'Post on GitHub' : 'Hand off to agent'}</h3><button class="btn btn-icon btn-ghost" data-act="close-drawer" aria-label="Close">${ICON.close}</button></div>
    <div class="drawer-body">
      <div class="summary-tiles">
        <div class="stat"><div class="v" id="tile-actionable">${S.actionable}</div><div class="l">requested changes</div></div>
        <div class="stat"><div class="v">${approved}</div><div class="l">approved cards</div></div>
        <div class="stat"><div class="v">${todo}</div><div class="l">not yet reviewed</div></div>
      </div>
      <h4>Overall comment</h4>
      <textarea class="note" rows="3" data-input="general" placeholder="Anything that applies to the whole change…">${esc(S.fb.general)}</textarea>
      <div class="finish-tabs">
        <button class="finish-tab ${GH.tab === 'agent' ? 'on' : ''}" data-act="finish-tab" data-v="agent"><span class="ft-ic">⚙</span><span><b>Hand off to agent</b><small>Your coding agent implements the feedback</small></span></button>
        <button class="finish-tab ${GH.tab === 'github' ? 'on' : ''}" data-act="finish-tab" data-v="github"><span class="ft-ic">⑂</span><span><b>Post on GitHub</b><small>Publish as a pull request review</small></span></button>
      </div>
      <div class="finish-panel">${GH.tab === 'agent' ? agentPanel() : githubPanel()}</div>
    </div>`;
  const nb = $('.drawer-body', drawer);
  if (nb) nb.scrollTop = top;
}

async function ghCheck() {
  GH.loading = true; GH.error = null; GH.preview = null; GH.ack = false; GH.force = false;
  renderDrawer();
  try {
    await saveNow();
    GH.status = await (await fetch('/api/github/status')).json();
    if (GH.status.auth && GH.status.auth.loggedIn) { stopLoginPoll(); GH.login = null; }
    renderDrawer();
    if (GH.status.pr) {
      GH.preview = await (await fetch('/api/github/preview')).json();
      if (GH.preview.status) GH.status = GH.preview.status;
    }
  } catch (e) { GH.error = e.message; }
  GH.loading = false;
  renderDrawer();
}

function stopLoginPoll() { clearInterval(GH.poll); GH.poll = null; }

async function ghLogin() {
  GH.error = null;
  const r = await (await fetch('/api/github/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  if (r.error) { GH.error = r.error; renderDrawer(); return; }
  if (r.done) { ghCheck(); return; }
  GH.login = r;
  renderDrawer();
  stopLoginPoll();
  GH.poll = setInterval(async () => {
    try {
      const st = await (await fetch('/api/github/status')).json();
      if (st.auth && st.auth.loggedIn) { stopLoginPoll(); GH.login = null; toast(`Connected as @${st.auth.user}`); ghCheck(); }
    } catch { /* keep polling */ }
  }, 2500);
}

async function ghPost() {
  const event = GH.event && GH.preview.allowedEvents.includes(GH.event) ? GH.event : GH.preview.review.suggestedEvent;
  const btn = $('.gh-post');
  if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
  await saveNow();
  const res = await fetch('/api/github/post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, event, force: GH.force }) });
  const r = await res.json();
  if (r.ok) { GH.result = r; toast('Review posted to GitHub'); renderDrawer(); return; }
  GH.error = r.error || 'Posting failed.';
  GH.ack = false;
  await ghCheck();
}

function openDrawer(tab) {
  if (tab) GH.tab = tab;
  $('#drawer').hidden = false;
  renderDrawer();
  saveNow();
  if (GH.tab === 'github' && !GH.status) ghCheck();
}

/* ---------------- persistence ---------------- */

function setSaveState(text, cls) {
  const el = $('#save-state');
  el.textContent = text;
  el.className = `save-state ${cls || ''}`;
}

async function saveNow() {
  clearTimeout(S.saveTimer);
  setSaveState('Saving…', 'saving');
  try {
    const res = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.fb) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    S.markdown = body.markdown;
    S.actionable = body.actionable;
    setSaveState(`Saved ${new Date(body.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    renderTopbar();
    const pre = $('#md-preview');
    if (pre) pre.textContent = S.markdown;
    const tile = $('#tile-actionable');
    if (tile) tile.textContent = S.actionable;
  } catch (e) {
    setSaveState(`Not saved: ${e.message}`, 'error');
  }
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  setSaveState('Editing…', 'saving');
  S.saveTimer = setTimeout(saveNow, 450);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copied to clipboard');
}

/* ---------------- events ---------------- */

function cardFb(id) {
  if (!S.fb.cards[id]) S.fb.cards[id] = { status: '', comment: '' };
  return S.fb.cards[id];
}

function decisionFb(key) {
  if (!S.fb.decisions[key]) S.fb.decisions[key] = { preferred: -1, comment: '' };
  return S.fb.decisions[key];
}

function commitComposer() {
  const ta = $('#composer');
  if (!ta || !S.composer) return;
  const text = ta.value.trim();
  const c = S.composer;
  if (c.editId) {
    const l = S.fb.lines.find((x) => x.id === c.editId);
    if (l) l.comment = text;
    if (!text) S.fb.lines = S.fb.lines.filter((x) => x.id !== c.editId);
  } else if (text) {
    S.fb.lines.push({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, cardId: S.openId, file: c.file, side: c.side, line: c.line, code: c.code, comment: text });
  }
  S.composer = null;
  renderSheet();
  scheduleSave();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) {
    if (e.target.id === 'sheet') closeSheet();
    return;
  }
  const act = t.dataset.act;
  switch (act) {
    case 'open': openCard(t.dataset.id); break;
    case 'finish': openDrawer(t.dataset.v); break;
    case 'gnode': {
      const name = t.closest('svg').dataset.svg;
      if (S.vps[name] && S.vps[name].moved) break;
      onDiagramNode(name, t.dataset.node);
      break;
    }
    case 'view':
      S.view = t.dataset.v; S.walk = null;
      try { localStorage.setItem('diffdeck.view', S.view); } catch { /* ignore */ }
      renderPage();
      break;
    case 'tab': S.sheetTab = t.dataset.v; renderSheet(); break;
    case 'clear-focus': S.focus = null; renderSheet(); break;
    case 'zoom': {
      const vp = S.vps[t.dataset.name];
      if (vp) { if (t.dataset.v === 'fit') vp.fit(); else vp.zoom(t.dataset.v === 'in' ? 1.2 : 1 / 1.2); }
      break;
    }
    case 'walk': {
      const n = walkOrder().length;
      if (t.dataset.v === 'start') S.walk = 0;
      else if (t.dataset.v === 'stop') S.walk = null;
      else if (S.walk != null) S.walk = Math.max(0, Math.min(n - 1, S.walk + (t.dataset.v === 'next' ? 1 : -1)));
      renderWalk();
      break;
    }
    case 'close': closeSheet(); break;
    case 'prev': step(-1); break;
    case 'next': step(1); break;
    case 'filter-status': S.filter.status = t.dataset.v; renderPage(); break;
    case 'filter-kind': S.filter.kind = t.dataset.v; renderPage(); break;
    case 'full': if (!t.disabled) { S.fullFiles = t.dataset.v === '1'; renderSheet(); } break;
    case 'view-opt': {
      const i = Number(t.dataset.i);
      S.openOpt[t.dataset.key] = S.openOpt[t.dataset.key] === i ? null : i;
      renderSheet();
      break;
    }
    case 'prefer': {
      const d = decisionFb(t.dataset.key);
      d.preferred = Number(t.dataset.i);
      const fb = cardFb(S.openId);
      if (d.preferred >= 0 && !fb.status) fb.status = 'changes';
      renderSheet(); scheduleSave();
      break;
    }
    case 'status': {
      const fb = cardFb(S.openId);
      fb.status = fb.status === t.dataset.v ? '' : t.dataset.v;
      renderSheet(); renderTopbar(); scheduleSave();
      break;
    }
    case 'comment': {
      const row = t.closest('tr.line');
      if (!row) break;
      const file = row.dataset.file, side = row.dataset.side, line = Number(row.dataset.line);
      const code = row.querySelector('td.code').textContent;
      S.composer = { key: `${file}|${side}|${line}`, file, side, line, code, editId: null };
      renderSheet();
      break;
    }
    case 'save-c': commitComposer(); break;
    case 'cancel-c': S.composer = null; renderSheet(); break;
    case 'edit-c': {
      const l = S.fb.lines.find((x) => x.id === t.dataset.cid);
      if (l) { S.composer = { key: `${l.file}|${l.side}|${l.line}`, file: l.file, side: l.side, line: l.line, code: l.code, editId: l.id }; renderSheet(); }
      break;
    }
    case 'del-c': S.fb.lines = S.fb.lines.filter((x) => x.id !== t.dataset.cid); renderSheet(); scheduleSave(); break;
    case 'copy': copy(t.dataset.text); break;
    case 'close-drawer': $('#drawer').hidden = true; stopLoginPoll(); renderGridOnly(); break;
    case 'finish-tab':
      GH.tab = t.dataset.v; renderDrawer();
      if (GH.tab === 'github' && !GH.loading) ghCheck();
      break;
    case 'gh-check': ghCheck(); break;
    case 'gh-login': ghLogin(); break;
    case 'gh-cancel-login':
      stopLoginPoll(); GH.login = null;
      fetch('/api/github/login/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      renderDrawer();
      break;
    case 'gh-open-device': copy(t.dataset.code); window.open(t.dataset.url, '_blank', 'noopener'); break;
    case 'gh-event': if (!t.disabled) { GH.event = t.dataset.v; renderDrawer(); } break;
    case 'gh-ack': GH.ack = t.checked; renderDrawer(); break;
    case 'gh-force': GH.force = t.checked; renderDrawer(); break;
    case 'gh-post': if (!t.disabled) ghPost(); break;
    case 'gh-reset': GH.result = null; ghCheck(); break;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'search') { S.filter.q = t.value; renderGridOnly(); return; }
  const kind = t.dataset && t.dataset.input;
  if (!kind) return;
  if (kind === 'card') cardFb(S.openId).comment = t.value;
  else if (kind === 'decision') decisionFb(t.dataset.key).comment = t.value;
  else if (kind === 'general') S.fb.general = t.value;
  scheduleSave();
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.target.id === 'composer') {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitComposer(); }
    if (e.key === 'Escape') { e.preventDefault(); S.composer = null; renderSheet(); }
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#drawer').hidden) { $('#drawer').hidden = true; renderGridOnly(); return; }
    if (S.openId) { closeSheet(); return; }
  }
  if (typing) return;
  if (e.key === 'Enter' && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('gnode')) {
    onDiagramNode(document.activeElement.closest('svg').dataset.svg, document.activeElement.dataset.node);
    return;
  }
  if (!S.openId && S.walk != null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    S.walk = Math.max(0, Math.min(walkOrder().length - 1, S.walk + (e.key === 'ArrowRight' ? 1 : -1)));
    renderWalk();
    return;
  }
  if (S.openId && e.key === 'ArrowLeft') step(-1);
  if (S.openId && e.key === 'ArrowRight') step(1);
  if (!S.openId && e.key === '/') { e.preventDefault(); const s = $('#search'); if (s) s.focus(); }
});


/* ---------------- boot + live reload ---------------- */

async function loadState(initial) {
  const res = await fetch('/api/state');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  S.data = data;
  if (initial) S.fb = data.feedback;
  renderPage();
  if (S.openId) {
    if (data.cards.some((c) => c.id === S.openId)) renderSheet(); else closeSheet();
  }
}

async function poll() {
  try {
    const res = await fetch('/api/version');
    const { version } = await res.json();
    if (S.data && version !== S.data.version) {
      await loadState(false);
      toast(S.data.breakdown ? 'Breakdown updated' : 'Diff updated');
    }
  } catch { /* server stopped; keep the page as is */ }
}

(async function boot() {
  try {
    await loadState(true);
    const m = /#card=([^&]+)/.exec(location.hash);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (S.data.cards.some((c) => c.id === id)) openCard(id);
    }
    saveNow();
    setInterval(poll, 2500);
  } catch (e) {
    $('#page').innerHTML = `<div class="callout error"><div class="callout-body"><b>Could not load the review.</b> ${esc(e.message)}</div></div>`;
  }
})();
