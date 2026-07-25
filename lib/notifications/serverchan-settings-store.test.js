const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ServerChanSettingsStore
} = require('./serverchan-settings-store');

function createStore() {
  const values = {};
  let chmodMode = null;
  const store = new ServerChanSettingsStore({
    readConfig: key => values[key],
    writeConfig: (key, value) => { values[key] = value; },
    configPath: () => __filename,
    chmod: (_path, mode) => { chmodMode = mode; }
  });
  return { store, values, getChmodMode: () => chmodMode };
}

test('persists ServerChan credentials while exposing only a masked key', () => {
  const { store, values, getChmodMode } = createStore();

  const result = store.save({
    sendKey: 'SCT_TEST_SECRET_1234',
    clientType: 'pushdeer'
  });

  assert.deepEqual(values.serverChan, {
    sendKey: 'SCT_TEST_SECRET_1234',
    clientType: 'pushdeer'
  });
  assert.equal(result.configured, true);
  assert.equal(result.clientType, 'pushdeer');
  assert.equal(result.maskedKey, 'SCT••••••••••');
  assert.equal(JSON.stringify(result).includes('TEST_SECRET'), false);
  assert.equal(getChmodMode(), 0o600);
});

test('keeps the stored SendKey when a later save leaves the field blank', () => {
  const { store } = createStore();
  store.save({ sendKey: 'SCT_TEST_SECRET_1234', clientType: 'wechat' });

  store.save({ sendKey: '', clientType: 'pushdeer' });

  assert.deepEqual(store.get(), {
    sendKey: 'SCT_TEST_SECRET_1234',
    clientType: 'pushdeer'
  });
});

test('rejects unsupported client types and clears configuration explicitly', () => {
  const { store } = createStore();
  assert.throws(
    () => store.save({ sendKey: 'SCT_TEST_SECRET_1234', clientType: 'email' }),
    /微信或 PushDeer/
  );

  store.save({ sendKey: 'SCT_TEST_SECRET_1234', clientType: 'wechat' });
  assert.deepEqual(store.clear(), {
    configured: false,
    maskedKey: '',
    clientType: 'wechat'
  });
});
