package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func signedAssistFixture(t *testing.T, key ed25519.PrivateKey, data []byte, version string) ([]byte, assistRelease) {
	t.Helper()
	hash := sha256.Sum256(data)
	release := assistRelease{Version: version, SHA256: hex.EncodeToString(hash[:]), Bytes: int64(len(data)), Platform: "windows-amd64"}
	payload, _ := json.Marshal(release)
	raw, _ := json.Marshal(assistSignedRelease{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))})
	return raw, release
}
func TestAssistUpdateRequiresPublisherSignatureAndNewerVersion(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	raw, _ := signedAssistFixture(t, key, []byte("test release"), "2026.10.16.6")
	if _, e := verifyAssistRelease(raw, pub); e != nil {
		t.Fatal(e)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, e := verifyAssistRelease(raw, other); e == nil {
		t.Fatal("foreign publisher accepted")
	}
	var envelope assistSignedRelease
	json.Unmarshal(raw, &envelope)
	envelope.Payload = base64.StdEncoding.EncodeToString([]byte(`{"version":"9999.1.1.1"}`))
	tampered, _ := json.Marshal(envelope)
	if _, e := verifyAssistRelease(tampered, pub); e == nil {
		t.Fatal("tampered release accepted")
	}
	for _, v := range []string{"2026.10.16.4", "2026.10.16.5", "bad", "2026.10.16.-1", "2026.10.16.9999999999"} {
		if assistNewer(v, "2026.10.16.5") {
			t.Fatal("downgrade or invalid version accepted", v)
		}
	}
	if !assistNewer("2026.10.16.10", "2026.10.16.9") {
		t.Fatal("lexical version comparison")
	}
}

func TestAssistPackagedReleaseSignature(t *testing.T) {
	dir := os.Getenv("ASSIST_RELEASE_DIR")
	if dir == "" {
		t.Skip("explicit packaged release verification")
	}
	raw, e := os.ReadFile(filepath.Join(dir, "update.json"))
	if e != nil {
		t.Fatal(e)
	}
	release, e := verifyAssistRelease(raw, officialAssistFeed().key)
	if e != nil {
		t.Fatal(e)
	}
	if release.Version != assistVersion {
		t.Fatal("packaged version differs from compiled connector")
	}
	if e = verifyAssistBinary(filepath.Join(dir, "chloe-assist.exe"), release); e != nil {
		t.Fatal(e)
	}
}
func TestAssistUpdateDownloadsOnlyVerifiedHTTPSRelease(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	binary := []byte("test binary")
	parts := strings.Split(assistVersion, ".")
	build, _ := strconv.Atoi(parts[3])
	parts[3] = strconv.Itoa(build + 1)
	futureVersion := strings.Join(parts, ".")
	raw, _ := signedAssistFixture(t, key, binary, futureVersion)
	corrupt := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/update.json" {
			w.Write(raw)
		} else if r.URL.Path == "/chloe-assist.exe" {
			if corrupt {
				w.Write([]byte("tampered"))
			} else {
				w.Write(binary)
			}
		} else {
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	exe := filepath.Join(dir, "assist.exe")
	os.WriteFile(exe, []byte("old"), 0600)
	u := &assistUpdater{feed: assistUpdateFeed{server.URL, server.Client(), pub}, exe: exe, directory: dir, auto: true}
	if e := u.download(context.Background()); e != nil {
		t.Fatal(e)
	}
	if u.stage == "" || verifyAssistBinary(u.stage, u.release) != nil {
		t.Fatal("verified candidate not staged")
	}
	data, _ := os.ReadFile(exe)
	if string(data) != "old" {
		t.Fatal("download replaced running program")
	}
	os.Remove(u.stage)
	u.stage = ""
	corrupt = true
	if e := u.download(context.Background()); e == nil {
		t.Fatal("corrupted candidate staged")
	}
	if u.stage != "" {
		t.Fatal("failed candidate marked ready")
	}
	corrupt = false
	_, release := signedAssistFixture(t, key, binary, futureVersion)
	u.blockedHash = release.SHA256
	if e := u.download(context.Background()); e == nil {
		t.Fatal("failed release automatically retried")
	}
	u.retryFailed()
	if e := u.download(context.Background()); e != nil {
		t.Fatal("explicit retry failed", e)
	}
	u.blockedHash = release.SHA256
	if e := u.install(); e == nil || !strings.Contains(e.Error(), "上次更新失败") {
		t.Fatal("quarantined release installed")
	}
	u.feed.base = strings.Replace(server.URL, "https:", "http:", 1)
	if e := u.download(context.Background()); e == nil {
		t.Fatal("HTTP update accepted")
	}
}
func TestAssistUpdateNeverInstallsDuringConsentOrActiveSession(t *testing.T) {
	for _, state := range []string{"preview", "connecting", "connected", "paused", "disconnected"} {
		b := &assistBrowser{state: state}
		if e := b.applyUpdate(false); e == nil {
			t.Fatal("install allowed in state", state)
		}
	}
	b := &assistBrowser{state: "unpaired", lastAction: time.Now()}
	if e := b.applyUpdate(true); e == nil || !strings.Contains(e.Error(), "空闲") {
		t.Fatal("automatic update ignored idle grace")
	}
	u := &assistUpdater{directory: t.TempDir(), auto: true}
	if e := u.setAuto(false); e != nil || u.isAuto() {
		t.Fatal("automatic update toggle failed")
	}
	raw, _ := os.ReadFile(filepath.Join(u.directory, "settings.json"))
	if !strings.Contains(string(raw), "false") {
		t.Fatal("preference not saved")
	}
}

func TestAssistWindowsUpdateReplacementAndRollback(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows executable locking/replacement")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "fixture.go")
	code := `package main
import("os";"strconv";"time")
func main(){
if len(os.Args)>1&&os.Args[1]=="--hold"{time.Sleep(2*time.Second);return}
if len(os.Args)==3&&os.Args[1]=="--assist-update-ready"{
os.WriteFile(os.Args[2]+".pid",[]byte(strconv.Itoa(os.Getpid())),0600)
os.WriteFile(os.Args[2],[]byte("2026.10.16.6"),0600)
time.Sleep(20*time.Second)
}}
`
	os.WriteFile(source, []byte(code), 0600)
	built := filepath.Join(dir, "fixture.exe")
	if output, e := exec.Command("go", "build", "-o", built, source).CombinedOutput(); e != nil {
		t.Fatalf("build update fixture: %s %v", output, e)
	}
	binary, _ := os.ReadFile(built)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	for _, failure := range []bool{false, true} {
		t.Run(strconv.FormatBool(failure), func(t *testing.T) {
			folder := t.TempDir()
			target := filepath.Join(folder, "assist.exe")
			os.WriteFile(target, append(append([]byte{}, binary...), []byte("OLD-BUILD-MARKER")...), 0700)
			oldHash, _, _ := sha256File(target)
			old := exec.Command(target, "--hold")
			if e := old.Start(); e != nil {
				t.Fatal(e)
			}
			defer old.Process.Kill()
			candidate := binary
			if failure {
				candidate = []byte("signed but not an executable")
			}
			stage := filepath.Join(folder, ".chloe-assist-update-fixture.exe")
			os.WriteFile(stage, candidate, 0700)
			raw, _ := signedAssistFixture(t, key, candidate, "2026.10.16.6")
			manifest := filepath.Join(folder, "manifest.json")
			os.WriteFile(manifest, raw, 0600)
			args := []string{target, stage, manifest, strconv.Itoa(old.Process.Pid), oldHash, folder}
			err := runAssistUpdateHelperVerified(args, pub)
			old.Wait()
			if failure {
				if err == nil {
					t.Fatal("invalid executable installed")
				}
				hash, _, _ := sha256File(target)
				if hash != oldHash {
					t.Fatal("rollback did not restore old file")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				newHash, _, _ := sha256File(target)
				expectedHash := sha256.Sum256(binary)
				if newHash != hex.EncodeToString(expectedHash[:]) || newHash == oldHash {
					t.Fatal("target not replaced with new build")
				}
				backupHash, _, _ := sha256File(target + ".previous.exe")
				if backupHash != oldHash {
					t.Fatal("old backup changed")
				}
				if _, e := os.Stat(target + ".previous.exe"); e != nil {
					t.Fatal("missing previous version")
				}
				pidFiles, _ := filepath.Glob(filepath.Join(folder, "ready-*.pid"))
				if len(pidFiles) != 1 {
					t.Fatal("new process was not started")
				}
				pidRaw, _ := os.ReadFile(pidFiles[0])
				pid, _ := strconv.Atoi(string(pidRaw))
				process, _ := os.FindProcess(pid)
				process.Kill()
			}
		})
	}
}
