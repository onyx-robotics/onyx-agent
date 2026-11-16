---
"@onyx-robotics/agent": minor
---

`onyx research image <file> ... [--on <item>] [--caption "..."] [--step <n>]`: a worker puts checkpoint screenshots and GIFs (PNG, JPEG, GIF or WebP, at most 4 MB each) on an item's page in the app, its hypothesis by default. Workers are told about it in their prompt. The SDK's `uploadFile(entity, bytes, { name, caption, step })` does the same from code.
