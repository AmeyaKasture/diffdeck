'use strict';

// Local-only HTTP server: serves the UI, the deck data and persists feedback.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, deckCards } = require('./breakdown');
const { emptyFeedback, sanitize, render } = require('./feedback');

const UI_DIR = path.join(__dirname, '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
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

function createServer(dir) {
  const fbJson = path.join(dir, 'feedback.json');
  const fbMd = path.join(dir, 'feedback.md');
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

  return http.createServer(async (req, res) => {
    // Reject cross-site requests: only the page served from this origin may write.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && origin !== `http://${host}`) return send(res, 403, { error: 'forbidden origin' });

    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(UI_DIR, file)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: version() });
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
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
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
}

function serve(dir, port) {
  return new Promise((resolve, reject) => {
    const server = createServer(dir);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { serve, createServer };
