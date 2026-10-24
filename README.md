# electerm AI subscription proxy — widget example

An [electerm](https://github.com/electerm/electerm) custom widget that signs in to a **ChatGPT**
or **SuperGrok** subscription and exposes it as a local OpenAI **Responses** endpoint, so
electerm's AI panel — chat, agent mode with tools, AI bookmarks, themes, quick commands, command
suggestions — uses the subscription instead of an API key.

It runs a small HTTP proxy on `127.0.0.1` and keeps the OAuth token in electerm's main process.
No electerm changes are needed.

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
3. pipes the SSE back unchanged.

The request body and the stream are not translated at all.

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

The page also lists the exact values to paste into electerm, with copy buttons.

## Point electerm at the proxy

**Settings → AI**:

| Field | Value |
| --- | --- |
| API URL | `http://localhost:8788/v1` |
| API PATH | `/responses` |
| API key | `local` (any value, the proxy ignores it) |
| Auth header | leave the default (`Authorization: Bearer`) |
| Proxy | empty |
| Model | click **Load models** on the proxy page and pick one your plan lists |

Use `localhost`, not `127.0.0.1`: electerm labels the panel from the URL, and `localhost` falls
back to the neutral "Custom AI Model" while `127.0.0.1` renders as `0`.

That is the whole setup. The agent panel, AI bookmarks, theme generation and quick commands all
go through the same config, so they all start using the subscription.

## What it does not do

- **Provider labels.** The panel title says "Custom AI Model". Naming a session after the
  provider needs a change in electerm itself.
- **One provider per instance.** ChatGPT and SuperGrok each need their own widget instance and
  port if you want both.
- **No upstream HTTP proxy.** The widget connects to the provider directly; it ignores electerm's
  proxy setting.
- **No `chat/completions`.** Only `/v1/responses`; a request to another path gets a message
  telling you to fix the API PATH.

## Security

- Tokens live only in electerm's **main process**, encrypted with Electron `safeStorage` (Keychain
  / DPAPI / libsecret). If the OS cannot encrypt, saving is refused — there is no plaintext
  fallback.
- Nothing secret reaches the renderer, `userConfig`, the AI history or sync data. The only thing
  electerm stores is the AI config you typed.
- The token files sit in `<data dir>/widgets/.ai-auth-proxy/`, deliberately **outside** the widget
  folder: every file inside a widget folder is served to the widget's own page by the
  `electerm-widget://` protocol.
- The proxy and the sign-in page listen on `127.0.0.1` (and `::1` for the same port) only.
- Installing a widget is trusting code to run in electerm's main process. This one holds a
  refresh token, so read it before you import it — it is a few hundred lines and has no
  dependencies.

## Development

```bash
npm test
```

Covers the token store (encryption, refusal, corrupt records), the proxy (header swap,
`store: false`, SSE passthrough, provider errors relayed, 401 without a token, `/v1/models`
normalisation, wrong-path hint), the admin page, and the OAuth primitives (PKCE, the exact-loopback
match, ID-token signature / nonce / audience / expiry / tampering).

What was verified end-to-end, without an account:

- a body built by electerm's own `buildRequest('openai-responses', …)` goes through the proxy and
  is parsed by electerm's own `createStreamParser` into text plus a tool call;
- the non-streaming path parses with `parseResponse` and `parseUsage` (that is the agent loop);
- the widget starts inside a real Electron main process, `safeStorage` is available, the page is
  served and a request without a token gets a readable `401`;
- the manifest imports through electerm's widget registry (`importWidget`) as `ai-auth-proxy`.

The OAuth sign-in itself needs a real account, so it is the one part that has only been reasoned
about, not run, here.

## Files

| File | Role |
| --- | --- |
| `index.js` | widget entry: `widgetInfo`, `widgetRun` (one instance = one proxy) |
| `lib/proxy.js` | the HTTP server: `/v1/responses`, `/v1/models`, `/admin/*` |
| `lib/page.js` | the sign-in page served at `/` |
| `lib/chatgpt.js` | ChatGPT OAuth (PKCE, loopback callback, refresh, revoke) |
| `lib/grok.js` | SuperGrok device-code flow |
| `lib/oauth.js` | PKCE, OIDC discovery, form posts, ID-token verification |
| `lib/store.js` | `safeStorage`-encrypted token store |

## Credits

Protocol details from electerm PR [#4589](https://github.com/electerm/electerm/pull/4589) by
[@thejohnd0e](https://github.com/thejohnd0e), and the issue discussion in
[#4591](https://github.com/electerm/electerm/issues/4591).

MIT.
