import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, test } from "bun:test"

import {
  DEFAULT_API_URL,
  apiBaseUrl,
  apiKey,
  apiTarget,
  describeApiTarget,
  readConfig,
  writeConfig,
  type CliProfile,
} from "./lib/config"
import { cliLoginCompleteHtml } from "./lib/login"
import {
  LOCAL_API_URL,
  buildCliLoginUrl,
  loginBaseUrl,
  loginProfileManifest,
  profileNameForTeam,
  saveLoginProfile,
} from "./commands/login"
import {
  commandProfile,
  commandProfileList,
  commandProfileDelete,
  commandProfileSetApiKeyEnv,
  commandProfileUse,
} from "./commands/profile"

const ALPHA_API_KEY_ENV = "ONYX_ALPHA_API_KEY"
const BETA_API_KEY_ENV = "ONYX_BETA_API_KEY"

function profile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    apiUrl: "https://app.onyx.test",
    apiKey: "onyx_key",
    teamId: "22222222-2222-4222-8222-222222222222",
    teamName: "Alpha Team",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides,
  }
}

async function captureLogs(fn: () => Promise<void>) {
  const previous = console.log
  const logs: string[] = []
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }
  try {
    await fn()
  } finally {
    console.log = previous
  }
  return logs.join("\n")
}

