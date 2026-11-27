const { spawn } = require('node:child_process');
const readline = require('node:readline');

// Exercise the real stdio bridge and authenticated daemon, with deterministic
// provider fixtures supplying the same tool call an agent would make.
module.exports = async function groupMCP(config, text) {
  const command = JSON.parse(text.split('__GLAD_GROUP_CALL__')[1].split('\n')[0]);
  const child = spawn(config.command, config.args || ['mcp'], {
    env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let id = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(new Error('Group MCP timeout')), 15000);
    pending.set(key, result => { clearTimeout(timer); pending.delete(key); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  try {
    await request('initialize', { protocolVersion: '2025-03-26' });
    const definitions = await request('tools/list', {});
    const response = await request('tools/call', { name: command.tool, arguments: command.args });
    let result;
    try { result = JSON.parse(response.result.content[0].text); } catch { result = response.result.content[0].text; }
    if (result && typeof result === 'object') delete result.messages;
    return 'GROUP_CONTROL_RESULT ' + JSON.stringify({ key:command.key, isError: response.result.isError, result, tools: definitions.result.tools.map(tool => tool.name) });
  } finally { child.stdin.end(); }
};
