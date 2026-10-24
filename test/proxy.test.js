const test = require('node:test')
const assert = require('node:assert')
const http = require('http')

const { createProxyServer } = require('../lib/proxy')

const SSE = [
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Hello"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
  '',
  ''
].join('\n')

function startUpstream (handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(entry)
      handler(req, res, entry)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(resolve => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections()
          }
          server.close(resolve)
        })
      })
    })
  })
}

function stubAuth (overrides = {}) {
  return {
    status: () => ({ connected: true, email: 'user@example.com', planUsageEnabled: true }),
    isSigningIn: () => false,
    getAccessToken: async () => 'test-token',
    ...overrides
  }
}

async function setup (auth = stubAuth(), upstreamHandler) {
  const upstream = await startUpstream(upstreamHandler)
  const proxy = createProxyServer({
    port: 0,
    provider: 'chatgpt',
    auth,
    endpoints: {
      responses: `${upstream.url}/v1/responses`,
      models: `${upstream.url}/v1/models`
    }
  })
  const { url } = await proxy.start()
  return {
    url,
    upstream,
    async close () {
      await proxy.stop()
      await upstream.close()
    }
  }
}

test('streams the provider SSE through untouched, with the subscription token', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(SSE)
  })
  try {
    const res = await fetch(`${ctx.url}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // what electerm sends when a real API key is configured: it must not
        // reach the provider, the proxy sets its own
        authorization: 'Bearer caller-key'
      },
      body: JSON.stringify({
        model: 'some-model',
        input: [{ role: 'user', content: 'hi' }],
        stream: true
      })
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    assert.equal(text, SSE, 'SSE bytes reach the client unmodified')

    const sent = ctx.upstream.requests[0]
    assert.equal(sent.headers.authorization, 'Bearer test-token')
    assert.equal(sent.headers['accept-encoding'], 'identity')
    const body = JSON.parse(sent.body)
    assert.equal(body.store, false, 'store:false is forced for subscription requests')
    assert.equal(body.model, 'some-model')
    assert.equal(body.stream, true)
    assert.deepEqual(body.input, [{ role: 'user', content: 'hi' }])
  } finally {
    await ctx.close()
  }
})

test('passes a non-streaming response body through', async () => {
  const payload = {
    id: 'resp_2',
    status: 'completed',
    output_text: 'done',
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
  }
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  try {
    const res = await fetch(`${ctx.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: [], stream: false })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), payload)
    assert.equal(JSON.parse(ctx.upstream.requests[0].body).store, false)
  } finally {
    await ctx.close()
  }
})

test('relays the provider error instead of falling back to anything', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'usage limit reached' } }))
  })
  try {
    const res = await fetch(`${ctx.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: [], stream: true })
    })
    assert.equal(res.status, 429)
    assert.match((await res.json()).error.message, /usage limit reached/)
  } finally {
    await ctx.close()
  }
})

test('answers 401 with a readable message when no token is stored', async () => {
  const ctx = await setup(
    stubAuth({
      getAccessToken: async () => {
        throw new Error('ChatGPT is not connected, open the widget URL and sign in')
      }
    }),
    (req, res) => res.end('{}')
  )
  try {
    const res = await fetch(`${ctx.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: [], stream: true })
    })
    assert.equal(res.status, 401)
    assert.match((await res.json()).error.message, /not connected/)
    assert.equal(ctx.upstream.requests.length, 0, 'nothing is sent upstream without a token')
  } finally {
    await ctx.close()
  }
})

test('serves /v1/models in the shape electerm expects', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'listed', visibility: 'list' },
        { id: 'hidden', visibility: 'hide' },
        { id: 'listed' }
      ]
    }))
  })
  try {
    const res = await fetch(`${ctx.url}/v1/models`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      object: 'list',
      data: [{ id: 'listed', object: 'model' }]
    })
    assert.equal(ctx.upstream.requests[0].headers.authorization, 'Bearer test-token')
  } finally {
    await ctx.close()
  }
})

test('points a wrong API path at the right one', async () => {
  const ctx = await setup(stubAuth(), (req, res) => res.end('{}'))
  try {
    const res = await fetch(`${ctx.url}/v1/chat/completions`, { method: 'POST' })
    assert.equal(res.status, 404)
    assert.match((await res.json()).error.message, /\/responses/)
  } finally {
    await ctx.close()
  }
})

test('serves the admin page and its status', async () => {
  const ctx = await setup(stubAuth(), (req, res) => res.end('{}'))
  try {
    const page = await fetch(`${ctx.url}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /AI URL|API URL/)

    const status = await (await fetch(`${ctx.url}/admin/status`)).json()
    assert.equal(status.provider, 'chatgpt')
    assert.equal(status.baseUrl, ctx.url)
    assert.equal(status.auth.connected, true)
  } finally {
    await ctx.close()
  }
})
