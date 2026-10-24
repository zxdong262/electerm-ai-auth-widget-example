const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')

const {
  createPkce,
  isExactLoopbackCallback,
  verifyIdToken
} = require('../lib/oauth')

const ISSUER = 'https://auth.example.test'

function signToken ({ payload, key, kid = 'k1' }) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(payload)}`
  const signature = crypto.sign('sha256', Buffer.from(data), key).toString('base64url')
  return `${data}.${signature}`
}

function keyPair () {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  // a real JWKS entry carries the kid that the token header points at
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  return { privateKey, jwk }
}

test('PKCE challenge is the base64url sha256 of the verifier', () => {
  const { verifier, challenge } = createPkce()
  assert.equal(verifier.length, 43)
  assert.equal(
    challenge,
    crypto.createHash('sha256').update(verifier).digest('base64url')
  )
})

test('only the exact loopback callback we registered is accepted', () => {
  const expected = 'http://127.0.0.1:52111/auth/callback'
  assert.equal(
    isExactLoopbackCallback(expected, 'http://127.0.0.1:52111/auth/callback?code=abc&state=1'),
    true
  )
  assert.equal(
    isExactLoopbackCallback(expected, 'http://127.0.0.1:52112/auth/callback?code=abc'),
    false,
    'different port'
  )
  assert.equal(
    isExactLoopbackCallback(expected, 'http://localhost:52111/auth/callback?code=abc'),
    false,
    'different host'
  )
  assert.equal(
    isExactLoopbackCallback(expected, 'http://127.0.0.1:52111/other?code=abc'),
    false,
    'different path'
  )
})

test('verifies a well-formed identity token', () => {
  const { privateKey, jwk } = keyPair()
  const nonce = 'nonce-1'
  const token = signToken({
    key: privateKey,
    payload: {
      iss: ISSUER,
      aud: 'client-1',
      nonce,
      sub: 'user-1',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1000) + 60
    }
  })
  const claims = verifyIdToken(token, { keys: [jwk] }, {
    issuer: ISSUER,
    audience: 'client-1',
    nonce
  })
  assert.equal(claims.sub, 'user-1')
  assert.equal(claims.email, 'user@example.com')
})

test('rejects a token signed by another key', () => {
  const { privateKey } = keyPair()
  const { jwk } = keyPair()
  const token = signToken({
    key: privateKey,
    payload: { iss: ISSUER, aud: 'client-1', nonce: 'n', sub: 'u', exp: Math.floor(Date.now() / 1000) + 60 }
  })
  assert.throws(
    () => verifyIdToken(token, { keys: [jwk] }, { issuer: ISSUER, audience: 'client-1', nonce: 'n' }),
    /signature does not verify/
  )
})

test('rejects a token with the wrong nonce, audience or issuer', () => {
  const { privateKey, jwk } = keyPair()
  const base = {
    iss: ISSUER,
    aud: 'client-1',
    nonce: 'expected',
    sub: 'u',
    exp: Math.floor(Date.now() / 1000) + 60
  }
  const token = signToken({ key: privateKey, payload: base })
  const opts = { issuer: ISSUER, audience: 'client-1', nonce: 'expected' }
  assert.throws(() => verifyIdToken(token, { keys: [jwk] }, { ...opts, nonce: 'other' }), /nonce/)
  assert.throws(() => verifyIdToken(token, { keys: [jwk] }, { ...opts, audience: 'other' }), /another client/)
  assert.throws(() => verifyIdToken(token, { keys: [jwk] }, { ...opts, issuer: 'https://evil.test' }), /issuer/)
})

test('rejects an expired token and a tampered payload', () => {
  const { privateKey, jwk } = keyPair()
  const opts = { issuer: ISSUER, audience: 'client-1', nonce: 'n' }
  const expired = signToken({
    key: privateKey,
    payload: {
      iss: ISSUER,
      aud: 'client-1',
      nonce: 'n',
      sub: 'u',
      exp: Math.floor(Date.now() / 1000) - 60
    }
  })
  assert.throws(() => verifyIdToken(expired, { keys: [jwk] }, opts), /expired/)

  const valid = signToken({
    key: privateKey,
    payload: {
      iss: ISSUER,
      aud: 'client-1',
      nonce: 'n',
      sub: 'u',
      exp: Math.floor(Date.now() / 1000) + 60
    }
  })
  const [header, , signature] = valid.split('.')
  const forged = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: 'client-1',
    nonce: 'n',
    sub: 'someone-else',
    exp: Math.floor(Date.now() / 1000) + 60
  })).toString('base64url')
  assert.throws(
    () => verifyIdToken(`${header}.${forged}.${signature}`, { keys: [jwk] }, opts),
    /signature does not verify/
  )
})
