'use strict';

// One diffdeck server ("hub") serves every repository under its own path,
// e.g. http://127.0.0.1:4777/agentic-cloud/. The registry of repositories and
// the hub's address live in ~/.diffdeck (override with DIFFDECK_HOME).

const fs = require('fs');
const os = require('os');
const path = require('path');

function home() {
  return process.env.DIFFDECK_HOME || path.join(os.homedir(), '.diffdeck');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const reposFile = () => path.join(home(), 'repos.json');
const hubFile = () => path.join(home(), 'hub.json');

function prepared(root) {
  return fs.existsSync(path.join(root, '.diffdeck', 'diff.json'));
}

// slug -> { root, addedAt }. Entries whose repository no longer has a prepared
// review (deleted folder, removed .diffdeck) are dropped.
function repos() {
  const all = readJson(reposFile(), {});
  const live = {};
  let changed = false;
  for (const [slug, entry] of Object.entries(all)) {
    if (entry && entry.root && prepared(entry.root)) live[slug] = entry;
    else changed = true;
  }
  if (changed) writeJson(reposFile(), live);
  return live;
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'repo';
}

function slugFor(root) {
  const real = fs.realpathSync(root);
  for (const [slug, e] of Object.entries(repos())) if (e.root === real) return slug;
  return null;
}

// Adds the repository (or returns its existing slug). The slug is the folder
// name; a different repository with the same folder name gets "-2", "-3", ...
function register(root, preferred) {
  const real = fs.realpathSync(root);
  const all = repos();
  for (const [slug, e] of Object.entries(all)) if (e.root === real) return slug;
  const base = slugify(preferred || path.basename(real));
  let slug = base;
  for (let n = 2; all[slug]; n++) slug = `${base}-${n}`;
  all[slug] = { root: real, addedAt: new Date().toISOString() };
  writeJson(reposFile(), all);
  return slug;
}

function unregister(root) {
  const real = fs.realpathSync(root);
  const all = repos();
  let removed = null;
  for (const [slug, e] of Object.entries(all)) if (e.root === real) { delete all[slug]; removed = slug; }
  if (removed) writeJson(reposFile(), all);
  return removed;
}

function hubInfo() { return readJson(hubFile(), null); }
function writeHubInfo(info) { writeJson(hubFile(), info); }
function clearHubInfo(pid) {
  const info = hubInfo();
  if (info && (!pid || info.pid === pid)) { try { fs.unlinkSync(hubFile()); } catch { /* gone */ } }
}

// The running hub, verified by pid and a ping, or null.
async function running() {
  const info = hubInfo();
  if (!info) return null;
  try { process.kill(info.pid, 0); } catch { clearHubInfo(info.pid); return null; }
  try {
    const res = await fetch(`${info.url}_hub/ping`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body.pid === info.pid ? { ...info, version: body.version } : null;
  } catch { return null; }
}

module.exports = { home, repos, register, unregister, slugFor, slugify, hubInfo, writeHubInfo, clearHubInfo, running };
