#!/usr/bin/env node

'use strict';

const { spawn } = require('node:child_process');

const targets = {
  'linux-x64': ['glad-web-linux-x64', 'bin/glad'],
  'linux-arm64': ['glad-web-linux-arm64', 'bin/glad'],
  'darwin-x64': ['glad-web-darwin-x64', 'bin/glad'],
  'darwin-arm64': ['glad-web-darwin-arm64', 'bin/glad'],
  'win32-x64': ['glad-web-win32-x64', 'bin/glad.exe']
};

const key = `${process.platform}-${process.arch}`;
const target = targets[key];
if (!target) {
  console.error(`Glad does not provide a binary for ${key}.`);
  process.exit(1);
}

let executable;
try {
  executable = require.resolve(`${target[0]}/${target[1]}`);
} catch (_) {
  console.error([
    `Glad's ${key} binary was not installed.`,
    'Reinstall without --omit=optional:',
    '  npm install -g glad-web'
  ].join('\n'));
  process.exit(1);
}

const child = spawn(executable, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch (_) { /* process already stopped */ }
  });
}

child.once('error', error => {
  console.error(`Unable to start Glad: ${error.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 1 : code);
});
