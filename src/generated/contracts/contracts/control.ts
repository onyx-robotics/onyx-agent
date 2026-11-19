// Generated from packages/core/src/contracts/control.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Control-plane contracts: spaces, members, packs.
 */
import { z } from "zod"

import { packPropertySchema, packTypeSchema } from "../registry/pack-format"

export const setMemberRoleInput = z.object({
  role: z.enum(["admin", "member", "viewer"]),
})

export const planPackInput = z.object({
  /** built-in pack keys, or pack YAML documents */
  packs: z.array(z.string().min(1)).min(1).max(20),
})
export type PlanPackInput = z.input<typeof planPackInput>

export const loadPackInput = planPackInput.extend({
  /** the registry version a plan read: refused (409) if the registry has moved since */
  expectedRegistryVersion: z.number().int().min(0).optional(),
})
export type LoadPackInput = z.input<typeof loadPackInput>

/**
 * Definitions to add to the org's own packs, each `<pack>.<key>`: any that exists already is left
 * as it is (a research run's types and metrics, from its config).
 */
export const extendRegistryInput = z.object({
  types: z.array(packTypeSchema).max(50).default([]),
  properties: z.array(packPropertySchema).max(200).default([]),
})
export type ExtendRegistryInput = z.input<typeof extendRegistryInput>

export const createOrgInput = z.object({
  name: z.string().min(1).max(200),
  packs: z.array(z.string().min(1)).default(["hardware"]),
})
export type CreateOrgInput = z.input<typeof createOrgInput>
