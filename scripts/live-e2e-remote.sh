#!/bin/bash
# Live end-to-end: Witt backend -> RuntimeResolver -> grok-build -> CPA -> Grok 4.7
#
# Safety properties:
#   * Never hunts for or kills whatever happens to hold a port.
#   * Uses an OS-assigned free high port.
#   * Test state lives in a private mktemp directory, never in shared data dirs.
#   * Only stops the PID this run started, after verifying that PID's command line
#     and working directory still match our backend.
#   * Refuses to overwrite a PID file that still refers to a live instance.
#   * A restart is only recorded as successful once the new process is verified
#     alive AND confirmed to own the test port.
#   * Any failed check makes Python and this shell script exit non-zero.
#   * Removes only the mktemp directory it created.
set -u
export PATH="/root/.local/bin:/usr/local/bin:$PATH"

APP_DIR=/opt/witt
RUN_DIR=$(mktemp -d /tmp/witt-e2e-XXXXXXXX)
chmod 700 "$RUN_DIR"
PID_FILE="$RUN_DIR/witt.pid"
LOG="$RUN_DIR/run.log"
PORT=""

# Lifecycle helpers (idempotent cleanup, non-zero exit on signal, cleanup failure
# upgrades the exit code). Single source of truth, also covered by
# scripts/test_lifecycle_exit.sh.
LIFECYCLE_LIB="${WITT_LIFECYCLE_LIB:-}"
if [ -z "$LIFECYCLE_LIB" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  for candidate in "$SCRIPT_DIR/lib/e2e-lifecycle.sh" "/opt/witt/scripts/lib/e2e-lifecycle.sh"; do
    if [ -f "$candidate" ]; then LIFECYCLE_LIB="$candidate"; break; fi
  done
fi
if [ -z "$LIFECYCLE_LIB" ] || [ ! -f "$LIFECYCLE_LIB" ]; then
  echo "FATAL: lifecycle library not found"
  exit 1
fi
. "$LIFECYCLE_LIB"

port_owner_pid() {
  ss -lntp 2>/dev/null | awk -v p=":$1 " 'index($0, p)' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

pid_identity_ok() {
  # $1 = pid. True only when it is our backend running from our app dir.
  local pid="$1" cmd cwd
  kill -0 "$pid" 2>/dev/null || return 1
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  case "$cmd" in *"node backend/server.js"*) ;; *) return 1 ;; esac
  [ "$cwd" = "$APP_DIR" ] || return 1
  return 0
}

stop_own_backend() {
  [ -f "$PID_FILE" ] || { echo "no PID file; nothing stopped"; return 0; }
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) echo "no usable PID recorded; nothing stopped"; return 0 ;; esac
  if ! kill -0 "$pid" 2>/dev/null; then echo "backend $pid already stopped"; return 0; fi
  if ! pid_identity_ok "$pid"; then
    echo "refusing to stop PID $pid: identity check failed"
    return 1
  fi
  echo "stopping our backend pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { echo "stopped after ${i}s"; return 0; }
    sleep 1
  done
  if pid_identity_ok "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
    echo "escalated to SIGKILL"
  else
    echo "refusing to SIGKILL PID $pid: identity changed"
    return 1
  fi
  return 0
}

lifecycle_cleanup_body() {
  local rc=0
  stop_own_backend || rc=1
  # Verify the port is actually free again.
  local owner
  owner=$(port_owner_pid "$PORT")
  if [ -n "${owner:-}" ]; then
    if [ "$owner" = "$(cat "$PID_FILE" 2>/dev/null || true)" ]; then
      echo "WARNING: test port $PORT still held by our pid $owner after stop"
      rc=1
    else
      echo "note: test port $PORT is now held by unrelated pid $owner (left alone)"
    fi
  else
    echo "test port $PORT released"
  fi
  case "$RUN_DIR" in
    /tmp/witt-e2e-*)
      if [ -d "$RUN_DIR" ]; then rm -rf -- "$RUN_DIR"; echo "removed test directory $RUN_DIR"; fi
      ;;
    *) echo "refusing to remove unexpected path: $RUN_DIR" ;;
  esac
  return $rc
}

fatal() {
  echo "FATAL: $*"
  exit 1
}

# Traps are installed only after the cleanup body exists, so an early failure
# still cleans up exactly once.
install_lifecycle_traps

# --- Private test state -----------------------------------------------------
mkdir -p "$RUN_DIR"/chat "$RUN_DIR"/images "$RUN_DIR"/files "$RUN_DIR"/tasks "$RUN_DIR"/users "$RUN_DIR"/auth
chmod 700 "$RUN_DIR/auth"

