/**
 * electerm widget entry: one instance = one proxy for one provider.
 *
 * This is an `instance` widget that also ships `electerm.ui`: electerm starts
 * it on launch (manifest `autoRun`) and renders ui/index.html inside the widget
 * panel. That page calls the functions exported below through
 * `window.electerm.call`, which run in this same main-process module -- so
 * signing in no longer means opening a separate localhost page in a browser.
 *
 * The proxy still serves its own admin page (lib/page.js) as a fallback for
 * older electerm builds and for anyone who wants to drive it from a browser.
 */

const path = require('path')
const { randomBytes } = require('crypto')
const { createStore } = require('./lib/store')
const { createChatGPTAuth } = require('./lib/chatgpt')
const { createGrokAuth } = require('./lib/grok')
const { createProxyServer, PROVIDERS } = require('./lib/proxy')
const { createFetchImpl, resolveUpstreamProxy } = require('./lib/upstream')

const DEFAULT_PORT = 8788
const TOKEN_DIR = '.ai-auth-proxy'

// The running proxy, shared with the panel through electerm's widget bridge.
// There is only one instance (singleInstance: true), so a module-level slot is
// enough. `boot` keeps the latest widgetRun so a panel call can start the proxy
// itself when the host did not (or its start failed): "not running" should be a
// recoverable state, not a dead panel. An explicit stop clears it.
let active = null
let boot = null
let lastStartAttempt = 0
let lastStartError = null

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
 * and kept, so the value electerm applies stays valid across restarts.
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
  description: 'Sign in to a ChatGPT or SuperGrok subscription from this panel, then apply the AI settings it offers.',
  version: '0.3.1',
  author: 'ZHAO Xudong',
  type: 'instance',
  builtin: false,
  singleInstance: true,
  autoRun: true,
  ui: 'ui/index.html',
  configs: [
    {
      name: 'provider',
      type: 'select',
      label: 'Provider',
      default: 'chatgpt',
      description: 'Which subscription the proxy forwards to. The panel can switch it without restarting.',
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
      name: 'upstreamProxy',
      type: 'string',
      label: 'Upstream proxy',
      default: '',
      description: 'Proxy for sign-in and API calls (http://... or socks5://...). Empty uses HTTPS_PROXY, then the system proxy, then a direct connection.'
    }
  ]
}

/**
 * The AI config electerm offers to apply. With `withModel` it asks the provider
 * for the model list (only after signing in) so the user does not have to open
 * "Load models" and pick one by hand. A failed list is not an error here: the
 * offer still works and electerm's own model button can fill it in later.
 */
