/**
 * ChatGPT subscription sign-in: OAuth authorization code + PKCE, with a
 * one-shot loopback callback on 127.0.0.1.
 *
 * The flow is the one OpenAI's own agent client uses: discovery on
 * auth.openai.com, a dynamically issued client id on first sign-in (the
 * `dynamic_agent_client` placeholder is exchanged for a real one in the
 * callback), a stable per-install host id, and a `chatgpt.tokens.use.direct`
 * scope that is what makes the token bill against the subscription instead of
 * an API key.
 *
 * Protocol details are adapted from electerm PR #4589 (thejohnd0e), which
 * implemented this in the app's main process.
 */

const { randomUUID } = require('crypto')
const {
  createPkce,
  isExactLoopbackCallback,
  createCallbackListener,
  discoverOIDC,
  postForm,
  verifyIdToken
} = require('./oauth')

const ISSUER = 'https://auth.openai.com'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const RESOURCE = 'https://api.openai.com/v1'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'

function createChatGPTAuth ({
  store,
  fetchImpl = globalThis.fetch,
  openExternal,
  log = () => {},
  clock = Date.now,
  random = randomUUID
}) {
  let pending = null
  let refreshPromise = null
  let version = 0

  function read () {
    return store.get('chatgpt')
  }

  async function hostState () {
    const host = store.getHost()
    const hostId = host.hostId || `urn:uuid:${random()}`
    if (hostId !== host.hostId) {
      store.setHost({ hostId })
    }
    return {
      hostId,
      clientId: (host.clientIds && host.clientIds.chatgpt) || '',
      accountId: (host.accountIds && host.accountIds.chatgpt) || ''
    }
  }

  async function signIn () {
    if (pending) {
      throw new Error('A ChatGPT sign-in is already in progress')
    }
    const attempt = {
      cancelled: false,
      listener: createCallbackListener(),
      controller: new AbortController()
    }
    pending = attempt
    const signal = attempt.controller.signal
    try {
      const [{ redirectUri, callback }, metadata, host, previous] = await Promise.all([
        attempt.listener.ready,
        discoverOIDC(ISSUER, { fetchImpl, signal }),
        hostState(),
        read()
      ])
      const isNewClient = !host.clientId
      const clientId = host.clientId || DYNAMIC_CLIENT_ID
      const { verifier, challenge } = createPkce()
      const state = random().replace(/-/g, '')
      const nonce = random().replace(/-/g, '')

      const authorize = new URL(metadata.authorization_endpoint)
      const params = {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        ext_agent_host_id: host.hostId
      }
      if (isNewClient) {
        params.agent_name_hint = 'electerm'
      }
      Object.entries(params).forEach(([key, value]) => {
        authorize.searchParams.set(key, value)
      })

      log('info', 'Opening the browser to sign in to ChatGPT')
      await openExternal(authorize.toString())
      const returned = await callback
      if (attempt.cancelled) {
        throw new Error('Sign-in cancelled')
      }
      if (!isExactLoopbackCallback(redirectUri, returned)) {
        throw new Error('OAuth callback did not come from the loopback address we opened')
      }
      const callbackUrl = new URL(returned)
      if (callbackUrl.searchParams.get('state') !== state) {
        throw new Error('OAuth state mismatch, the callback did not belong to this sign-in')
      }
      const code = callbackUrl.searchParams.get('code')
      if (callbackUrl.searchParams.has('error') || !code) {
        throw new Error(
          `ChatGPT refused the authorization: ${callbackUrl.searchParams.get('error') || 'no code returned'}`
        )
      }

      // On a first sign-in the placeholder is replaced by the client id the
      // provider issues. It has to be remembered, or every later refresh and
      // every later sign-in would register a new client.
      const returnedClientId = callbackUrl.searchParams.get('client_id')
      let issuedClientId = clientId
      if (isNewClient) {
        if (!returnedClientId || returnedClientId === DYNAMIC_CLIENT_ID) {
          throw new Error('ChatGPT did not issue a client id for this install')
        }
        issuedClientId = returnedClientId
      } else if (returnedClientId && returnedClientId !== clientId) {
        throw new Error('OAuth callback carried a different client id')
      }

      const tokens = await postForm(
        metadata.token_endpoint,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: issuedClientId,
          code_verifier: verifier,
          resource: RESOURCE
        },
        { fetchImpl, signal }
      )
      if (attempt.cancelled) {
        throw new Error('Sign-in cancelled')
      }

      const jwksRes = await fetchImpl(metadata.jwks_uri, {
        signal,
        headers: { accept: 'application/json' }
      })
      if (!jwksRes.ok) {
        throw new Error(`Cannot read the provider signing keys (${jwksRes.status})`)
      }
      const claims = verifyIdToken(tokens.id_token, await jwksRes.json(), {
        issuer: ISSUER,
        audience: issuedClientId,
        nonce,
        clock
      })
      const expectedAccount = host.accountId || (previous && previous.account && previous.account.sub)
      if (expectedAccount && expectedAccount !== claims.sub) {
        throw new Error('That is a different ChatGPT account than the one already connected')
      }

      const record = {
        clientId: issuedClientId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000,
        account: { sub: claims.sub, email: claims.email || '' },
        planUsageEnabled: String(tokens.scope || claims.scope || '')
          .split(/\s+/)
          .includes(PLAN_SCOPE)
      }
      if (attempt.cancelled || pending !== attempt) {
        throw new Error('Sign-in cancelled')
      }
      store.setHost({
        clientIds: { chatgpt: issuedClientId },
        accountIds: { chatgpt: claims.sub }
      })
      store.set('chatgpt', record)
      log('info', `Signed in to ChatGPT${record.account.email ? ` as ${record.account.email}` : ''}`)
      if (!record.planUsageEnabled) {
        log('warn', 'The token is missing chatgpt.tokens.use.direct, so it may not bill against the subscription')
      }
      return statusOf(record)
    } catch (error) {
      if (attempt.cancelled) {
        throw new Error('Sign-in cancelled')
      }
      throw error
    } finally {
      attempt.listener.close()
      if (pending === attempt) {
        pending = null
      }
    }
  }

  function statusOf (record) {
    if (!record) {
      return { connected: false, email: '', planUsageEnabled: false, expiresAt: 0 }
    }
    return {
      connected: true,
      email: (record.account && record.account.email) || '',
      planUsageEnabled: !!record.planUsageEnabled,
      expiresAt: record.expiresAt || 0
    }
  }

  async function refresh (record) {
    const metadata = await discoverOIDC(ISSUER, { fetchImpl })
    const startedAt = version
    const tokens = await postForm(metadata.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      client_id: record.clientId,
      resource: RESOURCE
    }, { fetchImpl })
    if (startedAt !== version) {
      throw new Error('ChatGPT was signed out while the token was refreshing')
    }
    const next = {
      ...record,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || record.refreshToken,
      expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000
    }
    store.set('chatgpt', next)
    return next.accessToken
  }

  return {
    provider: 'chatgpt',
    signIn,
    cancel () {
      if (!pending) {
        return { cancelled: false }
      }
      pending.cancelled = true
      pending.controller.abort()
      pending.listener.cancel()
      return { cancelled: true }
    },
    status () {
      return statusOf(read())
    },
    isSigningIn () {
      return !!pending
    },
    async getAccessToken () {
      const record = read()
      if (!record) {
        throw new Error('ChatGPT is not connected, open the widget URL and sign in')
      }
      if (record.planUsageEnabled === false) {
        throw new Error(
          'The ChatGPT token is missing plan usage permission, sign out and sign in again'
        )
      }
      if (record.accessToken && record.expiresAt > clock() + 60 * 1000) {
        return record.accessToken
      }
      if (!record.refreshToken) {
        throw new Error('The ChatGPT session expired, sign in again')
      }
      // One refresh at a time: several AI requests can arrive together and a
      // rotated refresh token would make all but the first fail.
      if (!refreshPromise) {
        refreshPromise = refresh(record).finally(() => {
          refreshPromise = null
        })
      }
      return refreshPromise
    },
    async signOut () {
      version++
      if (pending) {
        this.cancel()
      }
      const record = read()
      if (record) {
        try {
          const metadata = await discoverOIDC(ISSUER, { fetchImpl })
          if (metadata.revocation_endpoint && record.refreshToken) {
            await postForm(metadata.revocation_endpoint, {
              token: record.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: record.clientId
            }, { fetchImpl })
          }
        } catch (e) {
          log('warn', `Could not revoke the ChatGPT token: ${e.message}`)
        }
      }
      store.remove('chatgpt')
      log('info', 'Signed out of ChatGPT')
      return { signedOut: true }
    }
  }
}

module.exports = {
  createChatGPTAuth,
  CHATGPT_ISSUER: ISSUER,
  CHATGPT_SCOPES: SCOPES,
  CHATGPT_RESOURCE: RESOURCE,
  CHATGPT_DYNAMIC_CLIENT_ID: DYNAMIC_CLIENT_ID
}
