import os
import shlex
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import capcut  # noqa: E402

FAKE = Path(__file__).with_name("fake_capcut.py")


class FakeCliMixin:
    def setUp(self):
        self._saved = os.environ.get("CAPCUT_CLI")
        os.environ["CAPCUT_CLI"] = " ".join(shlex.quote(p) for p in (sys.executable, str(FAKE)))

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("CAPCUT_CLI", None)
        else:
            os.environ["CAPCUT_CLI"] = self._saved


class FlagArgs(unittest.TestCase):
    def test_kwargs_become_flags(self):
        got = capcut.flag_args({"font_size": 16, "karaoke": True, "no_probe": False, "color": None, "tag": ["a", "b"]})
        self.assertEqual(got, ["--font-size", "16", "--karaoke", "--tag", "a", "--tag", "b"])


class Run(FakeCliMixin, unittest.TestCase):
    def test_returns_parsed_json(self):
        self.assertEqual(capcut.run("info", "/p"), {"ok": True, "cmd": "info", "args": ["/p"]})

    def test_positionals_are_single_tokens_and_kwargs_are_flags(self):
        got = capcut.run("add-text", "/p", "0s", "3s", "你好 世界 \"quoted\"", font_size=16, karaoke=True)
        self.assertEqual(got["args"], ["/p", "0s", "3s", "你好 世界 \"quoted\"", "--font-size", "16", "--karaoke"])

    def test_non_zero_exit_raises_with_status_and_data(self):
        with self.assertRaises(capcut.CommandError) as cm:
            capcut.run("fail", "/p")
        self.assertEqual(cm.exception.status, 2)
        self.assertEqual(cm.exception.data["error"], "boom")
        self.assertIn("boom", str(cm.exception))

    def test_run_raw_never_raises(self):
        r = capcut.run_raw("fail", "/p")
        self.assertFalse(r.ok)
        self.assertEqual(r.error, "boom")

    def test_human_returns_text(self):
        out = capcut.run("info", "/p", human=True)
        self.assertIn("Project:", out)

    def test_version(self):
        self.assertEqual(capcut.version(), "0.0.0-fake")

    def test_doctor_returns_report_even_on_exit_1(self):
        report = capcut.doctor(drafts="/store")
        self.assertFalse(report["ok"])
        self.assertEqual(report["args"], ["--drafts", "/store"])


class Serve(FakeCliMixin, unittest.TestCase):
    def test_jobs_round_trip_and_failed_jobs_are_results(self):
        results = capcut.serve(
            [capcut.Job("info", project="/p", id="a"), {"cmd": "fail", "project": "/p", "args": ["x"]}],
            workers=2,
        )
        self.assertEqual([r["id"] for r in results], ["a", None])
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])
        self.assertEqual(results[1]["status"], 2)

    def test_job_to_dict_drops_unset_fields(self):
        self.assertEqual(capcut.Job("lint", project="/p").to_dict(), {"cmd": "lint", "project": "/p"})
        self.assertEqual(
            capcut.Job("add-text", "/p", ["0s", "2s", "hi"], id="t", retries=2, timeout=5000).to_dict(),
            {"cmd": "add-text", "project": "/p", "args": ["0s", "2s", "hi"], "id": "t", "retries": 2, "timeout": 5000},
        )


class NotInstalled(unittest.TestCase):
    def test_missing_binary_names_both_install_lines(self):
        saved = {k: os.environ.get(k) for k in ("CAPCUT_CLI", "PATH")}
        try:
            os.environ.pop("CAPCUT_CLI", None)
            os.environ["PATH"] = ""
            with self.assertRaises(capcut.CliNotFound) as cm:
                capcut.run("info", "/p")
            self.assertIn("npm install -g capcut-cli", str(cm.exception))
            self.assertIn("安装", str(cm.exception))
            self.assertIn("CAPCUT_CLI", str(cm.exception))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
