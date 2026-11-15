'use strict';

// Parses unified diff text (git diff / gh pr diff) into files and hunks.
// Each hunk keeps per-line old/new line numbers so the UI and feedback can
// refer to exact source locations.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function unquote(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  }
  return p;
}

function stripPrefix(p) {
  p = unquote(p.trim());
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      file = {
        oldPath: null,
        newPath: null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(line);
      if (m) {
        file.oldPath = m[1];
        file.newPath = m[2];
      }
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; }
      else if (line.startsWith('rename to ')) { file.newPath = unquote(line.slice(10)); file.status = 'renamed'; }
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('--- ')) { const p = stripPrefix(line.slice(4)); if (p !== null) file.oldPath = p; else file.status = 'added'; }
      else if (line.startsWith('+++ ')) { const p = stripPrefix(line.slice(4)); if (p !== null) file.newPath = p; else file.status = 'deleted'; }
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      hunk = {
        index: file.hunks.length,
        oldStart: +hm[1],
        oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3],
        newLines: hm[4] === undefined ? 1 : +hm[4],
        context: hm[5].trim(),
        additions: 0,
        deletions: 0,
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    const c = line[0];
    if (c === '+') {
      hunk.lines.push({ t: 'add', n: newNo++, s: line.slice(1) });
      hunk.additions++; file.additions++;
    } else if (c === '-') {
      hunk.lines.push({ t: 'del', o: oldNo++, s: line.slice(1) });
      hunk.deletions++; file.deletions++;
    } else if (c === ' ') {
      hunk.lines.push({ t: 'ctx', o: oldNo++, n: newNo++, s: line.slice(1) });
    } else if (c === '\\') {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noEol = true;
    } else if (line === '' && i === lines.length - 1) {
      // trailing newline of the whole diff
    } else if (line === '') {
      // some tools emit blank context lines without the leading space
      hunk.lines.push({ t: 'ctx', o: oldNo++, n: newNo++, s: '' });
    } else {
      hunk = null;
    }
  }

  for (const f of files) {
    f.path = f.status === 'deleted' ? f.oldPath : f.newPath;
    if (!f.path) f.path = f.oldPath || f.newPath || '(unknown)';
  }
  return files;
}

module.exports = { parseDiff };
