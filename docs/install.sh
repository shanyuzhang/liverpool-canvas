#!/usr/bin/env bash
# Liverpool Canvas Assistant: one-step installer for macOS and Linux.
#
#   curl -fsSL https://shanyuzhang.com/liverpool-canvas/install.sh | bash
#
# What it does, in order:
#   1. Uses Node.js 22+ if this computer already has it. Otherwise downloads the official
#      Node.js LTS from nodejs.org into ~/.liverpool-canvas/node (no admin password, nothing
#      installed system-wide) and checks its SHA-256 against nodejs.org's checksum list.
#   2. Checks that Chrome or Edge is installed (needed for the university sign-in window).
#   3. Starts Liverpool Canvas Assistant ({{PKG}}) from npm: setup the first time, a short
#      menu afterwards. Run the same command again any time.
# Source: https://github.com/shanyuzhang/liverpool-canvas
set -euo pipefail

PKG="{{PKG}}"
DATA="${LIVERPOOL_CANVAS_HOME:-$HOME/.liverpool-canvas}"
NODE_LINE="latest-v24.x"

say() { printf '%s\n' "$*" >&2; }
fail() { say ""; say "✗ $*"; exit 1; }

say "Liverpool Canvas Assistant"
say ""

# --- 1. Node.js ---------------------------------------------------------------------------
have_node() {
  [ -z "${LC_FORCE_NODE_DOWNLOAD:-}" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 22 ] 2>/dev/null
}

if have_node; then
  say "✓ Node.js $(node -v)"
else
  case "$(uname -s)" in
    Darwin) plat=darwin ;;
    Linux) plat=linux ;;
    *) fail "This installer is for macOS and Linux. On Windows, use: irm https://shanyuzhang.com/liverpool-canvas/install.ps1 | iex" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) fail "Unsupported processor: $(uname -m). Install Node.js 22+ from https://nodejs.org and run this again." ;;
  esac
  sums=$(curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt") || fail "Could not reach nodejs.org. Check your internet connection and try again."
  line=$(printf '%s\n' "$sums" | grep -E "  node-v[0-9.]+-$plat-$arch\.tar\.gz$" | head -n 1)
  [ -n "$line" ] || fail "No Node.js download found for $plat-$arch."
  sha=${line%% *}
  file=${line##* }
  name=${file%.tar.gz}
  dest="$DATA/node/$name"
  if [ ! -x "$dest/bin/node" ]; then
    say "· 正在下载 Node.js（只放在 ~/.liverpool-canvas 里，不需要管理员密码）"
    say "  Downloading Node.js (kept inside ~/.liverpool-canvas, no admin password needed)"
    tmp=$(mktemp -d)
    curl -fSL --progress-bar "https://nodejs.org/dist/$NODE_LINE/$file" -o "$tmp/$file" || { rm -rf "$tmp"; fail "Node.js download failed. Try again."; }
    if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp/$file"); else got=$(sha256sum "$tmp/$file"); fi
    got=${got%% *}
    if [ "$got" != "$sha" ]; then rm -rf "$tmp"; fail "The Node.js download did not match its checksum, so it was not used. Try again."; fi
    tar -xzf "$tmp/$file" -C "$tmp"
    mkdir -p "$DATA/node"
    rm -rf "$dest"
    mv "$tmp/$name" "$dest"
    rm -rf "$tmp"
  fi
  export PATH="$dest/bin:$PATH"
  say "✓ Node.js $(node -v) ($dest)"
fi

# --- 2. Chrome or Edge --------------------------------------------------------------------
browser=""
if [ "$(uname -s)" = "Darwin" ]; then
  for app in "Google Chrome" "Microsoft Edge" "Chromium"; do
    if [ -d "/Applications/$app.app" ] || [ -d "$HOME/Applications/$app.app" ]; then browser=$app; break; fi
  done
else
  for b in google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable chromium chromium-browser; do
    if command -v "$b" >/dev/null 2>&1; then browser=$b; break; fi
  done
fi
if [ -n "$browser" ]; then
  say "✓ $browser"
elif [ "$#" -eq 0 ]; then
  fail "需要 Google Chrome 或 Microsoft Edge 来登录学校账号。请先安装 Chrome（https://www.google.com/chrome/），再运行同一条命令。
  Chrome or Edge is needed for the university sign-in. Install Chrome (https://www.google.com/chrome/), then run the same command again."
fi
say ""

# --- 3. Start ----------------------------------------------------------------------------
# When this script arrives through a pipe (curl … | bash), its own input is the script, so the
# questions in setup are read from the terminal instead.
if [ ! -t 0 ] && (exec </dev/tty) 2>/dev/null; then
  exec npx -y "$PKG@latest" ${@+"$@"} </dev/tty
fi
exec npx -y "$PKG@latest" ${@+"$@"}
