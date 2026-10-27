/**
 * The admin page the proxy serves at /. It is a plain page in the user's
 * browser rather than a widget panel on purpose: the widget is an `instance`
 * type, which is the only kind electerm can start on launch, and instance
 * widgets get a generated config form instead of a custom UI.
 *
 * The page carries the proxy key, so it is the only place the user has to look
 * for the three values electerm needs. It also sends one non-streaming request
 * through the same path electerm uses, which is the difference between "the
 * page says connected" and "the AI panel actually works".
 */

function renderPage ({ provider, label, port, secret, csrf }) {
  const base = `http://localhost:${port}`
  const apiUrl = `${base}/v1`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${label} proxy - electerm</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfbfa;
  --card: #ffffff;
  --text: #1f2328;
  --muted: #6b7280;
  --line: #e5e7eb;
  --primary: #2563eb;
  --ok: #15803d;
  --bad: #b91c1c;
  --chip: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c;
    --card: #1e2126;
    --text: #e6e8eb;
    --muted: #9aa1ac;
    --line: #2e3238;
    --primary: #6ea8fe;
    --ok: #4ade80;
    --bad: #f87171;
    --chip: #262a30;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 20px 64px;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 720px; margin: 0 auto; }
h1 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
h2 { font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 32px 0 10px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.row + .row { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; background: var(--muted); }
.dot.ok { background: var(--ok); }
.dot.bad { background: var(--bad); }
button {
  font: inherit;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  padding: 6px 14px;
  cursor: pointer;
}
button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
select {
  font: inherit;
  color: var(--text);
  background: var(--chip);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 8px;
  max-width: 100%;
}
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.steps { list-style: none; margin: 0; padding: 0; counter-reset: step; }
.steps > li { counter-increment: step; display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
.steps > li:first-child { border-top: 0; padding-top: 0; }
.steps > li::before {
  content: counter(step);
  flex: 0 0 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--chip);
  color: var(--muted);
  font-size: 12px;
  line-height: 22px;
  text-align: center;
}
.steps .body { flex: 1 1 auto; min-width: 0; }
.steps .value { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.steps .value .mono { word-break: break-all; }
.copy { font-size: 12px; padding: 2px 10px; }
.test { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.test-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
pre {
  margin: 10px 0 0;
  padding: 10px 12px;
  background: var(--chip);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
}
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 0 0 6px; }
td { padding: 6px 0; vertical-align: top; border-top: 1px solid var(--line); font-size: 13px; }
tr:first-child td { border-top: 0; }
td.mono { white-space: nowrap; }
td.muted { color: var(--muted); }
.code { font-family: ui-monospace, monospace; font-size: 26px; letter-spacing: .12em; padding: 10px 0; }
.error { color: var(--bad); }
.note { font-size: 12px; color: var(--muted); margin-top: 10px; }
a { color: var(--primary); }
</style>
</head>
<body>
<main>
  <h1>${label} proxy for electerm</h1>
  <p class="muted">Listening on <span class="mono">${base}</span> &middot; one provider per widget instance</p>

  <h2>Account</h2>
  <div class="card">
    <div class="row">
      <div>
        <span class="dot" id="dot"></span>
        <span id="state">Checking...</span>
      </div>
      <div>
        <button id="signin" class="primary">Sign in</button>
        <button id="signout">Sign out</button>
      </div>
    </div>
    <div id="pending" style="display:none">
      <p class="muted" style="margin-top:14px">Approve this code at x.ai:</p>
      <div class="code" id="code"></div>
      <p><a id="verify" target="_blank" rel="noreferrer">Open the authorization page</a></p>
    </div>
    <p class="error" id="error" style="display:none"></p>
  </div>

  <h2>Point electerm at this proxy</h2>
  <div class="card">
    <p class="note" style="margin:0 0 12px">
      <strong>Easiest:</strong> in electerm, <em>Settings &rarr; Widgets &rarr; Running instances</em>,
      select this instance and press <strong>Use these settings</strong>. That fills the AI settings
      below in one click, and nothing is written until you press it.
    </p>
    <p class="note" style="margin:0 0 10px">Or fill it in by hand in <em>Settings &rarr; AI</em>:</p>
    <ol class="steps">
      <li>
        <div class="body">
          <div>API URL</div>
          <div class="value">
            <span class="mono">${apiUrl}</span>
            <button class="copy" data-copy="${apiUrl}">Copy</button>
          </div>
        </div>
      </li>
      <li>
        <div class="body">
          <div>API PATH</div>
          <div class="value">
            <span class="mono">/responses</span>
            <button class="copy" data-copy="/responses">Copy</button>
          </div>
        </div>
      </li>
      <li>
        <div class="body">
          <div>API key &mdash; the proxy key, not a provider key</div>
          <div class="value">
            <span class="mono">${secret}</span>
            <button class="copy" data-copy="${secret}">Copy</button>
          </div>
        </div>
      </li>
      <li>
        <div class="body">
          <div>Model</div>
          <div class="value">
            <select id="model"><option value="">Load the list first</option></select>
            <button id="loadmodels">Load models</button>
          </div>
          <p class="note" style="margin:8px 0 0">
            electerm's own <strong>Load models</strong> button does the same and fills the dropdown
            there; this one only lists them. Leave "Auth header" at its default and clear the proxy
            field.
          </p>
        </div>
      </li>
    </ol>

    <div class="test">
      <div class="test-row">
        <button id="test">Send a test request</button>
        <span class="muted" id="testhint">Runs the same non-streaming request the agent panel makes.</span>
      </div>
      <pre id="testout" style="display:none"></pre>
    </div>
  </div>

  <h2>Recent requests</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Path</th>
          <th>Model</th>
          <th>Mode</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="recent">
        <tr><td class="muted" colspan="5">No requests yet. Once electerm uses the AI panel, they show up here.</td></tr>
      </tbody>
    </table>
    <p class="note">Only the path, model and status are kept, never the prompt. Requests without a valid
    key are listed too, so a wrong key in electerm is visible instead of silent.</p>
    <p class="error" id="recenthint" style="display:none;margin:8px 0 0">
      The most recent request was refused (401): the API key in electerm's AI settings does not match
      the key above.
    </p>
  </div>

  <h2>Notes</h2>
  <div class="card">
    <p>Tokens are encrypted with the OS keystore and never leave electerm's main process. This page and the
    proxy only listen on 127.0.0.1, only accept requests addressed to that name, and require the key above.</p>
    <p class="muted">Requests are billed against your ${label} subscription, not an API key. If the plan has no
    access to a model, the provider's error is shown as-is in electerm &mdash; there is no fallback to API billing.</p>
  </div>
</main>
<script>
(function () {
  var provider = ${JSON.stringify(provider)}
  var secret = ${JSON.stringify(secret)}
  var csrf = ${JSON.stringify(csrf)}
  var dot = document.getElementById('dot')
  var state = document.getElementById('state')
  var errorEl = document.getElementById('error')
  var pendingEl = document.getElementById('pending')
  var codeEl = document.getElementById('code')
  var verifyEl = document.getElementById('verify')
  var signin = document.getElementById('signin')
  var signout = document.getElementById('signout')
  var modelSelect = document.getElementById('model')
  var recentBody = document.getElementById('recent')
  var testButton = document.getElementById('test')
  var testOut = document.getElementById('testout')
  var timer = null
  var lastRecent = ''

  function showError (message) {
    errorEl.textContent = message || ''
    errorEl.style.display = message ? 'block' : 'none'
  }

  function timeOf (ms) {
    var d = new Date(ms)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) {
      return (n < 10 ? '0' : '') + n
    }).join(':')
  }

  function renderRecent (list) {
    list = list || []
    // a refused request is the one failure the page can explain better than
    // electerm can, because the page is where the right key is printed
    var refused = list.length && list[0].status === 401
    document.getElementById('recenthint').style.display = refused ? 'block' : 'none'
    var key = JSON.stringify(list)
    if (key === lastRecent) {
      return
    }
    lastRecent = key
    recentBody.textContent = ''
    if (!list.length) {
      var empty = document.createElement('tr')
      var cell = document.createElement('td')
      cell.className = 'muted'
      cell.colSpan = 5
      cell.textContent = 'No requests yet. Once electerm uses the AI panel, they show up here.'
      empty.appendChild(cell)
      recentBody.appendChild(empty)
      return
    }
    list.forEach(function (item) {
      var tr = document.createElement('tr')
      var ok = item.status >= 200 && item.status < 300
      var mode = item.stream === null ? '-' : (item.stream ? 'stream' : 'one shot')
      if (item.source === 'page') {
        mode += ' (test)'
      }
      var cells = [
        { text: timeOf(item.at), className: 'mono muted' },
        { text: item.path, className: 'mono' },
        { text: item.model || '-', className: 'mono' },
        { text: mode, className: 'muted' },
        { text: String(item.status || '?'), className: 'mono ' + (ok ? 'ok' : 'bad') }
      ]
      cells.forEach(function (c) {
        var td = document.createElement('td')
        td.textContent = c.text
        if (c.className) {
          td.className = c.className
        }
        tr.appendChild(td)
      })
      recentBody.appendChild(tr)
    })
  }

  function render (data) {
    var auth = data.auth || {}
    var connected = !!auth.connected
    dot.className = 'dot ' + (connected ? 'ok' : 'bad')
    state.textContent = connected
      ? 'Connected' + (auth.email ? ' as ' + auth.email : '')
      : 'Not connected'
    signin.style.display = connected ? 'none' : 'inline-block'
    signin.textContent = provider === 'supergrok' ? 'Show code' : 'Sign in'
    signout.style.display = connected ? 'inline-block' : 'none'
    testButton.disabled = !connected
    if (auth.pending && auth.userCode) {
      pendingEl.style.display = 'block'
      codeEl.textContent = auth.userCode
      verifyEl.href = auth.verificationUrl
    } else {
      pendingEl.style.display = 'none'
    }
    if (auth.error) {
      showError(auth.error)
    }
    renderRecent(data.recent)
  }

  function poll () {
    fetch('/admin/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(render)
      .catch(function (e) { showError('Cannot reach the proxy: ' + e.message) })
  }

  // The page is the only place that sees requests arrive, so it keeps a slow
  // poll going: sign-in progress, device codes, and the request list.
  function schedule (delay) {
    clearTimeout(timer)
    if (document.hidden) {
      return
    }
    timer = setTimeout(function () {
      poll()
      schedule(4000)
    }, delay)
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      poll()
      schedule(4000)
    }
  })

  function post (path) {
    return fetch(path, { method: 'POST', headers: { 'x-proxy-csrf': csrf } })
      .then(function (r) { return r.json() })
      .then(function (body) {
        if (body && body.error) {
          throw new Error(body.error.message || 'Request failed')
        }
        return body
      })
  }

  signin.addEventListener('click', function () {
    showError('')
    signin.disabled = true
    post('/admin/signin')
      .then(function () { poll() })
      .catch(function (e) { showError(e.message) })
      .finally(function () { signin.disabled = false })
  })

  signout.addEventListener('click', function () {
    showError('')
    post('/admin/signout')
      .then(function () { poll() })
      .catch(function (e) { showError(e.message) })
  })

  function fillModels (models) {
    modelSelect.textContent = ''
    if (!models.length) {
      var none = document.createElement('option')
      none.value = ''
      none.textContent = 'The provider listed no models'
      modelSelect.appendChild(none)
      return
    }
    models.forEach(function (id) {
      var option = document.createElement('option')
      option.value = id
      option.textContent = id
      modelSelect.appendChild(option)
    })
  }

  document.getElementById('loadmodels').addEventListener('click', function () {
    var button = this
    button.disabled = true
    showError('')
    fetch('/admin/models', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (body) {
        if (body && body.error) {
          throw new Error(body.error.message || 'Request failed')
        }
        fillModels(body.models || [])
      })
      .catch(function (e) { showError(e.message) })
      .finally(function () { button.disabled = false })
  })

  // Walk a Responses object for its text, the same way electerm does.
  function textOf (data) {
    var text = ''
    if (data && Array.isArray(data.output)) {
      data.output.forEach(function (item) {
        if (item && item.type === 'message' && Array.isArray(item.content)) {
          item.content.forEach(function (part) {
            if (part && typeof part.text === 'string') {
              text += part.text
            }
          })
        }
      })
    }
    if (!text && data && typeof data.output_text === 'string') {
      text = data.output_text
    }
    return text
  }

  testButton.addEventListener('click', function () {
    var model = modelSelect.value
    if (!model) {
      testOut.style.display = 'block'
      testOut.textContent = 'Pick a model first: click "Load models".'
      return
    }
    var started = Date.now()
    testButton.disabled = true
    testOut.style.display = 'block'
    testOut.textContent = 'Sending...'
    fetch('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + secret,
        'x-proxy-source': 'page'
      },
      body: JSON.stringify({
        model: model,
        input: [{ role: 'user', content: 'Reply with the single word: ok' }],
        stream: false
      })
    })
      .then(function (r) {
        return r.json().catch(function () { return null }).then(function (body) {
          return { status: r.status, body: body }
        })
      })
      .then(function (result) {
        var ms = Date.now() - started
        var body = result.body || {}
        if (result.status < 200 || result.status >= 300 || body.error) {
          var message = (body.error && body.error.message) || JSON.stringify(body)
          throw new Error(result.status + ' after ' + ms + 'ms: ' + message)
        }
        var text = textOf(body)
        testOut.textContent = (text || '(the model returned no text)') +
          '\\n\\n' + result.status + ' in ' + ms + 'ms' +
          (body.usage ? ' \\u00b7 ' + body.usage.input_tokens + ' in / ' + body.usage.output_tokens + ' out' : '')
        poll()
      })
      .catch(function (e) {
        testOut.textContent = 'Failed: ' + e.message
      })
      .finally(function () { testButton.disabled = false })
  })

  Array.prototype.forEach.call(document.querySelectorAll('.copy'), function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-copy')
      navigator.clipboard.writeText(value).then(function () {
        var before = button.textContent
        button.textContent = 'Copied'
        setTimeout(function () { button.textContent = before }, 1200)
      })
    })
  })

  poll()
  schedule(4000)
})()
</script>
</body>
</html>`
}

module.exports = { renderPage }
