#!/bin/sh
# Install the onyx command: the release binary for this machine, checked against the release's
# SHA256SUMS. No Bun or Node needed.
#
#   curl -fsSL https://raw.githubusercontent.com/onyx-robotics/onyx-agent/main/scripts/install.sh | sh
#
# ONYX_VERSION picks a release (v0.2.0; the latest by default), ONYX_INSTALL_DIR where onyx goes
# (~/.local/bin by default). ONYX_RELEASE_URL is a folder with the binaries and SHA256SUMS to use
# instead of a GitHub release (a mirror, or file:// to try a local build).
set -eu

repo="https://github.com/onyx-robotics/onyx-agent/releases"
version="${ONYX_VERSION:-latest}"
dir="${ONYX_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "onyx install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no onyx binary for $(uname -s): Linux and macOS only (on Windows, use WSL)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no onyx binary for $(uname -m): x64 and arm64 only" ;;
esac
# a shell under Rosetta says x86_64 on an Apple silicon Mac: take the native binary
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi
bin="onyx-$os-$arch"

if [ -n "${ONYX_RELEASE_URL:-}" ]; then url="$ONYX_RELEASE_URL"
elif [ "$version" = latest ]; then url="$repo/latest/download"
else url="$repo/download/$version"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $bin ($version)"
curl -fsSL -o "$tmp/$bin" "$url/$bin" || fail "couldn't download $url/$bin"
curl -fsSL -o "$tmp/SHA256SUMS" "$url/SHA256SUMS" || fail "couldn't download $url/SHA256SUMS"

want="$(awk -v f="$bin" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$bin" | awk '{ print $1 }')"
else
  got="$(shasum -a 256 "$tmp/$bin" | awk '{ print $1 }')"
fi
[ -n "$want" ] && [ "$want" = "$got" ] || fail "$bin doesn't match the release's SHA256SUMS"

mkdir -p "$dir"
chmod +x "$tmp/$bin"
mv "$tmp/$bin" "$dir/onyx"
"$dir/onyx" help >/dev/null || fail "$dir/onyx doesn't run on this machine"
echo "Installed onyx in $dir"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir isn't on your PATH: add it (export PATH=\"$dir:\$PATH\" in your shell's profile)" ;;
esac
echo "Next: onyx login"
