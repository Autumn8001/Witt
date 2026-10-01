#!/usr/bin/env python3
"""Tests for scripts/deploy-live.py.

Covers:
  * the generated archive path is accepted by its own validator (the two used to
    disagree: a 32-character uuid hex against a {16} regex);
  * rejected lengths (15/17/31/33), traversal and illegal characters;
  * partial-swap failure handling a-e using a fake remote, asserting the return
    code, the real final directory state, and the report text.

Run: python scripts/test_deploy_live.py
"""

import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("deploy_live", HERE / "deploy-live.py")
deploy_live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_live)

TARGET = deploy_live.TARGET
STAMP = "20260101T000000Z"
TOKEN = "deadbeef"


class FakeRemote:
    """In-memory stand-in for SshRemote with injectable, countable failures."""

    def __init__(self, dirs=(), files=(), fail=None):
        self.dirs = set(dirs)
        self.files = set(files)
        # label -> remaining failures (>=1). A label with no entry never fails.
        self.fail = dict(fail or {})
        self.calls = []

    def _should_fail(self, label):
        self.calls.append(label)
        exact = self.fail.get(label, 0)
        generic = self.fail.get(label.split(":", 1)[0], 0)
        remaining = max(exact, generic)
        if remaining > 0:
            if exact > 0:
                self.fail[label] = exact - 1
            if generic > 0 and generic != exact:
                self.fail[label.split(":", 1)[0]] = generic - 1
            elif generic > 0:
                self.fail[label.split(":", 1)[0]] = generic - 1
            return True
        return False

    # --- SshRemote interface -------------------------------------------------
    def exists(self, flag, path):
        if flag == "-d":
            return path in self.dirs
        if flag == "-f":
            return path in self.files
        return False

    def upload(self, data, archive):
        if self._should_fail("upload"):
            raise OSError("upload failed")
        self.files.add(archive)

    def make_dir(self, path):
        if self._should_fail("make_dir"):
            return 1, "boom"
        self.dirs.add(path)
        return 0, ""

    def extract(self, archive, dest):
        if self._should_fail("extract"):
            return 1, "boom"
        self.files.add(f"{dest}/backend/server.js")
        return 0, ""

    def move(self, src, dst):
        if self._should_fail(f"move:{src}->{dst}"):
            return 1, "boom"
        if src not in self.dirs:
            return 1, "missing source"
        self.dirs.discard(src)
        self.dirs.add(dst)
        return 0, ""

    def remove_tree(self, path):
        self.dirs.discard(path)
        return 0, ""

    def remove_file(self, path):
        self.files.discard(path)
        return 0, ""

    def syntax_check(self, app_dir):
        return not self._should_fail(f"syntax:{app_dir}")

    def provision_env(self):
        if self._should_fail("provision_env"):
            return 1, "boom"
        return 0, ""


def make_deployer(remote):
    return deploy_live.Deployer(
        remote, b"payload", stamp=STAMP, token=TOKEN, log=lambda _m: None)


def existing_deployment():
    return FakeRemote(dirs={TARGET}, files={f"{TARGET}/backend/server.js"})


class ArchivePathTests(unittest.TestCase):
    def test_generated_path_is_accepted_by_its_own_validator(self):
        for _ in range(50):
            path = deploy_live.make_archive_path()
            self.assertTrue(deploy_live.ARCHIVE_RE.match(path),
                            f"generated path rejected by validator: {path}")
            self.assertEqual(deploy_live.require_safe_archive(path), path)

    def test_generated_token_length_is_stable(self):
        self.assertEqual(deploy_live.ARCHIVE_TOKEN_LEN, 32)
        path = deploy_live.make_archive_path()
        token = path[len("/root/witt-upload-"):-len(".tar.gz")]
        self.assertEqual(len(token), deploy_live.ARCHIVE_TOKEN_LEN)
        self.assertTrue(all(char in "0123456789abcdef" for char in token))

    def test_wrong_token_lengths_are_rejected(self):
        for length in (15, 17, 31, 33):
            with self.subTest(length=length):
                path = deploy_live.make_archive_path("a" * length)
                self.assertFalse(deploy_live.ARCHIVE_RE.match(path))
                with self.assertRaises(SystemExit):
                    deploy_live.require_safe_archive(path)

    def test_correct_length_is_the_only_accepted_length(self):
        accepted = deploy_live.make_archive_path("a" * deploy_live.ARCHIVE_TOKEN_LEN)
        self.assertEqual(deploy_live.require_safe_archive(accepted), accepted)

    def test_traversal_and_illegal_characters_are_rejected(self):
        bad_tokens = [
            "../../etc/passwd",
            "..",
            "a" * 31 + "/",
            "g" * 32,              # non-hex
            "A" * 32,              # uppercase
            "a" * 31 + "-",
            "a" * 30 + " z",
            "",
        ]
        for token in bad_tokens:
            with self.subTest(token=token):
                path = deploy_live.make_archive_path(token)
                with self.assertRaises(SystemExit):
                    deploy_live.require_safe_archive(path)

    def test_other_paths_are_rejected(self):
        for path in ["/etc/passwd", "/root/witt-upload-x.tar.gz",
                     "/root/witt-app", "", None, 123]:
            with self.subTest(path=path):
                with self.assertRaises(SystemExit):
                    deploy_live.require_safe_archive(path)


