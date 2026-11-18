'use strict';

// The diffdeck command line. bin/diffdeck.js checks the Node version first.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { repoRoot, workDir, prepare, defaultBase, resolveTarget } = require('./source');
const { load } = require('./breakdown');
const { listen } = require('./server');
const hub = require('./hub');
const { installCommands, uninstallCommands, installedCommands, AGENTS_MD_SNIPPET, AGENT_TARGETS } = require('./agent');
const { version } = require('../package.json');

const BIN = path.join(__dirname, '..', 'bin', 'diffdeck.js');

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, blue: (s) => `\x1b[34m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }
  : { b: (s) => s, dim: (s) => s, blue: (s) => s, green: (s) => s, yellow: (s) => s };

const HELP = `${c.b('diffdeck')} ${c.dim(`v${version}`)} — review a PR, branch or commit as an interactive flow diagram

${c.b('Usage')}
  diffdeck                      Open this repository's review (the prepared PR, or this branch vs main)
  diffdeck review <target>      Review a PR link, a branch (vs main) or a commit (vs its parent):
                                  diffdeck review https://github.com/org/repo/pull/42
                                  diffdeck review feature/login
                                  diffdeck review a1b2c3d
  diffdeck review --pr <n|link> | --branch <name> [--base <branch>] | --commit <id>
                                Say explicitly what the target is; --base changes what a branch is compared with
  diffdeck review --staged      Review staged changes
  diffdeck review --worktree    Review uncommitted changes against HEAD
  diffdeck demo                 Open a sample review, no setup needed

  diffdeck init [agent]         Add /diffdeck-breakdown and /diffdeck-apply commands to this repo
                                agent: ${AGENT_TARGETS.join(' | ')} | all (default)
  diffdeck init --uninstall     Remove the command files that init wrote
  diffdeck prepare [same args]  Only collect the diff (what agents run)
  diffdeck refresh              Re-collect the same PR, branch or commit after changes; keeps
                                the cards whose code did not change, and their approvals
  diffdeck serve                Open this repository's review at http://127.0.0.1:4777/<repo>/
                                (one background server hosts every repository; --foreground to debug)
  diffdeck list                 Show every repository on the server and its address
  diffdeck stop [--all]         Remove this repository from the server (--all: stop the server)
  diffdeck post [--event comment|request-changes|approve] [--yes]
                                Preview your review for the PR; with --yes, post it to GitHub
  diffdeck login                Log in to GitHub (via the gh CLI)
  diffdeck upgrade [--force]    Update diffdeck to the latest version from GitHub
  diffdeck doctor               Check Node, PATH, GitHub login, the base branch and agent commands
  diffdeck validate             Check .diffdeck/breakdown.json
  diffdeck feedback             Print .diffdeck/feedback.md

${c.b('Options')}
  --port <n>     Port for the UI (default 4777)
  --no-open      Do not open the browser
  -v, --version  Print the version

${c.b('Workflow')}
  1. In your agent:  /diffdeck-breakdown <PR link | branch | commit>   ${c.dim('(the agent asks if you leave it out)')}
  2. In a terminal:  diffdeck                 ${c.dim('(explore the diagram, comment, pick alternatives)')}
  3. In your agent:  /diffdeck-apply          ${c.dim('(or: "implement .diffdeck/feedback.md")')}
     or on GitHub:   Finish review → Post on GitHub  ${c.dim('(or: diffdeck post)')}
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--pr', '--port', '--event', '--branch', '--commit', '--base'].includes(a)) args[a.slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function openBrowser(url) {
  if (process.env.DIFFDECK_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, argv, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* ignore */ }
}


function flagValue(args, name, example) {
  const v = args[name];
  if (v === true || v === '') throw new Error(`--${name} needs a value, e.g. --${name} ${example}`);
  return v;
}

