'use strict';

/* Layered graph layout (Sugiyama-style) and SVG rendering with pan/zoom.
   No dependencies. Exposes window.Graph = { layout, measure, Viewport }. */

(function () {
  const CHAR_W = 7.1;

  function wrap(text, max) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  // Size a node from its text. shape: box | pill | diamond | io
  function measure(label, sub, shape, maxChars) {
    const lines = wrap(label, maxChars || 24);
    const subLines = sub ? wrap(sub, (maxChars || 24) + 6) : [];
    const textW = Math.max(...lines.map((l) => l.length * CHAR_W * 1.04), ...subLines.map((l) => l.length * 6.2), 60);
    let w = textW + 32;
    let h = lines.length * 18 + subLines.length * 15 + (subLines.length ? 26 : 22);
    if (shape === 'diamond') { w = Math.max(w * 1.45, 130); h = Math.max(h * 1.7, 74); }
    if (shape === 'io') w += 24;
    if (shape === 'pill') w += 12;
    return { w: Math.round(Math.max(w, 120)), h: Math.round(h), lines, subLines };
  }

  function layout(nodesIn, edgesIn, opts = {}) {
    const dir = opts.dir === 'LR' ? 'LR' : 'TB';
    const rankGap = opts.rankGap || 64;
    const nodeGap = opts.nodeGap || 34;
    const N = new Map();
    nodesIn.forEach((n, i) => N.set(n.id, { ...n, idx: i, rank: 0, dummy: false }));
    const E = edgesIn
      .filter((e) => N.has(e.from) && N.has(e.to) && e.from !== e.to)
      .map((e, i) => ({ ...e, i, reversed: false }));

    // 1. Break cycles: DFS from sources first, reverse back edges.
    const out = new Map([...N.keys()].map((k) => [k, []]));
    const indegAll = new Map([...N.keys()].map((k) => [k, 0]));
    for (const e of E) { out.get(e.from).push(e); indegAll.set(e.to, indegAll.get(e.to) + 1); }
    const state = new Map();
    const dfs = (v) => {
      state.set(v, 1);
      for (const e of out.get(v)) {
        const s = state.get(e.to);
        if (s === 1) e.reversed = true;
        else if (!s) dfs(e.to);
      }
      state.set(v, 2);
    };
    const starts = [...N.keys()].sort((a, b) => (indegAll.get(a) === 0 ? 0 : 1) - (indegAll.get(b) === 0 ? 0 : 1));
    for (const k of starts) if (!state.get(k)) dfs(k);
    const eff = E.map((e) => (e.reversed ? { e, u: e.to, v: e.from } : { e, u: e.from, v: e.to }));

    // 2. Rank by longest path (Kahn).
    const indeg = new Map([...N.keys()].map((k) => [k, 0]));
    const succ = new Map([...N.keys()].map((k) => [k, []]));
    for (const { u, v } of eff) { indeg.set(v, indeg.get(v) + 1); succ.get(u).push(v); }
    const queue = [...N.keys()].filter((k) => indeg.get(k) === 0);
    while (queue.length) {
      const u = queue.shift();
      for (const v of succ.get(u)) {
        N.get(v).rank = Math.max(N.get(v).rank, N.get(u).rank + 1);
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) queue.push(v);
      }
    }

    // 3. Dummy nodes so every segment spans one rank.
    let dummyId = 0;
    const segs = [];
    const paths = new Map();
    for (const { e, u, v } of eff) {
      const chain = [u];
      for (let r = N.get(u).rank + 1; r < N.get(v).rank; r++) {
        const id = `__d${dummyId++}`;
        N.set(id, { id, dummy: true, rank: r, w: 6, h: 6, idx: N.get(u).idx + 0.5 });
        chain.push(id);
      }
      chain.push(v);
      for (let k = 0; k < chain.length - 1; k++) segs.push([chain[k], chain[k + 1]]);
      paths.set(e.i, chain);
    }
    const preds = new Map([...N.keys()].map((k) => [k, []]));
    const succs = new Map([...N.keys()].map((k) => [k, []]));
    for (const [a, b] of segs) { succs.get(a).push(b); preds.get(b).push(a); }

    // 4. Order within layers: barycenter sweeps.
    const maxRank = Math.max(0, ...[...N.values()].map((n) => n.rank));
    const layers = Array.from({ length: maxRank + 1 }, () => []);
    [...N.values()].sort((a, b) => a.idx - b.idx).forEach((n) => layers[n.rank].push(n.id));
    const pos = new Map();
    const setPos = () => layers.forEach((L) => L.forEach((id, i) => pos.set(id, i)));
    setPos();
    const crossings = () => {
      let c = 0;
      for (let r = 0; r < maxRank; r++) {
        const s = [];
        for (const a of layers[r]) for (const b of succs.get(a)) s.push([pos.get(a), pos.get(b)]);
        for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
          if ((s[i][0] - s[j][0]) * (s[i][1] - s[j][1]) < 0) c++;
        }
      }
      return c;
    };
    let best = layers.map((L) => L.slice());
    let bestC = crossings();
    for (let it = 0; it < 12; it++) {
      const down = it % 2 === 0;
      const range = down ? [...Array(maxRank).keys()].map((r) => r + 1) : [...Array(maxRank).keys()].map((r) => maxRank - 1 - r);
      for (const r of range) {
        const nb = down ? preds : succs;
        const bc = new Map(layers[r].map((id) => {
          const ns = nb.get(id);
          return [id, ns.length ? ns.reduce((s, x) => s + pos.get(x), 0) / ns.length : pos.get(id)];
        }));
        layers[r].sort((a, b) => bc.get(a) - bc.get(b) || pos.get(a) - pos.get(b));
        layers[r].forEach((id, i) => pos.set(id, i));
      }
      const c = crossings();
      if (c < bestC) { bestC = c; best = layers.map((L) => L.slice()); }
    }
    best.forEach((L, r) => { layers[r] = L; });
    setPos();

    // 5. Coordinates.
    const cross = (n) => (dir === 'TB' ? n.w : n.h);
    const along = (n) => (dir === 'TB' ? n.h : n.w);
    const layerAlong = layers.map((L) => Math.max(0, ...L.map((id) => along(N.get(id)))));
    const rankPos = [];
    layerAlong.forEach((sz, r) => { rankPos[r] = r === 0 ? sz / 2 : rankPos[r - 1] + layerAlong[r - 1] / 2 + rankGap + sz / 2; });
    const cx = new Map();
    const gapBetween = (a, b) => (N.get(a).dummy || N.get(b).dummy ? nodeGap / 2 : nodeGap);
    const pack = (L, desired) => {
      const left = [];
      L.forEach((id, i) => {
        const min = i ? left[i - 1] + (cross(N.get(L[i - 1])) + cross(N.get(id))) / 2 + gapBetween(L[i - 1], id) : -Infinity;
        left.push(Math.max(desired[i], min));
      });
      const right = new Array(L.length);
      for (let i = L.length - 1; i >= 0; i--) {
        const id = L[i];
        const max = i < L.length - 1 ? right[i + 1] - (cross(N.get(L[i + 1])) + cross(N.get(id))) / 2 - gapBetween(id, L[i + 1]) : Infinity;
        right[i] = Math.min(desired[i], max);
      }
      L.forEach((id, i) => cx.set(id, (left[i] + right[i]) / 2));
    };
    layers.forEach((L) => {
      let x = 0;
      const d = L.map((id, i) => { if (i) x += (cross(N.get(L[i - 1])) + cross(N.get(id))) / 2 + gapBetween(L[i - 1], id); return x; });
      const mid = x / 2;
      pack(L, d.map((v) => v - mid));
    });
    for (let it = 0; it < 8; it++) {
      const down = it % 2 === 0;
      const order = down ? layers.map((_, r) => r) : layers.map((_, r) => maxRank - r);
      for (const r of order) {
        const L = layers[r];
        const desired = L.map((id) => {
          const ns = [...preds.get(id), ...succs.get(id)].filter((x) => (down ? N.get(x).rank < r : N.get(x).rank > r));
          const all = ns.length ? ns : [...preds.get(id), ...succs.get(id)];
          return all.length ? all.reduce((s, x) => s + cx.get(x), 0) / all.length : cx.get(id);
        });
        pack(L, desired);
      }
    }

    const real = [...N.values()];
    const minC = Math.min(...real.map((n) => cx.get(n.id) - cross(n) / 2));
    const pad = opts.pad || 28;
    for (const n of real) {
      const c = cx.get(n.id) - minC + pad;
      const a = rankPos[n.rank] + pad;
      if (dir === 'TB') { n.x = c; n.y = a; } else { n.x = a; n.y = c; }
    }
    const width = Math.max(...real.map((n) => n.x + n.w / 2)) + pad;
    const height = Math.max(...real.map((n) => n.y + n.h / 2)) + pad;

    // 6. Edge paths.
    const edges = E.map((e) => {
      const ids = paths.get(e.i);
      const pts = ids.map((id) => ({ x: N.get(id).x, y: N.get(id).y }));
      const first = N.get(ids[0]);
      const last = N.get(ids[ids.length - 1]);
      if (dir === 'TB') { pts[0].y += first.h / 2; pts[pts.length - 1].y -= last.h / 2; } else { pts[0].x += first.w / 2; pts[pts.length - 1].x -= last.w / 2; }
      if (e.reversed) pts.reverse();
      let d = `M${pts[0].x},${pts[0].y}`;
      for (let k = 0; k < pts.length - 1; k++) {
        const p = pts[k], q = pts[k + 1];
        if (dir === 'TB') { const m = (q.y - p.y) / 2; d += ` C${p.x},${p.y + m} ${q.x},${q.y - m} ${q.x},${q.y}`; } else { const m = (q.x - p.x) / 2; d += ` C${p.x + m},${p.y} ${q.x - m},${q.y} ${q.x},${q.y}`; }
      }
      const mk = Math.floor((pts.length - 1) / 2);
      const label = { x: (pts[mk].x + pts[mk + 1].x) / 2, y: (pts[mk].y + pts[mk + 1].y) / 2 };
      return { ...e, d, labelPos: label };
    });

    return { nodes: real.filter((n) => !n.dummy), edges, width, height, dir };
  }

  // Pan (drag) and zoom (pinch / ctrl+wheel / buttons) for an <svg> with a <g data-viewport>.
  class Viewport {
    constructor(svg, contentW, contentH, opts = {}) {
      this.svg = svg;
      this.g = svg.querySelector('[data-viewport]');
      this.w = contentW;
      this.h = contentH;
      this.k = 1; this.x = 0; this.y = 0;
      this.moved = false;
      this.maxFit = opts.maxFit || 1;
      this.bind();
      this.fit();
    }
    apply() { this.g.setAttribute('transform', `translate(${this.x},${this.y}) scale(${this.k})`); }
    size() { const r = this.svg.getBoundingClientRect(); return { W: r.width || 800, H: r.height || 500 }; }
    fit() {
      const { W, H } = this.size();
      this.k = Math.max(0.3, Math.min(this.maxFit, (W - 24) / this.w, (H - 24) / this.h));
      this.x = (W - this.w * this.k) / 2;
      this.y = Math.max(8, (H - this.h * this.k) / 2);
      this.apply();
    }
    zoomAt(factor, px, py) {
      const k = Math.max(0.25, Math.min(2.5, this.k * factor));
      this.x = px - ((px - this.x) * k) / this.k;
      this.y = py - ((py - this.y) * k) / this.k;
      this.k = k;
      this.apply();
    }
    zoom(factor) { const { W, H } = this.size(); this.zoomAt(factor, W / 2, H / 2); }
    centerOn(cx, cy) {
      const { W, H } = this.size();
      this.x = W / 2 - cx * this.k;
      this.y = H / 2 - cy * this.k;
      this.g.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)';
      this.apply();
      setTimeout(() => { this.g.style.transition = ''; }, 480);
    }
    bind() {
      this.svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        drag = { vp: this, px: e.clientX, py: e.clientY, x: this.x, y: this.y };
        this.moved = false;
      });
      this.svg.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls the page
        e.preventDefault();
        const r = this.svg.getBoundingClientRect();
        this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
    }
  }

  // One set of window listeners shared by every viewport (they are re-created on each render).
  let drag = null;
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const vp = drag.vp;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if (!vp.moved && Math.hypot(dx, dy) < 4) return;
    vp.moved = true;
    vp.svg.classList.add('panning');
    vp.x = drag.x + dx; vp.y = drag.y + dy;
    vp.apply();
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const vp = drag.vp;
    drag = null;
    vp.svg.classList.remove('panning');
    setTimeout(() => { vp.moved = false; }, 0);
  });

  window.Graph = { layout, measure, wrap, Viewport };
})();
