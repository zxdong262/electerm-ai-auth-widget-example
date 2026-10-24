const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createStore } = require('../lib/store')

// A stand-in for electron's safeStorage: reversible, obviously not secure, and
// enough to prove that nothing is written in the clear.
function fakeSafeStorage ({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`enc::${value}`, 'utf8'),
    decryptString: buffer => buffer.toString('utf8').replace(/^enc::/, '')
  }
}

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-auth-store-'))
}

test('round-trips a record and writes it encrypted', () => {
  const dir = tempDir()
  const store = createStore({ dir, safeStorage: fakeSafeStorage() })
  store.set('chatgpt', { accessToken: 'secret-token', expiresAt: 123 })

  assert.deepEqual(store.get('chatgpt'), { accessToken: 'secret-token', expiresAt: 123 })
  const onDisk = fs.readFileSync(path.join(dir, 'chatgpt.json'), 'utf8')
  assert.ok(onDisk.startsWith('v1:'), 'file is versioned')
  assert.ok(!onDisk.includes('secret-token'), 'token is not written in the clear')
  assert.equal(fs.statSync(path.join(dir, 'chatgpt.json')).mode & 0o777, 0o600)
})

test('refuses to store anything when encryption is unavailable', () => {
  const dir = tempDir()
  const store = createStore({ dir, safeStorage: fakeSafeStorage({ available: false }) })
  assert.throws(
    () => store.set('chatgpt', { accessToken: 'x' }),
    /refusing to store the token in plaintext/
  )
  assert.equal(fs.existsSync(path.join(dir, 'chatgpt.json')), false)
})

test('a record that cannot be decrypted reads as missing', () => {
  const dir = tempDir()
  const store = createStore({ dir, safeStorage: fakeSafeStorage() })
  store.set('supergrok', { accessToken: 'abc' })
  // a different keychain, or a profile copied from another machine
  const other = createStore({
    dir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('x'),
      decryptString: () => {
        throw new Error('cannot decrypt')
      }
    }
  })
  assert.equal(other.get('supergrok'), null)
})

test('unknown provider names are rejected', () => {
  const store = createStore({ dir: tempDir(), safeStorage: fakeSafeStorage() })
  assert.throws(() => store.get('openai'), /Unsupported provider/)
})

test('host state merges instead of overwriting', () => {
  const dir = tempDir()
  const store = createStore({ dir, safeStorage: fakeSafeStorage() })
  store.setHost({ hostId: 'urn:uuid:1' })
  store.setHost({ clientIds: { chatgpt: 'client-1' } })
  assert.deepEqual(store.getHost(), {
    hostId: 'urn:uuid:1',
    clientIds: { chatgpt: 'client-1' }
  })
})

test('remove deletes only that provider', () => {
  const dir = tempDir()
  const store = createStore({ dir, safeStorage: fakeSafeStorage() })
  store.set('chatgpt', { accessToken: 'a' })
  store.set('supergrok', { accessToken: 'b' })
  store.remove('chatgpt')
  assert.equal(store.get('chatgpt'), null)
  assert.equal(store.get('supergrok').accessToken, 'b')
})