async function withFakeOpenCodeModels<T>(
  models: string[],
  fn: () => Promise<T>
) {
  const root = await mkdtemp(join(tmpdir(), "onyx-profile-opencode-"))
  const bin = join(root, "opencode")
  await writeFile(
    bin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "models" ]]; then',
      `  cat <<'MODELS'`,
      models.join("\n"),
      "MODELS",
      "  exit 0",
      "fi",
      'echo "unexpected opencode command: $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
    "utf8"
  )
  await chmod(bin, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${previousPath ? `:${previousPath}` : ""}`
  try {
    return await fn()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}

describe("CLI profiles", () => {
  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = await mkdtemp(
      join(tmpdir(), "onyx-cli-config-test-")
    )
    delete process.env.ONYX_API_KEY
    delete process.env.ONYX_API_URL
    delete process.env.ONYX_WORKER_ID
    delete process.env[ALPHA_API_KEY_ENV]
    delete process.env[BETA_API_KEY_ENV]
  })

  test("stores login results as the current profile", async () => {
    const saved = await saveLoginProfile({
      baseUrl: "http://localhost:3000",
      result: {
        apiKey: "onyx_secret",
        apiKeyId: "44444444-4444-4444-8444-444444444444",
        apiUrl: "https://app.onyx.test",
        teamId: "22222222-2222-4222-8222-222222222222",
        teamName: "Alpha Team",
        alreadyConfigured: false,
      },
    })

    expect(saved).toEqual({
      profileName: "alpha",
      apiUrl: "https://app.onyx.test",
      alreadyConfigured: false,
    })
    const config = await readConfig()
    expect(config.currentProfile).toBe("alpha")
    expect(config.profiles.alpha).toMatchObject({
      apiUrl: "https://app.onyx.test",
      apiKey: "onyx_secret",
      apiKeyId: "44444444-4444-4444-8444-444444444444",
      teamId: "22222222-2222-4222-8222-222222222222",
      teamName: "Alpha Team",
    })
  })

  test("builds the browser login URL with a non-secret profile manifest", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          apiKey: "alpha-secret",
          apiKeyId: "44444444-4444-4444-8444-444444444444",
        }),
      },
    })

    const config = await readConfig()
    const loginUrl = buildCliLoginUrl({
      baseUrl: "https://app.onyx.test",
      redirectUri: "http://127.0.0.1:8765/callback",
      state: "state-123",
      profiles: loginProfileManifest(config),
      refresh: true,
    })

    expect(loginUrl.pathname).toBe("/cli/login")
    expect(loginUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8765/callback"
    )
    expect(loginUrl.searchParams.get("refresh")).toBe("true")
    const manifest = JSON.parse(
      Buffer.from(
        loginUrl.searchParams.get("profiles") ?? "",
        "base64url"
      ).toString("utf8")
    )
    expect(manifest).toEqual([
      {
        profileName: "alpha",
        teamId: "22222222-2222-4222-8222-222222222222",
        apiUrl: "https://app.onyx.test",
        apiKeyId: "44444444-4444-4444-8444-444444444444",
      },
    ])
    expect(JSON.stringify(manifest)).not.toContain("alpha-secret")
  })

  test("renders a branded login completion page", () => {
    const html = cliLoginCompleteHtml()

    expect(html).toContain("Onyx CLI login complete. You can close this tab.")
    expect(html).toContain("<span>Onyx</span>")
    expect(html).toContain('<section class="card"')
    expect(html).toContain('<div class="card-header">')
    expect(html).toContain('<div class="title-row">')
    expect(html).toContain('class="title-icon"')
    expect(html).toContain("color-scheme: light")
    expect(html).not.toContain("prefers-color-scheme: dark")
    expect(html).toContain("--background: oklch(1 0 0)")
    expect(html).toContain("max-width: 672px")
    expect(html).toContain("width: 60px")
    expect(html).toContain("font-size: 48px")
  })

  test("generates first-word profile names and handles empty names", () => {
    expect(profileNameForTeam("Acme Research Lab")).toBe("acme")
    expect(profileNameForTeam("Acme-Research Lab")).toBe("acme-research")
    expect(profileNameForTeam("!!!")).toBe("team")
  })

  test("reuses existing team and origin profiles", async () => {
    await writeConfig({
      currentProfile: "custom",
      profiles: {
        custom: profile({
          apiKey: "old-key",
          teamName: "Original Team",
          worker: {
            agent: "opencode",
            models: { opencode: "openrouter/qwen/qwen3-coder" },
          },
        }),
      },
    })

    const saved = await saveLoginProfile({
      baseUrl: "https://app.onyx.test",
      result: {
        apiKey: "new-key",
        apiUrl: "https://app.onyx.test",
        teamId: "22222222-2222-4222-8222-222222222222",
        teamName: "Renamed Team",
        alreadyConfigured: false,
      },
    })

    expect(saved.profileName).toBe("custom")
    const config = await readConfig()
    expect(config.profiles.custom?.apiKey).toBe("new-key")
    expect(config.profiles.custom?.teamName).toBe("Renamed Team")
    expect(config.profiles.custom?.worker).toEqual({
      agent: "opencode",
      models: { opencode: "openrouter/qwen/qwen3-coder" },
    })
  })

  test("suffixes generated profile names when another team owns the name", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          teamId: "33333333-3333-4333-8333-333333333333",
          teamName: "Alpha Other",
        }),
      },
    })

    const saved = await saveLoginProfile({
      baseUrl: "https://app.onyx.test",
      result: {
        apiKey: "new-key",
        apiUrl: "https://app.onyx.test",
        teamId: "22222222-2222-4222-8222-222222222222",
        teamName: "Alpha Team",
        alreadyConfigured: false,
      },
    })

    expect(saved.profileName).toBe("alpha-2")
    expect((await readConfig()).currentProfile).toBe("alpha-2")
  })

  test("selects already configured profiles without overwriting credentials", async () => {
    await writeConfig({
      currentProfile: "beta",
      profiles: {
        alpha: profile({ apiKey: "old-key" }),
        beta: profile({
          apiKey: "beta-key",
          teamId: "33333333-3333-4333-8333-333333333333",
          teamName: "Beta Team",
        }),
      },
    })

    const saved = await saveLoginProfile({
      baseUrl: "https://app.onyx.test",
      result: {
        apiUrl: "https://app.onyx.test",
        teamId: "22222222-2222-4222-8222-222222222222",
        teamName: "Alpha Team",
        profileName: "alpha",
        alreadyConfigured: true,
      },
    })

    const config = await readConfig()
    expect(saved).toEqual({
      profileName: "alpha",
      apiUrl: "https://app.onyx.test",
      alreadyConfigured: true,
    })
    expect(config.currentProfile).toBe("alpha")
    expect(config.profiles.alpha?.apiKey).toBe("old-key")
  })

  test("refresh replaces env-backed profile credentials with the returned stored key", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          apiKey: undefined,
          apiKeyEnv: ALPHA_API_KEY_ENV,
          worker: {
            agent: "claude",
            models: { claude: "sonnet" },
          },
        }),
      },
    })

    await saveLoginProfile({
      baseUrl: "https://app.onyx.test",
      result: {
        apiKey: "new-stored-key",
        apiKeyId: "44444444-4444-4444-8444-444444444444",
        apiUrl: "https://app.onyx.test",
        teamId: "22222222-2222-4222-8222-222222222222",
        teamName: "Alpha Team",
        alreadyConfigured: false,
      },
    })

    const alpha = (await readConfig()).profiles.alpha
    expect(alpha?.apiKey).toBe("new-stored-key")
    expect(alpha?.apiKeyId).toBe("44444444-4444-4444-8444-444444444444")
    expect(alpha?.apiKeyEnv).toBeUndefined()
    expect(alpha?.worker).toEqual({
      agent: "claude",
      models: { claude: "sonnet" },
    })
  })

  test("resolves current and overridden profiles for API calls", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
        beta: profile({
          apiUrl: "https://beta.onyx.test",
          apiKey: "beta-key",
          teamName: "Beta Team",
        }),
      },
    })

    expect(await apiBaseUrl()).toBe("https://app.onyx.test")
    expect(await apiKey()).toBe("alpha-key")
    expect(
      await apiBaseUrl({
        positional: ["status"],
        options: { profile: "beta" },
      })
    ).toBe("https://beta.onyx.test")
    expect(
      await apiKey({
        positional: ["status"],
        options: { profile: "beta" },
      })
    ).toBe("beta-key")
  })

  test("uses environment credentials before profiles", async () => {
    process.env.ONYX_API_KEY = "env-key"
    process.env.ONYX_API_URL = "https://env.onyx.test"

    expect(await apiBaseUrl()).toBe("https://env.onyx.test")
    expect(await apiKey()).toBe("env-key")
  })

  test("defaults API URL to the hosted app for standalone installs", async () => {
    process.env.ONYX_API_KEY = "env-key"

    expect(await apiBaseUrl()).toBe(DEFAULT_API_URL)
  })

  test("reports the API target with its source", async () => {
    expect(await apiTarget()).toBeNull()

    process.env.ONYX_API_KEY = "env-key"
    expect(await apiTarget()).toEqual({
      url: DEFAULT_API_URL,
      source: "default",
    })
    delete process.env.ONYX_API_KEY

    await writeConfig({
      currentProfile: "alpha",
      profiles: { alpha: profile() },
    })
    expect(await apiTarget()).toEqual({
      url: "https://app.onyx.test",
      source: "profile",
      profileName: "alpha",
    })

    process.env.ONYX_API_URL = "https://env.onyx.test"
    expect(await apiTarget()).toEqual({
      url: "https://env.onyx.test",
      source: "env",
    })

    expect(
      await apiTarget({
        positional: ["status"],
        options: { "api-url": "https://flag.onyx.test" },
      })
    ).toEqual({ url: "https://flag.onyx.test", source: "flag" })
  })

  test("describes API targets for status output", () => {
    expect(
      describeApiTarget({
        url: "https://app.onyx.test",
        source: "profile",
        profileName: "alpha",
      })
    ).toBe("https://app.onyx.test (profile alpha)")
    expect(
      describeApiTarget({ url: "https://env.onyx.test", source: "env" })
    ).toBe("https://env.onyx.test (ONYX_API_URL)")
    expect(
      describeApiTarget({ url: "https://flag.onyx.test", source: "flag" })
    ).toBe("https://flag.onyx.test (--api-url)")
    expect(describeApiTarget({ url: DEFAULT_API_URL, source: "default" })).toBe(
      `${DEFAULT_API_URL} (default)`
    )
  })

  test("login --local targets the locally running app", async () => {
    expect(
      await loginBaseUrl({ positional: ["login"], options: { local: "true" } })
    ).toBe(LOCAL_API_URL)

    await writeConfig({
      currentProfile: "alpha",
      profiles: { alpha: profile() },
    })
    expect(
      await loginBaseUrl({ positional: ["login"], options: { local: "true" } })
    ).toBe(LOCAL_API_URL)

    await expect(
      loginBaseUrl({
        positional: ["login"],
        options: { local: "true", "api-url": "https://flag.onyx.test" },
      })
    ).rejects.toThrow("Pass either --local or --api-url, not both.")
  })

  test("login without --local follows the configured target", async () => {
    expect(await loginBaseUrl({ positional: ["login"], options: {} })).toBe(
      DEFAULT_API_URL
    )

    await writeConfig({
      currentProfile: "alpha",
      profiles: { alpha: profile() },
    })
    expect(await loginBaseUrl({ positional: ["login"], options: {} })).toBe(
      "https://app.onyx.test"
    )
  })

  test("resolves profile API keys from apiKeyEnv before stored profile keys", async () => {
    process.env[ALPHA_API_KEY_ENV] = "alpha-env-key"
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          apiKey: "alpha-stored-key",
          apiKeyEnv: ALPHA_API_KEY_ENV,
        }),
      },
    })

    expect(await apiKey()).toBe("alpha-env-key")
  })

  test("does not fall back to a stored key when apiKeyEnv is missing", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          apiKey: "alpha-stored-key",
          apiKeyEnv: ALPHA_API_KEY_ENV,
        }),
      },
    })

    await expect(apiKey()).rejects.toThrow(
      'Profile "alpha" expects API key in ONYX_ALPHA_API_KEY'
    )
  })

  test("treats an empty profile API key environment variable as missing", async () => {
    process.env[ALPHA_API_KEY_ENV] = "  "
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          apiKey: "alpha-stored-key",
          apiKeyEnv: ALPHA_API_KEY_ENV,
        }),
      },
    })

    await expect(apiKey()).rejects.toThrow(
      'Profile "alpha" expects API key in ONYX_ALPHA_API_KEY'
    )
  })

  test("global environment API key overrides a missing profile apiKeyEnv", async () => {
    process.env.ONYX_API_KEY = "global-env-key"
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({
          apiKey: "alpha-stored-key",
          apiKeyEnv: ALPHA_API_KEY_ENV,
        }),
      },
    })

    expect(await apiKey()).toBe("global-env-key")
  })

  test("lists profiles and switches the active profile", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
        beta: profile({
          apiKey: "beta-key",
          teamId: "33333333-3333-4333-8333-333333333333",
          teamName: "Beta Team",
          worker: {
            agent: "opencode",
            models: { opencode: "openrouter/qwen/qwen3-coder" },
          },
        }),
      },
    })

    const output = await captureLogs(commandProfileList)
    expect(output).toContain("* alpha")
    expect(output).toContain("stored key")
    expect(output).toContain("worker:codex (default)")
    expect(output).toContain("  beta")
    expect(output).toContain(
      "worker:opencode model=openrouter/qwen/qwen3-coder"
    )

    await captureLogs(() =>
      commandProfileUse({
        positional: ["profile", "use", "beta"],
        options: {},
      })
    )
    expect((await readConfig()).currentProfile).toBe("beta")
  })

  test("blocks profile mutations from worker agents", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
        beta: profile({
          apiKey: "beta-key",
          teamId: "33333333-3333-4333-8333-333333333333",
          teamName: "Beta Team",
        }),
      },
    })

    process.env.ONYX_WORKER_CONTEXT = "/tmp/worker-context.json"
    const message = "Worker agents cannot mutate Onyx CLI profiles"

    try {
      await expect(
        commandProfileUse({
          positional: ["profile", "use", "beta"],
          options: {},
        })
      ).rejects.toThrow(message)
      await expect(
        commandProfileDelete({
          positional: ["profile", "delete", "beta"],
          options: {},
        })
      ).rejects.toThrow(message)
      await expect(
        commandProfileSetApiKeyEnv({
          positional: [
            "profile",
            "set-api-key-env",
            "alpha",
            ALPHA_API_KEY_ENV,
          ],
          options: {},
        })
      ).rejects.toThrow(message)
      await expect(
        commandProfile({
          positional: ["profile", "worker", "set"],
          options: {
            agent: "opencode",
            model: "openrouter/qwen/qwen3-coder",
          },
        })
      ).rejects.toThrow(message)
      await expect(
        commandProfile({
          positional: ["profile", "worker", "clear"],
          options: { agent: "true" },
        })
      ).rejects.toThrow(message)

      expect(await captureLogs(commandProfileList)).toContain("* alpha")
      expect(
        await captureLogs(() =>
          commandProfile({
            positional: ["profile", "worker", "get"],
            options: {},
          })
        )
      ).toContain("Worker agent: codex")

      const config = await readConfig()
      expect(config.currentProfile).toBe("alpha")
      expect(config.profiles.beta).toBeDefined()
      expect(config.profiles.alpha?.apiKeyEnv).toBeUndefined()
      expect(config.profiles.alpha?.worker).toBeUndefined()
    } finally {
      delete process.env.ONYX_WORKER_CONTEXT
    }
  })

  test("gets, sets, and clears profile worker defaults", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
      },
    })

    await captureLogs(() =>
      commandProfile({
        positional: ["profile", "worker", "set"],
        options: {
          agent: "opencode",
          model: "openrouter/qwen/qwen3-coder",
        },
      })
    )

    let alpha = (await readConfig()).profiles.alpha
    expect(alpha?.worker).toEqual({
      agent: "opencode",
      models: { opencode: "openrouter/qwen/qwen3-coder" },
    })

    const output = await captureLogs(() =>
      commandProfile({
        positional: ["profile", "worker", "get"],
        options: {},
      })
    )
    expect(output).toContain("Worker agent: opencode")
    expect(output).toContain("Model opencode: openrouter/qwen/qwen3-coder")
    expect(output).toContain("Model codex: (default)")

    await captureLogs(() =>
      commandProfile({
        positional: ["profile", "worker", "clear"],
        options: { model: "opencode" },
      })
    )
    alpha = (await readConfig()).profiles.alpha
    expect(alpha?.worker).toEqual({ agent: "opencode" })

    await captureLogs(() =>
      commandProfile({
        positional: ["profile", "worker", "clear"],
        options: { agent: "true" },
      })
    )
    alpha = (await readConfig()).profiles.alpha
    expect(alpha?.worker).toBeUndefined()
  })

  test("resolves OpenCode profile model display names before storing", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
      },
    })

    await withFakeOpenCodeModels(
      ["opencode/deepseek-v4-flash", "opencode/deepseek-v4-flash-free"],
      () =>
        captureLogs(() =>
          commandProfile({
            positional: ["profile", "worker", "set"],
            options: {
              agent: "opencode",
              model: "DeepSeek V4 Flash Free",
            },
          })
        )
    )

    const alpha = (await readConfig()).profiles.alpha
    expect(alpha?.worker).toEqual({
      agent: "opencode",
      models: { opencode: "opencode/deepseek-v4-flash-free" },
    })
  })

  test("rejects ambiguous OpenCode profile model display names", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
      },
    })

    await expect(
      withFakeOpenCodeModels(
        ["opencode/deepseek-v4-flash", "opencode/deepseek-v4-flash-free"],
        () =>
          commandProfile({
            positional: ["profile", "worker", "set"],
            options: {
              agent: "opencode",
              model: "DeepSeek V4 Flash",
            },
          })
      )
    ).rejects.toThrow("matched multiple available model ids")
  })

  test("stores exact OpenCode profile model identifiers without probing", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
      },
    })

    await captureLogs(() =>
      commandProfile({
        positional: ["profile", "worker", "set"],
        options: {
          agent: "opencode",
          model: "opencode/deepseek-v4-flash-free",
        },
      })
    )

    const alpha = (await readConfig()).profiles.alpha
    expect(alpha?.worker).toEqual({
      agent: "opencode",
      models: { opencode: "opencode/deepseek-v4-flash-free" },
    })
  })

  test("deletes profiles without switching teams implicitly", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-key" }),
        beta: profile({
          apiKey: "beta-key",
          teamId: "33333333-3333-4333-8333-333333333333",
          teamName: "Beta Team",
        }),
      },
    })

    await captureLogs(() =>
      commandProfileDelete({
        positional: ["profile", "delete", "beta"],
        options: {},
      })
    )

    let config = await readConfig()
    expect(config.currentProfile).toBe("alpha")
    expect(config.profiles.alpha).toBeDefined()
    expect(config.profiles.beta).toBeUndefined()

    await captureLogs(() =>
      commandProfileDelete({
        positional: ["profile", "delete", "alpha"],
        options: {},
      })
    )

    config = await readConfig()
    expect(config.currentProfile).toBe("")
    expect(config.profiles.alpha).toBeUndefined()
  })

  test("lists env-backed credential sources", async () => {
    process.env[ALPHA_API_KEY_ENV] = "alpha-env-key"
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKeyEnv: ALPHA_API_KEY_ENV }),
        beta: profile({
          apiKey: undefined,
          apiKeyEnv: BETA_API_KEY_ENV,
          teamName: "Beta Team",
        }),
      },
    })

    const output = await captureLogs(commandProfileList)
    expect(output).toContain("env:ONYX_ALPHA_API_KEY (set)")
    expect(output).toContain("env:ONYX_BETA_API_KEY (missing)")
  })

  test("sets a profile API key environment variable and removes stored key", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-stored-key" }),
      },
    })

    await captureLogs(() =>
      commandProfileSetApiKeyEnv({
        positional: ["profile", "set-api-key-env", "alpha", ALPHA_API_KEY_ENV],
        options: {},
      })
    )

    const config = await readConfig()
    const alpha = config.profiles.alpha
    expect(alpha).toBeDefined()
    expect(alpha?.apiKey).toBeUndefined()
    expect(alpha?.apiKeyEnv).toBe(ALPHA_API_KEY_ENV)
  })

  test("rejects unsafe API key environment variable names", async () => {
    await writeConfig({
      currentProfile: "alpha",
      profiles: {
        alpha: profile({ apiKey: "alpha-stored-key" }),
      },
    })

    await expect(
      commandProfileSetApiKeyEnv({
        positional: ["profile", "set-api-key-env", "alpha", "onyx_alpha"],
        options: {},
      })
    ).rejects.toThrow("Environment variable name must match")
  })

  test("errors when a selected profile is missing", async () => {
    await expect(apiKey()).rejects.toThrow("No Onyx CLI profile selected")
    await expect(
      apiKey({ positional: ["status"], options: { profile: "missing" } })
    ).rejects.toThrow('Unknown Onyx CLI profile "missing"')
    await expect(
      commandProfileUse({
        positional: ["profile", "use", "missing"],
        options: {},
      })
    ).rejects.toThrow('Unknown Onyx CLI profile "missing"')
    await expect(
      commandProfileDelete({
        positional: ["profile", "delete", "missing"],
        options: {},
      })
    ).rejects.toThrow('Unknown Onyx CLI profile "missing"')
  })
})
