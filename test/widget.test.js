const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

// The widget entry as electerm runs it: copied into <data>/widgets/<id>/, with
// electron replaced by a stand-in. This is the only place the start result is
// checked, and it is what electerm's widget panel reads.
//
// The copy matters: the widget keeps its tokens next to its own folder, so
// running the repo in place would write into the developer's home directory.

const REPO = path.join(__dirname, '..')

function tempWidget () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-auth-widget-'))
  const dir = path.join(root, 'widgets', 'ai-auth-proxy')
  fs.cpSync(REPO, dir, {
    recursive: true,
    filter: src => !/[\\/](\.git|node_modules|\.workbuddy-ai)([\\/]|$)/.test(src)
  })
  return { root, dir }
}

function stubElectron ({ resolveProxy = null } = {}) {
  const electron = {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`enc::${value}`, 'utf8'),
      decryptString: buffer => buffer.toString('utf8').replace(/^enc::/, '')
    },
    shell: { openExternal: () => Promise.resolve() }
  }
  if (resolveProxy) {
    electron.session = {
      defaultSession: { resolveProxy: async () => resolveProxy }
    }
  }
  const load = Module._load
  Module._load = function (request) {
    if (request === 'electron') {
      return electron
    }
    return load.apply(this, arguments)
  }
  return () => {
    Module._load = load
  }
}

