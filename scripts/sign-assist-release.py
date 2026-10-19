"""Sign an immutable Assist download directory. Private key stays outside Git."""
import argparse, base64, hashlib, json, pathlib, re, subprocess, tempfile

p = argparse.ArgumentParser()
p.add_argument("directory", type=pathlib.Path)
p.add_argument("--repo", type=pathlib.Path, required=True)
p.add_argument("--commit", required=True)
p.add_argument("--key", type=pathlib.Path, required=True)
args = p.parse_args()
assert re.fullmatch(r"[0-9a-f]{40}", args.commit)
source = (args.repo / "agent/windows/assist_update.go").read_text(encoding="utf-8")
version = re.search(r'var assistVersion = "([0-9.]+)"', source).group(1)
expected = re.search(r'const assistUpdateKey = "([A-Za-z0-9+/=]+)"', source).group(1)
public = subprocess.check_output(["openssl", "pkey", "-in", str(args.key), "-pubout", "-outform", "DER"])
# Ed25519 SubjectPublicKeyInfo: fixed 12-byte algorithm prefix + 32-byte key.
assert public[:12] == bytes.fromhex("302a300506032b6570032100") and len(public) == 44
assert base64.b64encode(public[-32:]).decode() == expected, "Signing key does not match the connector"
binary = (args.directory / "chloe-assist.exe").read_bytes()
metadata = {"version": version, "sourceCommit": args.commit, "sha256": hashlib.sha256(binary).hexdigest(),
            "bytes": len(binary), "signature": "NotSigned"}
payload = json.dumps({"version": version, "sha256": metadata["sha256"], "bytes": len(binary),
                      "platform": "windows-amd64"}, separators=(",", ":")).encode()
with tempfile.NamedTemporaryFile(dir=args.directory, delete=False) as f:
    f.write(payload)
    payload_file = pathlib.Path(f.name)
try:
    signature = subprocess.check_output(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(args.key), "-in", str(payload_file)])
finally:
    payload_file.unlink(missing_ok=True)
(args.directory / "update.json").write_text(json.dumps({"payload": base64.b64encode(payload).decode(),
                                                        "signature": base64.b64encode(signature).decode()}) + "\n")
(args.directory / "release.json").write_text(json.dumps(metadata) + "\n")
(args.directory / "SHA256SUMS.txt").write_text(metadata["sha256"] + "  chloe-assist.exe\n")
print(json.dumps({"version": version, "bytes": len(binary), "sha256": metadata["sha256"], "updateSignature": "Ed25519"}))
