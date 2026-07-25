const test = require('node:test');
const assert = require('node:assert/strict');
const ServerChanClient = require('./serverchan-client');

test('posts form-encoded ServerChan messages and validates the API result', async () => {
  let request = null;
  const client = new ServerChanClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, message: 'success' })
      };
    }
  });

  await client.send({
    sendKey: 'SCT_TEST_SECRET',
    title: '已完成\n会话',
    description: '正文'
  });

  assert.match(request.url, /SCT_TEST_SECRET\.send$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.get('title'), '已完成 会话');
  assert.equal(request.options.body.get('desp'), '正文');
});

test('surfaces ServerChan API failures without exposing request credentials', async () => {
  const client = new ServerChanClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 40001, message: 'SendKey无效' })
    })
  });

  await assert.rejects(
    client.send({ sendKey: 'SCT_TEST_SECRET', title: 'test' }),
    error => error.message === 'SendKey无效' && !error.message.includes('SCT_TEST_SECRET')
  );
});
