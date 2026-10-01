#!/bin/bash
# Behavioural tests for scripts/lib/e2e-lifecycle.sh.
#
# These execute real shell fixtures rather than grepping for strings: each
# scenario is written to a temp file, run with bash, and checked for its exit
# code and for how many times the cleanup body actually ran.
#
# Run: bash scripts/test_lifecycle_exit.sh
set -u

LIB="$(cd "$(dirname "$0")" && pwd)/lib/e2e-lifecycle.sh"
[ -f "$LIB" ] || { echo "FATAL: lifecycle library not found at $LIB"; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/witt-lifecycle-XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

PASS=0
FAIL=0
failures=""

# run_scenario <name> <expected-exit> <expected-cleanup-count> <script-body>
run_scenario() {
  local name="$1" expected_exit="$2" expected_count="$3" body="$4"
  local script="$WORK/$name.sh" log="$WORK/$name.log" count_file="$WORK/$name.count"

  {
    echo '#!/bin/bash'
    echo 'set -u'
    echo "COUNT_FILE='$count_file'"
    echo '. "$1"' # LIB passed as $1
    cat <<'BODY'
lifecycle_cleanup_body() {
  local n=0
  [ -f "$COUNT_FILE" ] && n=$(wc -l < "$COUNT_FILE")
  echo "cleanup" >> "$COUNT_FILE"
  LIFECYCLE_BODY_RC=${BODY_RC:-0}
  return "$LIFECYCLE_BODY_RC"
}
BODY
    echo "$body"
  } > "$script"

  bash "$script" "$LIB" > "$log" 2>&1
  local actual_exit=$?
  local actual_count=0
  [ -f "$count_file" ] && actual_count=$(wc -l < "$count_file")

  if [ "$actual_exit" -eq "$expected_exit" ] && [ "$actual_count" -eq "$expected_count" ]; then
    PASS=$((PASS + 1))
    echo "PASS  $name (exit=$actual_exit cleanup_runs=$actual_count)"
  else
    FAIL=$((FAIL + 1))
    failures="$failures
  - $name: expected exit=$expected_exit cleanup_runs=$expected_count, got exit=$actual_exit cleanup_runs=$actual_count"
    echo "FAIL  $name (exit=$actual_exit cleanup_runs=$actual_count)"
    sed 's/^/        | /' "$log"
  fi
}

echo "== lifecycle exit-code behaviour =="

run_scenario "normal_success" 0 1 '
install_lifecycle_traps
finish_with_cleanup 0
exit $?
'

run_scenario "normal_cleanup_failure_becomes_nonzero" 1 1 '
BODY_RC=1
install_lifecycle_traps
finish_with_cleanup 0
exit $?
'

run_scenario "failure_exit_is_preserved" 7 1 '
install_lifecycle_traps
finish_with_cleanup 7
exit $?
'

run_scenario "cleanup_failure_upgrades_failure_code" 7 1 '
BODY_RC=1
install_lifecycle_traps
finish_with_cleanup 7
exit $?
'

run_scenario "no_double_cleanup_when_explicit_and_trap_agree" 0 1 '
install_lifecycle_traps
cleanup
cleanup
finish_with_cleanup 0
exit $?
'

run_scenario "sigterm_cleans_up_and_exits_143" 143 1 '
install_lifecycle_traps
kill -TERM $$
sleep 5
'

run_scenario "sigint_cleans_up_and_exits_130" 130 1 '
install_lifecycle_traps
kill -INT $$
sleep 5
'

run_scenario "unhandled_exit_still_cleans_up_once" 1 1 '
install_lifecycle_traps
exit 1
'

run_scenario "fatal_before_finish_still_cleans_up" 1 1 '
install_lifecycle_traps
echo "aborting"
exit 1
'

run_scenario "cleanup_is_idempotent_across_signal_path" 143 1 '
install_lifecycle_traps
kill -TERM $$
sleep 5
'

echo
echo "SUMMARY $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  echo "failures:$failures"
  exit 1
fi
exit 0