# Random free high port chosen by the OS.
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
echo "test port=$PORT  run dir=$RUN_DIR"

TOKEN_FILE="$RUN_DIR/legacy-token"
python3 -c "import secrets,sys; open(sys.argv[1],'w').write(secrets.token_urlsafe(32))" "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

WITT_CPA_API_KEY=$(python3 - <<'PY'
import re
text = open('/opt/cliproxyapi/config.yaml', encoding='utf-8', errors='replace').read()
block = text.split('api-keys:', 1)[1].split('\n\n', 1)[0]
keys = re.findall(r'(?m)^\s*-\s*"([^"]+)"', block)
print(keys[0] if keys else '')
PY
)
[ -n "$WITT_CPA_API_KEY" ] || fatal "no CPA key available"
export WITT_CPA_API_KEY

export DROP_VAULT_PORT="$PORT"
export DROP_VAULT_DATA_DIR="$RUN_DIR/files"
export DROP_VAULT_TASK_DIR="$RUN_DIR/tasks"
export DROP_VAULT_CHAT_DIR="$RUN_DIR/chat"
export DROP_VAULT_IMAGE_DIR="$RUN_DIR/images"
export DROP_VAULT_USERS_DIR="$RUN_DIR/users"
export DROP_VAULT_AUTH_DIR="$RUN_DIR/auth"
export DROP_VAULT_TOKEN_FILE="$TOKEN_FILE"
export DROP_VAULT_CODEX_BIN=/usr/local/bin/codex
export DROP_VAULT_CODEX_WORKDIR=/root/witt-grok-work
export WITT_GROK_BIN=/root/.local/bin/grok
export WITT_CPA_URL=http://127.0.0.1:8317/v1
export WITT_SUB2API_URL=http://127.0.0.1:8080/v1
export OPEN_WEBUI_URL=http://186.244.203.27:3000/
export WITT_RUNTIME_LOG=1
export WITT_TEST_PORT="$PORT"
export WITT_TEST_RUN_DIR="$RUN_DIR"

# Refuse to clobber a PID file that still describes a live instance of ours.
if [ -f "$PID_FILE" ]; then
  EXISTING=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${EXISTING:-}" ] && kill -0 "$EXISTING" 2>/dev/null; then
    fatal "PID file already tracks live process $EXISTING; refusing to overwrite"
  fi
fi

cd "$APP_DIR" || fatal "cannot enter $APP_DIR"

nohup node backend/server.js > "$LOG" 2>&1 &
echo $! > "$PID_FILE"
echo "started our backend pid=$(cat "$PID_FILE")"

# Confirm the new process is alive and really owns the test port.
verify_started() {
  local pid owner i
  pid=$(cat "$PID_FILE")
  for i in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || { echo "backend pid $pid exited during startup"; return 1; }
    owner=$(port_owner_pid "$PORT")
    if [ "$owner" = "$pid" ]; then
      pid_identity_ok "$pid" || { echo "identity check failed for pid $pid"; return 1; }
      echo "confirmed: pid $pid is alive and owns port $PORT"
      return 0
    fi
    sleep 0.5
  done
  echo "backend pid $pid never owned port $PORT"
  return 1
}
verify_started || fatal "backend did not come up correctly"

python3 - <<'PY'
import json, os, signal, socket, subprocess, time, urllib.error, urllib.request

PORT = int(os.environ["WITT_TEST_PORT"])
BASE = "http://127.0.0.1:%d" % PORT
RUN_DIR = os.environ["WITT_TEST_RUN_DIR"]
PID_FILE = os.path.join(RUN_DIR, "witt.pid")
APP_DIR = os.environ.get("PWD", "/opt/witt")
TOKEN = open(os.path.join(RUN_DIR, "legacy-token")).read().strip()
CPA_KEY = os.environ.get("WITT_CPA_API_KEY", "")

RESULTS = []
def check(tid, name, ok, detail=""):
    RESULTS.append((tid, name, "PASS" if ok else "FAIL"))
    print("%-4s %-11s %-38s %s" % ("PASS" if ok else "FAIL", tid, name, str(detail)[:150]))

