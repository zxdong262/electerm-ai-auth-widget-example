/**
 * The local HTTP server: an OpenAI Responses endpoint on 127.0.0.1 that
 * forwards to the provider with the subscription token, plus a small admin
 * page for signing in.
 *
 * Why a proxy at all: electerm already speaks the Responses wire format
 * (src/app/lib/ai-format.js), and every AI feature reads baseURLAI /
 * apiPathAI / apiKeyAI from config at call time. So pointing the config at
 * http://localhost:<port>/v1 with path /responses makes chat, agent mode with
 * tools, AI bookmarks, themes, quick commands and command suggestions all use
 * the subscription, with no changes to electerm itself.
 *
 * What it changes in the request, and why:
 *   - `store: false`, which subscription-backed requests require and which
 *     electerm's own request builder never sets;
 *   - `stream: true`, always. The subscription backend rejects `stream: false`,
 *     but electerm's agent loop and its AI bookmark / theme / quick command
 *     editors all ask for a single JSON answer. Those requests are collapsed
 *     back into one object from the event stream (lib/sse.js);
 *   - `Authorization`, replaced with the subscription access token.
 *
 * Who may call it: only electerm, and only with the proxy key the sign-in page
 * shows. A local port with a spending credential behind it needs both halves:
 * the key proves the caller read the page, the Host check stops a DNS-rebinding
 * page from becoming same-origin, and the Origin check stops a cross-site POST.
 */

const http = require('http')
const https = require('https')
const { timingSafeEqual, randomBytes } = require('crypto')
const { renderPage } = require('./page')
const { collapseResponsesStream } = require('./sse')

const PROVIDERS = {
  chatgpt: {
    label: 'ChatGPT',
    responses: 'https://api.openai.com/v1/responses',
    models: 'https://api.openai.com/v1/models'
  },
  supergrok: {
    label: 'SuperGrok',
    responses: 'https://api.x.ai/v1/responses',
    models: 'https://api.x.ai/v1/models'
  }
}

const MAX_BODY = 20 * 1024 * 1024
const RECENT_LIMIT = 8

function sendJson (res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function sendError (res, status, message) {
  sendJson(res, status, { error: { message, type: 'proxy_error' } })
}

function readBody (req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Constant-time compare. A wrong length short-circuits before the comparison,
// which is fine: the length of the key is not the secret.
function secretMatches (given, expected) {
  if (!expected || typeof given !== 'string' || !given) {
    return false
  }
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

function bearer (req) {
  const raw = String(req.headers.authorization || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(raw)
  if (match) {
    return match[1].trim()
  }
  // a user who changed "Auth header" in electerm's AI config still gets in
  const key = req.headers['x-api-key']
  return typeof key === 'string' ? key.trim() : ''
}

// One upstream call, streamed back. Nothing is buffered: a chat answer arrives
// as the provider writes it, and the SSE bytes reach electerm's parser intact.
function forwardStream (target, { method, headers, body, res, onLog }) {
  const url = new URL(target)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const upstream = transport.request(url, { method, headers }, upstreamRes => {
      const outHeaders = { 'cache-control': 'no-store' }
      for (const key of ['content-type', 'x-request-id', 'openai-processing-ms']) {
        if (upstreamRes.headers[key]) {
          outHeaders[key] = upstreamRes.headers[key]
        }
      }
      res.writeHead(upstreamRes.statusCode || 502, outHeaders)
      upstreamRes.pipe(res)
      upstreamRes.on('error', err => {
        onLog('error', `Upstream stream failed: ${err.message}`)
        res.destroy(err)
      })
      upstreamRes.on('end', () => resolve(upstreamRes.statusCode || 502))
    })
    // electerm destroys its socket when the user hits stop; the upstream
    // request has to go with it, or the provider keeps generating.
    res.on('close', () => {
      if (!res.writableEnded) {
        upstream.destroy()
      }
    })
    upstream.on('error', err => {
      if (res.headersSent) {
        res.destroy(err)
        return
      }
      reject(err)
    })
    upstream.end(body)
  })
}

// The same call, buffered: used for the non-streaming path, where the whole
// event stream has to be read before one JSON object can be built.
function callUpstream (target, { method, headers, body }) {
  const url = new URL(target)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const upstream = transport.request(url, { method, headers }, upstreamRes => {
      const chunks = []
      upstreamRes.on('data', chunk => chunks.push(chunk))
      upstreamRes.on('end', () => resolve({
        status: upstreamRes.statusCode || 502,
        contentType: upstreamRes.headers['content-type'] || '',
        body: Buffer.concat(chunks)
      }))
      upstreamRes.on('error', reject)
    })
    upstream.on('error', reject)
    upstream.end(body)
  })
}