class PartialSwapTests(unittest.TestCase):
    def test_baseline_success(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_OK)
        self.assertEqual(deployer.status, "deployed")
        self.assertIn(TARGET, remote.dirs)
        self.assertNotIn(deployer.staging, remote.dirs)
        # The previous release is retained for the operator.
        self.assertIn(deployer.rollback, remote.dirs)

    def test_a_moving_the_old_release_aside_fails(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        remote.fail[f"move:{TARGET}->{deployer.rollback}"] = 99
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_STAGING_FAILED)
        self.assertEqual(deployer.status, "live-untouched")
        # Live directory untouched, nothing moved aside, staging cleaned up.
        self.assertIn(TARGET, remote.dirs)
        self.assertNotIn(deployer.rollback, remote.dirs)
        self.assertNotIn(deployer.staging, remote.dirs)
        report = "\n".join(deployer.report)
        self.assertIn("live directory was never moved", report)
        self.assertNotIn("restored", report.lower().replace("nothing to restore", ""))

    def test_b_old_moved_but_publish_fails(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        remote.fail[f"move:{deployer.staging}->{TARGET}"] = 99
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_SWAP_FAILED)
        self.assertEqual(deployer.status, "restored")
        self.assertIn(TARGET, remote.dirs)
        self.assertNotIn(deployer.rollback, remote.dirs)
        report = "\n".join(deployer.report)
        self.assertIn("previous release restored and verified", report)

    def test_c_publish_succeeds_but_verification_fails(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        remote.fail[f"syntax:{TARGET}"] = 1  # only the post-swap check fails
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_SWAP_FAILED)
        self.assertEqual(deployer.status, "restored")
        self.assertIn(TARGET, remote.dirs)
        self.assertIn(deployer.failed, remote.dirs)
        report = "\n".join(deployer.report)
        self.assertIn("previous release restored and verified", report)

    def test_d_rollback_restore_fails(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        remote.fail[f"syntax:{TARGET}"] = 1
        remote.fail[f"move:{deployer.rollback}->{TARGET}"] = 99
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_SWAP_FAILED)
        self.assertEqual(deployer.status, "restore-failed")
        report = "\n".join(deployer.report)
        self.assertIn("RESTORE FAILED", report)
        self.assertNotIn("restored and verified", report)

    def test_e_first_deployment_fails_without_a_previous_release(self):
        remote = FakeRemote()  # no existing deployment
        deployer = make_deployer(remote)
        remote.fail[f"move:{deployer.staging}->{TARGET}"] = 99
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_STAGING_FAILED)
        self.assertEqual(deployer.status, "nothing-to-restore")
        self.assertNotIn(TARGET, remote.dirs)
        self.assertNotIn(deployer.rollback, remote.dirs)
        report = "\n".join(deployer.report)
        self.assertIn("nothing to restore", report)

    def test_first_deployment_succeeds(self):
        remote = FakeRemote()
        deployer = make_deployer(remote)
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_OK)
        self.assertIn(TARGET, remote.dirs)
        self.assertNotIn(deployer.rollback, remote.dirs)

    def test_swap_is_two_separately_checked_steps(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        deployer.deploy()
        moves = [call for call in remote.calls if call.startswith("move:")]
        # Old release aside, then publish: two distinct mv invocations.
        self.assertEqual(moves, [
            f"move:{TARGET}->{deployer.rollback}",
            f"move:{deployer.staging}->{TARGET}",
        ])

    def test_recovery_never_claims_restored_without_verification(self):
        remote = existing_deployment()
        deployer = make_deployer(remote)
        remote.fail[f"syntax:{TARGET}"] = 99  # every verification fails
        code = deployer.deploy()
        self.assertEqual(code, deploy_live.EXIT_SWAP_FAILED)
        self.assertEqual(deployer.status, "restore-unverified")
        report = "\n".join(deployer.report)
        self.assertIn("RESTORE FAILED verification", report)
        self.assertNotIn("restored and verified", report)


class PathWhitelistTests(unittest.TestCase):
    def test_derived_paths_are_validated(self):
        with self.assertRaises(SystemExit):
            deploy_live.require_safe("/root/elsewhere.new-x", allow_derived=True)
        with self.assertRaises(SystemExit):
            deploy_live.require_safe("/root/witt-app.new-..-deadbeef", allow_derived=True)
        ok = f"{TARGET}.new-{STAMP}-{TOKEN}"
        self.assertEqual(deploy_live.require_safe(ok, allow_derived=True), ok)

    def test_deployer_rejects_a_traversal_archive(self):
        with self.assertRaises(SystemExit):
            deploy_live.Deployer(FakeRemote(), b"", archive="/root/../../etc/passwd",
                                 stamp=STAMP, token=TOKEN, log=lambda _m: None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
