const test = require('node:test');
const assert = require('node:assert/strict');
const { SkillHubSettingsStore, normalizeBaseUrl } = require('./settings-store');

function memoryStore() {
  const values = new Map();
  return {
    values,
    store: new SkillHubSettingsStore({
      readConfig: key => values.get(key),
      writeConfig: (key, value) => values.set(key, value),
      configPath: () => '',
      keyFile: '/run/secrets/test-key',
      readFile: () => Buffer.from('11'.repeat(32), 'hex')
    })
  };
}

test('encrypts the SkillHub token and returns only a mask publicly', () => {
  const { values, store } = memoryStore();
  const publicSettings = store.save({ baseUrl: 'http://skillhub:10070', token: 'clh_private_token_value' });
  const persisted = values.get('skillHub');

  assert.equal(persisted.baseUrl, 'http://skillhub:10070');
  assert.equal(JSON.stringify(persisted).includes('clh_private_token_value'), false);
  assert.deepEqual(store.get(), {
    baseUrl: 'http://skillhub:10070',
    token: 'clh_private_token_value'
  });
  assert.equal(publicSettings.configured, true);
  assert.match(publicSettings.maskedToken, /^clh_pri/);
  assert.equal('token' in publicSettings, false);
});

test('rejects plain HTTP for a remote SkillHub', () => {
  assert.throws(() => normalizeBaseUrl('http://skills.example.com'), /HTTPS/);
  assert.equal(normalizeBaseUrl('https://skills.example.com/'), 'https://skills.example.com');
});

test('fails closed when the encryption key is missing', () => {
  const store = new SkillHubSettingsStore({
    readConfig: () => undefined,
    writeConfig: () => {},
    configPath: () => '',
    keyFile: ''
  });
  assert.throws(() => store.save({ baseUrl: 'http://skillhub:10070', token: 'clh_private_token_value' }), error => {
    assert.equal(error.code, 'SKILLHUB_KEY_MISSING');
    return true;
  });
});
