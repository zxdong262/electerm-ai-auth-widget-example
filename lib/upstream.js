/**
 * Upstream HTTP for the provider, with optional proxy support.
 *
 * The widget used to call `globalThis.fetch` for OAuth and the model list, and
 * a bare `https.request` for the Responses stream. Neither honoured a proxy, so
 * in a network where OpenAI is only reachable through one, sign-in failed at
 * OIDC discovery with a Cloudflare 403 while electerm's own AI calls to
 * `localhost` were being sent through that same proxy (see issue #4591).
 *
 * This module gives every upstream call one transport: a small fetch-shaped
 * wrapper around http/https.request, with an `agent` electerm's
 * `createProxyAgent` factory builds from the proxy URL the user set on this
 * widget. Using the request API (rather than undici's dispatcher) means one
 * agent works for OAuth, models and the streamed response, and supports both
 * HTTP and SOCKS proxies without adding a dependency to the widget folder.
 *
 * It also answers "which proxy", because Node ignores the OS proxy settings
 * Chromium follows: the widget's own field first, then HTTPS_PROXY, then the
 * system proxy resolved through Electron's session (resolveUpstreamProxy).
 *
 * Only the parts of the Fetch API the OAuth code uses are implemented: ok,
 * status, headers.get, text() and json(). No streaming here -- the Responses
 * SSE goes straight through proxy.js with the same agent.
 */

const http = require('http')
const https = require('https')

const REDIRECTS = [301, 302, 303, 307, 308]

function toBuffer (body) {
  if (body == null) {
    return null
  }
  if (Buffer.isBuffer(body)) {
    return body
  }
  return Buffer.from(String(body), 'utf8')
}

function shape (status, headers, body) {
  const text = () => Promise.resolve(body.toString('utf8'))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => {
        const value = headers[String(name).toLowerCase()]
        return Array.isArray(value) ? value.join(', ') : (value == null ? null : String(value))
      }
    },
    text,
    json: () => text().then(value => JSON.parse(value))
  }
}

function oneRequest (url, options, agent) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const headers = { ...(options.headers || {}) }
    const body = toBuffer(options.body)
    if (body && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
      headers['content-length'] = body.length
    }
    const req = transport.request(target, {
      method: options.method || 'GET',
      headers,
      agent: agent || undefined
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(shape(res.statusCode || 502, res.headers, Buffer.concat(chunks))))
      res.on('error', reject)
    })
    req.on('error', reject)
    const signal = options.signal
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('The request was aborted'))
        return
      }
      const onAbort = () => req.destroy(new Error('The request was aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    req.end(body || undefined)
  })
}

// Chromium proxy rules look like "PROXY 127.0.0.1:10808; DIRECT" or
// "SOCKS5 127.0.0.1:1080". Node has no idea about any of this, which is why a
// desktop VPN that only sets the system proxy leaves Node's own requests
// blocked: the DNS/TLS traffic goes out unproxied and Cloudflare answers 403.
const RULE_PROTOCOLS = {
  PROXY: 'http',
  HTTPS: 'http',
  SOCKS: 'socks5',
  SOCKS4: 'socks5',
  SOCKS5: 'socks5'
}

function parseProxyRule (rule) {
  for (const part of String(rule || '').split(';')) {
    const [kind, address] = part.trim().split(/\s+/)
    const protocol = RULE_PROTOCOLS[String(kind || '').toUpperCase()]
    if (protocol && address) {
      return `${protocol}://${address}`
    }
  }
  return ''
}

async function systemProxy (url) {
  try {
    // Absent under `node --test` and in the web app, which has no session.
    const { session } = require('electron')
    if (!session || !session.defaultSession) {
      return ''
    }
    return parseProxyRule(await session.defaultSession.resolveProxy(url))
  } catch (error) {
    return ''
  }
}

/**
 * Which proxy the upstream calls should use, and why.
 *
 * Order: the widget's own setting, then HTTPS_PROXY, then whatever the OS
 * tells Chromium. The last one is what makes sign-in work with no config on a
 * machine where a VPN is set as the system proxy.
 */
async function resolveUpstreamProxy (config = {}, url = 'https://auth.openai.com') {
  const explicit = String(config.upstreamProxy || '').trim()
  if (explicit) {
    return { url: explicit, source: 'config' }
  }
  const fromEnv = String(process.env.HTTPS_PROXY || process.env.https_proxy || '').trim()
  if (fromEnv) {
    return { url: fromEnv, source: 'env' }
  }
  const system = await systemProxy(url)
  if (system) {
    return { url: system, source: 'system' }
  }
  return { url: '', source: '' }
}

function createFetchImpl ({ agent = null, maxRedirects = 5 } = {}) {
  async function fetchImpl (input, options = {}) {
    let url = String(input)
    let next = { ...options }
    for (let i = 0; i <= maxRedirects; i++) {
      const res = await oneRequest(url, next, agent)
      const location = REDIRECTS.includes(res.status) && res.headers.get('location')
      if (!location || i === maxRedirects) {
        return res
      }
      url = new URL(location, url).toString()
      // 303 means "look at this with GET"; the others keep the method.
      next = res.status === 303
        ? { ...next, method: 'GET', body: undefined }
        : { ...next }
    }
    throw new Error('Too many redirects')
  }
  return fetchImpl
}

module.exports = { createFetchImpl, parseProxyRule, resolveUpstreamProxy }
