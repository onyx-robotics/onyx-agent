import { readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import tseslint from "typescript-eslint"

const ROOT = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const dependencies = new Set(Object.keys(pkg.dependencies ?? {}))
const devDependencies = new Set(Object.keys(pkg.devDependencies ?? {}))

const packageOf = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
const builtin = (spec) =>
  spec.startsWith("node:") ||
  spec === "bun" ||
  spec.startsWith("bun:") ||
  builtinModules.includes(spec)

/**
 * This package is published on its own, so it imports only its own files and the packages it
 * declares: nothing outside this directory, and none of Onyx's private packages. What ships (src,
 * tests aside) uses only its dependencies; tests, scripts and config may use dev dependencies too.
 */
const ownImports = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      outside: "{{spec}} is outside this package: it imports only its own files and dependencies.",
      private:
        "{{name}} is one of Onyx's private packages: the API's contracts are in src/generated/contracts.",
      undeclared: "{{name}} isn't a dependency of this package (package.json).",
      devOnly: "{{name}} is a dev dependency: what ships uses only dependencies.",
    },
  },
  create(context) {
    const file = context.filename
    const path = relative(ROOT, file)
    const ships = path.startsWith(`src${sep}`) && !path.endsWith(".test.ts")
    function check(node, spec) {
      if (typeof spec !== "string") return
      if (spec.startsWith(".")) {
        const to = relative(ROOT, resolve(dirname(file), spec))
        if (to.startsWith("..") || isAbsolute(to))
          context.report({ node, messageId: "outside", data: { spec } })
        return
      }
      if (builtin(spec)) return
      const name = packageOf(spec)
      if (dependencies.has(name)) return
      if (!ships && devDependencies.has(name)) return
      const messageId = name.startsWith("@onyx/")
        ? "private"
        : devDependencies.has(name)
          ? "devOnly"
          : "undeclared"
      context.report({ node, messageId, data: { name } })
    }
    const literal = (n) => (n?.type === "Literal" ? n : null)
    return {
      ImportDeclaration: (n) => check(n.source, n.source.value),
      ExportAllDeclaration: (n) => check(n.source, n.source.value),
      ExportNamedDeclaration: (n) => n.source && check(n.source, n.source.value),
      ImportExpression: (n) => literal(n.source) && check(n.source, n.source.value),
      TSImportType: (n) => {
        const l = literal(n.argument?.literal)
        if (l) check(l, l.value)
      },
    }
  },
}

/** @type {import("eslint").Linter.Config[]} */
export default [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: { local: { rules: { "own-imports": ownImports } } },
    rules: {
      "local/own-imports": "error",
      // `_name` marks a binding that is unused on purpose (e.g. dropping a key with a rest pattern)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    ignores: ["dist/**", "**/coverage/**", "fixtures/**"],
  },
]
