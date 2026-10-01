#!/bin/bash
# shellcheck shell=bash
#
# Lifecycle helpers shared by the live verification script.
#
# Guarantees:
#   * cleanup runs at most once, even when a signal and the exit path both fire
#   * a caught INT/TERM cleans up and then exits NON-ZERO
#   * a failing cleanup turns an otherwise-successful run into a non-zero exit
#   * the normal path runs cleanup explicitly rather than relying on the EXIT trap
#   * the EXIT trap does not duplicate the cleanup work
#
# The caller must define `lifecycle_cleanup_body`, which returns 0 on success.
# After the run completes, the caller must call:
#     finish_with_cleanup "$rc"; exit $?
#
# Sourced, not executed. Safe to source more than once.

LIFECYCLE_CLEANUP_DONE=0
LIFECYCLE_CLEANUP_RC=0

# Run the cleanup body exactly once. Returns its status, or the remembered status
# on a repeat call.
cleanup() {
  if [ "$LIFECYCLE_CLEANUP_DONE" -eq 1 ]; then
    return "$LIFECYCLE_CLEANUP_RC"
  fi
  LIFECYCLE_CLEANUP_DONE=1
  LIFECYCLE_CLEANUP_RC=0
  if declare -F lifecycle_cleanup_body >/dev/null 2>&1; then
    lifecycle_cleanup_body || LIFECYCLE_CLEANUP_RC=1
  fi
  return "$LIFECYCLE_CLEANUP_RC"
}

# Signal handler: always exits non-zero (130 for INT, 143 for TERM).
on_signal() {
  local signal="$1"
  echo "received SIG${signal}; cleaning up before exiting"
  cleanup || true
  case "$signal" in
    INT) exit 130 ;;
    TERM) exit 143 ;;
    HUP) exit 129 ;;
    *) exit 1 ;;
  esac
}

# EXIT trap: preserves the caller's code, but never reports success when cleanup
# failed. The cleanup body itself has already run in that case, so this is a no-op.
lifecycle_exit_handler() {
  local rc=$?
  cleanup || true
  if [ "$LIFECYCLE_CLEANUP_RC" -ne 0 ] && [ "$rc" -eq 0 ]; then
    rc=1
  fi
  exit "$rc"
}

install_lifecycle_traps() {
  trap 'on_signal INT' INT
  trap 'on_signal TERM' TERM
  trap 'on_signal HUP' HUP
  trap lifecycle_exit_handler EXIT
}

# Explicit cleanup on the normal path. Returns the final exit code.
finish_with_cleanup() {
  local rc="${1:-0}"
  cleanup || true
  if [ "$LIFECYCLE_CLEANUP_RC" -ne 0 ] && [ "$rc" -eq 0 ]; then
    rc=1
  fi
  return "$rc"
}
