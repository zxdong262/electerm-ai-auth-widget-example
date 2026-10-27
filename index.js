/**
 * electerm widget entry: one instance = one proxy for one provider.
 *
 * An `instance` widget (rather than a `frontend` one with a custom panel) is
 * the only kind electerm can start on launch: the "autoRun" checkbox in the
 * config form writes an entry that is replayed at startup. A widget that ships
 * `electerm.ui` gets a panel instead of the form, and with it no way to be
 * started automatically — which for a proxy that has to be listening before
 * the AI panel works is the wrong trade.
 *
 * The sign-in UI is therefore served by the proxy itself, at its own URL.
 */

const path = require('path')
const { randomBytes } = require('crypto')
const { createStore } = require('./lib/store')
const { createChatGPTAuth } = require('./lib/chatgpt')
const { createGrokAuth } = require('./lib/grok')
const { createProxyServer, PROVIDERS } = require('./lib/proxy')

const DEFAULT_PORT = 8788
const TOKEN_DIR = '.ai-auth-proxy'

/**
 * Where the encrypted tokens live: next to the widget folder, not inside it.
 *
 * Everything under `<data>/widgets/<id>/` is served to the widget's own page by
 * the electerm-widget:// protocol, so a token file there would be reachable
 * from a document. `<data>/widgets/.ai-auth-proxy/` is outside the id folder
 * and is skipped by the widget listing (dot names are ignored).
 */
function tokenDir () {
  return path.join(__dirname, '..', TOKEN_DIR)
}

/**
 * The key electerm sends as "API key".
 *
 * Without one, any page in the user's browser that guesses the port can spend
 * the subscription; the port alone is not a credential. It is generated once
 * and kept, so the value the user pastes into electerm stays valid across
 * restarts. If it cannot be stored encrypted, it still works for this run and
 * the log says it will change next time -- refusing to start would be worse
 * than a key the user has to re-copy.
 */
function ensureSecret (store, log) {
  const existing = store.getSecret()
  if (existing) {
    return existing
  }
  const key = `sk-local-${randomBytes(24).toString('base64url')}`
  try {
    store.setSecret(key)
  } catch (error) {
    log('warn', `Cannot save the proxy key (${error.message}), it will change on the next start`)
  }
  return key
}

const widgetInfo = {
  name: 'AI subscription proxy',
  description: 'Sign in to a ChatGPT or SuperGrok subscription, then point electerm\'s AI config at the local proxy it runs.',
  version: '0.2.0',
  author: 'ZHAO Xudong',
  type: 'instance',
  builtin: false,
  singleInstance: true,
  configs: [
    {
      name: 'provider',
      type: 'select',
      label: 'Provider',
      default: 'chatgpt',
      description: 'Which subscription the proxy forwards to. One proxy serves one provider.',
      choices: [
        { label: 'ChatGPT', value: 'chatgpt' },
        { label: 'SuperGrok', value: 'supergrok' }
      ]
    },
    {
      name: 'port',
      type: 'number',
      label: 'Local port',
      default: DEFAULT_PORT,
      description: 'The proxy listens on 127.0.0.1 at this port. Change it only if 8788 is taken; the URL in electerm\'s AI config has to match.'
    },
    {
      name: 'autoRun',
      type: 'boolean',
      label: 'Start with electerm',
      default: true,
      description: 'Start this widget when electerm starts, so the AI panel keeps working without opening the widget list first.'
    }
  ]
}

function widgetRun (config = {}, ctx = {}) {
  const instanceId = `ai-auth-proxy-${Date.now().toString(36)}`
  const provider = config.provider === 'supergrok' ? 'supergrok' : 'chatgpt'
  const label = PROVIDERS[provider].label
  const requestedPort = Number(config.port)
  const port = Number.isFinite(requestedPort) && requestedPort > 0
    ? requestedPort
    : DEFAULT_PORT
  const log = (level, message) => {
    if (typeof ctx.log === 'function') {
      ctx.log(level, message)
    }
    if (level === 'error') {
      console.error(`[${label} proxy] ${message}`)
    } else {
      console.log(`[${label} proxy] ${message}`)
    }
  }

  let server = null

  async function start () {
    // Required lazily: this module is also loaded by `node --test`, where
    // electron does not exist.
    const { safeStorage, shell } = require('electron')
    const store = createStore({ dir: tokenDir(), safeStorage })
    const deps = {
      store,
      log,
      openExternal: url => shell.openExternal(url)
    }
    const auth = provider === 'supergrok'
      ? createGrokAuth(deps)
      : createChatGPTAuth(deps)
    const secret = ensureSecret(store, log)
    server = createProxyServer({ port, provider, auth, secret, log })
    const { url } = await server.start()
    const status = auth.status()
    return {
      success: true,
      msg: status.connected
        ? `${label} proxy is running at ${url}`
        : `${label} proxy is running at ${url} - open it to sign in`,
      // Offered to electerm, not applied: the widget panel lists these values
      // and the user presses "Use these settings" (see electerm's
      // app/widgets/ai-config.js for the whitelist). The model is left out on
      // purpose -- this widget does not know which one the plan exposes until
      // the user asks, and electerm's own "Load models" button fills it in.
      aiConfig: {
        nameAI: `${label} subscription`,
        baseURLAI: `${url}/v1`,
        apiPathAI: '/responses',
        apiKeyAI: secret,
        authHeaderNameAI: 'Authorization: Bearer'
      },
      serverInfo: {
        url,
        path: 'Open this URL to sign in, then use "Use these settings" below'
      }
    }
  }

  async function stop () {
    if (server) {
      const closing = server
      server = null
      await closing.stop()
      log('info', 'AI proxy stopped')
    }
  }

  return { instanceId, start, stop }
}

module.exports = { widgetInfo, widgetRun }
