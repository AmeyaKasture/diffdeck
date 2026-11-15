'use strict';

// Builds a throwaway git repo with a sample change and a ready-made breakdown,
// so `diffdeck demo` shows the full experience without any agent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { prepare, workDir } = require('./source');

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function createDemo() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'fixture.json'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffdeck-demo-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=diffdeck', '-c', 'user.email=demo@diffdeck.local', ...args], { cwd: root, stdio: 'ignore' });

  git('init', '-q', '-b', 'main');
  writeTree(root, fixture.base);
  git('add', '-A');
  git('commit', '-qm', 'Initial client');
  git('checkout', '-qb', fixture.branch);
  writeTree(root, fixture.head);
  git('add', '-A');
  git('commit', '-qm', fixture.message);

  prepare(root, { base: 'main' });
  fs.copyFileSync(path.join(__dirname, '..', 'demo', 'breakdown.json'), path.join(workDir(root), 'breakdown.json'));
  return root;
}

module.exports = { createDemo };
