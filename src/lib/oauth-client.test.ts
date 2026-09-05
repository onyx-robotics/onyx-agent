import { afterEach, describe, expect, mock, test } from "bun:test"

import {
  buildAuthorizationUrl,
  OAuthRequestError,
  persistableCredential,
  pollDeviceTokens,
  refreshOAuthCredential,
  startDeviceAuthorization,
  validateCliAuthConfig,
  type CliAuthConfig,
} from "./oauth-client"

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

const config: CliAuthConfig = {
  clientId: "client_cli_test",
  issuer: "https://auth.example.test",
  authorizationEndpoint: "https://auth.example.test/oauth2/authorize",
  tokenEndpoint: "https://auth.example.test/oauth2/token",
  deviceAuthorizationEndpoint:
    "https://auth.example.test/oauth2/device_authorization",
  jwksUri: "https://auth.example.test/oauth2/jwks",
  scopes: ["openid", "profile", "email", "offline_access"],
  loopbackRedirectUri: "http://127.0.0.1:*/callback",
}

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

describe("OAuth public-client protocol", () => {
  test("builds authorization-code requests with state and S256 PKCE", () => {
    const url = buildAuthorizationUrl({
      config,
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "state-value",
      nonce: "nonce-value",
      codeChallenge: "challenge-value",
    })
    expect(url.searchParams.get("client_secret")).toBeNull()
    expect(url.searchParams.get("state")).toBe("state-value")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:43123/callback"
    )
  })

  test("honors authorization_pending and slow_down before succeeding", async () => {
    const responses = [
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 900,
      }),
    ]
    globalThis.fetch = mock(
      async () => responses.shift()!
    ) as unknown as typeof fetch
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    const credential = await pollDeviceTokens({
      config,
      authorization: {
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/activate",
        expiresIn: 600,
        interval: 1,
      },
      timeoutMs: 60_000,
    })
    expect(credential.accessToken).toBe("access")
    expect(responses).toHaveLength(0)
  })

  test("retries transient refresh failures and preserves a rotated refresh token", async () => {
    const responses = [
      Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
      Response.json({ access_token: "new-access", expires_in: 900 }),
    ]
    globalThis.fetch = mock(
      async () => responses.shift()!
    ) as unknown as typeof fetch
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    const refreshed = await refreshOAuthCredential({
      config,
      credential: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 0,
      },
    })
    expect(refreshed).toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
    })
  })

  test("bounds a transient refresh failure to three requests", async () => {
    let requests = 0
    globalThis.fetch = mock(async () => {
      requests += 1
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503 }
      )
    }) as unknown as typeof fetch
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    await expect(
      refreshOAuthCredential({
        config,
        credential: {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: 0,
        },
      })
    ).rejects.toEqual(expect.any(OAuthRequestError))
    expect(requests).toBe(3)
  })

  test("surfaces denial without treating it as a fallback condition", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "access_denied" }, { status: 400 })
    ) as unknown as typeof fetch
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    await expect(
      pollDeviceTokens({
        config,
        authorization: {
          deviceCode: "device-code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example.test/activate",
          expiresIn: 600,
          interval: 1,
        },
        timeoutMs: 60_000,
      })
    ).rejects.toEqual(expect.any(OAuthRequestError))
  })

  test("sends the server nonce with device authorization and surfaces the ID token", async () => {
    let deviceBody = ""
    const responses = [
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example.test/activate",
        expires_in: 600,
        interval: 1,
      }),
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 900,
        id_token: "h.p.s",
      }),
    ]
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      if (responses.length === 2) deviceBody = String(init?.body)
      return responses.shift()!
    }) as unknown as typeof fetch
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    const authorization = await startDeviceAuthorization(config, {
      nonce: "server-nonce",
    })
    expect(new URLSearchParams(deviceBody).get("nonce")).toBe("server-nonce")
    const credential = await pollDeviceTokens({
      config,
      authorization,
      timeoutMs: 60_000,
    })
    expect(credential.idToken).toBe("h.p.s")
    expect(persistableCredential(credential)).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: credential.expiresAt,
    })
  })
})

describe("CLI auth configuration validation", () => {
  const apiUrl = "https://app.example.test"

  test("accepts https endpoints on the issuer origin", () => {
    expect(validateCliAuthConfig(config, { apiUrl })).toEqual(config)
    expect(
      validateCliAuthConfig(config, { apiUrl: "http://localhost:3000" })
        .clientId
    ).toBe(config.clientId)
  })

  test("rejects plaintext, cross-origin, or incomplete configurations", () => {
    expect(() =>
      validateCliAuthConfig(
        { ...config, tokenEndpoint: "http://auth.example.test/oauth2/token" },
        { apiUrl }
      )
    ).toThrow("issuer origin")
    expect(() =>
      validateCliAuthConfig(
        { ...config, tokenEndpoint: "https://evil.example/oauth2/token" },
        { apiUrl }
      )
    ).toThrow("issuer origin")
    expect(() =>
      validateCliAuthConfig(config, { apiUrl: "http://onyx.internal:3000" })
    ).toThrow("must use https")
    expect(() =>
      validateCliAuthConfig({ ...config, scopes: ["openid"] }, { apiUrl })
    ).toThrow("offline_access")
    expect(() =>
      validateCliAuthConfig({ ...config, issuer: undefined }, { apiUrl })
    ).toThrow("invalid CLI authentication configuration")
  })
})
