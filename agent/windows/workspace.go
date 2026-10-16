package main

// Remote Workspace execution uses program + argv. Legacy command policy stays
// restricted; Assist can grant commands separately with per-command local consent.
// File operations and process working directories remain scoped to the root.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxWorkspaceWrite = 512 * 1024
	maxSearchHits     = 200
	maxSearchBytes    = 256 * 1024
)

type approval struct {
	ID        string `json:"id"`
	Confirmed bool   `json:"confirmed"`
}

type workspaceArgs struct {
	TimeoutMS      int       `json:"timeout_ms,omitempty"`
	Operation      string    `json:"operation,omitempty"`
	Root           string    `json:"root,omitempty"`
	Path           string    `json:"path,omitempty"`
	Query          string    `json:"query,omitempty"`
	Content        string    `json:"content,omitempty"`
	ExpectedSHA256 string    `json:"expected_sha256,omitempty"`
	Before         string    `json:"before,omitempty"`
	After          string    `json:"after,omitempty"`
	Program        string    `json:"program,omitempty"`
	Argv           []string  `json:"argv,omitempty"`
	CWD            string    `json:"cwd,omitempty"`
	Approval       *approval `json:"approval,omitempty"`
}

type workspaceStat struct {
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

type workspaceSearchHit struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

var windowsReservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// normalizeWorkspacePath is stricter than filepath.Clean. It intentionally
// rejects Windows-only bypasses even while unit tests run on a non-Windows host.
func normalizeWorkspacePath(raw string) (string, error) {
	if raw == "" || raw == "." {
		return ".", nil
	}
	if strings.ContainsRune(raw, 0) || strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "\\") || drivePathPattern.MatchString(raw) {
		return "", errors.New("PATH_NOT_ALLOWED")
	}
	parts := strings.Split(strings.ReplaceAll(raw, "\\", "/"), "/")
	if len(parts) == 0 {
		return "", errors.New("PATH_NOT_ALLOWED")
	}
	for _, component := range parts {
		if component == "" || component == "." || component == ".." || strings.Contains(component, ":") || strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
			return "", errors.New("PATH_NOT_ALLOWED")
		}
		base := strings.TrimRight(strings.SplitN(component, ".", 2)[0], " .")
		if windowsReservedNames[strings.ToLower(base)] {
			return "", errors.New("PATH_NOT_ALLOWED")
		}
	}
	return filepath.Join(parts...), nil
}

// resolveWorkspacePath accepts a not-yet-created leaf for write operations.
// Its existing parent is canonicalised so junction/symlink escapes remain
// blocked before the write creates anything.
func resolveWorkspacePath(config agentConfig, alias, rawPath string, allowMissingLeaf bool) (string, string, error) {
	root, ok := config.roots[alias]
	if !ok || alias == "" {
		return "", "", errors.New("ROOT_NOT_CONFIGURED")
	}
	if config.fullAccess {
		candidate := rawPath
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(root, candidate)
		}
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil && allowMissingLeaf && errors.Is(err, os.ErrNotExist) {
			parent, parentErr := filepath.EvalSymlinks(filepath.Dir(candidate))
			if parentErr == nil {
				return filepath.Join(parent, filepath.Base(candidate)), candidate, nil
			}
		}
		if err != nil {
			return "", "", errors.New("PATH_NOT_FOUND")
		}
		return resolved, resolved, nil
	}
	rel, err := normalizeWorkspacePath(rawPath)
	if err != nil {
		return "", "", err
	}
	candidate := filepath.Join(root, rel)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err == nil {
		if !withinPath(root, resolved) {
			return "", "", errors.New("PATH_OUTSIDE_ROOT")
		}
		return resolved, rel, nil
	}
	if !allowMissingLeaf || !errors.Is(err, os.ErrNotExist) {
		return "", "", errors.New("PATH_NOT_FOUND")
	}
	parent := filepath.Dir(candidate)
	canonicalParent, parentErr := filepath.EvalSymlinks(parent)
	if parentErr != nil || !withinPath(root, canonicalParent) {
		return "", "", errors.New("PATH_OUTSIDE_ROOT")
	}
	return filepath.Join(canonicalParent, filepath.Base(candidate)), rel, nil
}

func workspaceOperation(p packet) string {
	if strings.HasPrefix(p.Tool, "workspace.") {
		return strings.TrimPrefix(p.Tool, "workspace.")
	}
	return ""
}