function createProxyServer ({
  port = 8788,
  provider = 'chatgpt',
  auth,
  secret,
  log = () => {},
  endpoints
}) {
  if (!secret) {
    throw new Error('the proxy needs a key: without one any local process can spend the subscription')
  }
  const target = endpoints || PROVIDERS[provider] || PROVIDERS.chatgpt
  const label = (PROVIDERS[provider] || PROVIDERS.chatgpt).label
  const csrf = randomBytes(18).toString('base64url')
  const recent = []
  let servers = []
  let boundPort = port

  function baseUrl () {
    return `http://localhost:${boundPort}`
  }

  function hostNames () {
    return [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`]
  }

  // Two checks, one purpose: make sure the request was addressed to this
  // server by a page that is allowed to talk to it.
  //   Host   -- a page on evil.com that DNS-rebinds to 127.0.0.1 keeps its own
  //             name in Host, so it never matches and is refused. This is the
  //             check that stops a browser page from becoming same-origin.
  //   Origin -- a cross-site POST from a page carries the page's origin. Same
  //             origin (our own page) is allowed, anything else is not.
  function guard (req, res) {
    const host = String(req.headers.host || '').toLowerCase()
    if (!hostNames().includes(host)) {
      log('warn', `Refused a request addressed to host "${host || '(none)'}"`)
      sendError(
        res,
        403,
        `This proxy only answers requests addressed to ${baseUrl()} (got Host: ${host || 'none'}).`
      )
      return false
    }
    const origin = String(req.headers.origin || '').toLowerCase()
    if (origin) {
      const allowed = hostNames().map(name => `http://${name}`)
      if (!allowed.includes(origin)) {
        log('warn', `Refused a request from origin "${origin}"`)
        sendError(res, 403, `Cross-site requests are not allowed (Origin: ${origin}).`)
        return false
      }
    }
    return true
  }

  function requireKey (req, res) {
    if (secretMatches(bearer(req), secret)) {
      return true
    }
    sendError(
      res,
      401,
      `Missing or wrong proxy key. Copy the "API key" value from ${baseUrl()} into electerm's AI settings.`
    )
    return false
  }

  // The admin page is same-origin by construction (guard above), so this is
  // the second lock: a token that only the page that the server rendered knows.
  function requireCsrf (req, res) {
    const given = String(req.headers['x-proxy-csrf'] || '')
    if (secretMatches(given, csrf)) {
      return true
    }
    sendError(res, 403, 'Missing or wrong page token, reload the proxy page and try again.')
    return false
  }

  async function accessToken () {
    return auth.getAccessToken()
  }

  async function listModels () {
    const token = await accessToken()
    const res = await fetch(target.models, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        `Could not list models (${res.status}): ${(body.error && body.error.message) || 'no details'}`
      )
    }
    let list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
    const hasVisibility = list.some(item => item && typeof item.visibility === 'string')
    if (hasVisibility) {
      list = list.filter(item => item.visibility === 'list')
    }
    const seen = new Set()
    const ids = []
    for (const item of list) {
      const id = typeof item === 'string' ? item : item && (item.slug || item.id || item.name)
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    return ids
  }

  async function handleResponses (req, res, entry) {
    const contentType = String(req.headers['content-type'] || '')
    // electerm always sends application/json. Anything else is a browser form
    // post, which cannot even set this header without a preflight.
    if (contentType && !/json/i.test(contentType)) {
      sendError(res, 415, 'Send the request as application/json.')
      return
    }
    let body
    try {
      const raw = await readBody(req)
      body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
    } catch (error) {
      sendError(res, 400, `Cannot read the request body: ${error.message}`)
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'The request body must be a JSON object.')
      return
    }

    const wantsStream = body.stream === true
    entry.model = typeof body.model === 'string' ? body.model : ''
    entry.stream = wantsStream
    // Required for subscription-backed requests; electerm's builder omits it.
    body.store = false
    // The subscription backend answers "Stream must be set to true" otherwise.
    body.stream = true

    let token
    try {
      token = await accessToken()
    } catch (error) {
      sendError(res, 401, error.message)
      return
    }
    const payload = Buffer.from(JSON.stringify(body))
    const headers = {
      'content-type': 'application/json',
      'content-length': payload.length,
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
      // ask for the bytes as they are: the SSE has to arrive unbuffered
      'accept-encoding': 'identity'
    }

    if (wantsStream) {
      try {
        const status = await forwardStream(target.responses, {
          method: 'POST',
          headers,
          body: payload,
          res,
          onLog: log
        })
        log('info', `${label} stream -> ${status}`)
      } catch (error) {
        log('error', `Upstream request failed: ${error.message}`)
        if (!res.headersSent) {
          sendError(res, 502, `Cannot reach ${label}: ${error.message}`)
        }
      }
      return
    }

    // Non-streaming caller (agent loop, AI bookmarks, themes, quick commands,
    // command suggestions): stream upstream, hand back one JSON object.
    let result
    try {
      result = await callUpstream(target.responses, {
        method: 'POST',
        headers,
        body: payload
      })
    } catch (error) {
      log('error', `Upstream request failed: ${error.message}`)
      sendError(res, 502, `Cannot reach ${label}: ${error.message}`)
      return
    }

    const text = result.body.toString('utf8')
    if (result.status < 200 || result.status >= 300) {
      // relay the provider's own error, unchanged and with its status
      res.writeHead(result.status, {
        'content-type': result.contentType || 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store'
      })
      res.end(text)
      log('info', `${label} request -> ${result.status}`)
      return
    }
    if (/json/i.test(result.contentType) || /^\s*[{[]/.test(text)) {
      // the provider answered with plain JSON anyway: pass it through
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store'
      })
      res.end(text)
      log('info', `${label} request -> 200`)
      return
    }

    const collapsed = collapseResponsesStream(text, { model: entry.model })
    if (collapsed.error) {
      log('error', `Could not fold the stream into a response: ${collapsed.error}`)
      sendError(res, 502, collapsed.error)
      return
    }
    sendJson(res, 200, collapsed.response)
    log('info', `${label} request -> 200 (folded from the event stream)`)
  }

  const routes = {
    'GET /': (req, res) => {
      const html = renderPage({
        provider,
        label,
        port: boundPort,
        secret,
        csrf
      })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store'
      })
      res.end(html)
    },
    'GET /admin/status': (req, res) => {
      sendJson(res, 200, {
        provider,
        label,
        port: boundPort,
        baseUrl: baseUrl(),
        auth: auth.status(),
        signingIn: auth.isSigningIn(),
        recent: recent.slice(0, RECENT_LIMIT)
      })
    },
    'POST /admin/signin': async (req, res) => {
      if (!requireCsrf(req, res)) {
        return
      }
      try {
        const result = provider === 'supergrok'
          ? await auth.beginSignIn()
          : await auth.signIn()
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        log('error', `Sign-in failed: ${error.message}`)
        sendError(res, 400, error.message)
      }
    },
    'POST /admin/signout': async (req, res) => {
      if (!requireCsrf(req, res)) {
        return
      }
      try {
        await auth.signOut()
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendError(res, 400, error.message)
      }
    },
    'POST /admin/cancel': (req, res) => {
      if (!requireCsrf(req, res)) {
        return
      }
      sendJson(res, 200, { ok: true, ...auth.cancel() })
    },
    'GET /admin/models': async (req, res) => {
      try {
        sendJson(res, 200, { models: await listModels() })
      } catch (error) {
        sendError(res, 400, error.message)
      }
    },
    'GET /v1/models': async (req, res) => {
      try {
        const ids = await listModels()
        sendJson(res, 200, {
          object: 'list',
          data: ids.map(id => ({ id, object: 'model' }))
        })
      } catch (error) {
        sendError(res, 502, error.message)
      }
    },
    'POST /v1/responses': handleResponses,
    'POST /v1/chat/completions': (req, res) => {
      // A wrong API path is the most likely first mistake, so say what to fix
      // instead of relaying a 404 from the provider.
      sendError(
        res,
        404,
        'This proxy only serves the Responses API. Set "API PATH" to /responses in electerm\'s AI config.'
      )
    }
  }

  function record (req, res, entry) {
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, ...rest) => {
      entry.status = status
      return writeHead(status, ...rest)
    }
    res.on('finish', () => {
      recent.unshift({ ...entry, at: Date.now() })
      recent.length = Math.min(recent.length, RECENT_LIMIT)
    })
  }

  function route (req, res) {
    if (!guard(req, res)) {
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = `${req.method} ${url.pathname}`
    const handler = routes[key]
    if (!handler) {
      sendError(res, 404, `No route for ${key}. AI requests go to /v1/responses.`)
      return
    }
    const entry = {
      method: req.method,
      path: url.pathname,
      status: 0,
      model: '',
      stream: null,
      source: String(req.headers['x-proxy-source'] || 'client')
    }
    // Every /v1 call needs the proxy key, including /v1/models. The wrong-path
    // hint is the exception: it costs nothing and is the message a user who
    // mistyped the path actually needs.
    const isAI = url.pathname.startsWith('/v1/')
    const needsKey = isAI && url.pathname !== '/v1/chat/completions'
    if (isAI) {
      record(req, res, entry)
    }
    if (needsKey && !requireKey(req, res)) {
      return
    }
    Promise.resolve(handler(req, res, entry)).catch(error => {
      log('error', `${key} failed: ${error.message}`)
      if (!res.headersSent) {
        sendError(res, 500, error.message)
      }
    })
  }

  return {
    get url () {
      return baseUrl()
    },
    start () {
      return new Promise((resolve, reject) => {
        // 127.0.0.1 is the address the AI config should use, but "localhost"
        // may resolve to ::1 first depending on the resolver, so the same port
        // is also opened there. Binding ::1 is best effort: a machine without
        // IPv6 loopback still gets a working proxy on 127.0.0.1.
        const primary = http.createServer(route)
        primary.once('error', error => {
          const hint = error.code === 'EADDRINUSE'
            ? `port ${port} is already in use, change the port in the widget config`
            : error.message
          reject(new Error(`Cannot start the AI proxy: ${hint}`))
        })
        primary.listen(port, '127.0.0.1', () => {
          boundPort = primary.address().port
          servers.push(primary)
          const v6 = http.createServer(route)
          v6.once('error', () => {
            // ::1 unavailable: keep the IPv4 listener and carry on
            resolve({ url: baseUrl(), port: boundPort })
          })
          v6.listen(boundPort, '::1', () => {
            servers.push(v6)
            log('info', `AI proxy for ${label} listening on ${baseUrl()}`)
            resolve({ url: baseUrl(), port: boundPort })
          })
        })
      })
    },
    stop () {
      return new Promise(resolve => {
        const closing = servers
        servers = []
        if (!closing.length) {
          resolve()
          return
        }
        let left = closing.length
        const done = () => {
          left -= 1
          if (left <= 0) {
            resolve()
          }
        }
        for (const server of closing) {
          server.close(done)
          // Keep-alive sockets from the AI panel would otherwise hold the port
          // until they time out, and the next start would fail on EADDRINUSE.
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections()
          }
        }
      })
    }
  }
}

module.exports = { createProxyServer, PROVIDERS }
