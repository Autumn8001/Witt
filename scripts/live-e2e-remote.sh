#!/bin/bash
# Live end-to-end: Witt backend -> RuntimeResolver -> grok-build -> CPA -> Grok 4.7
set -u
export PATH="/root/.local/bin:/usr/local/bin:$PATH"
set -a; . /root/.witt/app.env; set +a
cd /root/witt-app

echo "=== stop previous instance by listening port ==="
OLD_PID=$(ss -lntp 2>/dev/null | awk '/:3003 /{print $NF}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -n "${OLD_PID:-}" ]; then kill "$OLD_PID" 2>/dev/null || true; sleep 2; echo "stopped $OLD_PID"; else echo "none"; fi

echo "=== start Witt backend (loopback 3003) ==="
: > /root/witt-run.log
nohup node backend/server.js >> /root/witt-run.log 2>&1 &
echo $! > /root/.witt/witt.pid
echo "pid=$(cat /root/.witt/witt.pid)"

python3 - <<'PY'
import json, os, signal, socket, subprocess, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:3003"
TOKEN = open("/root/.witt/legacy-token").read().strip()
ENV = {}
for line in open("/root/.witt/app.env"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        ENV[key] = value
CPA_KEY = ENV.get("WITT_CPA_API_KEY", "")

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

def wait_health(seconds=60):
    for _ in range(int(seconds * 2)):
        status, _body = call("GET", "/health", timeout=5)
        if status == 200:
            return True
        time.sleep(0.5)
    return False

def read_sse(path, seconds=6):
    try:
        connection = socket.create_connection(("127.0.0.1", 3003), timeout=seconds)
    except OSError as error:
        return "connect failed: %s" % error
    request = ("GET %s HTTP/1.1\r\nHost: 127.0.0.1:3003\r\nAuthorization: Bearer %s\r\n"
               "Accept: text/event-stream\r\n\r\n" % (path, TOKEN))
    connection.sendall(request.encode())
    connection.settimeout(seconds)
    chunks = []
    try:
        while True:
            data = connection.recv(65536)
            if not data:
                break
            chunks.append(data)
    except socket.timeout:
        pass
    except OSError:
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

# ---------------------------------------------------------------- boot
check("T-WITT-00", "backend boots", wait_health())

status, body = call("GET", "/runtime/harnesses")
harnesses = as_dict(body)
ids = {h["id"]: h for h in harnesses.get("harnesses", [])}
check("T-WITT-02", "harness inventory", status == 200 and set(ids) == {"codex", "grok-build", "google-antigravity"},
      {k: v["installed"] for k, v in ids.items()})
check("T-WITT-03", "grok binary present", bool(ids.get("grok-build", {}).get("installed")),
      ids.get("grok-build", {}).get("bin"))

status, body = call("GET", "/providers")
providers = as_dict(body).get("providers", [])
check("T-WITT-05", "providers + protocol", {p["id"] for p in providers} >= {"cpa", "sub2api"},
      [(p["id"], p["protocol"], p["secret_display"]) for p in providers])

status, body = call("POST", "/providers/cpa/check", {}, timeout=90)
cpa = as_dict(body).get("provider", {})
check("T-WITT-06", "CPA health + discovery", cpa.get("health") == "healthy" and bool(cpa.get("discovered_models")),
      "health=%s models=%s" % (cpa.get("health"), len(cpa.get("discovered_models") or [])))

status, body = call("GET", "/servers/overview", timeout=90)
overview = as_dict(body)
http = {s["name"]: s for s in overview.get("http", [])}
check("T-WITT-07", "server center metrics",
      bool(overview.get("cpu")) and bool(overview.get("memory")) and overview.get("readOnly") is True,
      "cpu=%s mem=%s%% disk=%s%% up=%ss" % (overview.get("cpu", {}).get("count"),
      overview.get("memory", {}).get("usedPercent"), (overview.get("disk") or {}).get("usedPercent"),
      int(overview.get("uptimeSeconds") or 0)))
check("T-WITT-08", "real service health",
      all(http.get(n, {}).get("status") == "healthy" for n in ("witt", "open-webui", "cpa", "sub2api")),
      {k: v["status"] for k, v in http.items()})
check("T-WITT-09", "open webui entry",
      overview.get("openWebuiUrl") == "http://186.244.203.27:3000/", overview.get("openWebuiUrl"))

# ------------------------------------------------- Witt -> Grok session
status, body = call("POST", "/chat/conversations", {
    "title": "Live E2E grok", "model": "grok-4.7-high", "reasoning": "high",
    "accessMode": "danger-full-access", "workDir": "/root/witt-grok-work"})
created = as_dict(body)
conv = created.get("conversation") if isinstance(created.get("conversation"), dict) else {}
cid = conv.get("id")
check("T-GROK-11", "Witt creates Grok session",
      status in (200, 201) and conv.get("harnessId") == "grok-build" and bool(cid),
      "status=%s harness=%s model=%s body=%s" % (status, conv.get("harnessId"), conv.get("model"), body[:120]))

if not cid:
    print("cannot continue without a session")
    raise SystemExit(1)

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
text2 = (assistant2 or {}).get("text") or ""
check("T-GROK-15", "second turn keeps context", "ZEPHYR-9" in text2, "text=%r" % text2[:80])
check("T-GROK-15b", "session id stable across turns",
      (conv2 or {}).get("harnessSessionId") == session_id, (conv2 or {}).get("harnessSessionId"))

status, body = call("PATCH", "/chat/conversations/%s" % cid, {"model": "no-such-model-xyz"})
check("T-GROK-18", "invalid model -> client error", status == 400, "status=%s" % status)

status, body = call("PATCH", "/chat/conversations/%s" % cid, {"model": "gemini-3.8-flash-high"})
guard = as_dict(body)
check("T-GROK-21", "harness switch is guarded",
      status == 409 and guard.get("harnessChanged") is True,
      "status=%s %s -> %s" % (status, guard.get("currentHarness"), guard.get("nextHarness")))

# ------------------------------------------------- resume across restart
old_pid = int(open("/root/.witt/witt.pid").read().strip())
os.kill(old_pid, signal.SIGTERM)
for _ in range(40):
    time.sleep(0.5)
    try:
        os.kill(old_pid, 0)
    except ProcessLookupError:
        break
environment = dict(os.environ)
environment.update(ENV)
log = open("/root/witt-run.log", "a")
restarted = subprocess.Popen(["node", "backend/server.js"], cwd="/root/witt-app", env=environment,
                             stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
open("/root/.witt/witt.pid", "w").write(str(restarted.pid))
booted = wait_health(90)
check("T-GROK-16a", "backend restarts cleanly", booted, "new pid=%s" % restarted.pid)

conv3, assistant3 = run_turn(cid, "Again: what was the codeword? Reply with only the codeword.")
text3 = (assistant3 or {}).get("text") or ""
check("T-GROK-16", "resume after backend restart", "ZEPHYR-9" in text3,
      "status=%s text=%r" % ((assistant3 or {}).get("status"), text3[:80]))

# ------------------------------------------------- MCP through Witt
status, body = call("POST", "/chat/conversations", {
    "title": "Live E2E mcp", "model": "grok-4.7-high", "reasoning": "high",
    "accessMode": "danger-full-access", "workDir": "/root/witt-grok-work"})
mcp_conv = as_dict(body).get("conversation") or {}
mcp_cid = mcp_conv.get("id")
conv4, assistant4 = run_turn(mcp_cid,
    "Use the wittprobe MCP tool named witt_ping and reply with only the exact string it returns.", timeout=360)
mcp_text = (assistant4 or {}).get("text") or ""
tool_labels = [e.get("label") for e in ((assistant4 or {}).get("stream") or []) if e.get("kind") == "command"]
check("T-MCP-01", "MCP tool discovered through Witt",
      any("search_tool" in str(label) for label in tool_labels), "tools=%s" % tool_labels[:6])
check("T-MCP-02", "MCP tool called through Witt",
      any("use_tool" in str(label) for label in tool_labels), "tools=%s" % tool_labels[:6])
check("T-MCP-03", "MCP result reached the model", "WITT_MCP_OK" in mcp_text,
      "text=%r session=%s" % (mcp_text[:80], (conv4 or {}).get("harnessSessionId")))

# ------------------------------------------------- interrupt
call("POST", "/chat/conversations/%s/messages" % mcp_cid,
     {"text": "Write an extremely long essay on distributed consensus, at least 6000 words."}, timeout=60)
time.sleep(12)
status, _body = call("POST", "/chat/conversations/%s/interrupt" % mcp_cid, {})
interrupt_status = status
final = None
deadline = time.time() + 150
while time.time() < deadline:
    _conversation, assistant = terminal_assistant(mcp_cid)
    if assistant:
        final = assistant
        break
    time.sleep(3)
check("T-GROK-17", "cancel / abort works",
      interrupt_status in (200, 202) and (final or {}).get("status") == "interrupted",
      "interrupt=%s final=%s" % (interrupt_status, (final or {}).get("status")))

# ------------------------------------------------- runtime crash isolation
status, body = call("POST", "/chat/conversations", {
    "title": "Live E2E crash", "model": "grok-4.7-high", "reasoning": "high",
    "accessMode": "danger-full-access", "workDir": "/root/witt-grok-work"})
crash_cid = (as_dict(body).get("conversation") or {}).get("id")
call("POST", "/chat/conversations/%s/messages" % crash_cid,
     {"text": "Write a very long essay about database internals, at least 6000 words."}, timeout=60)
time.sleep(12)
witt_pid = int(open("/root/.witt/witt.pid").read().strip())
try:
    children = subprocess.run(["pgrep", "-P", str(witt_pid)], capture_output=True, text=True).stdout.split()
except Exception:
    children = []
killed = []
for child in children:
    try:
        exe = os.readlink("/proc/%s/exe" % child)
    except OSError:
        continue
    if "grok" in exe:
        try:
            os.kill(int(child), signal.SIGKILL)
            killed.append(int(child))
        except OSError:
            pass
crash_final = None
deadline = time.time() + 120
while time.time() < deadline:
    _conversation, assistant = terminal_assistant(crash_cid)
    if assistant:
        crash_final = assistant
        break
    time.sleep(3)
health_after, _body = call("GET", "/health", timeout=10)
check("T-GROK-19", "runtime crash isolated from backend",
      bool(killed) and health_after == 200 and (crash_final or {}).get("status") == "failed",
      "killed=%s health=%s turn=%s text=%r" % (killed, health_after, (crash_final or {}).get("status"),
      ((crash_final or {}).get("text") or "")[:70]))

# ------------------------------------------------- security and logs
sse = read_sse("/chat/conversations/%s/events" % cid, seconds=5)
leaks = []
for path in ("/providers", "/runtime/harnesses", "/servers/overview",
             "/chat/conversations/%s" % cid, "/chat/conversations/%s" % mcp_cid):
    _st, raw = call("GET", path, timeout=90)
    if CPA_KEY and CPA_KEY in raw:
        leaks.append(path)
if CPA_KEY and CPA_KEY in sse:
    leaks.append("sse")
check("T-GROK-20a", "no secret in API or SSE responses", not leaks, "leaks=%s sse_bytes=%s" % (leaks, len(sse)))

run_log = open("/root/witt-run.log", encoding="utf-8", errors="replace").read()
check("T-GROK-20b", "no secret in backend log", not (CPA_KEY and CPA_KEY in run_log))

runtime_lines = [line for line in run_log.splitlines() if "[runtime]" in line]
events = set()
for line in runtime_lines:
    try:
        events.add(json.loads(line.split("[runtime]", 1)[1].strip()).get("event"))
    except Exception:
        pass
check("T-GROK-22", "structured runtime logs present",
      {"runtime_started", "end", "prompt_start"} & events or {"runtime_started", "end"} <= events,
      "events=%s lines=%d" % (sorted(e for e in events if e), len(runtime_lines)))
check("T-GROK-22b", "runtime log carries session and model",
      any(json.loads(line.split("[runtime]", 1)[1].strip()).get("sessionId") for line in runtime_lines
          if line.split("[runtime]", 1)[1].strip().startswith("{")))

print()
passed = sum(1 for _t, _n, r in RESULTS if r == "PASS")
print("SUMMARY %d/%d PASS" % (passed, len(RESULTS)))
for tid, name, result in RESULTS:
    if result != "PASS":
        print("  FAILED %s %s" % (tid, name))
PY

echo "=== cleanup: stop verification backend ==="
PID=$(cat /root/.witt/witt.pid 2>/dev/null || true)
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"; sleep 2
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" || true
  echo "stopped $PID"
fi
ss -lntp 2>/dev/null | awk '/:3003 /{print}' || true
echo "(no output above means port 3003 released)"