// What to review: a PR, a branch (vs main) or a commit (vs its parent).
// A single positional argument is detected automatically.
function sourceOpts(root, args) {
  const base = args.base !== undefined ? flagValue(args, 'base', 'main') : undefined;
  if (args.pr !== undefined) {
    const pr = flagValue(args, 'pr', '42');
    const t = resolveTarget(root, /^\d+$/.test(pr) ? `#${pr}` : pr);
    if (!t.pr) throw new Error('--pr expects a PR number or link, e.g. --pr 42 or --pr https://github.com/org/repo/pull/42');
    return t;
  }
  if (args.branch !== undefined) return { branch: flagValue(args, 'branch', 'feature/login'), base };
  if (args.commit !== undefined) return { commit: flagValue(args, 'commit', 'a1b2c3d') };
  if (args.staged) return { staged: true };
  if (args.worktree) return {};
  if (args._[0]) {
    const t = resolveTarget(root, args._[0]);
    return t.branch ? { ...t, base } : t;
  }
  if (base) return { base };
  // With no arguments, keep reviewing what was prepared before (PR, branch or commit).
  try {
    const { meta } = JSON.parse(fs.readFileSync(path.join(workDir(root), 'diff.json'), 'utf8'));
    if (meta.source === 'pr' && (meta.prUrl || meta.prNumber)) return { pr: String(meta.prUrl || meta.prNumber) };
    if (meta.source === 'branch' && meta.target) return { branch: meta.target.branch, base: meta.target.base || undefined };
    if (meta.source === 'commit' && meta.target) return { commit: meta.target.commit };
  } catch { /* nothing prepared yet */ }
  const auto = defaultBase(root);
  return auto ? { base: auto, autoBase: true } : {};
}

function doPrepare(root, args) {
  const r = prepare(root, sourceOpts(root, args));
  const m = r.meta;
  const hunks = r.files.reduce((n, f) => n + f.hunks.length, 0);
  console.log(`${c.green('✓')} ${c.b(m.label)}: ${r.files.length} files, ${hunks} hunks${r.unchanged ? c.dim(' (unchanged; breakdown and feedback kept)') : ''}`);
  const sha = (s) => (s ? String(s).slice(0, 7) : '');
  if (m.base) console.log(c.dim(`  base ${m.base}${m.baseSha && sha(m.baseSha) !== m.base ? ` @ ${sha(m.baseSha)}` : ''}   head ${m.branch && m.branch !== 'HEAD' ? `${m.branch} ` : ''}@ ${m.head}`));
  for (const n of m.notes || []) console.log(c.yellow(`  ${n}`));
  if (!r.files.length) console.log(c.yellow('  The diff is empty. Try `diffdeck review <base>` or `--pr <n>`.'));
  if (r.files.length > 150 && m.source !== 'commit') console.log(c.yellow(`  That is a lot of files. If most of them are not part of this change, the base is probably out of date: run \`git fetch\` and pass --base origin/<branch>.`));
  if (m.repoMismatch) console.log(c.yellow(`  ${m.repoMismatch}`));
  if (m.untracked && m.untracked.length) console.log(c.yellow(`  ${m.untracked.length} untracked file(s) are not included; \`git add -N <file>\` to include them.`));
  const rd = r.rounds;
  if (rd && rd.carried) {
    console.log(`  Round ${rd.round}: ${rd.kept.length} card(s) unchanged${rd.approvals.length ? ` (${rd.approvals.length} still approved)` : ''}, ${c.b(`${rd.stale.length} stale`)}, ${rd.removed.length} removed. Round ${rd.round - 1} is in ${c.dim('.diffdeck/rounds/' + (rd.round - 1))}`);
    for (const card of rd.stale) console.log(c.dim(`    stale: ${card.id}`));
  } else if (rd && rd.round > 1) {
    console.log(c.dim(`  Round ${rd.round - 1} is archived in .diffdeck/rounds/${rd.round - 1}; this review starts from scratch.`));
  }
  return r;
}

/* ---------------- the shared server ---------------- */

// One server hosts every repository at http://127.0.0.1:<port>/<repo>/.
// `serve` registers the repository and starts the server only if needed.

function printRunning(dir, url) {
  const hasBreakdown = fs.existsSync(path.join(dir, 'breakdown.json'));
  console.log(`${c.green('✓')} The review is open at ${c.b(c.blue(url))}`);
  if (!hasBreakdown) console.log(`  ${c.yellow('No breakdown yet.')} In your agent run ${c.b('/diffdeck-breakdown <PR link>')}; the page updates by itself.`);
  console.log(`  Feedback is saved to ${c.dim(path.join(dir, 'feedback.md'))}`);
  console.log(c.dim('  All reviews on this server: ' + url.replace(/[^/]+\/$/, '') + '   ·   remove this one: diffdeck stop'));
}