func decodeWorkspaceArgs(p packet) (workspaceArgs, error) {
	var args workspaceArgs
	if len(p.Args) == 0 || json.Unmarshal(p.Args, &args) != nil {
		return workspaceArgs{}, errors.New("COMMAND_NOT_ALLOWED")
	}
	if p.Tool == "workspace" {
		if args.Operation == "" {
			return workspaceArgs{}, errors.New("COMMAND_NOT_ALLOWED")
		}
		args.Operation = strings.TrimPrefix(args.Operation, "workspace.")
	} else {
		if args.Operation != "" && args.Operation != workspaceOperation(p) {
			return workspaceArgs{}, errors.New("COMMAND_NOT_ALLOWED")
		}
		args.Operation = workspaceOperation(p)
	}
	// The server carries the confirmation in the command envelope. Keeping it
	// outside operation arguments prevents an approval receipt from changing the
	// immutable intent that was presented to the user.
	if len(p.Approval) > 0 {
		if args.Approval != nil || json.Unmarshal(p.Approval, &args.Approval) != nil {
			return workspaceArgs{}, errors.New("COMMAND_NOT_ALLOWED")
		}
	}
	return args, nil
}

func validWorkspaceSchema(p packet, operation string) bool {
	var raw map[string]json.RawMessage
	if json.Unmarshal(p.Args, &raw) != nil || raw == nil {
		return false
	}
	required := map[string]bool{}
	allowed := map[string]bool{}
	add := func(keys ...string) {
		for _, key := range keys {
			required[key], allowed[key] = true, true
		}
	}
	switch operation {
	case "system_info":
		// no operation-specific fields
	case "list", "stat", "read", "read_image":
		add("root", "path")
	case "search":
		add("root", "path", "query")
	case "write":
		add("root", "path", "content", "expected_sha256")
	case "patch":
		add("root", "path", "expected_sha256", "before", "after")
	case "exec":
		add("root", "program", "argv")
		allowed["cwd"] = true
		allowed["approval"] = true
		allowed["timeout_ms"] = true
	case "git_status", "git_diff":
		// Status/diff deliberately operate at the session root by default.
		// A bounded relative cwd is optional for monorepos.
		add("root")
		allowed["cwd"] = true
	default:
		return false
	}
	if p.Tool == "workspace" {
		required["operation"], allowed["operation"] = true, true
	} else {
		allowed["operation"] = true
	}
	for key := range raw {
		if !allowed[key] {
			return false
		}
	}
	for key := range required {
		if _, ok := raw[key]; !ok {
			return false
		}
	}
	return true
}

func validSHA256(value string, allowEmpty bool) bool {
	if value == "" && allowEmpty {
		return true
	}
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func sha256File(path string) (string, []byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), data, nil
}

func jsonWorkspaceResult(p packet, deviceID string, value any) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1, ExecutionState: "completed"}
	data, err := json.Marshal(value)
	if err != nil || len(data) > maxOutput {
		result.Error = "OUTPUT_TOO_LARGE"
		return result
	}
	result.Stdout, result.ExitCode = string(data), 0
	return result
}

func workspaceError(p packet, deviceID, code, state string) packet {
	return packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1, Error: code, ExecutionState: state}
}

func requireApproval(args workspaceArgs) bool {
	return args.Approval != nil && args.Approval.Confirmed && len(args.Approval.ID) >= 8 && len(args.Approval.ID) <= 128
}

