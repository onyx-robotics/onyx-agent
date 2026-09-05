#!/usr/bin/env bash
set -euo pipefail

REPO="${ONYX_INSTALL_REPO:-onyx-robotics/onyx-agent}"
VERSION="${ONYX_VERSION:-latest}"
DEFAULT_INSTALL_DIR="$HOME/.local/bin"
INSTALL_DIR="${ONYX_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR%/}"
BASE_URL="${ONYX_INSTALL_BASE_URL:-https://github.com/$REPO/releases}"
INSTALL_MARKER=".onyx-install"

style_reset=""
style_bold=""
style_dim=""
style_rail=""
style_dot=""
style_ok=""
style_warn=""
style_error=""
style_code=""
rail_marker="|"
prompt_marker=">"
ok_marker="OK"

if [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
  rail_marker="│"
  prompt_marker="◆"
  ok_marker="✓"
fi

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  esc="$(printf '\033')"
  style_reset="${esc}[0m"
  style_bold="${esc}[1m"
  style_dim="${esc}[2m"
  style_rail="${esc}[38;5;39m"
  style_dot="${esc}[38;5;39m"
  style_ok="${esc}[32m"
  style_warn="${esc}[33m"
  style_error="${esc}[31m"
  style_code="${esc}[36m"
fi

print_intro() {
  printf "\n%bOnyx CLI Installer%b\n" "$style_bold" "$style_reset"
  printf "%bA guided setup for the local Onyx agent.%b\n" "$style_dim" "$style_reset"
  printf "%bRelease:%b %s\n" "$style_dim" "$style_reset" "$VERSION"
  printf "%bDestination:%b %s\n" "$style_dim" "$style_reset" "$INSTALL_DIR"
}

status_line() {
  printf "  %s\n" "$*"
}

status_code() {
  printf "    %b%s%b\n" "$style_code" "$*" "$style_reset"
}

status_success() {
  printf "  %b%s%b %s\n" "$style_ok" "$ok_marker" "$style_reset" "$*"
}

status_warn() {
  printf "  %bNote:%b %s\n" "$style_warn" "$style_reset" "$*"
}

prompt_start() {
  prompt_title="$1"
  prompt_detail="${2:-}"

  printf "\n%b%s%b  %b%s%b\n" \
    "$style_dot" "$prompt_marker" "$style_reset" \
    "$style_bold" "$prompt_title" "$style_reset"

  if [ -n "$prompt_detail" ]; then
    prompt_line "$prompt_detail"
  fi
}

prompt_line() {
  printf "%b%s%b     %s\n" "$style_rail" "$rail_marker" "$style_reset" "$*"
}

prompt_code() {
  printf "%b%s%b       %b%s%b\n" "$style_rail" "$rail_marker" "$style_reset" "$style_code" "$*" "$style_reset"
}

prompt_success() {
  printf "%b%s%b     %b%s%b %s\n" "$style_rail" "$rail_marker" "$style_reset" "$style_ok" "$ok_marker" "$style_reset" "$*"
}

prompt_warn() {
  printf "%b%s%b     %bNote:%b %s\n" "$style_rail" "$rail_marker" "$style_reset" "$style_warn" "$style_reset" "$*"
}

die() {
  printf "%bError:%b %s\n" "$style_error" "$style_reset" "$*" >&2
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
  if [ "${ONYX_INSTALL_NO_TTY:-}" = "1" ]; then
    return 1
  fi

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
  status_line "Add Onyx to your PATH:"
  status_code "$(path_export_line)"
}

print_prompt_path_instruction() {
  prompt_line "Add Onyx to your PATH:"
  prompt_code "$(path_export_line)"
}

print_path_prompt() {
  prompt_start "Make onyx available" "$INSTALL_DIR is not currently on PATH."
  prompt_line "Add $HOME/.local/bin to your shell PATH?"
}

shell_rc_file() {
  shell_name="${SHELL:-}"
  shell_name="${shell_name##*/}"
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
  prompt_success "Added $INSTALL_DIR to PATH in $rc_file"
  prompt_line "Open a new terminal or run:"
  prompt_code "$(path_export_line)"
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
        printf "%b%s%b     %s [Y/n] " "$style_rail" "$rail_marker" "$style_reset" "$question" > /dev/tty
      else
        printf "%b%s%b     %s [y/N] " "$style_rail" "$rail_marker" "$style_reset" "$question" > /dev/tty
      fi
      IFS= read -r answer < /dev/tty || return 2
      [ -n "$answer" ] || answer="$default_answer"
      case "$answer" in
        y|Y|yes|YES|Yes) return 0 ;;
        n|N|no|NO|No) return 1 ;;
        *) prompt_line "Please answer yes or no." > /dev/tty ;;
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
  if path_contains "${PATH:-}" "$INSTALL_DIR"; then
    status_success "onyx is available on PATH from $INSTALL_DIR"
    return 0
  fi

  if [ "${ONYX_INSTALL_NO_PROMPT:-}" = "1" ]; then
    status_warn "$INSTALL_DIR is not currently on PATH."
    print_path_instruction
    return 0
  fi

  if [ "$INSTALL_DIR" = "$HOME/.local/bin" ] &&
    { [ -n "${ONYX_INSTALL_PATH_ANSWER:-}" ] || has_tty; }; then
    if [ -n "${ONYX_INSTALL_PATH_ANSWER:-}" ]; then
      print_path_prompt
    else
      print_path_prompt > /dev/tty
    fi

    if prompt_yes_no "Add $HOME/.local/bin to your shell PATH?" yes; then
      append_path_to_shell_rc
    else
      print_prompt_path_instruction
    fi
    return 0
  fi

  status_warn "$INSTALL_DIR is not currently on PATH."
  print_path_instruction
}