async function startHubInBackground(args) {
  const child = spawn(process.execPath, [BIN, '__hub', ...(args.port ? ['--port', String(args.port)] : [])], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir(),
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = await hub.running();
    if (info) return info;
  }
  throw new Error('The diffdeck server did not start. Run `diffdeck serve --foreground` to see the error.');
}

async function runHub(args) {
  let port = Number(args.port || process.env.DIFFDECK_PORT || 4777);
  let server;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { server = await listen(port); break; } catch (e) {
      if (e.code !== 'EADDRINUSE' || args.port) throw e;
      port++;
    }
  }
  const info = { pid: process.pid, port, url: `http://127.0.0.1:${port}/`, version, startedAt: new Date().toISOString() };
  hub.writeHubInfo(info);
  const cleanup = () => hub.clearHubInfo(process.pid);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); server.close(); process.exit(0); });
  process.on('exit', cleanup);
  return info;
}

// diffdeck 0.2.0 ran one server per repository, recorded in .diffdeck/server.json.
function stopLegacyServer(dir) {
  const file = path.join(dir, 'server.json');
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    fs.unlinkSync(file);
  } catch { /* none */ }
}

async function doServe(dir, args, preferredSlug) {
  load(dir); // fail early with a helpful message if nothing is prepared
  stopLegacyServer(dir);
  const slug = hub.register(path.dirname(dir), preferredSlug);
  let info = await hub.running();
  if (info && info.version !== version) {
    console.log(c.dim(`  restarting the diffdeck server (${info.version} → ${version})`));
    try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 300));
    info = null;
  }
  if (!info && args.foreground) {
    info = await runHub(args);
    printRunning(dir, `${info.url}${slug}/`);
    console.log(c.dim('  Running in the foreground. Press Ctrl+C to stop the server for all repositories.'));
    if (!args['no-open']) openBrowser(`${info.url}${slug}/`);
    return;
  }
  if (!info) info = await startHubInBackground(args);
  const url = `${info.url}${slug}/`;
  printRunning(dir, url);
  if (!args['no-open']) openBrowser(url);
}

async function doStop(root, args) {
  const info = await hub.running();
  if (args.all) {
    if (!info) { console.log('The diffdeck server is not running.'); return; }
    process.kill(info.pid, 'SIGTERM');
    console.log(`${c.green('✓')} Stopped the diffdeck server at ${info.url} (all reviews).`);
    return;
  }
  const slug = hub.unregister(root);
  if (!slug) console.log('This repository is not on the diffdeck server.');
  else console.log(`${c.green('✓')} Removed ${c.b(`/${slug}/`)} from the diffdeck server.`);
  const left = Object.keys(hub.repos()).length;
  if (info && left === 0) {
    process.kill(info.pid, 'SIGTERM');
    console.log(c.dim('  No reviews left, so the server was stopped.'));
  } else if (info && slug) {
    console.log(c.dim(`  ${left} other review${left === 1 ? '' : 's'} still at ${info.url}`));
  }
}

async function doList() {
  const info = await hub.running();
  const all = hub.repos();
  const slugs = Object.keys(all);
  if (!slugs.length) { console.log('No repositories registered. Run `diffdeck` in a repository.'); return; }
  console.log(info ? `${c.green('●')} Server running at ${c.b(info.url)}` : `${c.yellow('○')} Server not running (it starts with \`diffdeck\` in any repository).`);
  const width = Math.max(...slugs.map((s) => s.length)) + 2;
  for (const slug of slugs) {
    const where = info ? `${info.url}${slug}/` : `/${slug}/`;
    console.log(`  ${slug.padEnd(width)} ${c.blue(where)}  ${c.dim(all[slug].root)}`);
  }
}

/* ---------------- upgrade ---------------- */

const REPO = 'AmeyaKasture/diffdeck';
const PKG_ROOT = path.join(__dirname, '..');

