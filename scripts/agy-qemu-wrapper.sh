#!/bin/bash
# Versioned copy of the VPS launcher. Install only after provisioning agytest,
# qemu-user, and the verified original ELF; never install the CLI over this file.
set -eu
export HOME="/home/agytest"
export USER="agytest"
if [ "$(id -u)" = "0" ]; then
    exec setpriv --reuid=agytest --regid=agytest --clear-groups /usr/bin/qemu-x86_64 -cpu max /root/.local/bin/agy.orig-elf "$@"
else
    exec /usr/bin/qemu-x86_64 -cpu max /root/.local/bin/agy.orig-elf "$@"
fi
