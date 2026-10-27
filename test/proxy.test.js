const test = require('node:test')
const assert = require('node:assert')
const http = require('http')

const { createProxyServer } = require('../lib/proxy')

const KEY = 'sk-local-test-key'

const TEXT_STREAM = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-x","status":"in_progress","output":[]}}',
  '',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello"}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":" there"}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello there"}]}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-x","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello there"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
  '',
  ''
].join('\n')

const TOOL_STREAM = [
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"list_files","arguments":""}}',
  '',
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"path\\":\\"/tmp\\"}"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_2","object":"response","model":"gpt-x","status":"completed","output":[{"id":"fc_1","type":"function_call","call_id":"call_1","name":"list_files","arguments":"{\\"path\\":\\"/tmp\\"}"}],"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}',
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

async function setup (auth = stubAuth(), upstreamHandler = (req, res) => res.end('{}')) {
  const upstream = await startUpstream(upstreamHandler)
  const proxy = createProxyServer({
    port: 0,
    provider: 'chatgpt',
    auth,
    secret: KEY,
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

// What electerm does: POST with the key from its AI settings.
function callAI (url, body, { key = KEY, path = '/v1/responses', headers = {} } = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...headers
    },
    body: JSON.stringify(body)
  })
}

// fetch() refuses to set Host, so the guard is tested with a raw request.
function rawGet (url, path, headers = {}) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path,
      method: 'GET',
      headers
    }, res => {
      let body = ''
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('refuses a caller that does not know the proxy key', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(TEXT_STREAM)
  })
  try {
    // the old advice was "any value": that is exactly what has to stop working
    const res = await callAI(ctx.url, { model: 'm', input: [], stream: true }, { key: 'local' })
    assert.equal(res.status, 401)
    assert.match((await res.json()).error.message, /proxy key/)
    assert.equal(ctx.upstream.requests.length, 0, 'nothing reaches the provider without the key')
  } finally {
    await ctx.close()
  }
})

test('streams the provider SSE through untouched with the proxy key', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(TEXT_STREAM)
  })
  try {
    const res = await callAI(ctx.url, {
      model: 'some-model',
      input: [{ role: 'user', content: 'hi' }],
      stream: true
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    assert.equal(text, TEXT_STREAM, 'SSE bytes reach the client unmodified')

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

test('folds the stream into one response for a non-streaming caller', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(TEXT_STREAM)
  })
  try {
    // this is what AIchatWithTools (the agent loop), AI bookmarks, themes and
    // quick commands send: stream: false, one JSON answer expected
    const res = await callAI(ctx.url, {
      model: 'gpt-x',
      input: [{ role: 'user', content: 'hi' }],
      stream: false
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const body = await res.json()
    assert.equal(body.status, 'completed')
    assert.equal(body.output[0].content[0].text, 'Hello there')
    assert.equal(body.usage.total_tokens, 5, 'usage survives the fold')

    const sent = JSON.parse(ctx.upstream.requests[0].body)
    assert.equal(sent.stream, true, 'the subscription backend only accepts a stream')
    assert.equal(sent.store, false)
  } finally {
    await ctx.close()
  }
})

test('folds a tool call so the agent loop still sees it', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(TOOL_STREAM)
  })
  try {
    const res = await callAI(ctx.url, {
      model: 'gpt-x',
      input: [{ role: 'user', content: 'list /tmp' }],
      tools: [{ type: 'function', name: 'list_files', parameters: {} }],
      stream: false
    })
    const body = await res.json()
    assert.equal(body.status, 'completed')
    const call = body.output.find(item => item.type === 'function_call')
    assert.equal(call.call_id, 'call_1')
    assert.equal(call.name, 'list_files')
    assert.deepEqual(JSON.parse(call.arguments), { path: '/tmp' })
  } finally {
    await ctx.close()
  }
})

test('passes a plain JSON answer through when the provider ignores stream', async () => {
  const payload = {
    id: 'resp_3',
    status: 'completed',
    output_text: 'done',
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
  }
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  try {
    const res = await callAI(ctx.url, { model: 'm', input: [], stream: false })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), payload)
  } finally {
    await ctx.close()
  }
})

test('relays a provider error with its status, on both paths', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'usage limit reached' } }))
  })
  try {
    for (const stream of [true, false]) {
      const res = await callAI(ctx.url, { model: 'm', input: [], stream })
      assert.equal(res.status, 429)
      assert.match((await res.json()).error.message, /usage limit reached/)
    }
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
    const res = await callAI(ctx.url, { model: 'm', input: [], stream: true })
    assert.equal(res.status, 401)
    assert.match((await res.json()).error.message, /not connected/)
    assert.equal(ctx.upstream.requests.length, 0, 'nothing is sent upstream without a token')
  } finally {
    await ctx.close()
  }
})

