'use strict';

// Local-only HTTP server ("hub"). Every registered repository is served under
// its own path, /<slug>/, with its UI, deck data and feedback; / lists them all.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, deckCards } = require('./breakdown');
const { emptyFeedback, sanitize, render } = require('./feedback');
const github = require('./github');
const hub = require('./hub');
const { version: VERSION } = require('../package.json');

const UI_DIR = path.join(__dirname, '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 5 * 1024 * 1024;

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Handles one repository's requests; `sub` is the path below /<slug>.
function repoApp(dir) {
  const fbJson = path.join(dir, 'feedback.json');
  const fbMd = path.join(dir, 'feedback.md');
  const root = path.dirname(dir);
  const version = () => `${mtime(path.join(dir, 'diff.json'))}:${mtime(path.join(dir, 'breakdown.json'))}`;

  function readFeedback() {
    try { return sanitize(JSON.parse(fs.readFileSync(fbJson, 'utf8'))); } catch { return emptyFeedback(); }
  }

  function state() {
    const loaded = load(dir);
    const cards = deckCards(loaded);
    return {
      version: version(),
      meta: loaded.meta,
      files: loaded.files,
      breakdown: loaded.breakdown && !loaded.errors.length
        ? { title: loaded.breakdown.title, summary: loaded.breakdown.summary, reviewOrder: loaded.breakdown.reviewOrder || '', flow: loaded.breakdown.flow || null }
        : null,
      errors: loaded.errors,
      warnings: loaded.warnings,
      cards,
      feedback: readFeedback(),
      paths: { dir, feedback: fbMd },
    };
  }

  function deck() {
    const loaded = load(dir);
    return { meta: loaded.meta, cards: deckCards(loaded) };
  }

  async function githubRoute(req, res, sub) {
    const route = `${req.method} ${sub.slice('/api/github'.length)}`;
    if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json required' });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    const { meta, cards } = deck();
    switch (route) {
      case 'GET /status': return send(res, 200, await github.status(root, meta));
      case 'POST /login': return send(res, 200, await github.startLogin(body.host || 'github.com'));
      case 'POST /login/cancel': github.cancelLogin(); return send(res, 200, { ok: true });
      case 'GET /preview': return send(res, 200, await github.preview(root, meta, cards, readFeedback()));
      case 'POST /post': {
        if (body.confirm !== true) return send(res, 400, { error: 'confirmation required' });
        const r = await github.post(root, meta, cards, readFeedback(), { event: body.event, force: body.force === true });
        return send(res, r.ok ? 200 : 409, r);
      }
      default: return send(res, 404, { error: 'not found' });
    }
  }

  return async function handle(req, res, sub) {
    if (req.method === 'GET' && STATIC[sub]) {
      const [file, type] = STATIC[sub];
      return send(res, 200, fs.readFileSync(path.join(UI_DIR, file)), type);
    }
    if (req.method === 'GET' && sub === '/api/state') return send(res, 200, state());
    if (req.method === 'GET' && sub === '/api/version') return send(res, 200, { version: version() });
    if (sub.startsWith('/api/github/')) return githubRoute(req, res, sub);
    if (req.method === 'POST' && sub === '/api/feedback') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json required' });
      const fb = sanitize(JSON.parse(await readBody(req)));
      const loaded = load(dir);
      const meta = { ...loaded.meta, title: (loaded.breakdown && loaded.breakdown.title) || loaded.meta.title };
      const { markdown, actionable } = render(meta, deckCards(loaded), fb);
      fs.writeFileSync(fbJson, JSON.stringify(fb, null, 2));
      fs.writeFileSync(fbMd, markdown);
      return send(res, 200, { ok: true, savedAt: fb.updatedAt, actionable, markdown });
    }
    return send(res, 404, { error: 'not found' });
  };
}

