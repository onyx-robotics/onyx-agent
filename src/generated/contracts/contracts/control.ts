// Generated from packages/core/src/contracts/control.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Control-plane contracts: spaces, members, workspaces, packs.
 */
import { z } from "zod"

import { workspaceSketch } from "../view/sketch"
import { workspaceDocInput, workspaceViewInput } from "../view/workspace"

const workspaceName = z.string().trim().min(1).max(200)
const visibility = z.enum(["private", "link"])

/** A new workspace: empty unless a document is given; with its maker's sketch of it, if any. */
export const workspaceCreateInput = z.object({
  name: workspaceName,
  doc: workspaceDocInput.optional(),
  visibility: visibility.optional(),
  sketch: workspaceSketch.optional(),
})
export type WorkspaceCreateInput = z.input<typeof workspaceCreateInput>

/**
 * A change to a workspace, by whoever may change it: the version it was made on (a newer one is a
 * 409), and what changes. `link`: anyone in the org with its address can open it. `keepRevision`:
 * keep the document it replaces in its history even within an editing spell (a change kept over
 * someone else's).
 */
export const workspaceUpdateInput = z.object({
  expectedVersion: z.number().int().min(1),
  name: workspaceName.optional(),
  doc: workspaceDocInput.optional(),
  visibility: visibility.optional(),
  keepRevision: z.boolean().optional(),
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

/**
 * The viewer's copy of a workspace they can open (one per person and workspace): with what it shows
 * now, if given (the change that made it), and their sketch of it.
 */
export const workspaceForkInput = z.object({
  doc: workspaceDocInput.optional(),
  sketch: workspaceSketch.optional(),
})
export type WorkspaceForkInput = z.input<typeof workspaceForkInput>

/** A workspace put back as it was (its revision) or as it started (its original, the template). */
export const workspaceResetInput = z.object({ expectedVersion: z.number().int().min(1) })
export type WorkspaceResetInput = z.input<typeof workspaceResetInput>

/** Someone's sketch of a workspace, drawn over its revision `version`. */
export const workspaceSketchInput = z.object({
  sketch: workspaceSketch,
  version: z.number().int().min(1),
})
export type WorkspaceSketchInput = z.input<typeof workspaceSketchInput>

/** The org's template made what a workspace shows (admins): its document, or the one given. */
export const workspaceTemplateInput = z.object({ doc: workspaceDocInput.optional() })
export type WorkspaceTemplateInput = z.input<typeof workspaceTemplateInput>

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