print_auth_followup() {
  user_cmd="$(install_path_for_user)"
  status_line "Authenticate later with browser login:"
  status_code "$user_cmd login"
  status_line "Or use a global API key:"
  status_code 'export ONYX_API_KEY="onyx_..."'
}

print_prompt_auth_followup() {
  user_cmd="$(install_path_for_user)"
  prompt_line "Login later with browser login:"
  prompt_code "$user_cmd login"
  prompt_line "Or use a global API key:"
  prompt_code 'export ONYX_API_KEY="onyx_..."'
}

run_login_without_cancel() {
  status_line "Waiting for login..."
  if "$install_path" login; then
    status_success "Onyx login complete."
  else
    status_warn "Onyx login did not complete."
    print_auth_followup
  fi
}

run_login_with_cancel() {
  prompt_start "Authenticate" "Opening browser login... Press Ctrl+C to cancel."

  # `curl ... | bash` leaves the installer's stdin attached to the script
  # pipe. Running login in the background with redirected output therefore
  # makes the CLI detect a headless shell and silently choose device auth.
  # Keep the interactive login in the foreground, attach its input to the
  # controlling terminal, and explicitly select browser auth.
  if "$install_path" login --browser < /dev/tty > /dev/tty 2>&1; then
    prompt_success "Onyx login complete."
  else
    prompt_warn "Browser login did not complete."
    print_prompt_auth_followup
  fi
}

setup_auth() {
  if [ "${ONYX_INSTALL_NO_PROMPT:-}" = "1" ]; then
    print_auth_followup
    return 0
  fi

  case "${ONYX_INSTALL_AUTH:-login}" in
    env)
      status_line "Use a global Onyx API key by adding this to your shell:"
      status_code 'export ONYX_API_KEY="onyx_..."'
      ;;
    skip)
      print_auth_followup
      ;;
    login|browser|"")
      if has_tty; then
        run_login_with_cancel
      else
        run_login_without_cancel
      fi
      ;;
    *)
      status_warn "Unknown ONYX_INSTALL_AUTH value: ${ONYX_INSTALL_AUTH:-}"
      print_auth_followup
      ;;
  esac
}

prepare_install_dir() {
  mkdir -p "$INSTALL_DIR" || die "Unable to create install directory: $INSTALL_DIR"
  [ -w "$INSTALL_DIR" ] || die "Install directory is not writable: $INSTALL_DIR. Choose a user-writable directory with ONYX_INSTALL_DIR, or rerun with permissions."

  marker_path="$INSTALL_DIR/$INSTALL_MARKER"
  prepare_install_path "$install_path" "$HOME/.onyx/bin/onyx"
  prepare_install_path "$worker_install_path" ""
}

