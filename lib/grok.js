/**
 * SuperGrok sign-in: the OAuth 2.0 device authorization grant.
 *
 * No loopback listener and no PKCE here: the app shows a short code, the user
 * approves it on x.ai from any browser, and the app polls the token endpoint
 * until the code is approved or expires.
 *
 * Protocol details are adapted from electerm PR #4589 (thejohnd0e).
 */

const { randomUUID } = require('crypto')
const { postForm } = require('./oauth')

const ISSUER = 'https://auth.x.ai'
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

function createGrokAuth ({
  store,
  fetchImpl = globalThis.fetch,
  openExternal,
  log = () => {},
  clock = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = randomUUID
}) {
  let attempt = null
  let refreshPromise = null
  let version = 0

  function read () {
    return store.get('supergrok')
  }

  function statusOf (record) {
    const base = {
      connected: !!record,
      email: (record && record.account && record.account.email) || '',
      planUsageEnabled: !!record,
      expiresAt: (record && record.expiresAt) || 0
    }
    if (!attempt) {
      return { ...base, pending: false, userCode: '', verificationUrl: '', error: '' }
    }
    return {
      ...base,
      pending: !attempt.done,
      userCode: attempt.userCode || '',
      verificationUrl: attempt.verificationUrl || '',
      error: attempt.error || ''
    }
  }

  function checkVerificationUrl (value) {
    let url
    try {
      url = new URL(value)
    } catch (e) {
      throw new Error('The provider returned an unusable verification URL')
    }
    if (url.protocol !== 'https:' || !(url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))) {
      throw new Error('The provider returned a verification URL outside x.ai')
    }
    return url.toString()
  }

  async function poll (current) {
    try {
      while (clock() < current.expiresAt) {
        await sleep(current.interval * 1000)
        if (current.cancelled) {
          throw new Error('Sign-in cancelled')
        }
        const res = await fetchImpl(`${ISSUER}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT,
            device_code: current.deviceCode,
            client_id: CLIENT_ID
          }).toString(),
          signal: current.controller.signal
        })
        const body = await res.json().catch(() => ({}))
        if (res.ok && body.access_token) {
          if (current.cancelled) {
            throw new Error('Sign-in cancelled')
          }
          store.set('supergrok', {
            accessToken: body.access_token,
            refreshToken: body.refresh_token,
            expiresAt: clock() + (Number(body.expires_in) || 21600) * 1000
          })
          current.done = true
          log('info', 'Signed in to SuperGrok')
          return
        }
        if (body.error === 'authorization_pending') {
          continue
        }
        if (body.error === 'slow_down') {
          current.interval += 5
          continue
        }
        if (body.error === 'access_denied') {
          throw new Error(
            'SuperGrok authorization was denied, confirm the account has an eligible subscription'
          )
        }
        if (body.error === 'expired_token') {
          throw new Error('The device code expired, start sign-in again')
        }
        throw new Error(`SuperGrok authorization failed: ${body.error || res.status}`)
      }
      throw new Error('The device code expired, start sign-in again')
    } catch (error) {
      if (current.cancelled) {
        log('info', 'SuperGrok sign-in cancelled')
      } else {
        current.error = error.message
        log('error', `SuperGrok sign-in failed: ${error.message}`)
      }
    } finally {
      current.done = true
      if (attempt === current) {
        attempt = null
      }
    }
  }

  return {
    provider: 'supergrok',
    async beginSignIn () {
      if (attempt) {
        throw new Error('A SuperGrok sign-in is already in progress')
      }
      const res = await fetchImpl(`${ISSUER}/oauth2/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          scope: SCOPE,
          referrer: 'electerm'
        }).toString()
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.device_code) {
        throw new Error(
          `SuperGrok refused the device code request (${res.status}): ${body.error || 'no details'}`
        )
      }
      if (!/^[A-Z0-9-]+$/i.test(String(body.user_code || ''))) {
        throw new Error('The provider returned a malformed device code')
      }
      const current = {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUrl: checkVerificationUrl(
          body.verification_uri_complete || body.verification_uri
        ),
        expiresAt: clock() + Math.max(1, Number(body.expires_in) || 600) * 1000,
        interval: Math.max(1, Number(body.interval) || 5),
        cancelled: false,
        done: false,
        error: '',
        controller: new AbortController()
      }
      attempt = current
      log('info', `Enter the code ${current.userCode} on x.ai to approve SuperGrok`)
      // Polling runs in the background so the admin page can answer at once and
      // show progress; the page polls /admin/status for the outcome.
      poll(current)
      try {
        await openExternal(current.verificationUrl)
      } catch (e) {
        log('warn', `Could not open a browser, open ${current.verificationUrl} yourself`)
      }
      return {
        userCode: current.userCode,
        verificationUrl: current.verificationUrl,
        expiresIn: Math.floor((current.expiresAt - clock()) / 1000)
      }
    },
    cancel () {
      if (!attempt) {
        return { cancelled: false }
      }
      attempt.cancelled = true
      attempt.controller.abort()
      attempt = null
      return { cancelled: true }
    },
    status () {
      return statusOf(read())
    },
    isSigningIn () {
      return !!attempt
    },
    async getAccessToken () {
      const record = read()
      if (!record) {
        throw new Error('SuperGrok is not connected, open the widget URL and sign in')
      }
      if (record.accessToken && record.expiresAt > clock() + 60 * 1000) {
        return record.accessToken
      }
      if (!record.refreshToken) {
        throw new Error('The SuperGrok session expired, sign in again')
      }
      if (!refreshPromise) {
        const startedAt = version
        refreshPromise = postForm(`${ISSUER}/oauth2/token`, {
          grant_type: 'refresh_token',
          refresh_token: record.refreshToken,
          client_id: CLIENT_ID
        }, { fetchImpl }).then(tokens => {
          if (startedAt !== version) {
            throw new Error('SuperGrok was signed out while the token was refreshing')
          }
          store.set('supergrok', {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || record.refreshToken,
            expiresAt: clock() + (Number(tokens.expires_in) || 21600) * 1000
          })
          return tokens.access_token
        }).finally(() => {
          refreshPromise = null
        })
      }
      return refreshPromise
    },
    async signOut () {
      version++
      this.cancel()
      const record = read()
      if (record && record.refreshToken) {
        try {
          await postForm(`${ISSUER}/oauth2/revoke`, {
            token: record.refreshToken,
            client_id: CLIENT_ID
          }, { fetchImpl })
        } catch (e) {
          log('warn', `Could not revoke the SuperGrok token: ${e.message}`)
        }
      }
      store.remove('supergrok')
      log('info', 'Signed out of SuperGrok')
      return { signedOut: true }
    }
  }
}

module.exports = {
  createGrokAuth,
  GROK_ISSUER: ISSUER,
  GROK_CLIENT_ID: CLIENT_ID,
  GROK_SCOPE: SCOPE
}
