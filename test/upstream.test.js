const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { EventEmitter } = require('events')

const { createFetchImpl, parseProxyRule, resolveUpstreamProxy } = require('../lib/upstream')

function startServer (handler) {
  const server = http.createServer(handler)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => server.close(done))
      })
    })
  })
}

test('fetch-shaped upstream calls: POST, JSON, text, status and headers', async () => {
  const seen = []
  const server = await startServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() })
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'yes' })
        res.end(JSON.stringify({ hello: 'world' }))
      } else {
        res.writeHead(418, { 'content-type': 'text/plain' })
        res.end('no')
      }
    })
  })
  try {
    const fetchImpl = createFetchImpl()
    const res = await fetchImpl(`${server.url}/ok`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 })
    })
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-test'), 'yes')
    assert.deepEqual(await res.json(), { hello: 'world' })
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].body, '{"a":1}')

    const bad = await fetchImpl(`${server.url}/bad`)
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 418)
    assert.equal(await bad.text(), 'no')
  } finally {
    await server.close()
  }
})

test('follows redirects and switches to GET on 303', async () => {
  const methods = []
  const server = await startServer((req, res) => {
    methods.push(req.method)
    if (req.url === '/start') {
      res.writeHead(303, { location: '/final' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"done":true}')
  })
  try {
    const res = await createFetchImpl()(`${server.url}/start`, {
      method: 'POST',
      body: 'x=1'
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { done: true })
    assert.deepEqual(methods, ['POST', 'GET'])
  } finally {
    await server.close()
  }
})

test('the proxy agent is handed to the request layer', async () => {
  // Stub http.request: a real agent would open a CONNECT tunnel. What matters
  // here is that every upstream call carries the configured agent.
  const https = require('https')
  const originalHttp = http.request
  const originalHttps = https.request
  const seen = []
  function fakeRequest (url, options, cb) {
    seen.push(options.agent)
    const req = new EventEmitter()
    req.end = () => setImmediate(() => req.emit('error', new Error('stopped by test')))
    req.destroy = () => {}
    return req
  }
  http.request = fakeRequest
  https.request = fakeRequest
  try {
    const agent = { marker: 'electerm-proxy-agent' }
    const fetchImpl = createFetchImpl({ agent })
    await assert.rejects(
      fetchImpl('https://api.openai.com/v1/models'),
      /stopped by test/
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0], agent)
  } finally {
    http.request = originalHttp
    https.request = originalHttps
  }
})

test('an aborted signal stops the request', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200).end('late')
  })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      createFetchImpl()(`${server.url}/`, { signal: controller.signal }),
      /aborted/
    )
  } finally {
    await server.close()
  }
})

test('a Chromium proxy rule becomes a proxy URL', () => {
  assert.equal(parseProxyRule('PROXY 127.0.0.1:10808; DIRECT'), 'http://127.0.0.1:10808')
  assert.equal(parseProxyRule('SOCKS5 127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
  assert.equal(parseProxyRule('DIRECT'), '')
  assert.equal(parseProxyRule(''), '')
})

test('the widget field wins, then HTTPS_PROXY, then the system proxy', async () => {
  const saved = [process.env.HTTPS_PROXY, process.env.https_proxy]
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  try {
    assert.deepEqual(
      await resolveUpstreamProxy({ upstreamProxy: 'http://one:1' }),
      { url: 'http://one:1', source: 'config' }
    )
    process.env.HTTPS_PROXY = 'http://two:2'
    assert.deepEqual(
      await resolveUpstreamProxy({}),
      { url: 'http://two:2', source: 'env' }
    )
    delete process.env.HTTPS_PROXY
    // no electron under node --test: the system lookup is skipped, not thrown
    assert.deepEqual(await resolveUpstreamProxy({}), { url: '', source: '' })
  } finally {
    if (saved[0] === undefined) {
      delete process.env.HTTPS_PROXY
    } else {
      process.env.HTTPS_PROXY = saved[0]
    }
    if (saved[1] === undefined) {
      delete process.env.https_proxy
    } else {
      process.env.https_proxy = saved[1]
    }
  }
})

test('the system proxy is read from Electron when nothing else is set', async () => {
  const Module = require('module')
  const load = Module._load
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        session: {
          defaultSession: {
            resolveProxy: async url => {
              assert.match(url, /^https:/)
              return 'PROXY 127.0.0.1:7890; DIRECT'
            }
          }
        }
      }
    }
    return load.apply(this, arguments)
  }
  const saved = [process.env.HTTPS_PROXY, process.env.https_proxy]
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  try {
    assert.deepEqual(
      await resolveUpstreamProxy({}),
      { url: 'http://127.0.0.1:7890', source: 'system' }
    )
  } finally {
    Module._load = load
    if (saved[0] !== undefined) {
      process.env.HTTPS_PROXY = saved[0]
    }
    if (saved[1] !== undefined) {
      process.env.https_proxy = saved[1]
    }
  }
})