async function aiConfigFor (state, withModel = false) {
  const out = {
    nameAI: `${state.label} subscription`,
    baseURLAI: `${state.url}/v1`,
    apiPathAI: '/responses',
    apiKeyAI: state.secret,
    authHeaderNameAI: 'Authorization: Bearer',
    // The endpoint is loopback, so applying these settings clears electerm's
    // AI Proxy. The widget's own upstream proxy is a separate user setting.
    proxyAI: ''
  }
  if (withModel) {
    try {
      const models = await state.server.listModels()
      if (models.length) {
        out.modelAI = models[0]
      }
    } catch (error) {
      // not signed in yet, or the provider refused: leave the model out
    }
  }
  return out
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

  // The user sets the upstream proxy in this widget's config, or in the
  // standard HTTPS_PROXY env var; otherwise the system proxy is used (see
  // doStart). electerm only supplies the agent factory; its own AI Proxy
  // setting is cleared by the offer below, because the AI client reaches this
  // widget over loopback and must not use that proxy.

  let server = null
  let auths = null
  let secret = ''
  let starting = null
  let startResult = null
  // Panel-editable network setting. Kept apart from `config` so a value typed
  // in the panel applies on the next start without the host re-running the
  // widget form (an instance widget with `electerm.ui` has no form at all).
  const settings = {
    upstreamProxy: String(config.upstreamProxy || '').trim()
  }

  async function doStart () {
    // Required lazily: this module is also loaded by `node --test`, where
    // electron does not exist.
    const { safeStorage, shell } = require('electron')
    // Which proxy the upstream calls use, resolved when the proxy starts:
    // the widget's own field, then HTTPS_PROXY, then the OS proxy Chromium
    // would use. Node ignores the OS setting, so without the last step a VPN
    // that only configures the system proxy leaves these calls at 403.
    const upstream = await resolveUpstreamProxy(settings)
    let agent = null
    if (upstream.url) {
      agent = typeof ctx.createProxyAgent === 'function'
        ? ctx.createProxyAgent(upstream.url)
        : null
    }
    // Older electerm builds hand over a finished agent instead of a factory.
    if (!agent) {
      agent = ctx.proxyAgent || null
    }
    const fetchImpl = agent ? createFetchImpl({ agent }) : globalThis.fetch
    log(
      'info',
      upstream.url
        ? `upstream through ${upstream.url} (${upstream.source})`
        : 'upstream direct'
    )
    const store = createStore({ dir: tokenDir(), safeStorage })
    const deps = {
      store,
      log,
      fetchImpl,
      openExternal: url => shell.openExternal(url)
    }
    // Both auth objects are cheap and share the token store, so the panel can
    // switch provider without stopping the listener and changing the port.
    auths = {
      chatgpt: createChatGPTAuth(deps),
      supergrok: createGrokAuth(deps)
    }
    secret = ensureSecret(store, log)
    server = createProxyServer({
      port,
      provider,
      auth: auths[provider],
      secret,
      log,
      agent,
      fetchImpl
    })
    const { url } = await server.start()
    const status = auths[provider].status()
    active = {
      instanceId,
      provider,
      label,
      port,
      url,
      secret,
      server,
      auths,
      instance,
      config,
      ctx,
      settings,
      viaProxy: !!agent,
      upstreamProxy: upstream.url,
      upstreamSource: upstream.source
    }
    lastStartError = null
    startResult = {
      success: true,
      msg: status.connected
        ? `${label} proxy is running at ${url}`
        : `${label} proxy is running at ${url} - sign in from this panel`,
      // Offered, never written by the widget: the panel's "Use these settings"
      // button applies it (see electerm's app/widgets/ai-config.js).
      aiConfig: await aiConfigFor(active),
      serverInfo: {
        url,
        path: 'Sign in in this panel, then press "Use these settings" above'
      }
    }
    return startResult
  }

  // Idempotent: the host calls start() on run, and a panel call may call it
  // again to recover a failed start. One listener, one token store, one result.
  async function start () {
    if (active && active.instanceId === instanceId) {
      return startResult
    }
    if (starting) {
      return starting
    }
    starting = doStart()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  async function stop () {
    // An explicit stop is a decision, not a crash: do not let the next panel
    // poll quietly restart it. A failed start has no active proxy, so it stays
    // retryable.
    if (boot && boot.instance === instance && active && active.instanceId === instanceId) {
      boot.stopped = true
    }
    if (active && active.instanceId === instanceId) {
      active = null
    }
    startResult = null
    if (server) {
      const closing = server
      server = null
      await closing.stop()
      log('info', 'AI proxy stopped')
    }
  }

  // A proxy change needs a new agent, and an agent cannot be swapped into a
  // running listener: rebuild it. Tokens live on disk, so nothing is lost; a
  // sign-in that was still pending has to be redone.
  async function restart () {
    if (active && active.instanceId === instanceId) {
      const closing = server
      active = null
      server = null
      startResult = null
      await closing.stop()
    }
    return start()
  }

  async function applyUpstreamProxy (value) {
    settings.upstreamProxy = String(value || '').trim()
    if (active && active.instanceId === instanceId) {
      await restart()
    }
    return {
      upstreamProxy: settings.upstreamProxy,
      status: active ? await getStatus() : null
    }
  }

  const instance = { instanceId, start, stop, restart, applyUpstreamProxy }
  boot = { instance, stopped: false }
  return instance
}

async function ensureActive () {
  if (active) {
    return active
  }
  if (boot && !boot.stopped && Date.now() - lastStartAttempt > 3000) {
    lastStartAttempt = Date.now()
    try {
      await boot.instance.start()
    } catch (error) {
      lastStartError = error
    }
  }
  if (active) {
    return active
  }
  const why = lastStartError ? `: ${lastStartError.message}` : ''
  throw new Error(`The AI proxy is not running. Press Run in the widget panel${why}`)
}

// ---- panel API: window.electerm.call(name, ...args) ----

async function getStatus () {
  const s = await ensureActive()
  const auth = s.auths[s.provider]
  const status = auth.status() || {}
  return {
    provider: s.provider,
    label: s.label,
    url: s.url,
    port: s.port,
    viaProxy: s.viaProxy,
    upstream: s.upstreamProxy || '',
    upstreamSource: s.upstreamSource || '',
    // What the user typed, as opposed to `upstream` (what is actually used).
    configured: s.settings ? s.settings.upstreamProxy : '',
    connected: !!status.connected,
    email: status.email || '',
    planUsageEnabled: !!status.planUsageEnabled,
    pending: !!(status.pending || (typeof auth.isSigningIn === 'function' && auth.isSigningIn())),
    userCode: status.userCode || '',
    verificationUrl: status.verificationUrl || '',
    error: status.error || ''
  }
}

async function getAIConfig () {
  return { aiConfig: await aiConfigFor(await ensureActive(), true) }
}

async function signIn () {
  const s = await ensureActive()
  const auth = s.auths[s.provider]
  const result = s.provider === 'supergrok'
    ? await auth.beginSignIn()
    : await auth.signIn()
  return { ...(result || {}), status: await getStatus() }
}

async function signOut () {
  const s = await ensureActive()
  await s.auths[s.provider].signOut()
  return getAIConfig()
}

async function cancelSignIn () {
  const s = await ensureActive()
  return s.auths[s.provider].cancel()
}

async function listModels () {
  return { models: await (await ensureActive()).server.listModels() }
}

// Changes the upstream proxy from the panel and restarts the listener so the
// new agent is in place before the next request.
async function setUpstreamProxy (value) {
  const target = (active && active.instance) || (boot && boot.instance)
  if (!target) {
    throw new Error('The AI proxy is not running. Press Run in the widget panel')
  }
  return target.applyUpstreamProxy(value)
}

async function setProvider (value) {
  const s = await ensureActive()
  const next = value === 'supergrok' ? 'supergrok' : 'chatgpt'
  if (next !== s.provider) {
    const previous = s.auths[s.provider]
    if (typeof previous.cancel === 'function') {
      previous.cancel()
    }
    s.server.setProvider(next, s.auths[next])
    s.provider = next
    s.label = PROVIDERS[next].label
  }
  return getAIConfig()
}

// A real non-streaming request through the same path the agent panel uses.
// "Connected" and "the AI panel works" are not the same claim.
async function testRequest () {
  const s = await ensureActive()
  let model
  try {
    model = (await s.server.listModels())[0]
  } catch (error) {
    return { ok: false, message: error.message }
  }
  const res = await fetch(`${s.url}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${s.secret}`
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: 'Say OK' }],
      stream: false
    })
  })
  const text = await res.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch (e) {}
  const answer = (body.output || [])
    .map(item => (item.content || []).map(part => part.text || '').join(''))
    .join('')
  return {
    ok: res.ok,
    status: res.status,
    message: res.ok
      ? (answer || '(empty answer)')
      : ((body.error && body.error.message) || text.slice(0, 200))
  }
}

module.exports = {
  widgetInfo,
  widgetRun,
  getStatus,
  getAIConfig,
  signIn,
  signOut,
  cancelSignIn,
  listModels,
  setProvider,
  setUpstreamProxy,
  testRequest
}