function newer(a, b) { // true when version a is newer than b
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function runInherit(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
}

async function doUpgrade(args) {
  const via = PKG_ROOT.includes(`${path.sep}_npx${path.sep}`) ? 'npx' : fs.existsSync(path.join(PKG_ROOT, '.git')) ? 'clone' : 'npm';
  if (via === 'npx') {
    console.log(`You are running diffdeck through npx, which keeps a cached copy. Install it once with\n  ${c.b(`npm install -g github:${REPO}`)}\nand from then on use ${c.b('diffdeck upgrade')}.`);
    return;
  }

  let latest;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = (await res.json()).version;
  } catch (e) {
    throw new Error(`Could not check GitHub for a new version (${e.message}). To upgrade manually: npm install -g github:${REPO}`);
  }
  if (!args.force && !newer(latest, version)) {
    console.log(`${c.green('✓')} diffdeck ${version} is the latest version.${latest !== version ? c.dim(` (GitHub has ${latest})`) : ''}`);
    return;
  }
  console.log(newer(latest, version) ? `Upgrading diffdeck ${version} → ${latest}…` : `Reinstalling diffdeck (installed ${version}, GitHub has ${latest})…`);

  let code;
  if (via === 'clone') {
    console.log(c.dim(`  installed from a clone at ${PKG_ROOT}; running git pull`));
    code = await runInherit('git', ['-C', PKG_ROOT, 'pull', '--ff-only']);
    if (code !== 0) throw new Error(`git pull failed in ${PKG_ROOT}. Commit or stash local changes there, then run diffdeck upgrade again.`);
  } else {
    code = await runInherit('npm', ['install', '-g', `github:${REPO}`]);
    if (code !== 0) throw new Error(`npm could not install the new version. If it reported a permission error (EACCES), install into your home folder instead of using sudo:\n  npm config set prefix ~/.local\n  npm install -g github:${REPO}\nand make sure ~/.local/bin is on your PATH.`);
  }
  const installed = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  console.log(`${c.green('✓')} diffdeck is now ${installed}.`);

  // Refresh this repository's agent commands and restart its server so both use the new version.
  const bin = path.join(PKG_ROOT, 'bin', 'diffdeck.js');
  let root = null;
  try { root = repoRoot(process.cwd()); } catch { /* not in a repository */ }
  const targets = root ? installedCommands(root) : [];
  if (root && targets.length) {
    await runInherit(process.execPath, [bin, 'init', targets.join(','), '--quiet'], { cwd: root });
  }
  const running = await hub.running();
  if (running) {
    try { process.kill(running.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 300));
    spawn(process.execPath, [bin, '__hub', '--port', String(running.port)], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
    console.log(`${c.green('✓')} Restarted the diffdeck server on the new version; all reviews keep their addresses.`);
  }
}

/* ---------------- doctor ---------------- */

async function doDoctor() {
  const { execFileSync } = require('child_process');
  let problems = 0;
  const ok = (msg) => console.log(`${c.green('✓')} ${msg}`);
  const bad = (msg, fix) => { problems++; console.log(`${c.yellow('!')} ${msg}${fix ? `\n    ${c.dim(fix)}` : ''}`); };
  const sh = (cmd, argv, opts = {}) => { try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, ...opts }).trim(); } catch { return null; } };

  ok(`diffdeck ${version} on Node ${process.version} (${BIN})`);

  // Agents started outside a terminal run commands in a non-interactive shell,
  // which does not read ~/.zshrc or ~/.bashrc, where nvm is usually loaded.
  const shell = process.env.SHELL || '/bin/sh';
  const env = { HOME: os.homedir(), USER: process.env.USER || '', SHELL: shell, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
  const found = sh(shell, ['-lc', 'command -v diffdeck'], { cwd: os.homedir(), env });
  if (found) ok(`a fresh non-interactive shell finds diffdeck: ${found}`);
  else bad(`a fresh non-interactive ${path.basename(shell)} does not find diffdeck, so agents started outside a terminal may not either`,
    `Run \`diffdeck init\` again (the commands then name the full path), or link it: mkdir -p ~/.local/bin && ln -sf "${BIN}" ~/.local/bin/diffdeck`);

  const gh = sh('gh', ['auth', 'status']);
  if (sh('gh', ['--version']) == null) bad('the GitHub CLI (gh) is not installed; it is needed for PRs and posting', 'brew install gh, or see https://github.com/cli/cli#installation');
  else if (gh == null) bad('gh is not logged in to GitHub', 'diffdeck login');
  else ok('gh is logged in to GitHub');

  let root = null;
  try { root = repoRoot(process.cwd()); } catch { /* not in a repository */ }
  if (!root) { console.log(c.dim('  (run diffdeck doctor inside a repository to check its base branch and agent commands)')); }
  else {
    const name = (sh('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }) || 'origin/main').replace(/^origin\//, '');
    const behind = sh('git', ['rev-list', '--count', `refs/heads/${name}..refs/remotes/origin/${name}`], { cwd: root });
    if (behind && Number(behind) > 0) bad(`local ${name} is ${behind} commit(s) behind origin/${name}`, `diffdeck compares with origin/${name} automatically; to update yours: git checkout ${name} && git pull`);
    else if (behind != null) ok(`local ${name} is up to date with origin/${name}`);
    const fetched = sh('git', ['log', '-1', '--format=%cr', `refs/remotes/origin/${name}`], { cwd: root });
    if (fetched) console.log(c.dim(`  origin/${name} was last updated ${fetched}; run git fetch to see newer commits`));
    const cmds = installedCommands(root);
    if (cmds.length) ok(`agent commands installed for ${cmds.join(', ')}`);
    else bad('no agent commands in this repository', 'diffdeck init');
  }

  const info = await hub.running();
  if (!info) console.log(c.dim('  The review server is not running (it starts with diffdeck serve).'));
  else if (info.version !== version) bad(`the review server runs ${info.version}, but diffdeck is ${version}`, 'diffdeck serve restarts it');
  else ok(`review server running at ${info.url}`);

  console.log(problems ? `\n${problems} problem(s) found.` : '\nEverything looks fine.');
  if (problems) process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  const known = ['review', 'demo', 'init', 'agent-setup', 'prepare', 'refresh', 'serve', 'stop', 'list', 'validate', 'feedback', 'post', 'login', 'upgrade', 'doctor', 'help', '__hub'];
  const cmd = !first || first.startsWith('-') ? 'review' : first;
  const args = parseArgs(cmd === first ? argv.slice(1) : argv);

  if (args.help || args.h || cmd === 'help') { process.stdout.write(HELP); return; }
  if (args.version || argv.includes('-v')) { console.log(version); return; }
  if (args.y) args.yes = true;
  if (!known.includes(cmd)) { process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 2; return; }

  if (cmd === 'upgrade') { await doUpgrade(args); return; }
  if (cmd === '__hub') { await runHub(args); return; }
  if (cmd === 'list') { await doList(); return; }
  if (cmd === 'doctor') { await doDoctor(args); return; }
  if (cmd === 'stop' && args.all) { await doStop(null, args); return; }

  if (cmd === 'demo') {
    const { createDemo } = require('./demo');
    const root = createDemo();
    console.log(`${c.green('✓')} Demo repository created at ${c.dim(root)}`);
    await doServe(workDir(root), args, 'demo');
    return;
  }

  const root = repoRoot(process.cwd());
  const dir = workDir(root);

  switch (cmd) {
    case 'review':
      doPrepare(root, args);
      await doServe(dir, args);
      return;
    case 'prepare':
    case 'refresh': {
      if (cmd === 'refresh' && !fs.existsSync(path.join(dir, 'diff.json'))) throw new Error('Nothing to refresh yet. Run `diffdeck prepare <PR link | branch | commit>` first.');
      const r = doPrepare(root, args);
      if (r.unchanged) { if (cmd === 'refresh') console.log('  Nothing changed since the last round. For a PR, push your changes first; a commit never changes.'); return; }
      if (r.rounds && r.rounds.carried) console.log(`  Next: update the cards listed in ${c.b('.diffdeck/refresh.md')}, run ${c.b('diffdeck validate')}, then ${c.b('diffdeck serve')}.`);
      else console.log(`  Next: have your agent follow ${c.b('.diffdeck/AGENT_TASK.md')}, then run ${c.b('diffdeck serve')}.`);
      return;
    }
    case 'serve':
      await doServe(dir, args);
      return;
    case 'stop':
      await doStop(root, args);
      return;
    case 'validate': {
      const r = load(dir);
      if (!r.breakdown && !r.errors.length) { console.log('No .diffdeck/breakdown.json yet.'); process.exitCode = 1; return; }
      for (const e of r.errors) console.log(`error: ${e}`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      if (r.errors.length) { process.exitCode = 1; return; }
      const decisions = r.cards.reduce((n, card) => n + card.decisions.length, 0);
      const flows = r.cards.filter((card) => card.flow).length;
      console.log(`OK: ${r.cards.length} cards, ${decisions} design decisions, ${flows} logic flows${r.breakdown.flow ? ', system flow' : ', no system flow'}.`);
      return;
    }
    case 'feedback': {
      const f = path.join(dir, 'feedback.md');
      if (!fs.existsSync(f)) { console.log('No feedback yet. Run `diffdeck` and review.'); process.exitCode = 1; return; }
      process.stdout.write(fs.readFileSync(f, 'utf8'));
      return;
    }
    case 'login': {
      const github = require('./github');
      const st = await github.authStatus(root);
      if (!st.installed) { console.log(`The GitHub CLI is required. Install it (${c.b('brew install gh')} / ${c.b('winget install --id GitHub.cli')} / https://github.com/cli/cli#installation), then run ${c.b('diffdeck login')} again.`); process.exitCode = 1; return; }
      if (st.loggedIn) { console.log(`${c.green('✓')} Already logged in to GitHub as ${c.b('@' + st.user)}.`); return; }
      await new Promise((resolve) => spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'], { stdio: 'inherit' }).on('exit', resolve).on('error', resolve));
      return;
    }
    case 'post': {
      const github = require('./github');
      const { deckCards } = require('./breakdown');
      const { sanitize } = require('./feedback');
      const loaded = load(dir);
      let fb;
      try { fb = sanitize(JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8'))); } catch { console.log('No feedback yet. Run `diffdeck` and review first.'); process.exitCode = 1; return; }
      const cards = deckCards(loaded);
      const pv = await github.preview(root, loaded.meta, cards, fb);
      const st = pv.status;
      if (!st.auth.installed) { console.log(`The GitHub CLI is required: ${c.b('brew install gh')} (or see https://github.com/cli/cli#installation).`); process.exitCode = 1; return; }
      if (!st.auth.loggedIn) { console.log(`Not logged in to GitHub. Run ${c.b('diffdeck login')} first.`); process.exitCode = 1; return; }
      if (!st.pr) { console.log(st.prError.message + (st.prError.error === 'no-pr' ? `\nPush and open one with ${c.b('gh pr create --fill')}, or use ${c.b('diffdeck review --pr <n>')}.` : '')); process.exitCode = 1; return; }
      if (pv.error) { console.log(pv.error); process.exitCode = 1; return; }
      const map = { comment: 'COMMENT', 'request-changes': 'REQUEST_CHANGES', approve: 'APPROVE' };
      const event = args.event ? map[args.event] : pv.review.suggestedEvent;
      if (!event) { console.log('--event must be comment, request-changes or approve.'); process.exitCode = 2; return; }
      console.log(`${c.b(`PR #${st.pr.number}`)} ${st.pr.title}\n${c.dim(st.pr.url)}\nAs @${st.auth.user} · ${event.toLowerCase().replace('_', ' ')} · ${pv.review.inline.length} inline comment(s)${pv.review.unplaced.length ? `, ${pv.review.unplaced.length} moved to the summary (lines not in the PR diff)` : ''}`);
      for (const w of st.warnings || []) console.log(c.yellow(`! ${w}`));
      console.log(`\n${pv.review.body || c.dim('(no summary)')}\n`);
      if (!args.yes) { console.log(c.dim('Preview only. Run again with --yes to post this review publicly.')); return; }
      const r = await github.post(root, loaded.meta, cards, fb, { event, force: !!args.force });
      if (!r.ok) { console.log(`${r.error}${r.duplicate ? ` (${r.duplicate.url}; add --force to post again)` : ''}`); process.exitCode = 1; return; }
      console.log(`${c.green('✓')} Posted: ${r.url}`);
      return;
    }
    case 'init':
    case 'agent-setup': {
      if (args.uninstall) {
        const removed = uninstallCommands(root);
        if (!removed.length) { console.log('No diffdeck command files found in this repository.'); return; }
        console.log(`${c.green('✓')} Removed agent commands:`);
        for (const w of removed) console.log(`  ${w}`);
        return;
      }
      const which = args._[0] || 'all';
      const written = installCommands(root, which === 'all' ? AGENT_TARGETS : which.split(','), `"${process.execPath}" "${BIN}"`);
      console.log(`${c.green('✓')} ${args.quiet ? 'Refreshed' : 'Added'} agent commands:`);
      for (const w of written) console.log(`  ${w}`);
      if (args.quiet) return;
      console.log(`\nFor other agents (Codex, Aider, ...), add this to ${c.b('AGENTS.md')}:\n`);
      console.log(AGENTS_MD_SNIPPET);
      return;
    }
  }
}

main().catch((e) => {
  console.error(`diffdeck: ${e.message}`);
  process.exitCode = 1;
});
