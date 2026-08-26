const { spawn } = require('child_process');
const { chmodSync, statSync } = require('fs');

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45000;

const NATIVE_PACKAGES = {
  'darwin-arm64': '@ccusage/ccusage-darwin-arm64',
  'darwin-x64': '@ccusage/ccusage-darwin-x64',
  'linux-arm64': '@ccusage/ccusage-linux-arm64',
  'linux-x64': '@ccusage/ccusage-linux-x64',
  'win32-arm64': '@ccusage/ccusage-win32-arm64',
  'win32-x64': '@ccusage/ccusage-win32-x64'
};

function resolveCcusageBinary(platform = process.platform, arch = process.arch) {
  const packageName = NATIVE_PACKAGES[`${platform}-${arch}`];
  if (!packageName) {
    throw new Error(`ccusage is not available for ${platform}-${arch}`);
  }
  const binaryName = platform === 'win32' ? 'ccusage.exe' : 'ccusage';
  try {
    return require.resolve(`${packageName}/bin/${binaryName}`);
  } catch (_error) {
    throw new Error(`ccusage native package is missing for ${platform}-${arch}`);
  }
}

function ensureCcusageBinaryExecutable(binaryPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return binaryPath;

  const statPath = options.statPath || statSync;
  const chmodPath = options.chmodPath || chmodSync;
  try {
    // ccusage's platform packages can be installed without execute bits. Its JS
    // wrapper repairs them too, but this runner intentionally spawns the native binary.
    if ((statPath(binaryPath).mode & 0o111) === 0) chmodPath(binaryPath, 0o755);
    return binaryPath;
  } catch (error) {
    throw new Error(`ccusage native binary is not executable: ${error.message}`);
  }
}

function reportArgs(timezone) {
  return [
    'daily',
    '--sections', 'daily,weekly,monthly',
    '--by-agent',
    '--json',
    '--offline',
    '--timezone', timezone
  ];
}

class CcusageRunner {
  constructor(options = {}) {
    this.binaryPath = options.binaryPath
      || ensureCcusageBinaryExecutable(resolveCcusageBinary());
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess || spawn;
  }

  loadAllPeriods(timezone) {
    return this.runJson(reportArgs(timezone));
  }

  runJson(args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.binaryPath, args, {
        env: { ...process.env, NO_COLOR: '1' },
        shell: false,
        windowsHide: true
      });
      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = callback => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error('ccusage timed out while reading local usage data')));
      }, this.timeoutMs);

      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(() => reject(new Error('ccusage report exceeded the safe output limit')));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', chunk => {
        if (stderrBytes >= 64 * 1024) return;
        stderr.push(chunk);
        stderrBytes += chunk.length;
      });
      child.on('error', error => finish(() => reject(new Error(`Unable to start ccusage: ${error.message}`))));
      child.on('close', code => finish(() => {
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new Error(errorText || `ccusage exited with code ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
        } catch (_error) {
          reject(new Error('ccusage returned invalid JSON'));
        }
      }));
    });
  }
}

module.exports = {
  CcusageRunner,
  ensureCcusageBinaryExecutable,
  reportArgs,
  resolveCcusageBinary
};
