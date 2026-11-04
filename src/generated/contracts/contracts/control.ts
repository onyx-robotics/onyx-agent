// Generated from packages/core/src/contracts/control.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Control-plane contracts: spaces, members, workspaces, packs.
 */
import { z } from "zod"

import { workspaceDocInput, workspaceViewInput } from "../view/workspace"

const workspaceName = z.string().trim().min(1).max(200)

/** A new workspace: empty unless a document is given. */
export const workspaceCreateInput = z.object({
  name: workspaceName,
  doc: workspaceDocInput.optional(),
})
export type WorkspaceCreateInput = z.input<typeof workspaceCreateInput>

/**
 * A change to a workspace, by its owner: the version it was made on (a newer one is a 409), and
 * what changes. `link`: anyone in the org with its address can open it, read only.
 */
export const workspaceUpdateInput = z.object({
  expectedVersion: z.number().int().min(1),
  name: workspaceName.optional(),
  doc: workspaceDocInput.optional(),
  visibility: z.enum(["private", "link"]).optional(),
})
export type WorkspaceUpdateInput = z.input<typeof workspaceUpdateInput>

/**
 * A workspace's view to share, frozen: every field of it as shown, and the workspace revision it's
 * shown over (no newer than the workspace's).
 */
export const workspaceShareInput = z.object({
  view: workspaceViewInput,
  baseVersion: z.number().int().min(1),
})
export type WorkspaceShareInput = z.input<typeof workspaceShareInput>

/** A share link's id: 16 base64url characters (96 random bits). */
export const shareId = z.string().regex(/^[A-Za-z0-9_-]{16}$/)

/** A copy of a workspace you can open, as your own (private). */
export const workspaceDuplicateInput = z.object({ name: workspaceName.optional() })
export type WorkspaceDuplicateInput = z.input<typeof workspaceDuplicateInput>

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

export const createOrgInput = z.object({
  name: z.string().min(1).max(200),
  packs: z.array(z.string().min(1)).default(["hardware"]),
})
export type CreateOrgInput = z.input<typeof createOrgInput>
