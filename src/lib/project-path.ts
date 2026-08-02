export function normalizeProjectPath(value?: string | null) {
  const path = (value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
  if (path === ".") return ""
  if (
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      "--project-path must be a relative path without '.' or '..'"
    )
  }
  return path
}
