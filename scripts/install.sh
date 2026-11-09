#!/bin/sh
# The onyx command, and its skills for Claude Code, from a release of onyx-agent on GitHub:
#
#   curl -fsSL https://onyxresearch.ai/install.sh | bash
#
#   ONYX_VERSION=0.2.1      that release rather than the latest
#   ONYX_INSTALL_DIR=<dir>  where onyx goes (~/.local/bin)
#   ONYX_SKILLS_DIR=<dir>   where the skills go (~/.claude/skills)
#   ONYX_NO_SKILLS=1        no skills
#
# Set them for bash: `curl -fsSL https://onyxresearch.ai/install.sh | ONYX_VERSION=0.2.1 bash`.
# Linux and macOS, x64 and arm64; on Windows, run it in WSL. Everything comes from one release
# and is checked against its SHA256SUMS before anything is installed. Run it again to update.
#
# It's POSIX sh (dash, and macOS's bash 3.2), and nothing runs before its last line, so a
# download cut short does nothing.

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# a path with ~ for the home directory, to print
tilde() {
  case $1 in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# <url> <file>
fetch() {
  curl -fsSL --retry 2 -o "$2" "$1" || die "couldn't download $1"
}

# <file>: its SHA-256, in hex
sha256() {
  if has sha256sum; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# <file> <asset> <SHA256SUMS>: the file is the release's asset, or nothing is installed
check() {
  want=$(awk -v name="$2" '$2 == name || $2 == "*" name { print $1; exit }' "$3")
  [ -n "$want" ] || die "SHA256SUMS has no checksum for $2: nothing installed"
  got=$(sha256 "$1")
  [ "$got" = "$want" ] || die "$2 doesn't match its checksum in SHA256SUMS: nothing installed"
}

main() {
  set -eu

  releases=${ONYX_RELEASES_URL:-https://github.com/onyx-robotics/onyx-agent/releases}
  releases=${releases%/}
  [ -n "${HOME:-}" ] || die "HOME isn't set"
  bin_dir=${ONYX_INSTALL_DIR:-$HOME/.local/bin}
  skills_dir=${ONYX_SKILLS_DIR:-$HOME/.claude/skills}
  skills=1
  case ${ONYX_NO_SKILLS:-} in
    "" | 0) ;;
    *) skills= ;;
  esac

  # this machine's binary
  os=$(uname -s)
  case $os in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) die "onyx doesn't run on Windows itself: use WSL, and run this there" ;;
    *) die "there's no onyx for $os: it runs on Linux and macOS (and Windows in WSL)" ;;
  esac
  arch=$(uname -m)
  case $arch in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "there's no onyx for $arch processors: it runs on x64 and arm64" ;;
  esac
  # a shell under Rosetta says x86_64 on Apple silicon: take the native binary
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    arch=arm64
  fi
  asset=onyx-$os-$arch

  has curl || die "the installer needs curl"
  has sha256sum || has shasum || die "the installer needs sha256sum or shasum to check what it downloads"
  if [ -n "$skills" ]; then
    has tar || die "the installer needs tar for the skills (ONYX_NO_SKILLS=1 leaves them out)"
  fi

  # which release: the latest is where GitHub redirects .../latest (.../tag/v0.2.1)
  if [ -n "${ONYX_VERSION:-}" ]; then
    tag=v${ONYX_VERSION#v}
  else
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") ||
      die "couldn't reach $releases/latest to find the latest release"
    case $latest in
      */tag/*) tag=${latest##*/} ;;
      *) die "couldn't find the latest release: $releases/latest led to $latest" ;;
    esac
  fi
  case $tag in
    "" | v | v[!0-9]* | [!v]* | *[!A-Za-z0-9.+-]*) die "$tag isn't a release: ONYX_VERSION takes a version, like 0.2.1" ;;
  esac
  from=$releases/download/$tag

  say "Installing onyx $tag ($os-$arch)"
  staged=
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t onyx) || die "couldn't make a temporary directory"
  trap 'rm -rf "$tmp" ${staged:+"$staged"}' EXIT
  trap 'exit 1' HUP INT TERM

  # everything downloaded and checked before anything is installed
  curl -fsSL --retry 2 -o "$tmp/SHA256SUMS" "$from/SHA256SUMS" ||
    die "couldn't download $from/SHA256SUMS: is there a release $tag (0.2.0 or later)?"
  fetch "$from/$asset" "$tmp/$asset"
  check "$tmp/$asset" "$asset" "$tmp/SHA256SUMS"
  if [ -n "$skills" ]; then
    fetch "$from/skills.tar.gz" "$tmp/skills.tar.gz"
    check "$tmp/skills.tar.gz" skills.tar.gz "$tmp/SHA256SUMS"
    mkdir "$tmp/skills"
    tar -xzf "$tmp/skills.tar.gz" -C "$tmp/skills" || die "couldn't unpack skills.tar.gz"
  fi

  # the binary goes in beside the old one, then takes its name: never half a binary
  mkdir -p "$bin_dir" || die "couldn't make $bin_dir"
  bin_dir=$(CDPATH='' cd -- "$bin_dir" && pwd) || die "couldn't open $bin_dir"
  dest=$bin_dir/onyx
  staged=$bin_dir/.onyx-install.$$
  { cp "$tmp/$asset" "$staged" && chmod +x "$staged" && mv -f "$staged" "$dest"; } ||
    die "couldn't install onyx in $bin_dir"
  say "Installed onyx $tag in $(tilde "$dest")"

  # each skill folder in the archive replaces its own, and no other
  if [ -n "$skills" ]; then
    mkdir -p "$skills_dir" || die "couldn't make $skills_dir"
    names=
    for folder in "$tmp/skills"/*; do
      [ -d "$folder" ] || continue
      name=${folder##*/}
      { rm -rf "${skills_dir:?}/$name" && mv "$folder" "$skills_dir/$name"; } ||
        die "couldn't install the skill $name in $skills_dir"
      names=$names${names:+, }$name
    done
    say "Installed the skills for Claude Code ($names) in $(tilde "$skills_dir")"
  fi

  case :${PATH:-}: in
    *:"$bin_dir":*)
      found=$(command -v onyx 2>/dev/null || true)
      if [ -n "$found" ] && [ "$found" != "$dest" ]; then
        warn "$found comes first on your PATH, so onyx runs it rather than $(tilde "$dest"). Remove it (npm uninstall -g @onyx-robotics/agent, if npm installed it) or put $(tilde "$bin_dir") earlier on your PATH."
      fi
      ;;
    *)
      case $bin_dir in
        "$HOME"/*) shown=\$HOME/${bin_dir#"$HOME"/} ;;
        *) shown=$bin_dir ;;
      esac
      # printed for the person to run, so ~ stays as it is
      rc='~/.profile'
      case ${SHELL:-} in
        */zsh) rc='~/.zshrc' ;;
        */bash) if [ "$os" = darwin ]; then rc='~/.bash_profile'; else rc='~/.bashrc'; fi ;;
      esac
      line="echo 'export PATH=\"$shown:\$PATH\"' >> $rc"
      case ${SHELL:-} in */fish) line="fish_add_path \"$shown\"" ;; esac
      say ""
      say "$(tilde "$bin_dir") isn't on your PATH. Add it, then open a new terminal:"
      say "  $line"
      ;;
  esac

  say ""
  say "Next:"
  say "  onyx login"
  say "  then, in a repository, run /onyx in Claude Code (or ask Claude to set up an Onyx research run)"
}

main "$@"
