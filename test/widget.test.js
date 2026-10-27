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

function stubElectron () {
  const electron = {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`enc::${value}`, 'utf8'),
      decryptString: buffer => buffer.toString('utf8').replace(/^enc::/, '')
    },
    shell: { openExternal: () => Promise.resolve() }
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
