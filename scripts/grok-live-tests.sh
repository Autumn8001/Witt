#!/bin/bash
# Grok Build live behaviour tests: session, resume, invalid model, cancel.
set -u
export PATH="/root/.local/bin:$PATH"
set -a; . /root/.witt/cpa.env; set +a
WORK=/root/witt-grok-work
mkdir -p "$WORK"; cd "$WORK"
SID=$(python3 -c 'import uuid;print(uuid.uuid4())')
echo "SESSION=$SID"

echo "=== T-GROK-04 new session with fixed id ==="
timeout 180 grok -p "Remember the codeword ZEPHYR-9. Reply with just: STORED" \
  --model witt-grok-high --output-format json --no-auto-update \
  --session-id "$SID" --cwd "$WORK" 2>&1 | python3 -c '
import sys,json
raw=sys.stdin.read().strip()
try:
    d=json.loads(raw.splitlines()[-1])
    print("text:", (d.get("text") or "")[:120])
    print("sessionId:", d.get("sessionId"))
    print("stopReason:", d.get("stopReason"))
except Exception as e:
    print("RAW:", raw[:300])
'

echo "=== T-GROK-05/06 second turn resumes context in a new process ==="
timeout 180 grok -p "What was the codeword? Reply with only the codeword." \
  --model witt-grok-high --output-format json --no-auto-update \
  -r "$SID" --cwd "$WORK" 2>&1 | python3 -c '
import sys,json
raw=sys.stdin.read().strip()
try:
    d=json.loads(raw.splitlines()[-1])
    print("text:", (d.get("text") or "")[:160])
    print("sessionId:", d.get("sessionId"))
except Exception as e:
    print("RAW:", raw[:300])
'

echo "=== sessions on disk ==="
grok sessions 2>&1 | head -10

echo "=== T-GROK-08 invalid model ==="
timeout 120 grok -p "hello" --model definitely-not-a-model --output-format json \
  --no-auto-update --cwd "$WORK" >/tmp/witt-badmodel.out 2>&1
echo "exit=$?"
head -c 400 /tmp/witt-badmodel.out; echo

echo "=== T-GROK-09 cancel: kill a long run ==="
timeout 300 grok -p "Write a very long detailed essay about distributed systems, at least 5000 words." \
  --model witt-grok-high --output-format streaming-json --no-auto-update --cwd "$WORK" \
  >/tmp/witt-cancel.out 2>&1 &
PID=$!
sleep 12
kill -TERM $PID 2>/dev/null
sleep 3
if kill -0 $PID 2>/dev/null; then echo "still running, SIGKILL"; kill -9 $PID 2>/dev/null; sleep 1; fi
wait $PID 2>/dev/null
echo "cancel exit=$?"
echo "bytes emitted before cancel: $(wc -c </tmp/witt-cancel.out)"
tail -c 200 /tmp/witt-cancel.out; echo
rm -f /tmp/witt-badmodel.out /tmp/witt-cancel.out
