/**
 * The local HTTP server: an OpenAI Responses endpoint on 127.0.0.1 that
 * forwards to the provider with the subscription token, plus a small admin
 * page for signing in.
 *
 * Why a proxy at all: electerm already speaks the Responses wire format
 * (src/app/lib/ai-format.js), and every AI feature reads baseURLAI /
 * apiPathAI from config at call time. So pointing the config at
 * http://localhost:<port>/v1 with path /responses makes chat, agent mode with
 * tools, AI bookmarks, themes, quick commands and command suggestions all use
 * the subscription, with no changes to electerm itself.
 *
 * The body is passed through almost untouched. The two edits are:
 *   - `store: false`, which subscription-backed requests require and which
 *     electerm's own request builder never sets;
 *   - `Authorization`, replaced with the subscription access token.
 */

const http = require('http')
const https = require('https')
const { renderPage } = require('./page')

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

// One upstream call, streamed back. Nothing is buffered: a chat answer arrives
// as the provider writes it, and the SSE bytes reach electerm's parser intact.
function forward (target, { method, headers, body, res, onLog }) {
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

function createProxyServer ({
  port = 8788,
  provider = 'chatgpt',
  auth,
  log = () => {},
  endpoints
}) {
  const target = endpoints || PROVIDERS[provider] || PROVIDERS.chatgpt
  const label = (PROVIDERS[provider] || PROVIDERS.chatgpt).label
  let servers = []
  let boundPort = port

  function baseUrl () {
    return `http://localhost:${boundPort}`
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

  async function handleResponses (req, res) {
    let body
    try {
      const raw = await readBody(req)
      body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
    } catch (error) {
      sendError(res, 400, `Cannot read the request body: ${error.message}`)
      return
    }
    if (body && typeof body === 'object') {
      // Required for subscription-backed requests; electerm's builder omits it.
      body.store = false
    }
    let token
    try {
      token = await accessToken()
    } catch (error) {
      sendError(res, 401, error.message)
      return
    }
    const payload = Buffer.from(JSON.stringify(body))
    try {
      const status = await forward(target.responses, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          authorization: `Bearer ${token}`,
          accept: body.stream ? 'text/event-stream' : 'application/json',
          // ask for the bytes as they are: the SSE has to arrive unbuffered
          'accept-encoding': 'identity'
        },
        body: payload,
        res,
        onLog: log
      })
      log('info', `${label} ${body.stream ? 'stream' : 'request'} -> ${status}`)
    } catch (error) {
      log('error', `Upstream request failed: ${error.message}`)
      if (!res.headersSent) {
        sendError(res, 502, `Cannot reach ${label}: ${error.message}`)
      }
    }
  }

  const routes = {
    'GET /': (req, res) => {
      const html = renderPage({ provider, label, port: boundPort })
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
        signingIn: auth.isSigningIn()
      })
    },
    'POST /admin/signin': async (req, res) => {
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
      try {
        await auth.signOut()
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendError(res, 400, error.message)
      }
    },
    'POST /admin/cancel': (req, res) => {
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

  function route (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = `${req.method} ${url.pathname}`
    const handler = routes[key]
    if (handler) {
      Promise.resolve(handler(req, res)).catch(error => {
        log('error', `${key} failed: ${error.message}`)
        if (!res.headersSent) {
          sendError(res, 500, error.message)
        }
      })
      return
    }
    sendError(res, 404, `No route for ${key}. AI requests go to /v1/responses.`)
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
