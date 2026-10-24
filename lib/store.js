/**
 * Token storage, encrypted with the OS keystore through Electron `safeStorage`.
 *
 * Two rules, both deliberate:
 *   - no plaintext fallback. If the OS cannot encrypt (a Linux session without
 *     a keyring, for example), saving is refused instead of writing a token
 *     that anyone with read access to the profile can use.
 *   - the files live OUTSIDE the widget folder. Every file under
 *     `<data>/widgets/<id>/` is served to the widget's own page by the
 *     electerm-widget:// protocol, and a token file has no business being
 *     reachable from a document.
 */

const fsDefault = require('fs')
const pathDefault = require('path')
const { randomUUID } = require('crypto')

const PROVIDERS = new Set(['chatgpt', 'supergrok'])
const VERSION = 'v1:'

function createStore ({
  dir,
  safeStorage,
  fs = fsDefault,
  path = pathDefault,
  random = randomUUID
}) {
  if (!dir) {
    throw new Error('token store needs a directory')
  }

  function encrypt (value) {
    if (
      !safeStorage ||
      typeof safeStorage.isEncryptionAvailable !== 'function' ||
      !safeStorage.isEncryptionAvailable()
    ) {
      throw new Error(
        'OS-backed encryption is unavailable, refusing to store the token in plaintext'
      )
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  function readFile (name) {
    let ciphertext
    try {
      ciphertext = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch (e) {
      return null
    }
    if (!ciphertext.startsWith(VERSION)) {
      return null
    }
    try {
      const plain = safeStorage.decryptString(
        Buffer.from(ciphertext.slice(VERSION.length), 'base64')
      )
      return JSON.parse(plain)
    } catch (e) {
      // A different OS user, a reset keychain, or a profile copied from
      // another machine all land here. Returning null makes the caller ask
      // for a fresh sign-in instead of failing at request time.
      return null
    }
  }

  function writeFile (name, value) {
    const ciphertext = VERSION + encrypt(JSON.stringify(value))
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, name)
    const temp = `${target}.${random()}.tmp`
    try {
      fs.writeFileSync(temp, ciphertext, { mode: 0o600 })
      fs.renameSync(temp, target)
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true })
      } catch (_) {}
      throw error
    }
  }

  function assertProvider (provider) {
    if (!PROVIDERS.has(provider)) {
      throw new Error(`Unsupported provider: ${provider}`)
    }
  }

  return {
    get (provider) {
      assertProvider(provider)
      return readFile(`${provider}.json`)
    },
    set (provider, record) {
      assertProvider(provider)
      writeFile(`${provider}.json`, record)
    },
    remove (provider) {
      assertProvider(provider)
      try {
        fs.rmSync(path.join(dir, `${provider}.json`), { force: true })
      } catch (_) {}
    },
    // host id and the dynamically issued client id are not secrets, but they
    // are just as specific to this install, so they travel with the tokens.
    getHost () {
      return readFile('host.json') || {}
    },
    setHost (patch) {
      writeFile('host.json', { ...readFile('host.json'), ...patch })
    }
  }
}

module.exports = { createStore, PROVIDERS }
