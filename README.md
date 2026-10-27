# electerm AI subscription proxy — widget example

An [electerm](https://github.com/electerm/electerm) custom widget that signs in to a **ChatGPT**
or **SuperGrok** subscription and exposes it as a local OpenAI **Responses** endpoint, so
electerm's AI panel — chat, agent mode with tools, AI bookmarks, themes, quick commands, command
suggestions — uses the subscription instead of an API key.

It runs a small HTTP proxy on `127.0.0.1` and keeps the OAuth token in electerm's main process.
No electerm changes are needed to *use* it: the proxy is reached through the AI config, and the
widget also offers that config so the user can apply it with one button (which needs a build that
understands a widget's `aiConfig` offer — see [Point electerm at the proxy](#point-electerm-at-the-proxy)).

> **Status.** This is an example, not part of electerm. The OAuth protocol details are adapted
> from [PR #4589](https://github.com/electerm/electerm/pull/4589) by
> [@thejohnd0e](https://github.com/thejohnd0e), who tested that flow in the app on Windows; this
> widget has not been signed in against a live account by the author of this repo. Everything
> that can be tested without an account — the proxy, the token store, the request and stream
> format against electerm's own parser — is covered by `npm test`.

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

- An electerm build with custom widget support (`Settings → Widgets` has an **Import** button).
- Node 20+ if you want to run the tests. The widget itself uses the Node runtime inside electerm.
- A ChatGPT or SuperGrok plan that the provider allows this kind of access on. If the plan has no
  access, the provider's error is shown as-is — there is no fallback to API billing.

## Install

```bash
git clone https://github.com/zxdong262/electerm-ai-auth-widget-example.git
```

1. In electerm open **Settings → Widgets**.
2. Click **Import** and pick the folder you just cloned. (The folder name does not matter; the
   widget is installed as `ai-auth-proxy` from its `package.json`.)
3. Select **AI subscription proxy** in the list, keep the provider (`ChatGPT` or `SuperGrok`),
   keep the port `8788`, and tick **Start with electerm**.
4. Click **Run**. A toast shows the URL — the widget is now listening.

`Start with electerm` is the part that matters in daily use: it makes electerm start the proxy
again on launch, so the AI panel keeps working without opening this screen. It can be toggled
later from the instance list (the lightning icon on the running instance).

## Sign in

Open the URL from the toast — <http://localhost:8788> — and click **Sign in**.

- **ChatGPT** opens your browser for an OAuth sign-in. The app catches the callback on a
  one-shot `127.0.0.1` port that only exists while signing in, then shows "Connected as …".
- **SuperGrok** shows a short code; approve it on x.ai and the page flips to connected by itself.

The page is also the setup sheet: it lists the three values electerm needs, with copy buttons, and
carries the proxy key (see below). **Send a test request** runs one non-streaming request through
the same code path the agent panel uses, so "connected" and "the AI panel works" are not the same
claim.

## Point electerm at the proxy

**One click:** in electerm open **Settings → Widgets → Running instances**, select this instance, and
press **Use these settings**. The widget's run result carries a ready-made AI config (URL, path, key,
auth header, and the name the AI panel shows), and electerm lists it with that button — nothing is
written until you press it.

**Or by hand**, in **Settings → AI**:

| Field | Value |
| --- | --- |
| API URL | `http://localhost:8788/v1` |
| API PATH | `/responses` |
| API key | the proxy key from the page (`sk-local-…`) — not a provider key |
| Auth header | leave the default (`Authorization: Bearer`) |
| Proxy | empty |
| Model | click **Load models** in electerm, or on the proxy page and copy one |

With the one-click path the panel label comes from the config, so it reads "ChatGPT subscription"
instead of being derived from the URL. That matters for a local endpoint: electerm's URL-derived
label takes the second-to-last part of the hostname, so `localhost` has nothing to take and
`127.0.0.1` yields `0`. Either host works once a name is set — by the button, or by filling
**Name** in **Settings → AI** (the `0` case needs the same build that understands the offer).

The model is the one thing the offer leaves out: this widget does not know which models the plan
exposes until the user asks, so **Load models** in electerm's AI settings fills that dropdown.

That is the whole setup. The agent panel, AI bookmarks, theme generation and quick commands all
go through the same config, so they all start using the subscription. If the key is wrong, electerm
shows the proxy's `401` message and the page marks the refused request in **Recent requests**.

> The one-click path needs an electerm build that reads `aiConfig` from a widget result (see
> `app/widgets/ai-config.js` in electerm). On an older build the panel simply shows the instance
> log, and the values above are still on the proxy page to copy.

## What it does not do

- **The panel label comes from the config, not from the widget.** The AI panel title is derived
  from the URL, so a local endpoint would read "Custom AI Model"; this widget sends `nameAI` in
  its offer, and once applied the panel says "ChatGPT subscription".
- **One provider per instance.** ChatGPT and SuperGrok each need their own widget instance and
  port if you want both.
- **No upstream HTTP proxy.** The widget connects to the provider directly; it ignores electerm's
  proxy setting.
- **No `chat/completions`.** Only `/v1/responses`; a request to another path gets a message
  telling you to fix the API PATH.

## Security

A local port that spends a subscription is worth locking, even when it is on `127.0.0.1`:

- **The proxy key.** Every `/v1` call must send the key the page shows, as `Authorization: Bearer`
  or `x-api-key`. The key is generated once, encrypted with `safeStorage` like the tokens, and
  stays the same across restarts so it is pasted once. Without it, any page in the browser could
  guess the port and spend the plan.
- **Host check.** Requests must be addressed to `localhost:<port>`, `127.0.0.1:<port>` or
  `[::1]:<port>`. A page on the internet that DNS-rebinds to `127.0.0.1` keeps its own name in
  `Host` and is refused, which is what stops it from becoming same-origin with the proxy.
- **Origin check.** A cross-site POST carries the page's origin and is refused; the proxy's own
  page is allowed. This covers the admin routes as well.
- **Page token.** The mutating admin routes (`signin`, `signout`, `cancel`) also need the
  per-render token that is only in the page's HTML, so a local process cannot drive sign-in
  without reading the page first.
- **`application/json` only** on `/v1/responses`, which a browser form post cannot set.
- **Tokens** live only in electerm's **main process**, encrypted with Electron `safeStorage`
  (Keychain / DPAPI / libsecret). If the OS cannot encrypt, saving is refused — there is no
  plaintext fallback.
- Nothing secret reaches the renderer, `userConfig`, the AI history or sync data. The only thing
  electerm stores is the AI config you typed.
- The token files sit in `<data dir>/widgets/.ai-auth-proxy/`, deliberately **outside** the widget
  folder: every file inside a widget folder is served to the widget's own page by the
  `electerm-widget://` protocol.
- **Recent requests** on the page keep the time, path, model and status only — never a prompt.
- **The AI config is an offer, not a write.** The widget hands electerm a config with its start
  result; electerm lists it and writes it only when the user presses the button. The widget cannot
  set the system prompt (`roleAI`) this way — that field is not on the whitelist.
- Installing a widget is trusting code to run in electerm's main process. This one holds a
  refresh token, so read it before you import it — it is a few hundred lines and has no
  dependencies.

What this does not defend against: code already running as the same OS user, which can read the
page and the key. That is out of scope for a local proxy — such a process could also attach to
electerm directly.

## Development

```bash
npm test
```

Covers the token store (encryption, refusal, corrupt records, the proxy key), the proxy (key
required, Host and Origin refusal, `store: false`, `stream: true`, SSE passthrough, the fold for
non-streaming callers, provider errors relayed with their status, 401 without a token,
`/v1/models` normalisation, wrong-path hint, the request log), the SSE fold on its own, the admin
page, the widget entry itself (the `aiConfig` offer, and that its key is the one the page shows and
the proxy accepts, and survives a restart), and the OAuth primitives (PKCE, the exact-loopback
match, ID-token signature / nonce / audience / expiry / tampering).

What was verified end-to-end, without an account:

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

| File | Role |
| --- | --- |
| `index.js` | widget entry: `widgetInfo`, `widgetRun` (one instance = one proxy) |
| `lib/proxy.js` | the HTTP server: `/v1/responses`, `/v1/models`, `/admin/*`, access checks |
| `lib/sse.js` | folds a Responses event stream into one response object |
| `lib/page.js` | the sign-in and setup page served at `/` |
| `lib/chatgpt.js` | ChatGPT OAuth (PKCE, loopback callback, refresh, revoke) |
| `lib/grok.js` | SuperGrok device-code flow |
| `lib/oauth.js` | PKCE, OIDC discovery, form posts, ID-token verification |
| `lib/store.js` | `safeStorage`-encrypted token and proxy-key store |

## Credits

Protocol details from electerm PR [#4589](https://github.com/electerm/electerm/pull/4589) by
[@thejohnd0e](https://github.com/thejohnd0e), and the issue discussion in
[#4591](https://github.com/electerm/electerm/issues/4591).

MIT.