def call(method, path, body=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except Exception as error:
        return 0, str(error)

def as_dict(text):
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def wait_health(seconds=90):
    for _ in range(int(seconds * 2)):
        if call("GET", "/health", timeout=5)[0] == 200:
            return True
        time.sleep(0.5)
    return False

def read_sse(path, seconds=6):
    try:
        connection = socket.create_connection(("127.0.0.1", PORT), timeout=seconds)
    except OSError as error:
        return "connect failed: %s" % error
    request = ("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAuthorization: Bearer %s\r\n"
               "Accept: text/event-stream\r\n\r\n" % (path, PORT, TOKEN))
    connection.sendall(request.encode())
    connection.settimeout(seconds)
    chunks = []
    try:
        while True:
            data = connection.recv(65536)
            if not data:
                break
            chunks.append(data)
    except (socket.timeout, OSError):
        pass
    connection.close()
    return b"".join(chunks).decode("utf-8", "replace")

def terminal_assistant(cid):
    status, raw = call("GET", "/chat/conversations/%s" % cid, timeout=30)
    if status != 200:
        return None, None
    conversation = as_dict(raw).get("conversation") or {}
    assistants = [m for m in conversation.get("messages", []) if m.get("role") == "assistant"]
    if assistants and assistants[-1].get("status") in ("completed", "failed", "interrupted"):
        return conversation, assistants[-1]
    return conversation, None

def run_turn(cid, text, timeout=300):
    status, body = call("POST", "/chat/conversations/%s/messages" % cid, {"text": text}, timeout=60)
    if status not in (200, 201, 202):
        return None, {"status": "send-failed", "text": "HTTP %s %s" % (status, body[:160])}
    deadline = time.time() + timeout
    while time.time() < deadline:
        conversation, assistant = terminal_assistant(cid)
        if assistant:
            return conversation, assistant
        time.sleep(3)
    return None, {"status": "timeout", "text": ""}

def identity_ok(pid):
    try:
        cmdline = open("/proc/%d/cmdline" % pid, "rb").read().decode("utf-8", "replace").replace("\0", " ")
        cwd = os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        return False
    return "node backend/server.js" in cmdline and cwd == APP_DIR

def stop_own_backend():
    """Stop only the backend this run started, after verifying its identity."""
    try:
        pid = int(open(PID_FILE).read().strip())
    except Exception:
        return False
    if not identity_ok(pid):
        print("refusing to stop pid: identity mismatch")
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    for _ in range(30):
        time.sleep(0.5)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
    return False

def port_owner_pid(port):
    try:
        out = subprocess.run(["ss", "-lntp"], capture_output=True, text=True).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if ":%d " % port in line:
            import re
            match = re.search(r"pid=(\d+)", line)
            if match:
                return int(match.group(1))
    return None

def start_and_verify():
    """Start a backend and only report success once it owns the test port."""
    environment = dict(os.environ)
    log = open(os.path.join(RUN_DIR, "run.log"), "a")
    process = subprocess.Popen(["node", "backend/server.js"], cwd=APP_DIR, env=environment,
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    open(PID_FILE, "w").write(str(process.pid))
    for _ in range(120):
        if process.poll() is not None:
            print("restarted backend exited during startup")
            return False
        if port_owner_pid(PORT) == process.pid and identity_ok(process.pid):
            return True
        time.sleep(0.5)
    return False

# --------------------------------------------------------------- capabilities
status, body = call("GET", "/chat/capabilities", timeout=120)
caps = as_dict(body)
ids = [m.get("id") for m in caps.get("models", [])]
runtime = caps.get("runtime", {})
check("T-CAP-01", "capabilities 200 without Codex", status == 200, "status=%s" % status)
check("T-CAP-02", "grok model offered", "grok-4.7-high" in ids, "models=%s" % ids)
check("T-CAP-03", "gemini not offered", not any(str(i).startswith("gemini") for i in ids), "models=%s" % ids)
check("T-CAP-04", "codex reported unavailable",
      (runtime.get("codex") or {}).get("available") is False, "codex=%s" % (runtime.get("codex")))
check("T-CAP-05", "antigravity reported blocked",
      (runtime.get("google-antigravity") or {}).get("status") == "blocked_runtime_incompatible")
check("T-CAP-06", "capabilities leak no host detail",
      not any(marker in body for marker in ("/usr/local/bin", "codexBin", "ENOENT"))
      and (not CPA_KEY or CPA_KEY not in body), "checked markers")

check("T-WITT-00", "backend boots", wait_health())

status, body = call("GET", "/runtime/harnesses")
hids = {h["id"]: h for h in as_dict(body).get("harnesses", [])}
check("T-WITT-02", "harness inventory",
      status == 200 and set(hids) == {"codex", "grok-build", "google-antigravity"},
      {k: v["installed"] for k, v in hids.items()})
check("T-WITT-03", "grok binary present", bool(hids.get("grok-build", {}).get("installed")))

status, body = call("GET", "/providers")
providers = as_dict(body).get("providers", [])
by_id = {p.get("id"): p for p in providers}
cpa_provider = by_id.get("cpa") or {}
sub_provider = by_id.get("sub2api") or {}
check("T-WITT-05", "providers expose protocol and redacted secret state",
      cpa_provider.get("protocol") == "openai-responses"
      and sub_provider.get("protocol") == "openai-chat-completions"
      and cpa_provider.get("secret_display") in ("Configured", "Missing")
      and sub_provider.get("secret_display") in ("Configured", "Missing")
      # The secret value itself must never be part of the response.
      and "secret" not in cpa_provider
      and "secret" not in sub_provider
      and isinstance(cpa_provider.get("secret_configured"), bool)
      and (not CPA_KEY or CPA_KEY not in body),
      "cpa=%s/%s sub2api=%s/%s" % (cpa_provider.get("protocol"),
      cpa_provider.get("secret_display"), sub_provider.get("protocol"),
      sub_provider.get("secret_display")))

status, body = call("POST", "/providers/cpa/check", {}, timeout=90)
cpa = as_dict(body).get("provider", {})
check("T-WITT-06", "CPA health + discovery",
      cpa.get("health") == "healthy" and bool(cpa.get("discovered_models")),
      "health=%s models=%s" % (cpa.get("health"), len(cpa.get("discovered_models") or [])))

status, body = call("GET", "/servers/overview", timeout=90)
overview = as_dict(body)
http = {s["name"]: s for s in overview.get("http", [])}
check("T-WITT-07", "server center metrics",
      bool(overview.get("cpu")) and overview.get("readOnly") is True,
      "cpu=%s mem=%s%% disk=%s%%" % (overview.get("cpu", {}).get("count"),
      overview.get("memory", {}).get("usedPercent"), (overview.get("disk") or {}).get("usedPercent")))
check("T-WITT-08", "real service health",
      all(http.get(n, {}).get("status") == "healthy" for n in ("witt", "open-webui", "cpa", "sub2api")),
      {k: v["status"] for k, v in http.items()})
check("T-WITT-09", "open webui entry configured",
      overview.get("openWebuiUrl") == "http://186.244.203.27:3000/", overview.get("openWebuiUrl"))
check("T-WITT-10", "server center is read-only",
      "actions" not in overview and overview.get("readOnly") is True)

# --------------------------------------------- defaults and paused runtime
status, body = call("POST", "/chat/conversations", {"title": "defaults probe"})
conv = as_dict(body).get("conversation") or {}
check("T-DEF-01", "new session defaults to grok/cpa",
      conv.get("model") == "grok-4.7-high" and conv.get("harnessId") == "grok-build"
      and conv.get("providerId") == "cpa",
      "model=%s harness=%s provider=%s" % (conv.get("model"), conv.get("harnessId"), conv.get("providerId")))
cid = conv.get("id")

status, body = call("POST", "/chat/conversations",
                    {"title": "gemini probe", "model": "gemini-3.8-flash-high"})
gem = as_dict(body)
check("T-DEF-02", "creating a paused-runtime session is refused",
      status == 400 and gem.get("blockReason") == "blocked_runtime_incompatible",
      "status=%s blockReason=%s" % (status, gem.get("blockReason")))

status, body = call("POST", "/chat/conversations", {"title": "gpt probe", "model": "gpt-5.6-sol"})
gpt = as_dict(body).get("conversation") or {}
check("T-DEF-03", "gpt session is not labelled as CPA",
      gpt.get("providerId") == "codex",
      "model=%s provider=%s" % (gpt.get("model"), gpt.get("providerId")))

if not cid:
    print("cannot continue without a session")

status, body = call("PATCH", "/chat/conversations/%s" % cid, {"model": "gemini-3.8-flash-high"}) if cid else (0, "{}")
patched = as_dict(body)
check("T-DEF-04", "patching to a paused runtime is refused",
      status == 409 and patched.get("blockReason") == "blocked_runtime_incompatible",
      "status=%s blockReason=%s" % (status, patched.get("blockReason")))

if not cid:
    failed = [t for t, _n, r in RESULTS if r != "PASS"]
    print("\nSUMMARY %d/%d PASS" % (len(RESULTS) - len(failed), len(RESULTS)))
    raise SystemExit(1)

# ------------------------------------------------- Witt -> Grok session
status, body = call("POST", "/chat/conversations", {
    "title": "Live E2E grok", "model": "grok-4.7-high", "reasoning": "high",
    "accessMode": "danger-full-access", "workDir": "/root/witt-grok-work"})
conv = as_dict(body).get("conversation") or {}
cid = conv.get("id")
check("T-GROK-11", "session binds grok-build",
      status in (200, 201) and conv.get("harnessId") == "grok-build" and bool(cid),
      "status=%s harness=%s body=%s" % (status, conv.get("harnessId"), body[:100]))

conv1, assistant1 = run_turn(cid, "Remember the codeword ZEPHYR-9. Reply with just: STORED")
text1 = (assistant1 or {}).get("text") or ""
check("T-GROK-12", "real prompt through Witt",
      (assistant1 or {}).get("status") == "completed" and "STORED" in text1,
      "status=%s text=%r" % ((assistant1 or {}).get("status"), text1[:90]))

kinds = sorted({e.get("kind") for e in ((assistant1 or {}).get("stream") or [])})
check("T-GROK-13", "streaming events persisted", bool(kinds) and "message" in kinds, "kinds=%s" % kinds)

session_id = (conv1 or {}).get("harnessSessionId")
check("T-GROK-14", "harness_session_id persisted", bool(session_id), "session=%s" % session_id)

conv2, assistant2 = run_turn(cid, "What was the codeword? Reply with only the codeword.")
check("T-GROK-15", "second turn keeps context",
      "ZEPHYR-9" in ((assistant2 or {}).get("text") or ""),
      "text=%r" % (((assistant2 or {}).get("text") or "")[:60]))
check("T-GROK-15b", "existing binding unchanged",
      (conv2 or {}).get("model") == "grok-4.7-high" and (conv2 or {}).get("harnessId") == "grok-build",
      "model=%s harness=%s" % ((conv2 or {}).get("model"), (conv2 or {}).get("harnessId")))

status, _body = call("PATCH", "/chat/conversations/%s" % cid, {"model": "no-such-model-xyz"})
check("T-GROK-18", "invalid model rejected", status == 400, "status=%s" % status)

status, body = call("PATCH", "/chat/conversations/%s" % cid, {"model": "gpt-5.5"})
guard = as_dict(body)
check("T-GROK-21", "cross-harness switch refused",
      status == 409 and guard.get("harnessChanged") is True,
      "status=%s %s -> %s" % (status, guard.get("currentHarness"), guard.get("nextHarness")))

# ------------------------------------------------- resume across restart
stopped = stop_own_backend()
if not stopped:
    # Refuse to continue: starting a second backend while the first is unverified
    # would make every later result meaningless.
    check("T-GROK-16a", "backend restart", False, "could not stop the running backend")
    print()
    print("ABORTING: refusing to start a second backend while the first is still running")
    failed = [t for t, _n, r in RESULTS if r != "PASS"]
    print("SUMMARY %d/%d PASS" % (len(RESULTS) - len(failed), len(RESULTS)))
    for tid, name, result in RESULTS:
        if result != "PASS":
            print("  FAILED %s %s" % (tid, name))
    raise SystemExit(1)

check("T-GROK-16a", "backend restart verified on the test port", start_and_verify(),
      "see run log if this failed")
conv3, assistant3 = run_turn(cid, "Again: what was the codeword? Reply with only the codeword.")
check("T-GROK-16", "resume after backend restart",
      "ZEPHYR-9" in ((assistant3 or {}).get("text") or ""),
      "status=%s text=%r" % ((assistant3 or {}).get("status"),
      ((assistant3 or {}).get("text") or "")[:60]))

# ---------------------------------------------------- MCP through Witt
status, body = call("POST", "/chat/conversations", {"title": "mcp probe", "model": "grok-4.7-high"})
mcp_cid = (as_dict(body).get("conversation") or {}).get("id")
conv4, assistant4 = run_turn(mcp_cid,
    "Use the wittprobe MCP tool named witt_ping and reply with only the exact string it returns.",
    timeout=360)
mcp_text = (assistant4 or {}).get("text") or ""
labels = [e.get("label") for e in ((assistant4 or {}).get("stream") or []) if e.get("kind") == "command"]
check("T-MCP-01", "MCP tool discovered", any("search_tool" in str(l) for l in labels), labels[:6])
check("T-MCP-02", "MCP tool actually invoked", any("use_tool" in str(l) for l in labels), labels[:6])
check("T-MCP-03", "MCP result reached the model", "WITT_MCP_OK" in mcp_text,
      "text=%r session=%s" % (mcp_text[:70], (conv4 or {}).get("harnessSessionId")))

# ------------------------------------------------------------- interrupt
call("POST", "/chat/conversations/%s/messages" % mcp_cid,
     {"text": "Write an extremely long essay on distributed consensus, at least 6000 words."}, timeout=60)
time.sleep(12)
status, _body = call("POST", "/chat/conversations/%s/interrupt" % mcp_cid, {})
final = None
deadline = time.time() + 150
while time.time() < deadline:
    _c, assistant = terminal_assistant(mcp_cid)
    if assistant:
        final = assistant
        break
    time.sleep(3)
check("T-GROK-17", "cancel / abort works",
      status in (200, 202) and (final or {}).get("status") == "interrupted",
      "interrupt=%s final=%s" % (status, (final or {}).get("status")))

# ------------------------------------------------- runtime crash isolation
status, body = call("POST", "/chat/conversations", {"title": "crash probe", "model": "grok-4.7-high"})
crash_cid = (as_dict(body).get("conversation") or {}).get("id")
call("POST", "/chat/conversations/%s/messages" % crash_cid,
     {"text": "Write a very long essay about database internals, at least 6000 words."}, timeout=60)
time.sleep(12)
backend_pid = int(open(PID_FILE).read().strip())
killed = []
try:
    children = subprocess.run(["pgrep", "-P", str(backend_pid)], capture_output=True, text=True).stdout.split()
except Exception:
    children = []
for child in children:
    try:
        exe = os.readlink("/proc/%s/exe" % child)
    except OSError:
        continue
    # Only our own descendant, and only if it really is the grok runtime.
    if "grok" in exe:
        try:
            os.kill(int(child), signal.SIGKILL)
            killed.append(int(child))
        except OSError:
            pass
crash_final = None
deadline = time.time() + 120
while time.time() < deadline:
    _c, assistant = terminal_assistant(crash_cid)
    if assistant:
        crash_final = assistant
        break
    time.sleep(3)
health_after = call("GET", "/health", timeout=10)[0]
check("T-GROK-19", "runtime crash isolated from backend",
      bool(killed) and health_after == 200 and (crash_final or {}).get("status") == "failed",
      "killed=%s health=%s turn=%s" % (killed, health_after, (crash_final or {}).get("status")))

# ------------------------------------------------- secret safety and logs
sse = read_sse("/chat/conversations/%s/events" % cid, seconds=5)
leaks = [p for p in ("/providers", "/runtime/harnesses", "/servers/overview", "/chat/capabilities")
         if CPA_KEY and CPA_KEY in call("GET", p, timeout=90)[1]]
if CPA_KEY and CPA_KEY in sse:
    leaks.append("sse")
check("T-GROK-20a", "no secret in responses or SSE", not leaks, "leaks=%s" % leaks)
log_text = open(os.path.join(RUN_DIR, "run.log"), encoding="utf-8", errors="replace").read()
check("T-GROK-20b", "no secret in backend log", not (CPA_KEY and CPA_KEY in log_text))

runtime_lines = []
for line in log_text.splitlines():
    if "[runtime]" in line:
        try:
            runtime_lines.append(json.loads(line.split("[runtime]", 1)[1].strip()))
        except Exception:
            pass
check("T-GROK-22", "structured runtime logs", bool(runtime_lines),
      "lines=%d" % len(runtime_lines))
check("T-GROK-22b", "runtime log carries session and model",
      any(entry.get("sessionId") and entry.get("model") for entry in runtime_lines),
      "sessions=%d" % len({e.get("sessionId") for e in runtime_lines if e.get("sessionId")}))

print()
failed = [t for t, _n, r in RESULTS if r != "PASS"]
print("SUMMARY %d/%d PASS" % (len(RESULTS) - len(failed), len(RESULTS)))
for tid, name, result in RESULTS:
    if result != "PASS":
        print("  FAILED %s %s" % (tid, name))
raise SystemExit(0 if not failed else 1)
PY
E2E_EXIT=$?
# Explicit cleanup on the normal path; a failing cleanup upgrades the exit code.
finish_with_cleanup "$E2E_EXIT"
FINAL_EXIT=$?
echo "e2e exit code: $FINAL_EXIT (cleanup rc: $LIFECYCLE_CLEANUP_RC)"
exit "$FINAL_EXIT"
