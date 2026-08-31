const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoots = ['lib/web', 'lib/npm', 'scripts', 'tests'];
const standaloneFiles = ['playwright.config.js'];

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const files = [
  ...sourceRoots.flatMap(sourceRoot => collectJavaScriptFiles(path.join(projectRoot, sourceRoot))),
  ...standaloneFiles.map(file => path.join(projectRoot, file))
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Checked ${files.length} JavaScript files.`);
