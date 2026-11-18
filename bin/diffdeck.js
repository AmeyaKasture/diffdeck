#!/usr/bin/env node
// Kept to syntax that very old Node versions can parse, so they print this
// message instead of a syntax error from the code below.
var major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write(
    'diffdeck needs Node 18 or newer, but this is Node ' + process.version + '.\n' +
    'Install a newer Node with nvm:\n' +
    '  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n' +
    '  nvm install 22\n' +
    'then install diffdeck again: npm install -g github:AmeyaKasture/diffdeck\n'
  );
  process.exit(1);
}
require('../lib/cli.js');