const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Summary of one repository's review for the overview page.
function summary(slug, root) {
  const dir = path.join(root, '.diffdeck');
  try {
    const loaded = load(dir);
    const cards = deckCards(loaded);
    let fb = emptyFeedback();
    try { fb = sanitize(JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8'))); } catch { /* none yet */ }
    const reviewed = cards.filter((c) => fb.cards[c.id] && fb.cards[c.id].status).length;
    return {
      slug, root,
      title: (loaded.breakdown && !loaded.errors.length && loaded.breakdown.title) || loaded.meta.title || loaded.meta.label,
      label: loaded.meta.label,
      url: loaded.meta.url || '',
      cards: cards.length,
      reviewed,
      hasBreakdown: !!loaded.breakdown && !loaded.errors.length,
      prepared: loaded.meta.generatedAt,
    };
  } catch (e) {
    return { slug, root, title: slug, label: e.message, cards: 0, reviewed: 0, hasBreakdown: false };
  }
}

function overviewPage() {
  const list = Object.entries(hub.repos()).map(([slug, e]) => summary(slug, e.root));
  const rows = list.map((r) => `
    <a class="card" style="--kind: var(--k-${r.hasBreakdown ? 'feature' : 'chore'}); min-height: 0; text-decoration: none; color: inherit" href="/${encodeURIComponent(r.slug)}/">
      <div class="card-top"><span class="card-num">/${escHtml(r.slug)}/</span>
        <span class="status ${r.reviewed && r.reviewed === r.cards ? 'approved' : 'todo'}">${r.reviewed}/${r.cards} reviewed</span></div>
      <h3>${escHtml(r.title)}</h3>
      <p class="summary">${escHtml(r.label)}${r.hasBreakdown ? '' : ' · no breakdown yet'}</p>
      <div class="card-foot"><span class="file-chip" style="max-width:100%" title="${escHtml(r.root)}">${escHtml(r.root)}</span></div>
    </a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>diffdeck reviews</title><link rel="stylesheet" href="/app.css"></head><body>
  <header class="topbar"><div class="topbar-inner"><a class="brand" href="/" style="color:inherit;text-decoration:none">
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="20" height="20" rx="5" fill="#C9D2F6"/><rect x="9" y="3" width="20" height="20" rx="5" fill="#3451D1"/></svg><span>diffdeck</span></a>
    <span class="source-chip">${list.length} review${list.length === 1 ? '' : 's'}</span></div></header>
  <main class="page"><section class="hero" style="grid-template-columns:1fr"><div><div class="eyebrow">All reviews</div><h1>Your reviews</h1>
  <p>Every repository you run diffdeck in gets its own address on this server. Run <code>diffdeck</code> in another repository to add it here; <code>diffdeck stop</code> in a repository removes it.</p></div></section>
  ${list.length ? `<div class="grid">${rows}</div>` : '<div class="empty">No reviews yet. Run <code>diffdeck</code> in a repository.</div>'}
  </main></body></html>`;
}

function createHub() {
  const apps = new Map(); // slug -> { root, handle }

  return http.createServer(async (req, res) => {
    // Reject cross-site requests: only pages served from this origin may write.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && origin !== `http://${host}`) return send(res, 403, { error: 'forbidden origin' });

    const url = new URL(req.url, `http://${host}`);
    try {
      if (url.pathname === '/_hub/ping') return send(res, 200, { ok: true, pid: process.pid, version: VERSION });
      if (url.pathname === '/_hub/repos') return send(res, 200, hub.repos());
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, overviewPage(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'app.css')), 'text/css; charset=utf-8');

      const m = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const slug = m && decodeURIComponent(m[1]);
      const entry = slug && hub.repos()[slug];
      if (!entry) {
        if (req.method !== 'GET' || (m && m[2] && m[2].startsWith('/api/'))) return send(res, 404, { error: `no review called "${slug}"` });
        return send(res, 404, `<!doctype html><meta charset="utf-8"><title>Not found</title><link rel="stylesheet" href="/app.css"><main class="page"><div class="empty">There is no review called <b>${escHtml(slug)}</b> on this server. <a href="/">See all reviews</a>.</div></main>`, 'text/html; charset=utf-8');
      }
      if (!m[2]) { res.writeHead(302, { Location: `/${encodeURIComponent(slug)}/${url.search}` }); return res.end(); }

      let app = apps.get(slug);
      if (!app || app.root !== entry.root) {
        app = { root: entry.root, handle: repoApp(path.join(entry.root, '.diffdeck')) };
        apps.set(slug, app);
      }
      return await app.handle(req, res, m[2]);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createHub();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { listen, createHub, repoApp };