// commandRisk makes policy local and deterministic. It is intentionally small:
// unknown programs are denied; package/service-changing commands require an
// approval receipt generated by the server UI.
func commandRisk(program string, argv []string) string {
	name := strings.ToLower(strings.TrimSuffix(filepath.Base(program), ".exe"))
	if name == "powershell" || name == "pwsh" || name == "cmd" || name == "sh" || name == "bash" || name == "zsh" || name == "wscript" || name == "cscript" || name == "mshta" || name == "rundll32" || name == "reg" || name == "sc" || name == "net" || name == "shutdown" || name == "format" || name == "diskpart" || name == "del" || name == "erase" || name == "rm" {
		return "DENY"
	}
	allowed := map[string]bool{"git": true, "go": true, "node": true, "npm": true, "npx": true, "pnpm": true, "yarn": true, "python": true, "python3": true, "py": true, "java": true, "mvn": true, "mvnw": true, "gradle": true, "gradlew": true, "dotnet": true, "cargo": true, "rustc": true, "pytest": true}
	if !allowed[name] {
		return "DENY"
	}
	for index, arg := range argv {
		lower := strings.ToLower(arg)
		if strings.ContainsAny(arg, "\x00\r\n") {
			return "DENY"
		}
		if name == "git" && (lower == "push" || lower == "rebase" || lower == "commit" || lower == "config") {
			return "CONFIRM"
		}
		if name == "git" && (lower == "reset" || lower == "clean" || lower == "checkout" || lower == "restore") {
			return "DENY"
		}
		if (name == "node" && (lower == "-e" || lower == "--eval" || lower == "-p" || lower == "--print")) ||
			((name == "python" || name == "python3" || name == "py") && (lower == "-c" || lower == "--command")) {
			return "DENY"
		}
		if (name == "npm" || name == "pnpm" || name == "yarn") &&
			(lower == "install" || lower == "ci" || lower == "add" || lower == "remove" || lower == "uninstall" || lower == "-m") {
			return "CONFIRM"
		}
		if (name == "python" || name == "python3" || name == "py") && lower == "-m" && index+1 < len(argv) && strings.EqualFold(argv[index+1], "pip") {
			return "CONFIRM"
		}
		if strings.Contains(lower, "--force") || strings.Contains(lower, "--global") {
			return "CONFIRM"
		}
	}
	return "SAFE"
}

