#!/bin/sh
set -eu

REPO="${ONYX_INSTALL_REPO:-onyx-robotics/onyx-agent}"
VERSION="${ONYX_VERSION:-latest}"
DEFAULT_INSTALL_DIR="$HOME/.local/bin"
INSTALL_DIR="${ONYX_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR%/}"
BASE_URL="${ONYX_INSTALL_BASE_URL:-https://github.com/$REPO/releases}"
INSTALL_MARKER=".onyx-install"

die() {
  echo "Error: $*" >&2
  exit 1
}

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

path_contains() {
  case ":$1:" in
    *":$2:"*) return 0 ;;
    *) return 1 ;;
  esac
}

has_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

install_path_for_user() {
  if path_contains "${PATH:-}" "$INSTALL_DIR"; then
    echo "onyx"
  else
    echo "$install_path"
  fi
}

path_export_line() {
  if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
    echo 'export PATH="$HOME/.local/bin:$PATH"'
  else
    echo "export PATH=\"$INSTALL_DIR:\$PATH\""
  fi
}

print_path_instruction() {
  echo ""
  echo "Add Onyx to your PATH:"
  echo "  $(path_export_line)"
}

shell_rc_file() {
  shell_name="${SHELL##*/}"
  case "$shell_name" in
    zsh) echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    *)
      if [ -f "$HOME/.zshrc" ]; then
        echo "$HOME/.zshrc"
      elif [ -f "$HOME/.bashrc" ]; then
        echo "$HOME/.bashrc"
      else
        echo "$HOME/.profile"
      fi
      ;;
  esac
}

append_path_to_shell_rc() {
  rc_file="$(shell_rc_file)"
  path_line="$(path_export_line)"

  if [ -f "$rc_file" ] && grep -F "$path_line" "$rc_file" >/dev/null 2>&1; then
    :
  else
    {
      echo ""
      echo "# Onyx CLI"
      echo "$path_line"
    } >> "$rc_file" || die "Unable to update $rc_file"
  fi

  if [ -n "${PATH:-}" ]; then
    export PATH="$INSTALL_DIR:$PATH"
  else
    export PATH="$INSTALL_DIR"
  fi
  echo "Added $INSTALL_DIR to PATH in $rc_file"
  echo "Open a new terminal or run:"
  echo "  $(path_export_line)"
}

prompt_yes_no() {
  question="$1"
  default_answer="$2"

  if [ -n "${ONYX_INSTALL_PATH_ANSWER:-}" ]; then
    answer="$ONYX_INSTALL_PATH_ANSWER"
  else
    has_tty || return 2
    while :; do
      if [ "$default_answer" = "yes" ]; then
        printf "%s [Y/n] " "$question" > /dev/tty
      else
        printf "%s [y/N] " "$question" > /dev/tty
      fi
      IFS= read -r answer < /dev/tty || return 2
      [ -n "$answer" ] || answer="$default_answer"
      case "$answer" in
        y|Y|yes|YES|Yes) return 0 ;;
        n|N|no|NO|No) return 1 ;;
        *) echo "Please answer yes or no." > /dev/tty ;;
      esac
    done
  fi

  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    n|N|no|NO|No) return 1 ;;
    *) return 2 ;;
  esac
}

setup_path() {
  echo ""
  echo "Step 1/2: Make onyx available"

  if path_contains "${PATH:-}" "$INSTALL_DIR"; then
    echo "onyx is available on PATH from $INSTALL_DIR"
    return 0
  fi

  echo "$INSTALL_DIR is not currently on PATH."

  if [ "${ONYX_INSTALL_NO_PROMPT:-}" = "1" ]; then
    print_path_instruction
    return 0
  fi

  if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
    if prompt_yes_no "Add $HOME/.local/bin to your shell PATH?" yes; then
      append_path_to_shell_rc
    else
      print_path_instruction
    fi
    return 0
  fi

  print_path_instruction
}

print_auth_followup() {
  user_cmd="$(install_path_for_user)"
  echo ""
  echo "Authenticate later with browser login:"
  echo "  $user_cmd login"
  echo ""
  echo "Or use a global API key:"
  echo '  export ONYX_API_KEY="onyx_..."'
}

auth_choice() {
  if [ "${ONYX_INSTALL_NO_PROMPT:-}" = "1" ]; then
    echo "skip"
    return 0
  fi

  if [ -n "${ONYX_INSTALL_AUTH:-}" ]; then
    echo "$ONYX_INSTALL_AUTH"
    return 0
  fi

  if ! has_tty; then
    echo "skip"
    return 0
  fi

  while :; do
    {
      echo ""
      echo "Step 2/2: Authenticate"
      echo "  1) Browser login (recommended)"
      echo "  2) Environment API key"
      echo "  3) Skip for now"
      printf "Choose an authentication method [1]: "
    } > /dev/tty
    IFS= read -r choice < /dev/tty || {
      echo "skip"
      return 0
    }
    [ -n "$choice" ] || choice="1"
    case "$choice" in
      1|login|browser) echo "login"; return 0 ;;
      2|env|key|api-key) echo "env"; return 0 ;;
      3|skip|none) echo "skip"; return 0 ;;
      *) echo "Please choose 1, 2, or 3." > /dev/tty ;;
    esac
  done
}

setup_auth() {
  choice="$(auth_choice)"
  case "$choice" in
    login)
      echo ""
      echo "Starting browser login..."
      if "$install_path" login; then
        echo "Onyx login complete."
      else
        echo "Login did not complete. You can retry with:"
        echo "  $(install_path_for_user) login"
      fi
      ;;
    env)
      echo ""
      echo "Use a global Onyx API key by adding this to your shell:"
      echo '  export ONYX_API_KEY="onyx_..."'
      ;;
    skip)
      print_auth_followup
      ;;
    *)
      echo ""
      echo "Unknown auth choice: $choice"
      print_auth_followup
      ;;
  esac
}

prepare_install_dir() {
  mkdir -p "$INSTALL_DIR" || die "Unable to create install directory: $INSTALL_DIR"
  [ -w "$INSTALL_DIR" ] || die "Install directory is not writable: $INSTALL_DIR. Choose a user-writable directory with ONYX_INSTALL_DIR, or rerun with permissions."

  marker_path="$INSTALL_DIR/$INSTALL_MARKER"
  if [ -e "$install_path" ] || [ -L "$install_path" ]; then
    if [ -f "$marker_path" ] && grep -F "path=$install_path" "$marker_path" >/dev/null 2>&1; then
      :
    elif [ -L "$install_path" ] && [ "$(readlink "$install_path" 2>/dev/null || true)" = "$HOME/.onyx/bin/onyx" ]; then
      :
    else
      die "Refusing to overwrite existing file: $install_path. Remove it, move it, or choose another directory with ONYX_INSTALL_DIR."
    fi

    if [ -L "$install_path" ]; then
      rm -f "$install_path"
    fi
  fi
}

write_install_marker() {
  {
    echo "managed-by=onyx-installer"
    echo "path=$install_path"
  } > "$INSTALL_DIR/$INSTALL_MARKER" 2>/dev/null || true
}

target="$(detect_target)"
asset="onyx-$target"
install_path="$INSTALL_DIR/onyx"

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

prepare_install_dir

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

cp "$tmp/$asset" "$install_path"
chmod 0755 "$install_path"
write_install_marker

if [ "${ONYX_SKIP_SKILL:-}" != "1" ]; then
  "$install_path" developer sync-skill --quiet ||
    "$install_path" agent install-skill --quiet ||
    true
fi

echo "Installed onyx to $install_path"
setup_path
setup_auth
