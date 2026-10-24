/**
 * The admin page the proxy serves at /. It is a plain page in the user's
 * browser rather than a widget panel on purpose: the widget is an `instance`
 * type, which is the only kind electerm can start on launch, and instance
 * widgets get a generated config form instead of a custom UI.
 */

function renderPage ({ provider, label, port }) {
  const base = `http://localhost:${port}`
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
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 8px 0; vertical-align: top; border-top: 1px solid var(--line); }
td:first-child { width: 96px; color: var(--muted); white-space: nowrap; }
td .mono { word-break: break-all; }
.copy { margin-left: 8px; font-size: 12px; padding: 2px 8px; }
.chip { display: inline-block; margin: 4px 6px 0 0; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; cursor: pointer; font-family: ui-monospace, monospace; font-size: 12px; }
.chip:hover { border-color: var(--primary); }
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

  <h2>Paste into electerm &rarr; Settings &rarr; AI</h2>
  <div class="card">
    <table>
      <tr>
        <td>API URL</td>
        <td><span class="mono" id="v-url">${base}/v1</span><button class="copy" data-copy="${base}/v1">Copy</button></td>
      </tr>
      <tr>
        <td>API PATH</td>
        <td><span class="mono">/responses</span><button class="copy" data-copy="/responses">Copy</button></td>
      </tr>
      <tr>
        <td>API key</td>
        <td><span class="mono">local</span><button class="copy" data-copy="local">Copy</button>
          <span class="muted"> (any value, the proxy ignores it)</span></td>
      </tr>
      <tr>
        <td>Model</td>
        <td>
          <span class="muted">Load the list your plan exposes:</span>
          <button id="loadmodels">Load models</button>
          <div id="models"></div>
        </td>
      </tr>
    </table>
    <p class="note">Leave "Auth Header" at its default and clear the proxy field. The model name is whatever your
    subscription lists &mdash; click a chip to copy it, then paste it into the Model field.</p>
  </div>

  <h2>Notes</h2>
  <div class="card">
    <p>Tokens are encrypted with the OS keystore and never leave electerm's main process. This page and the
    proxy only listen on 127.0.0.1.</p>
    <p class="muted">Requests are billed against your ${label} subscription, not an API key. If the plan has no
    access to a model, the provider's error is shown as-is in electerm &mdash; there is no fallback to API billing.</p>
  </div>
</main>
<script>
(function () {
  var provider = ${JSON.stringify(provider)}
  var dot = document.getElementById('dot')
  var state = document.getElementById('state')
  var errorEl = document.getElementById('error')
  var pendingEl = document.getElementById('pending')
  var codeEl = document.getElementById('code')
  var verifyEl = document.getElementById('verify')
  var signin = document.getElementById('signin')
  var signout = document.getElementById('signout')
  var timer = null

  function showError (message) {
    errorEl.textContent = message || ''
    errorEl.style.display = message ? 'block' : 'none'
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
    if (auth.pending) {
      schedule()
    }
  }

  function poll () {
    fetch('/admin/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(render)
      .catch(function (e) { showError('Cannot reach the proxy: ' + e.message) })
  }

  function schedule () {
    clearTimeout(timer)
    timer = setTimeout(poll, 1500)
  }

  function post (path) {
    return fetch(path, { method: 'POST' })
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

  document.getElementById('loadmodels').addEventListener('click', function () {
    var box = document.getElementById('models')
    box.textContent = 'Loading...'
    fetch('/admin/models', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (body) {
        if (body && body.error) {
          throw new Error(body.error.message || 'Request failed')
        }
        box.textContent = ''
        var models = body.models || []
        if (!models.length) {
          box.textContent = 'The provider listed no models for this account.'
          return
        }
        models.forEach(function (id) {
          var chip = document.createElement('span')
          chip.className = 'chip'
          chip.textContent = id
          chip.title = 'Copy'
          chip.addEventListener('click', function () {
            navigator.clipboard.writeText(id)
          })
          box.appendChild(chip)
        })
      })
      .catch(function (e) {
        box.textContent = ''
        showError(e.message)
      })
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
})()
</script>
</body>
</html>`
}

module.exports = { renderPage }
