---
"@onyx-robotics/agent": patch
---

The docs and the skills install `onyx` from the public releases (`curl -fsSL https://raw.githubusercontent.com/onyx-robotics/onyx-agent/main/scripts/install.sh | sh`, no Bun or Node needed) and `onyx-site` from PyPI, rather than from a checkout of Onyx's private repository. The README leads with the binary; npm is for the SDK, or with Bun.
