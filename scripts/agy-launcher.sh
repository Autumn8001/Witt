#!/bin/bash
set -eu
export HOME="/home/agytest"
# Only a trusted root service may select administrator execution. Untrusted
# sessions remain agytest, regardless of their requested conversation mode.
if [ "$(id -u)" = "0" ] && [ "${CHLOE_AGY_ADMIN_EXECUTION:-0}" = "1" ]; then
  export USER="root"
  exec /usr/bin/qemu-x86_64 -cpu max /root/.local/bin/agy.orig-elf "$@"
fi
export USER="agytest"
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=agytest --regid=agytest --clear-groups /usr/bin/qemu-x86_64 -cpu max /root/.local/bin/agy.orig-elf "$@"
else
  exec /usr/bin/qemu-x86_64 -cpu max /root/.local/bin/agy.orig-elf "$@"
fi
