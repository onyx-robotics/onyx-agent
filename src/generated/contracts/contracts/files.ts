// Generated from packages/core/src/contracts/files.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Files kept by the platform (docs/research.md, "Images"): an image attached to an item, such as
 * a worker's checkpoint screenshot or a GIF of a rollout, stored once per org by its content hash
 * and recorded on the item as an annotation ref of system `onyx-files`. Anyone who can see the
 * item can see its images; the ref names the bytes, never grants them.
 */
import { z } from "zod"

/** The ref system of an uploaded file: its locator is its sha256, hex. */
export const FILES_SYSTEM = "onyx-files"

/** The most one upload may be: under a serverless function's request limit (4.5 MB). */
export const FILE_MAX_BYTES = 4 * 1024 * 1024

/** What may be uploaded: images a browser shows, none that can run script (no SVG). */
export const FILE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export type FileMediaType = (typeof FILE_MEDIA_TYPES)[number]

/** `POST /files`'s query; the body is the file's bytes. */
export const fileUploadQuery = z.object({
  /** the item it's attached to */
  entity: z.string().uuid(),
  /** its file name, as shown */
  name: z.string().min(1).max(200).optional(),
  /** what it shows */
  caption: z.string().max(2000).optional(),
  /** where in the work it was taken: a training step, an iteration, a checkpoint's number */
  step: z.coerce.number().int().nonnegative().optional(),
})
export type FileUploadQuery = z.input<typeof fileUploadQuery>

export interface UploadedFile {
  /** the ref's id: `GET /files/:id` serves it */
  id: string
  entity: string
  contentHash: string
  mediaType: FileMediaType
  sizeBytes: number
  name: string | null
  caption: string | null
  step: number | null
  /** its address on this server, under /api/v1 */
  path: string
}
