import { shouldUseDeviceFlow } from "../commands/login"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertWslStorage,
  classifyWsl,
  isLinuxLocalMount,
  isWindowsExecutable,
  parseMountInfo,
  resolveStoragePath,
  storageMount,
} from "./linux-environment"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test("kernel evidence distinguishes ordinary Linux, WSL1 and WSL2", () => {
  expect(classifyWsl("darwin", "microsoft-standard-WSL2")).toBe("none")
  expect(classifyWsl("linux", "6.8.0-generic")).toBe("none")
  expect(classifyWsl("linux", "4.4.0-19041-Microsoft")).toBe("1")
  expect(classifyWsl("linux", "6.6.87.2-microsoft-standard-WSL2")).toBe("2")
  expect(classifyWsl("linux", "custom-wsl-kernel")).toBe("unknown")
})

test("mount selection handles escaped aliases and rejects network/unknown filesystems", () => {
  const mounts = parseMountInfo(
    "1 0 8:0 / / rw - ext4 /dev/sda rw\n2 1 0:1 / /aliased\\040drive rw - 9p C:\\134 rw\n3 1 0:2 / /net rw - nfs host:/share rw\n4 1 0:3 / /tmp rw - tmpfs tmpfs rw"
  )
  expect(storageMount("/aliased drive/repo", mounts)?.source).toBe("C:\\")
  expect(isLinuxLocalMount(storageMount("/aliased drive/repo", mounts))).toBe(
    false
  )
  expect(isLinuxLocalMount(storageMount("/net/repo", mounts))).toBe(false)
  expect(isLinuxLocalMount(storageMount("/tmp/repo", mounts))).toBe(true)
  expect(isLinuxLocalMount(storageMount("/network/repo", mounts))).toBe(true)
  expect(isLinuxLocalMount(null)).toBe(false)
})

test("storage checks resolve symlinks and nonexistent descendants without creating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "onyx-wsl-"))
  roots.push(root)
  await mkdir(join(root, "drive"))
  await symlink(join(root, "drive"), join(root, "alias"))
  const drive = await resolveStoragePath(join(root, "drive"))
  const target = join(root, "alias", "missing", "credentials")
  expect(await resolveStoragePath(target)).toBe(
    join(drive, "missing", "credentials")
  )
  const inspection = {
    version: "2" as const,
    mounts: async () =>
      `1 0 8:0 / / rw - ext4 /dev/sda rw\n2 1 0:1 / ${drive} rw - 9p C: rw`,
  }
  await expect(
    assertWslStorage([target], "Credentials", inspection)
  ).rejects.toThrow("Linux-local storage")
  await expect(
    assertWslStorage([root], "Research", { ...inspection, version: "1" })
  ).rejects.toThrow("requires WSL2")
  await assertWslStorage([target], "Native Linux", {
    ...inspection,
    version: "none",
  })
  await symlink(join(root, "absent"), join(root, "dangling"))
  await expect(
    resolveStoragePath(join(root, "dangling", "new"))
  ).rejects.toThrow()
  await expect(
    assertWslStorage([join(root, "dangling", "new")], "Credentials", inspection)
  ).rejects.toThrow("Repair dangling or inaccessible symlinks")
})

test("WSL device login preserves explicit flow overrides and native TTY behavior", () => {
  const args = { positional: ["login"], options: {} }
  const environment = { wsl: "2" as const, ssh: false, tty: true }
  expect(shouldUseDeviceFlow(args, environment)).toBe(true)
  expect(
    shouldUseDeviceFlow({ ...args, options: { browser: "true" } }, environment)
  ).toBe(false)
  expect(
    shouldUseDeviceFlow(
      { ...args, options: { device: "true" } },
      { ...environment, wsl: "none" }
    )
  ).toBe(true)
  expect(shouldUseDeviceFlow(args, { ...environment, wsl: "none" })).toBe(false)
  expect(() =>
    shouldUseDeviceFlow(
      { ...args, options: { browser: "true", device: "true" } },
      environment
    )
  ).toThrow("either")
})

test("ambiguous stacked mounts cannot hide Windows-backed storage", () => {
  const mounts = [
    { path: "/repo", type: "ext4", source: "/dev/sda" },
    { path: "/repo", type: "9p", source: "C:" },
  ]
  expect(isLinuxLocalMount(storageMount("/repo/project", mounts))).toBe(false)
})

test("Linux provider formats take precedence over cross-platform names and strings", () => {
  expect(
    isWindowsExecutable("/home/test/opencode.exe", "\u007fELF\u0002\u0001")
  ).toBe(false)
  expect(
    isWindowsExecutable(
      "/home/test/codex.js",
      '#!/usr/bin/env node\nconst name = process.platform === "win32" ? "codex.exe" : "codex";'
    )
  ).toBe(false)
  expect(
    isWindowsExecutable("/home/test/provider", "MZ native Windows binary")
  ).toBe(true)
  expect(isWindowsExecutable("/home/test/provider.cmd", "@echo off")).toBe(true)
  expect(
    isWindowsExecutable(
      "/home/test/provider",
      '#!/bin/sh\nexec "$basedir/node.exe" "$basedir/provider.js" "$@"'
    )
  ).toBe(true)
  expect(
    isWindowsExecutable(
      "/home/test/provider",
      "#!/usr/bin/env bash\nexec /mnt/c/Windows/System32/cmd.exe /c provider"
    )
  ).toBe(true)
  expect(
    isWindowsExecutable(
      "/home/test/provider",
      '#!/bin/sh\nexec node "$basedir/provider.js" "$@"'
    )
  ).toBe(false)
})
