/**
 * The OAuth primitives both providers need, with no dependencies.
 *
 * `jsonwebtoken` is not used on purpose: a widget folder is loaded into the
 * app's main process, so every dependency it pulls in is a dependency the app
 * does not control. Node's crypto verifies an RS256 ID token in about ten
 * lines.
 */

const crypto = require('crypto')
const http = require('http')

const CALLBACK_PATH = '/auth/callback'

function createPkce (randomBytes = crypto.randomBytes) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Only the exact loopback callback we registered counts: same scheme, same
// host, same port, same path. Anything else is a redirect we did not ask for.
function isExactLoopbackCallback (expected, actual) {
  try {
    const a = new URL(expected)
    const b = new URL(actual)
    return (
      a.protocol === 'http:' &&
      a.hostname === '127.0.0.1' &&
      b.protocol === a.protocol &&
      b.hostname === a.hostname &&
      b.port === a.port &&
      a.pathname === CALLBACK_PATH &&
      b.pathname === a.pathname
    )
  } catch (e) {
    return false
  }
}

// One-shot listener for the authorization code. It binds an ephemeral port on
// 127.0.0.1 and only lives while a sign-in is in progress.
function createCallbackListener ({ timeoutMs = 5 * 60 * 1000 } = {}) {
  let server
  let timer
  let resolveCallback
  let rejectCallback
  let settled = false

  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  // The caller may never await this (the user closes the window instead), and
  // an unhandled rejection here would take the whole app down.
  callback.catch(() => {})

  function settle (fn, value) {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    fn(value)
  }

  const ready = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
        '<body style="font:14px system-ui;padding:40px">Sign-in finished, ' +
        'you can close this window and go back to electerm.</body>'
      )
      settle(resolveCallback, url.toString())
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`
      timer = setTimeout(
        () => settle(rejectCallback, new Error('Sign-in timed out')),
        timeoutMs
      )
      resolve({ redirectUri, callback })
    })
  })

  return {
    ready,
    close () {
      clearTimeout(timer)
      if (server) {
        server.close()
      }
    },
    cancel () {
      settle(rejectCallback, new Error('Sign-in cancelled'))
      if (server) {
        server.close()
      }
    }
  }
}

async function discoverOIDC (issuer, { fetchImpl = globalThis.fetch, signal } = {}) {
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
    signal,
    headers: { accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`Cannot read the provider configuration (${res.status})`)
  }
  const metadata = await res.json()
  // A discovery document that points at another host is the one way this flow
  // could be talked into sending a code somewhere else.
  const issuerHost = new URL(issuer).hostname
  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'registration_endpoint',
    'revocation_endpoint'
  ]) {
    if (!metadata[key]) {
      continue
    }
    const url = new URL(metadata[key])
    if (url.protocol !== 'https:' || url.hostname !== issuerHost) {
      throw new Error(`Provider configuration rejected: ${key} points elsewhere`)
    }
  }
  return metadata
}

function describeOAuthError (body) {
  if (!body || typeof body !== 'object') {
    return 'no details'
  }
  const code = typeof body.error === 'string' ? body.error : ''
  const text = typeof body.error_description === 'string' ? body.error_description : ''
  return [code, text].filter(Boolean).join(': ') || 'no details'
}

async function postForm (url, fields, { fetchImpl = globalThis.fetch, signal } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch (e) {
    body = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    // The provider's own wording is kept: "which scope was refused" is exactly
    // what someone debugging a subscription sign-in needs to see.
    throw new Error(`Provider refused the request (${res.status}): ${describeOAuthError(body)}`)
  }
  return body
}

function verifyIdToken (idToken, jwks, { issuer, audience, nonce, clock = Date.now }) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('Provider returned no usable identity token')
  }
  const [rawHeader, rawPayload, rawSignature] = idToken.split('.')
  let header
  let claims
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'))
  } catch (e) {
    throw new Error('Provider returned a malformed identity token')
  }
  const jwk = ((jwks && jwks.keys) || []).find(key => key && key.kid === header.kid)
  if (!jwk) {
    throw new Error('Identity token signed by an unknown key')
  }
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const valid = crypto.verify(
    'sha256',
    Buffer.from(`${rawHeader}.${rawPayload}`),
    key,
    Buffer.from(rawSignature, 'base64url')
  )
  if (!valid) {
    throw new Error('Identity token signature does not verify')
  }
  if (claims.iss !== issuer) {
    throw new Error('Identity token issued by an unexpected issuer')
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(audience)) {
    throw new Error('Identity token is meant for another client')
  }
  if (nonce && claims.nonce !== nonce) {
    throw new Error('Identity token nonce mismatch')
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= clock()) {
    throw new Error('Identity token expired')
  }
  return claims
}

module.exports = {
  CALLBACK_PATH,
  createPkce,
  isExactLoopbackCallback,
  createCallbackListener,
  discoverOIDC,
  describeOAuthError,
  postForm,
  verifyIdToken
}