test('requires the proxy key on every /v1 call', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })
  try {
    const noKey = await fetch(`${ctx.url}/v1/models`)
    assert.equal(noKey.status, 401)
    assert.match((await noKey.json()).error.message, /proxy key/)

    const wrongKey = await fetch(`${ctx.url}/v1/models`, {
      headers: { authorization: 'Bearer local' }
    })
    assert.equal(wrongKey.status, 401)

    const good = await fetch(`${ctx.url}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` }
    })
    assert.equal(good.status, 200)

    // a user who changed "Auth header" in electerm still gets in
    const apiKeyHeader = await fetch(`${ctx.url}/v1/models`, {
      headers: { 'x-api-key': KEY }
    })
    assert.equal(apiKeyHeader.status, 200)
  } finally {
    await ctx.close()
  }
})

test('refuses a request addressed to another host (DNS rebinding)', async () => {
  const ctx = await setup()
  try {
    const port = new URL(ctx.url).port
    const rebound = await rawGet(ctx.url, '/admin/status', {
      host: `evil.example:${port}`,
      origin: `http://evil.example:${port}`
    })
    assert.equal(rebound.status, 403)
    assert.match(rebound.body, /only answers requests addressed to/)

    const local = await rawGet(ctx.url, '/admin/status', { host: `localhost:${port}` })
    assert.equal(local.status, 200)
  } finally {
    await ctx.close()
  }
})

test('refuses a cross-site request but allows the page itself', async () => {
  const ctx = await setup()
  try {
    const foreign = await fetch(`${ctx.url}/admin/signout`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' }
    })
    assert.equal(foreign.status, 403)
    assert.match((await foreign.json()).error.message, /Cross-site/)

    const own = await fetch(`${ctx.url}/admin/status`, {
      headers: { origin: ctx.url }
    })
    assert.equal(own.status, 200)
  } finally {
    await ctx.close()
  }
})

test('admin actions need the token the page was rendered with', async () => {
  let signedOut = 0
  const ctx = await setup(stubAuth({ signOut: async () => { signedOut++ } }))
  try {
    const withoutToken = await fetch(`${ctx.url}/admin/signout`, { method: 'POST' })
    assert.equal(withoutToken.status, 403)
    assert.equal(signedOut, 0)

    const page = await (await fetch(`${ctx.url}/`)).text()
    const match = /var csrf = "([^"]+)"/.exec(page)
    assert.ok(match, 'the page carries its token')
    const withToken = await fetch(`${ctx.url}/admin/signout`, {
      method: 'POST',
      headers: { 'x-proxy-csrf': match[1] }
    })
    assert.equal(withToken.status, 200)
    assert.equal(signedOut, 1)
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
    const res = await fetch(`${ctx.url}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` }
    })
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

test('points a wrong API path at the right one, even without a key', async () => {
  const ctx = await setup()
  try {
    const res = await fetch(`${ctx.url}/v1/chat/completions`, { method: 'POST' })
    assert.equal(res.status, 404)
    assert.match((await res.json()).error.message, /\/responses/)
  } finally {
    await ctx.close()
  }
})

test('rejects a body that is not JSON', async () => {
  const ctx = await setup()
  try {
    const res = await fetch(`${ctx.url}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${KEY}`
      },
      body: 'model=x'
    })
    assert.equal(res.status, 415)
    assert.equal(ctx.upstream.requests.length, 0)
  } finally {
    await ctx.close()
  }
})

test('serves the admin page, its status and a request log', async () => {
  const ctx = await setup(stubAuth(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(TEXT_STREAM)
  })
  try {
    const page = await fetch(`${ctx.url}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /API URL/)
    assert.match(html, new RegExp(KEY), 'the page carries the proxy key')

    const status = await (await fetch(`${ctx.url}/admin/status`)).json()
    assert.equal(status.provider, 'chatgpt')
    assert.equal(status.baseUrl, ctx.url)
    assert.equal(status.auth.connected, true)
    assert.deepEqual(status.recent, [])

    await callAI(ctx.url, { model: 'gpt-x', input: [], stream: false })
    const after = await (await fetch(`${ctx.url}/admin/status`)).json()
    assert.equal(after.recent.length, 1)
    assert.equal(after.recent[0].path, '/v1/responses')
    assert.equal(after.recent[0].model, 'gpt-x')
    assert.equal(after.recent[0].stream, false)
    assert.equal(after.recent[0].status, 200)
    assert.equal(JSON.stringify(after.recent).includes('Reply with'), false, 'prompts are never logged')
  } finally {
    await ctx.close()
  }
})
