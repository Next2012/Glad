#!/usr/bin/env node

// Opt-in live smoke check. It uses one deliberately tiny Haiku turn and is
// never part of the regular test suite, so normal development does not consume
// Claude quota.

const baseURL = process.env.GLAD_LIVE_URL || 'http://127.0.0.1:3001';
const workingDirectory = process.env.GLAD_LIVE_CWD || process.cwd();
const prompt = 'Reply with exactly GLAD_HAIKU_SMOKE. Do not use tools.';

async function main() {
  const create = await fetch(`${baseURL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toolKey: 'claude-code',
      workingDirectory,
      name: 'Claude Haiku smoke',
      claudeOptions: { model: 'haiku', effort: 'low', permissionMode: 'dontAsk' }
    })
  });
  const created = await create.json();
  if (!create.ok || !created.id) throw new Error(created.error || `create failed: ${create.status}`);
  const sessionId = created.id;
  let socket;
  try {
    const websocketURL = baseURL.replace(/^http/, 'ws') + `/ws?sessionId=${encodeURIComponent(sessionId)}`;
    socket = new WebSocket(websocketURL);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude live smoke timed out')), 120000);
      let accepted = false;
      let assistant = '';
      let updates = 0;
      let turnStatus = '';
      let context = null;
      let statusCard = null;
      let statusRequested = false;
      socket.addEventListener('error', () => reject(new Error('Claude live smoke WebSocket failed')));
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'claude-snapshot') {
          socket.send(JSON.stringify({
            type: 'claude-input', text: prompt,
            clientMessageId: `live-${Date.now()}`
          }));
          return;
        }
        if (message.type === 'send-result') {
          if (!message.accepted) reject(new Error(message.error || 'Claude rejected the smoke prompt'));
          accepted = true;
          return;
        }
        const payload = message.type === 'claude-event' ? message.event : null;
        if (payload?.type === 'message-updated' && payload.message?.kind === 'assistant') {
          updates += 1;
          assistant = payload.message.text || assistant;
        }
        if (payload?.type === 'message-updated' && payload.message?.kind === 'turn-end' && payload.message.context) {
          context = payload.message.context;
          if (!statusRequested) {
            statusRequested = true;
            socket.send(JSON.stringify({ type: 'claude-status' }));
          }
        }
        if (payload?.type === 'message' && payload.message?.kind === 'assistant') {
          assistant = payload.message.text || assistant;
        }
        if (payload?.type === 'message' && payload.message?.kind === 'status') {
          statusCard = payload.message;
          if (context) {
            clearTimeout(timer);
            resolve({ accepted, assistant, updates, status: turnStatus, context, statusCard });
          }
        }
        if (payload?.type === 'message' && payload.message?.kind === 'turn-end') {
          turnStatus = payload.message.turnStatus;
        }
      });
    });
    if (!result.accepted || result.status !== 'completed' || !result.assistant.includes('GLAD_HAIKU_SMOKE')
        || !(Number(result.context?.remainingTokens) > 0)
        || !Array.isArray(result.statusCard?.usage?.rateLimits)) {
      throw new Error(`unexpected Claude result: ${JSON.stringify(result)}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, model: 'haiku', ...result })}\n`);
  } finally {
    socket?.close();
    await fetch(`${baseURL}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
