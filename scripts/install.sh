#!/bin/sh
set -eu

REPO="${ONYX_INSTALL_REPO:-onyx-robotics/onyx-agent}"
VERSION="${ONYX_VERSION:-latest}"
INSTALL_DIR="${ONYX_INSTALL_DIR:-$HOME/.onyx/bin}"
BASE_URL="${ONYX_INSTALL_BASE_URL:-https://github.com/$REPO/releases}"

detect_target() {
  os="${ONYX_INSTALL_OS:-$(uname -s)}"
  arch="${ONYX_INSTALL_ARCH:-$(uname -m)}"

  case "$os" in
    Darwin|darwin) os="darwin" ;;
    Linux|linux) os="linux" ;;
    *) echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  if [ "$os" = "linux" ] && [ "$arch" = "x64" ]; then
    echo "linux-x64-baseline"
    return
  fi

  echo "$os-$arch"
}

target="$(detect_target)"
asset="onyx-$target"

if [ "$VERSION" = "latest" ]; then
  download_base="$BASE_URL/latest/download"
else
  download_base="$BASE_URL/download/$VERSION"
fi

asset_url="$download_base/$asset"
checksums_url="$download_base/checksums.txt"

if [ "${ONYX_INSTALL_DRY_RUN:-}" = "1" ]; then
  echo "target=$target"
  echo "asset=$asset"
  echo "asset_url=$asset_url"
  echo "checksums_url=$checksums_url"
  echo "install_dir=$INSTALL_DIR"
  exit 0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need curl
need grep
need awk

if command -v sha256sum >/dev/null 2>&1; then
  sha_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha_cmd="shasum -a 256"
else
  echo "Missing required command: sha256sum or shasum" >&2
  exit 1
fi

tmp="${TMPDIR:-/tmp}/onyx-install.$$"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$tmp"

echo "Downloading Onyx agent $VERSION for $target..."
curl -fsSL "$asset_url" -o "$tmp/$asset"
curl -fsSL "$checksums_url" -o "$tmp/checksums.txt"

expected="$(grep "  $asset\$" "$tmp/checksums.txt" | awk '{print $1}')"
if [ -z "$expected" ]; then
  echo "No checksum found for $asset" >&2
  exit 1
fi

actual="$($sha_cmd "$tmp/$asset" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then
  echo "Checksum mismatch for $asset" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install_path="$INSTALL_DIR/onyx"
cp "$tmp/$asset" "$install_path"
chmod 0755 "$install_path"

if [ "${ONYX_SKIP_SKILL:-}" != "1" ]; then
  "$install_path" agent install-skill --quiet || true
fi

echo "Installed onyx to $install_path"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Add Onyx to your PATH:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
