import { expect, test } from "bun:test"

import { itemArg, propArgs, unsetArgs } from "./args"
import { UsageError } from "./output"

test("an item is its id, or a source key split at its first colon", () => {
  const id = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
  expect(itemArg(id)).toEqual({ id })
  expect(itemArg("git:9f2c1e")).toEqual({ source: { system: "git", key: "9f2c1e" } })
  expect(itemArg("plm:arms/arm-2:left")).toEqual({
    source: { system: "plm", key: "arms/arm-2:left" },
  })
  for (const bad of ["run-42", ":x", "git:", undefined])
    expect(() => itemArg(bad)).toThrow(UsageError)
})

test("props: JSON when it is JSON, text otherwise; unset is null", () => {
  expect(propArgs(["n=3", "ok=true", "s=hil", 'q="3"', "none=null", "eq=a=b"])).toEqual({
    n: 3,
    ok: true,
    s: "hil",
    q: "3",
    none: null,
    eq: "a=b",
  })
  expect(() => propArgs(["novalue"])).toThrow(UsageError)
  expect(unsetArgs(["a", "b"])).toEqual({ a: null, b: null })
})