async function freePort () {
  const server = require('http').createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the start result offers electerm a usable AI config', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port, autoRun: true }, { log: () => {} })
    const result = await instance.start()

    const { aiConfig } = result
    assert.ok(aiConfig, 'a start result carries an aiConfig for electerm to offer')
    assert.equal(aiConfig.baseURLAI, `http://localhost:${port}/v1`)
    assert.equal(aiConfig.apiPathAI, '/responses')
    assert.equal(aiConfig.authHeaderNameAI, 'Authorization: Bearer')
    assert.match(aiConfig.nameAI, /ChatGPT/)
    assert.equal(aiConfig.proxyAI, '', 'the offer decides the AI proxy too: loopback needs none')

    // the fields electerm will not take from a widget, and must not get here
    assert.equal('roleAI' in aiConfig, false, 'the system prompt is not a widget setting')
    assert.equal('languageAI' in aiConfig, false)

    // the key in the offer is the key the proxy actually accepts, and the one
    // the page shows, so "apply" cannot hand electerm a key that 401s
    const page = await (await fetch(`${result.serverInfo.url}/`)).text()
    const shown = /var secret = "([^"]+)"/.exec(page)
    assert.equal(shown[1], aiConfig.apiKeyAI)

    const accepted = await fetch(`${result.serverInfo.url}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${aiConfig.apiKeyAI}`
      },
      body: JSON.stringify({ model: 'm', input: [], stream: false })
    })
    assert.equal(accepted.status, 401)
    // 401 because nobody is signed in yet, not because the key was refused
    assert.match((await accepted.json()).error.message, /not connected/)
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the key in the offer survives a restart', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  const runs = []
  try {
    const widget = require(path.join(dir, 'index.js'))
    for (let i = 0; i < 2; i++) {
      const instance = widget.widgetRun({ provider: 'chatgpt', port }, { log: () => {} })
      const result = await instance.start()
      runs.push(result.aiConfig.apiKeyAI)
      await instance.stop()
    }
    assert.equal(runs[0], runs[1], 'electerm only has to apply the config once')
  } finally {
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the panel API reports state and offers an AI config', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, { log: () => {} })
    const { serverInfo } = await instance.start()

    const status = await widget.getStatus()
    assert.equal(status.provider, 'chatgpt')
    assert.equal(status.connected, false)
    assert.equal(status.viaProxy, false)
    assert.equal(status.port, port)

    // not signed in yet, so no model, but the offer is still complete
    const { aiConfig } = await widget.getAIConfig()
    assert.equal(aiConfig.baseURLAI, `${serverInfo.url}/v1`)
    assert.equal(aiConfig.apiPathAI, '/responses')
    assert.equal('modelAI' in aiConfig, false)
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('switching provider in the panel keeps the endpoint electerm already uses', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, { log: () => {} })
    const { serverInfo } = await instance.start()
    const before = (await widget.getAIConfig()).aiConfig

    await widget.setProvider('supergrok')
    const after = (await widget.getAIConfig()).aiConfig
    assert.equal(after.baseURLAI, before.baseURLAI, 'the port did not change')
    assert.match(after.nameAI, /SuperGrok/)
    assert.equal((await widget.getStatus()).provider, 'supergrok')

    // the browser fallback page follows the switch too
    const admin = await (await fetch(`${serverInfo.url}/admin/status`)).json()
    assert.equal(admin.provider, 'supergrok')
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the user-set upstream proxy is the only proxy the widget uses', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  const seen = []
  const ctx = {
    log: () => {},
    createProxyAgent: url => {
      seen.push(url)
      return { marker: 'user-proxy' }
    }
  }
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({
      provider: 'chatgpt',
      port,
      upstreamProxy: 'socks5://127.0.0.1:1080'
    }, ctx)
    await instance.start()
    assert.deepEqual(seen, ['socks5://127.0.0.1:1080'])
    assert.equal((await widget.getStatus()).viaProxy, true)
    assert.equal((await widget.getAIConfig()).aiConfig.proxyAI, '')
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('HTTPS_PROXY is the fallback when the user leaves the field empty', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  const saved = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://env-proxy:3128'
  const seen = []
  const ctx = {
    log: () => {},
    createProxyAgent: url => {
      seen.push(url)
      return { marker: 'env-proxy' }
    }
  }
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, ctx)
    await instance.start()
    assert.deepEqual(seen, ['http://env-proxy:3128'])
  } finally {
    if (saved === undefined) {
      delete process.env.HTTPS_PROXY
    } else {
      process.env.HTTPS_PROXY = saved
    }
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('older electerm builds can still hand over a ready-made agent', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun(
      { provider: 'chatgpt', port },
      { log: () => {}, proxyAgent: { marker: true } }
    )
    await instance.start()
    assert.equal((await widget.getStatus()).viaProxy, true)
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a panel call starts the proxy when the host did not', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, { log: () => {} })
    // no instance.start(): the widget was never run (or its start failed), so
    // the panel used to fail every call with "not running yet"
    const s = await widget.getStatus()
    assert.equal(s.url, `http://localhost:${port}`)
    assert.equal(s.connected, false)
    // the host's own start() is idempotent: one listener, one offer
    const result = await instance.start()
    assert.equal(result.success, true)
    assert.equal(result.serverInfo.url, s.url)
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit stop stays stopped and points at the Run button', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, { log: () => {} })
    await instance.start()
    await instance.stop()
    await assert.rejects(
      widget.getStatus(),
      /Press Run in the widget panel/
    )
  } finally {
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the system proxy is used when the field and the env are empty', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron({ resolveProxy: 'PROXY 127.0.0.1:7890; DIRECT' })
  const port = await freePort()
  const saved = [process.env.HTTPS_PROXY, process.env.https_proxy]
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  const seen = []
  const ctx = {
    log: () => {},
    createProxyAgent: url => {
      seen.push(url)
      return { marker: 'system-proxy' }
    }
  }
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, ctx)
    await instance.start()
    // Node ignores the OS proxy; a VPN that only sets the system proxy used to
    // leave sign-in at a Cloudflare 403.
    assert.deepEqual(seen, ['http://127.0.0.1:7890'])
    const status = await widget.getStatus()
    assert.equal(status.viaProxy, true)
    assert.equal(status.upstream, 'http://127.0.0.1:7890')
    assert.equal(status.upstreamSource, 'system')
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
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('saving an upstream proxy from the panel rebuilds the listener', async () => {
  const { root, dir } = tempWidget()
  const restore = stubElectron()
  const port = await freePort()
  const saved = [process.env.HTTPS_PROXY, process.env.https_proxy]
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  const seen = []
  const ctx = {
    log: () => {},
    createProxyAgent: url => {
      seen.push(url)
      return { marker: url }
    }
  }
  let instance
  try {
    const widget = require(path.join(dir, 'index.js'))
    instance = widget.widgetRun({ provider: 'chatgpt', port }, ctx)
    await instance.start()
    assert.equal((await widget.getStatus()).viaProxy, false)

    await widget.setUpstreamProxy('socks5://127.0.0.1:1080')
    assert.deepEqual(seen, ['socks5://127.0.0.1:1080'])
    const status = await widget.getStatus()
    assert.equal(status.viaProxy, true)
    assert.equal(status.upstream, 'socks5://127.0.0.1:1080')
    assert.equal(status.upstreamSource, 'config')
    // restart keeps the same port and server secret, so the AI config stays valid
    assert.equal(status.port, port)
    assert.equal((await widget.getAIConfig()).aiConfig.baseURLAI, status.url + '/v1')
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
    if (instance) {
      await instance.stop()
    }
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