prepare_install_path() {
  target_path="$1"
  legacy_link_target="$2"
  marker_path="$INSTALL_DIR/$INSTALL_MARKER"

  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    if [ -f "$marker_path" ] && {
      grep -F "path=$target_path" "$marker_path" >/dev/null 2>&1 ||
      grep -F "worker_path=$target_path" "$marker_path" >/dev/null 2>&1
    }; then
      :
    elif [ -n "$legacy_link_target" ] && [ -L "$target_path" ] && [ "$(readlink "$target_path" 2>/dev/null || true)" = "$legacy_link_target" ]; then
      :
    else
      die "Refusing to overwrite existing file: $target_path. Remove it, move it, or choose another directory with ONYX_INSTALL_DIR."
    fi

    if [ -L "$target_path" ]; then
      rm -f "$target_path"
    fi
  fi
}

write_install_marker() {
  {
    echo "managed-by=onyx-installer"
    echo "path=$install_path"
    echo "worker_path=$worker_install_path"
  } > "$INSTALL_DIR/$INSTALL_MARKER" 2>/dev/null || true
}

target="$(detect_target)"
asset="onyx-$target"
worker_asset="onyx-worker-$target"
install_path="$INSTALL_DIR/onyx"
worker_install_path="$INSTALL_DIR/onyx-worker"

if [ "$VERSION" = "latest" ]; then
  download_base="$BASE_URL/latest/download"
else
  download_base="$BASE_URL/download/$VERSION"
fi

asset_url="$download_base/$asset"
worker_asset_url="$download_base/$worker_asset"
checksums_url="$download_base/checksums.txt"

if [ "${ONYX_INSTALL_DRY_RUN:-}" = "1" ]; then
  echo "target=$target"
  echo "asset=$asset"
  echo "worker_asset=$worker_asset"
  echo "asset_url=$asset_url"
  echo "worker_asset_url=$worker_asset_url"
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

print_intro

status_line "Target: $target"
status_success "Required tools found."
prepare_install_dir
status_success "Install directory ready: $INSTALL_DIR"

tmp="${TMPDIR:-/tmp}/onyx-install.$$"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$tmp"

status_line "Downloading Onyx agent $VERSION for $target..."
curl -fsSL "$asset_url" -o "$tmp/$asset"
curl -fsSL "$worker_asset_url" -o "$tmp/$worker_asset"
curl -fsSL "$checksums_url" -o "$tmp/checksums.txt"
status_success "Downloaded release assets."

verify_asset_checksum() {
  verify_asset="$1"
  expected="$(grep "  $verify_asset\$" "$tmp/checksums.txt" | awk '{print $1}')"
  if [ -z "$expected" ]; then
    echo "No checksum found for $verify_asset" >&2
    exit 1
  fi

  actual="$($sha_cmd "$tmp/$verify_asset" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for $verify_asset" >&2
    exit 1
  fi
}

status_line "Verifying checksums..."
verify_asset_checksum "$asset"
verify_asset_checksum "$worker_asset"
status_success "Checksum verified."

status_line "Installing onyx and onyx-worker..."
cp "$tmp/$asset" "$install_path"
cp "$tmp/$worker_asset" "$worker_install_path"
chmod 0755 "$install_path"
chmod 0755 "$worker_install_path"
write_install_marker
status_success "Installed onyx to $install_path"
status_success "Installed onyx-worker to $worker_install_path"

if [ "${ONYX_SKIP_SKILL:-}" != "1" ]; then
  if "$install_path" developer sync-skill --quiet; then
    status_success "Synced bundled Onyx skill."
  elif "$install_path" agent install-skill --quiet; then
    status_success "Installed bundled Onyx skill."
  else
    status_warn "Skipped bundled skill setup; the CLI is installed."
  fi
else
  status_warn "Skipped bundled skill setup."
fi

setup_path
setup_auth

printf "\n%bOnyx is ready.%b\n" "$style_bold" "$style_reset"