func validProgram(program string) bool {
	if program == "" || len(program) > 80 || strings.ContainsAny(program, "/\\:\x00 \t\r\n") {
		return false
	}
	for _, r := range program {
		if !(r == '.' || r == '-' || r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

func atomicWrite(path string, data []byte, existing os.FileInfo) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".witt-write-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	mode := os.FileMode(0o600)
	if existing != nil {
		mode = existing.Mode().Perm()
	}
	if err = tmp.Chmod(mode); err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func executeWorkspace(ctx context.Context, p packet, deviceID string, config agentConfig) packet {
	args, err := decodeWorkspaceArgs(p)
	if err != nil || !validWorkspaceSchema(p, args.Operation) {
		return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
	}
	start := time.Now()
	var result packet
	switch args.Operation {
	case "system_info":
		if args.Root != "" || args.Path != "" || args.Query != "" {
			return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
		}
		result = executeSystemInfo(ctx, p, deviceID)
		result.ExecutionState = "completed"
	case "list", "stat", "read", "read_image", "search", "write", "patch", "exec", "git_status", "git_diff":
		if args.Root == "" {
			return workspaceError(p, deviceID, "ROOT_NOT_CONFIGURED", "not_started")
		}
		result = executeWorkspaceRootOperation(ctx, p, deviceID, config, args)
	default:
		return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
	}
	if result.DurationMS == 0 {
		result.DurationMS = time.Since(start).Milliseconds()
	}
	return result
}

func executeWorkspaceRootOperation(ctx context.Context, p packet, deviceID string, config agentConfig, args workspaceArgs) packet {
	allowMissing := args.Operation == "write"
	path := args.Path
	if args.Operation == "exec" || args.Operation == "git_status" || args.Operation == "git_diff" {
		path = args.CWD
	}
	target, relative, err := resolveWorkspacePath(config, args.Root, path, allowMissing)
	if err != nil {
		return workspaceError(p, deviceID, err.Error(), "not_started")
	}
	if ctx.Err() != nil {
		return workspaceError(p, deviceID, "COMMAND_TIMEOUT", "not_started")
	}
	scopeRoot := config.roots[args.Root]
	if config.fullAccess {
		scopeRoot = ""
	}
	switch args.Operation {
	case "list":
		if args.Path == "" {
			args.Path = "."
		}
		if args.Query != "" || args.Content != "" || args.ExpectedSHA256 != "" || args.Before != "" || args.After != "" || args.Program != "" || len(args.Argv) != 0 {
			return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
		}
		return executeWorkspaceList(p, deviceID, scopeRoot, target)
	case "stat":
		return executeWorkspaceStat(p, deviceID, relative, target)
	case "read":
		return executeWorkspaceRead(p, deviceID, relative, target)
	case "read_image":
		return executeWorkspaceImage(p, deviceID, target)
	case "search":
		if args.Query == "" || len(args.Query) > 512 {
			return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
		}
		return executeWorkspaceSearch(ctx, p, deviceID, scopeRoot, target, args.Query)
	case "write":
		if config.assist != nil {
			return executeAssistEdit(ctx, p, deviceID, config, args, target)
		}
		return executeWorkspaceWrite(ctx, p, deviceID, target, args)
	case "patch":
		if config.assist != nil {
			return executeAssistEdit(ctx, p, deviceID, config, args, target)
		}
		return executeWorkspacePatch(ctx, p, deviceID, target, args)
	case "exec":
		if config.assist != nil {
			return executeAssistExec(ctx, p, deviceID, config, args, target)
		}
		return executeWorkspaceExec(ctx, p, deviceID, target, args, config.fullAccess)
	case "git_status":
		return executeWorkspaceGit(ctx, p, deviceID, target, []string{"status", "--short", "--branch"})
	case "git_diff":
		return executeWorkspaceGit(ctx, p, deviceID, target, []string{"diff", "--no-ext-diff", "--"})
	}
	return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
}

func executeWorkspaceList(p packet, deviceID, root, path string) packet {
	info, err := os.Stat(path)
	if err != nil {
		return workspaceError(p, deviceID, "PATH_NOT_FOUND", "completed")
	}
	if !info.IsDir() {
		return workspaceError(p, deviceID, "NOT_A_DIRECTORY", "completed")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return workspaceError(p, deviceID, "FILE_LIST_FAILED", "completed")
	}
	result := make([]fileMetadata, 0, minInt(len(entries), maxListEntries))
	for i, entry := range entries {
		if i >= maxListEntries {
			break
		}
		candidate := filepath.Join(path, entry.Name())
		resolved, resolveErr := filepath.EvalSymlinks(candidate)
		if resolveErr != nil || (root != "" && !withinPath(root, resolved)) {
			continue
		}
		metadata, statErr := entry.Info()
		if statErr != nil {
			continue
		}
		kind := "file"
		if metadata.IsDir() {
			kind = "directory"
		}
		rel, relErr := filepath.Rel(root, candidate)
		if root == "" {
			rel, relErr = candidate, nil
		}
		if relErr != nil {
			continue
		}
		result = append(result, fileMetadata{Name: entry.Name(), Path: filepath.ToSlash(rel), Type: kind, Size: metadata.Size(), ModTime: metadata.ModTime().UTC().Format(time.RFC3339Nano)})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return jsonWorkspaceResult(p, deviceID, result)
}

func executeWorkspaceStat(p packet, deviceID, relative, path string) packet {
	info, err := os.Stat(path)
	if err != nil {
		return workspaceError(p, deviceID, "PATH_NOT_FOUND", "completed")
	}
	kind := "file"
	if info.IsDir() {
		kind = "directory"
	}
	return jsonWorkspaceResult(p, deviceID, workspaceStat{Path: filepath.ToSlash(relative), Type: kind, Size: info.Size(), ModTime: info.ModTime().UTC().Format(time.RFC3339Nano)})
}

func executeWorkspaceRead(p packet, deviceID, relative, path string) packet {
	info, err := os.Stat(path)
	if err != nil {
		return workspaceError(p, deviceID, "PATH_NOT_FOUND", "completed")
	}
	if !info.Mode().IsRegular() {
		return workspaceError(p, deviceID, "NOT_A_FILE", "completed")
	}
	if info.Size() > maxFileRead {
		return workspaceError(p, deviceID, "FILE_TOO_LARGE", "completed")
	}
	hash, data, err := sha256File(path)
	if err != nil {
		return workspaceError(p, deviceID, "FILE_READ_FAILED", "completed")
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 || looksBinary(data) {
		return workspaceError(p, deviceID, "BINARY_FILE", "completed")
	}
	return jsonWorkspaceResult(p, deviceID, map[string]string{"path": filepath.ToSlash(relative), "content": string(data), "sha256": hash})
}

func executeWorkspaceImage(p packet, deviceID, path string) packet {
	f, err := os.Open(path)
	if err != nil {
		return workspaceError(p, deviceID, "FILE_READ_FAILED", "completed")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 20*1024*1024 {
		return workspaceError(p, deviceID, "IMAGE_TOO_LARGE", "completed")
	}
	metadata, _, err := image.DecodeConfig(f)
	if err != nil || metadata.Width <= 0 || metadata.Height <= 0 || int64(metadata.Width)*int64(metadata.Height) > 40_000_000 {
		return workspaceError(p, deviceID, "INVALID_IMAGE", "completed")
	}
	f.Seek(0, 0)
	picture, _, err := image.Decode(f)
	if err != nil {
		return workspaceError(p, deviceID, "INVALID_IMAGE", "completed")
	}
	w, h := metadata.Width, metadata.Height
	if w > 2048 || h > 2048 {
		if w >= h {
			h = max(1, h*2048/w)
			w = 2048
		} else {
			w = max(1, w*2048/h)
			h = 2048
		}
		resized := image.NewRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				resized.Set(x, y, picture.At(picture.Bounds().Min.X+x*metadata.Width/w, picture.Bounds().Min.Y+y*metadata.Height/h))
			}
		}
		picture = resized
	}
	var output bytes.Buffer
	for _, quality := range []int{90, 75, 55, 35} {
		output.Reset()
		if jpeg.Encode(&output, picture, &jpeg.Options{Quality: quality}) != nil {
			return workspaceError(p, deviceID, "INVALID_IMAGE", "completed")
		}
		if output.Len() <= maxScreenshotBytes {
			break
		}
	}
	if output.Len() > maxScreenshotBytes {
		return workspaceError(p, deviceID, "IMAGE_TOO_LARGE", "completed")
	}
	return packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 0, ExecutionState: "completed", Mime: "image/jpeg", Data: base64.StdEncoding.EncodeToString(output.Bytes())}
}

func executeWorkspaceSearch(ctx context.Context, p packet, deviceID, root, start, query string) packet {
	hits := make([]workspaceSearchHit, 0)
	bytesUsed := 0
	err := filepath.WalkDir(start, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || ctx.Err() != nil {
			return walkErr
		}
		if len(hits) >= maxSearchHits {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		resolved, resolveErr := filepath.EvalSymlinks(path)
		if resolveErr != nil || (root != "" && !withinPath(root, resolved)) {
			return nil
		}
		info, statErr := entry.Info()
		if statErr != nil || !info.Mode().IsRegular() || info.Size() > maxFileRead {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil || !utf8.Valid(data) || looksBinary(data) {
			return nil
		}
		for number, line := range strings.Split(string(data), "\n") {
			if !strings.Contains(line, query) {
				continue
			}
			rel, _ := filepath.Rel(root, path)
			if root == "" {
				rel = path
			}
			candidate := workspaceSearchHit{Path: filepath.ToSlash(rel), Line: number + 1, Text: line}
			encoded, _ := json.Marshal(candidate)
			if bytesUsed+len(encoded) > maxSearchBytes {
				return io.EOF
			}
			bytesUsed += len(encoded)
			hits = append(hits, candidate)
			if len(hits) >= maxSearchHits {
				return io.EOF
			}
		}
		return nil
	})
	if ctx.Err() != nil {
		return workspaceError(p, deviceID, "COMMAND_TIMEOUT", "completed")
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return workspaceError(p, deviceID, "SEARCH_FAILED", "completed")
	}
	return jsonWorkspaceResult(p, deviceID, hits)
}

func executeWorkspaceWrite(ctx context.Context, p packet, deviceID, path string, args workspaceArgs) packet {
	if !validSHA256(args.ExpectedSHA256, true) || len(args.Content) > maxWorkspaceWrite {
		return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
	}
	info, statErr := os.Stat(path)
	if statErr == nil {
		if !info.Mode().IsRegular() {
			return workspaceError(p, deviceID, "NOT_A_FILE", "not_started")
		}
		hash, _, err := sha256File(path)
		if err != nil {
			return workspaceError(p, deviceID, "FILE_READ_FAILED", "not_started")
		}
		if !strings.EqualFold(hash, args.ExpectedSHA256) {
			return workspaceError(p, deviceID, "HASH_MISMATCH", "not_started")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) || args.ExpectedSHA256 != "" {
		return workspaceError(p, deviceID, "HASH_MISMATCH", "not_started")
	}
	if ctx.Err() != nil {
		return workspaceError(p, deviceID, "COMMAND_TIMEOUT", "not_started")
	}
	if err := atomicWrite(path, []byte(args.Content), info); err != nil {
		if ctx.Err() != nil {
			return workspaceError(p, deviceID, "EXECUTION_STATE_UNKNOWN", "unknown")
		}
		return workspaceError(p, deviceID, "WRITE_FAILED", "completed")
	}
	if ctx.Err() != nil {
		return workspaceError(p, deviceID, "EXECUTION_STATE_UNKNOWN", "unknown")
	}
	return jsonWorkspaceResult(p, deviceID, map[string]string{"sha256": hashBytes([]byte(args.Content))})
}

func hashBytes(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func executeWorkspacePatch(ctx context.Context, p packet, deviceID, path string, args workspaceArgs) packet {
	if !validSHA256(args.ExpectedSHA256, false) || args.Before == "" || len(args.Before)+len(args.After) > maxWorkspaceWrite {
		return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return workspaceError(p, deviceID, "PATH_NOT_FOUND", "not_started")
	}
	hash, data, err := sha256File(path)
	if err != nil {
		return workspaceError(p, deviceID, "FILE_READ_FAILED", "not_started")
	}
	if !strings.EqualFold(hash, args.ExpectedSHA256) {
		return workspaceError(p, deviceID, "HASH_MISMATCH", "not_started")
	}
	text := string(data)
	if strings.Count(text, args.Before) != 1 {
		return workspaceError(p, deviceID, "PATCH_MISMATCH", "not_started")
	}
	updated := strings.Replace(text, args.Before, args.After, 1)
	if ctx.Err() != nil {
		return workspaceError(p, deviceID, "COMMAND_TIMEOUT", "not_started")
	}
	if err := atomicWrite(path, []byte(updated), info); err != nil {
		if ctx.Err() != nil {
			return workspaceError(p, deviceID, "EXECUTION_STATE_UNKNOWN", "unknown")
		}
		return workspaceError(p, deviceID, "WRITE_FAILED", "completed")
	}
	if ctx.Err() != nil {
		return workspaceError(p, deviceID, "EXECUTION_STATE_UNKNOWN", "unknown")
	}
	return jsonWorkspaceResult(p, deviceID, map[string]string{"sha256": hashBytes([]byte(updated))})
}

func executeWorkspaceExec(ctx context.Context, p packet, deviceID, cwd string, args workspaceArgs, fullAccess ...bool) packet {
	if !validProgram(args.Program) || len(args.Argv) > 64 {
		return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
	}
	for _, arg := range args.Argv {
		if len(arg) > 4096 || strings.ContainsRune(arg, 0) {
			return workspaceError(p, deviceID, "COMMAND_NOT_ALLOWED", "not_started")
		}
	}
	risk := commandRisk(args.Program, args.Argv)
	if len(fullAccess) > 0 && fullAccess[0] {
		risk = "SAFE"
	}
	if risk == "DENY" {
		return workspaceError(p, deviceID, "COMMAND_DENIED", "not_started")
	}
	if risk == "CONFIRM" && !requireApproval(args) {
		return workspaceError(p, deviceID, "APPROVAL_REQUIRED", "not_started")
	}
	return runProgram(ctx, p, deviceID, cwd, args.Program, args.Argv)
}

func executeWorkspaceGit(ctx context.Context, p packet, deviceID, cwd string, argv []string) packet {
	return runProgram(ctx, p, deviceID, cwd, "git", argv)
}

func runProgram(ctx context.Context, p packet, deviceID, cwd, program string, argv []string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1, ExecutionState: "not_started"}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		result.Error = "NOT_A_DIRECTORY"
		return result
	}
	cmd := exec.CommandContext(ctx, program, argv...)
	cmd.Dir = cwd
	cmd.WaitDelay = 2 * time.Second
	stdout, stderr := &boundedWriter{limit: maxOutput}, &boundedWriter{limit: maxOutput}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// From this point a subprocess may exist. A timeout or lost connection has
	// an indeterminate outcome even when the operating system later reaps it.
	err = cmd.Run()
	result.Stdout, result.Stderr = string(stdout.data), string(stderr.data)
	result.Truncated = stdout.truncated || stderr.truncated
	if ctx.Err() != nil {
		result.Error, result.ExecutionState = "EXECUTION_STATE_UNKNOWN", "unknown"
		return result
	}
	result.ExecutionState = "completed"
	if err == nil {
		result.ExitCode = 0
		return result
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		result.Error = "COMMAND_FAILED"
		return result
	}
	result.Error = "COMMAND_FAILED"
	return result
}
