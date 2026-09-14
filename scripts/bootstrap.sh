#!/usr/bin/env bash
# Prepare the checked-out/downloaded source on macOS or Debian/Ubuntu Linux.
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.tools"
lock="$root/.tools/.bootstrap-lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo 'This checkout already has a bootstrap lock. Finish the other install before retrying.' >&2
  exit 1
fi
printf '%s\n' "$$" > "$lock/pid"
scratch=''
cleanup() {
  [ -z "$scratch" ] || rm -rf "$scratch"
  rm -f "$lock/pid"
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo 'Supported: macOS, Debian/Ubuntu Linux.' >&2; exit 1 ;;
esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) exit 1 ;; esac
if [ "$platform" = darwin ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install || true
    echo 'Complete the macOS developer-tools window, then run this command again.' >&2
    exit 3
  fi
else
  missing=0
  for tool in curl tar python3 cc make; do command -v "$tool" >/dev/null 2>&1 || missing=1; done
  if [ "$missing" = 1 ]; then
    command -v apt-get >/dev/null || { echo 'Install curl, tar, Python 3 and C/C++ build tools first.' >&2; exit 1; }
    if [ "$(id -u)" = 0 ]; then
      apt-get update
      apt-get install -y ca-certificates curl tar python3 build-essential
    else
      sudo apt-get update
      sudo apt-get install -y ca-certificates curl tar python3 build-essential
    fi
  fi
fi
case "$platform-$arch" in
  darwin-arm64) expected=d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8 ;;
  darwin-x64) expected=6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3 ;;
  linux-arm64) expected=0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081 ;;
  linux-x64) expected=6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8 ;;
esac
node_dir="$root/.tools/node-v24.13.0-$platform-$arch"
mkdir -p "$root/.tools"
if [ ! -x "$node_dir/bin/node" ]; then
  scratch="$(mktemp -d "$root/.tools/bootstrap.XXXXXX")"
  archive="node-v24.13.0-$platform-$arch.tar.gz"
  if ! curl --fail --location --silent --show-error --retry 1 --connect-timeout 15 \
      --speed-limit 65536 --speed-time 20 --max-time 180 \
      "https://nodejs.org/dist/v24.13.0/$archive" -o "$scratch/node.tar.gz"; then
    echo 'Official download is unavailable or slow; trying a mirror with the same official checksum.'
    curl --fail --location --silent --show-error --retry 1 --connect-timeout 15 \
      --speed-limit 32768 --speed-time 30 --max-time 600 \
      "https://registry.npmmirror.com/-/binary/node/v24.13.0/$archive" -o "$scratch/node.tar.gz"
  fi
  python3 - "$scratch/node.tar.gz" "$expected" <<'PY'
import hashlib,sys
with open(sys.argv[1],'rb') as f:
    actual=hashlib.sha256(f.read()).hexdigest()
if actual != sys.argv[2]: raise SystemExit('Node archive checksum mismatch')
PY
  tar -xzf "$scratch/node.tar.gz" -C "$scratch"
  test ! -e "$node_dir" || { echo 'Incomplete existing Node directory; preserve it and choose a clean checkout.' >&2; exit 1; }
  mv "$scratch/node-v24.13.0-$platform-$arch" "$node_dir"
fi
test "$("$node_dir/bin/node" --version)" = v24.13.0
export PATH="$node_dir/bin:$PATH"
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
bash "$root/scripts/prepare.sh"
python3 "$root/scripts/source-version.py" --record
python3 - "$root" "$node_dir" <<'PY'
import pathlib,shlex,sys
root=pathlib.Path(sys.argv[1]); node=pathlib.Path(sys.argv[2])
paths=[str(node/'bin'),str(root/'.tools/node_modules/.bin'),str(root/'.tools/bin')]
(root/'.tools/env.sh').write_text('export PATH='+shlex.quote(':'.join(paths))+':"$PATH"\n')
print('Tools ready. Enable them with: source '+shlex.quote(str(root/'.tools/env.sh')))
print('Next: docs/DEPLOYMENT-SOP.md. No services or accounts were changed.')
PY
