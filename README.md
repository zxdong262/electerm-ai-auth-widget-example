# electerm AI subscription proxy — widget example

An [electerm](https://github.com/electerm/electerm) custom widget that signs in to a **ChatGPT**
or **SuperGrok** subscription and exposes it as a local OpenAI **Responses** endpoint, so
electerm's AI panel — chat, agent mode with tools, AI bookmarks, themes, quick commands, command
suggestions — uses the subscription instead of an API key.

Sign-in and setup happen **inside the widget's own panel**: import it once, press **Sign in**, then
press **Use these settings** above the panel. The proxy starts with electerm and keeps the OAuth
token in the main process; the only optional field is the upstream proxy for networks that need one.
The **Run/Stop** button in the panel header shows and controls that state.

> **Status.** This is an example, not part of electerm. The OAuth protocol details are adapted
> from [PR #4589](https://github.com/electerm/electerm/pull/4589) by
> [@thejohnd0e](https://github.com/thejohnd0e), who tested the flow in the app on Windows. The
> author of this repo has not signed in with a live account; everything that can be tested without
> one — the proxy, the token store, the upstream proxy layer, the panel API and the request and
> stream format against electerm's own parser — is covered by `npm test`.

## Why a proxy works

electerm already speaks the Responses API as a first-class wire format
(`src/app/lib/ai-format.js`: `detectFormat` maps any path containing `/responses`, `buildRequest`
emits `input` + `instructions` + flattened tools, and the stream parser understands
`response.output_text.delta` / `function_call_arguments.delta` / `response.completed`). Every AI
feature reads `baseURLAI` / `apiPathAI` / `apiKeyAI` from config at call time.

So the widget only has to be an HTTP endpoint that:

1. replaces `Authorization` with the subscription's access token,
2. adds `store: false` (required for subscription-backed requests; electerm's request builder
   never sets it),
3. asks upstream for `stream: true` — the subscription backend rejects `stream: false` with
   `{"detail":"Stream must be set to true"}` — and folds the event stream back into one JSON
   object for the callers that asked for a single answer,
4. pipes the SSE back unchanged for the callers that want it.

Step 3 is what makes agent mode work. `AIchatWithTools`, which is how the agent panel calls
tools, always sends `stream: false`; so do AI bookmarks, theme generation, quick commands and
command suggestions. Those requests are read to the end and rebuilt into the exact Response
object the non-streaming endpoint would have returned, including `usage` and `function_call`
items (`lib/sse.js`).

## Requirements

- An electerm build with custom widget support, plus the small core changes from
  [issue #4591](https://github.com/electerm/electerm/issues/4591): widgets with `electerm.ui` can
  auto-start, their panel has Run/Stop controls, a widget's `aiConfig` offer may clear a setting
  (shown as `none` in the panel), UI calls reach the running instance's module, and the main
  process hands widgets an agent factory so they can use the proxy the user set.
- Node 20+ if you want to run the tests. The widget itself uses the Node runtime inside electerm.
- A ChatGPT or SuperGrok plan that the provider allows this kind of access on. If the plan has no
  access, the provider's error is shown as-is — there is no fallback to API billing.

On an older build the widget still works: open the proxy URL in a browser, sign in there, and copy
the values shown on that page into **Settings → AI**.

## Setup

```bash
git clone https://github.com/zxdong262/electerm-ai-auth-widget-example.git
```

1. In electerm open **Settings → Widgets → Import** and pick the cloned folder. It installs as
   `ai-auth-proxy` (from `package.json`).
2. Select **AI subscription proxy** in the list. The panel starts the proxy on its own and
   registers it for launch; press **Sign in** in the panel. If it did not start (a taken port,
   for example), the panel shows the error and offers **Run** in its header; **Stop** shuts the
   proxy down. The panel disables its buttons while the proxy is stopped.
   - **ChatGPT** opens your browser for OAuth. The callback lands on a one-shot `127.0.0.1`
     listener, the browser tab says "Sign-in finished" and closes itself, and the panel flips to
     "Connected as …".
   - **SuperGrok** shows a device code in the panel; approve it on x.ai and the panel updates by
     itself.
   - Switch provider with the dropdown — the port and the AI config stay the same.
3. Press **Use these settings** in the block above the panel. It applies URL, path, key, auth
   header, the panel name **and a model** (the widget asks the provider for the model list after
   signing in), and clears **Proxy** — shown as `none` in the offer — because the endpoint is
   loopback. Nothing is written until you press it.

That is the whole setup. The agent panel, AI bookmarks, theme generation and quick commands all
read the same config. **Send a test request** in the panel runs one non-streaming request through
the same path the agent loop uses, so "connected" and "the AI panel works" are not the same claim.

The browser page at <http://localhost:8788> is still served as a fallback: it shows the same
status, the values to copy, the proxy key, the model list and **Recent requests**. By hand, the
values are `http://localhost:8788/v1`, `/responses`, and the proxy key (`sk-local-…`, not a
provider key). The key stays the same across restarts, so the config is applied once.

## Networks that need a proxy

The old catch-22 was: with **Proxy** set in **Settings → AI**, electerm sent its `localhost`
requests to the remote proxy (`ECONNREFUSED`); with it cleared, the widget could not reach OpenAI
(Cloudflare `403` on OIDC discovery). The two directions are now two separate settings, both
chosen by you — core no longer special-cases `localhost`:

- **Use these settings** writes `proxyAI: ''` with the URL, path and key, so electerm's AI client
  reaches the loopback endpoint directly. The offer lists `Proxy: none` before you apply it, so
  the clear is visible rather than a side effect.
- The widget's sign-in and API calls use **Upstream** in this widget's panel
  (`http://…` or `socks5://…`; OIDC discovery, token exchange, refresh, model list and the
  Responses stream all go through it via `lib/upstream.js`). Empty means, in order: the standard
  `HTTPS_PROXY` environment variable, then **the system proxy** — the one a VPN sets and Chromium
  follows but Node does not, which is what made a working VPN still end in a Cloudflare `403` —
  then a direct connection. Saving the field restarts the listener so the new agent is in place.
  electerm only supplies the agent factory; the value never comes from **Settings → AI**, so it
  survives both a restart and applying the offer. The panel shows the effective route, e.g.
  `upstream: http://127.0.0.1:10808 (system)`.

One consequence: `proxyAI` is one global setting. Applying the offer clears it for every AI
provider, not just this widget; switch back to a remote provider that needs a proxy by setting
**Proxy** again, and re-apply this widget's offer when you come back.

## What it does not do

- **One subscription at a time.** The dropdown switches provider in place, but one port serves one
  provider at a time.
- **Only `/v1/responses`.** A request to another path gets a message telling you to fix API PATH.
- **No `chat/completions`, no upstream translation.** The body and stream are the Responses format,
  unchanged except for `store`, `stream` and the authorization header.
- **The embedded panel needs a recent electerm.** Older builds get the browser page and manual
  config instead.

## Security

A local port that spends a subscription is worth locking, even when it is on `127.0.0.1`:

- **The proxy key.** Every `/v1` call must send the key the page shows, as `Authorization: Bearer`
  or `x-api-key`. It is generated once, encrypted with `safeStorage` like the tokens, and stays the
  same across restarts. Without it, any page in the browser could guess the port and spend the plan.
- **Host check.** Requests must be addressed to `localhost:<port>`, `127.0.0.1:<port>` or
  `[::1]:<port>`. A DNS-rebound page keeps its own name in `Host` and is refused.
- **Origin check.** A cross-site POST is refused; the proxy's own page is allowed. Admin routes
  are covered too.
- **Page token.** The mutating admin routes (`signin`, `signout`, `cancel`) also need the
  per-render token that only exists in the page's HTML.
- **`application/json` only** on `/v1/responses`, which a browser form post cannot set.
- **Tokens** live only in electerm's **main process**, encrypted with Electron `safeStorage`
  (Keychain / DPAPI / libsecret). If the OS cannot encrypt, saving is refused — no plaintext
  fallback. The embedded panel is an iframe on its own origin; it calls main-process functions
  through `window.electerm.call` and only ever receives a status, never a token.
- The token files sit in `<data dir>/widgets/.ai-auth-proxy/`, deliberately **outside** the widget
  folder: every file inside a widget folder is served by the `electerm-widget://` protocol.
- **Recent requests** keep time, path, model and status only — never a prompt.
- **The AI config is an offer, not a write.** The widget hands electerm a config with its start
  result or a panel call; the host lists it and writes it only when the user presses the button.
  The widget cannot set the system prompt (`roleAI`) this way — it is not on the whitelist.
- Installing a widget is trusting code to run in electerm's main process. This one holds a refresh
  token, so read it before you import it — it has no dependencies.

What this does not defend against: code already running as the same OS user, which can read the
page and the key. That is out of scope for a local proxy — such a process could also attach to
electerm directly.

## Development

```bash
npm test
```

55 tests cover the token store, the proxy (key, Host/Origin, `store: false`, `stream: true`, SSE
passthrough and fold, provider errors, 401, `/v1/models`, request log), the SSE fold, the admin
page, the upstream HTTP layer (redirects, abort, agent injection, proxy rule parsing and the
config → env → system resolution order), the widget entry and its panel API (the `aiConfig`
offer, provider switching without a port change, upstream agent reporting and switching it from
the panel, recovery from a missing start, staying stopped), and the OAuth primitives (PKCE,
exact-loopback match, ID-token signature / nonce / audience / expiry / tampering).

Verified end-to-end without an account:

- a body built by electerm's own `buildRequest('openai-responses', …)` goes through the proxy and
  is parsed by electerm's own `createStreamParser` into text plus a tool call;
- the non-streaming path — what the agent loop uses — is folded by the proxy and parsed by
  electerm's own `parseResponse` / `parseUsage` into the same message and token counts;
- the widget starts inside a real Electron main process, `safeStorage` is available, the page is
  served and a request without a token gets a readable `401`;
- the manifest imports through electerm's widget registry (`importWidget`) as `ai-auth-proxy`.

The OAuth sign-in itself needs a real account, so it is the one part that has only been reasoned
about, not run, here.

## Files

- `index.js` — widget entry, panel API (`getStatus`, `signIn`, `getAIConfig`, `setProvider`, …)
- `ui/index.html` — the embedded sign-in panel (`electerm.ui`)
- `lib/proxy.js` — HTTP server: `/v1/responses`, `/v1/models`, `/admin/*`, access checks
- `lib/upstream.js` — fetch-shaped upstream transport with electerm's proxy agent
- `lib/sse.js` — folds a Responses event stream into one response object
- `lib/page.js` — browser fallback page at `/`
- `lib/chatgpt.js` / `lib/grok.js` / `lib/oauth.js` — the two sign-in flows and their primitives
- `lib/store.js` — `safeStorage`-encrypted token and proxy-key store

## Credits

Protocol details from electerm PR [#4589](https://github.com/electerm/electerm/pull/4589) by
[@thejohnd0e](https://github.com/thejohnd0e), and the issue discussion in
[#4591](https://github.com/electerm/electerm/issues/4591).

MIT.
