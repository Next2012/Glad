"""发布摘要门禁的负例: 变更、缺失、错来源均不能通过。"""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "release_gate", Path(__file__).with_name("release_gate.py")
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.previous)
        self.command("git", "init", "-q")
        self.command("git", "config", "user.name", "Release test")
        self.command("git", "config", "user.email", "release-test@example.invalid")
        (self.root / ".gitignore").write_text("dist/\n")
        (self.root / "source.txt").write_text("original source")
        self.commit()
        self.assets = self.root / "dist"
        self.assets.mkdir()
        (self.assets / "linux").write_bytes(b"real candidate")
        (self.assets / "windows").write_bytes(b"second platform")
        self.approved = self.assets / "approved.json"
        self.approved.write_text(
            json.dumps(gate.record("1.2.3", self.assets, ["linux", "windows"]))
        )

    def command(self, *args):
        return subprocess.check_output(args, text=True).strip()

    def commit(self):
        self.command("git", "add", ".")
        self.command("git", "commit", "-qm", "source")

    def check(self):
        gate.verify("1.2.3", self.assets, ["linux", "windows"], self.approved)

    def test_same_candidate_passes(self):
        self.check()

    def test_changed_bytes_fail(self):
        (self.assets / "windows").write_bytes(b"different official bytes")
        with self.assertRaisesRegex(ValueError, "禁止发布"):
            self.check()

    def test_missing_platform_fails(self):
        (self.assets / "windows").unlink()
        with self.assertRaisesRegex(ValueError, "缺少必交付"):
            self.check()

    def test_removed_platform_from_required_list_fails(self):
        with self.assertRaisesRegex(ValueError, "禁止发布"):
            gate.verify("1.2.3", self.assets, ["linux"], self.approved)

    def test_wrong_version_fails(self):
        with self.assertRaisesRegex(ValueError, "禁止发布"):
            gate.verify("1.2.4", self.assets, ["linux", "windows"], self.approved)

    def test_wrong_source_fails(self):
        (self.root / "source.txt").write_text("new source")
        self.commit()
        with self.assertRaisesRegex(ValueError, "禁止发布"):
            self.check()

    def test_uncommitted_source_fails(self):
        (self.root / "source.txt").write_text("dirty source")
        with self.assertRaisesRegex(ValueError, "干净提交"):
            self.check()

    def test_missing_approval_fails(self):
        self.approved.unlink()
        with self.assertRaises(FileNotFoundError):
            self.check()

    def test_full_history_refused_and_source_tag_unchanged(self):
        self.command("git", "tag", "v0.1.0")
        (self.root / "source.txt").write_text("second source")
        self.commit()
        with self.assertRaisesRegex(ValueError, "fetch-depth"):
            gate.context("1.2.3")
        source = self.root
        shallow = source / "dist" / "clone"
        self.command("git", "clone", "-q", "--depth=1", source.as_uri(), str(shallow))
        os.chdir(shallow)
        gate.context("1.2.3")
        self.assertEqual(gate.git("tag", "--list"), "v1.2.3")
        self.assertEqual(
            gate.git("remote", "get-url", "--push", "origin"),
            "disabled://candidate-tags",
        )
        os.chdir(source)
        self.assertEqual(gate.git("tag", "--list"), "v0.1.0")

    def test_old_candidate_tag_on_other_source_fails(self):
        old_revision = self.command("git", "rev-parse", "HEAD")
        (self.root / "source.txt").write_text("accepted final source")
        self.commit()
        self.command("git", "tag", "v1.2.3", old_revision)
        self.approved.write_text(
            json.dumps(gate.record("1.2.3", self.assets, ["linux", "windows"]))
        )
        with self.assertRaisesRegex(ValueError, "候选旧 tag"):
            gate.check_tag("1.2.3", self.assets, ["linux", "windows"], self.approved)

    def test_final_source_tag_check_passes_without_pushing(self):
        gate.check_tag("1.2.3", self.assets, ["linux", "windows"], self.approved)
        self.command("git", "tag", "v1.2.3")
        gate.check_tag("1.2.3", self.assets, ["linux", "windows"], self.approved)

    def test_archive_ignores_clock_and_owner_metadata(self):
        source = self.assets / "Example.app"
        source.mkdir()
        executable = source / "client"
        executable.write_bytes(b"same client")
        executable.chmod(0o755)
        first, second = self.assets / "first.tar.gz", self.assets / "second.tar.gz"
        gate.archive(source, first)
        os.utime(executable, (999999999, 999999999))
        gate.archive(source, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
