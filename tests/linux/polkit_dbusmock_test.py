#!/usr/bin/env python3
"""Psyche password presence against python-dbusmock's logind and a polkitd stand-in.

Runs the REAL system-bus client (apps/gateway/src/compose/password-presence.ts, through
apps/gateway/test/linux/polkit-driver.ts) on a private system bus, so the logind and polkit wire
shapes, the two-step check, the cancellation id and the error mapping are exercised end to end.

    python3 tests/linux/polkit_dbusmock_test.py     (needs python3-dbusmock, dbus-daemon, pnpm)
    scripts/ci/linux-polkit-dbusmock.sh             (what CI runs)
"""

import json
import os
import pathlib
import subprocess
import unittest

import dbus
import dbusmock

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TEMPLATE = str(HERE / "polkitd_psyche.py")
DRIVER = "test/linux/polkit-driver.ts"
LOGIN = "org.freedesktop.login1"


class PasswordPresence(dbusmock.DBusTestCase):
    @classmethod
    def setUpClass(cls):
        cls.start_system_bus()
        cls.bus = cls.get_dbus(True)

    def setUp(self):
        self.logind_proc = None
        self.start_logind()
        self.polkit_proc, self.polkit = self.spawn_server_template(TEMPLATE, {}, stdout=subprocess.PIPE)
        self.addCleanup(self.stop)
        self.session("c2", "wayland")

    def start_logind(self):
        self.logind_proc, self.logind = self.spawn_server_template("logind", {}, stdout=subprocess.PIPE)

    def stop(self):
        for p in (self.logind_proc, self.polkit_proc):
            p.terminate()
            p.wait()

    def restart_logind(self):
        self.logind_proc.terminate()
        self.logind_proc.wait()
        self.start_logind()

    def session(self, sid, typ, active=True, uid=None):
        owner = os.getuid() if uid is None else uid
        self.logind.AddSession(sid, "seat0", owner, "owner", active, dbus_interface=dbusmock.MOCK_IFACE)
        obj = self.bus.get_object(LOGIN, f"/org/freedesktop/login1/session/{sid}")
        obj.UpdateProperties("org.freedesktop.login1.Session", {"Type": typ}, dbus_interface=dbusmock.MOCK_IFACE)

    def run_driver(self, command, check=True):
        # DBUS_SYSTEM_BUS_ADDRESS (the private test bus) is set by start_system_bus(); only the
        # driver reads it, and hands it to the test-only presenceBusAt.
        out = subprocess.run(
            ["pnpm", "--filter", "@psyche/gateway", "exec", "tsx", DRIVER, command],
            cwd=ROOT,
            env=dict(os.environ),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if not check:
            return out
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def mock(self, method, *args):
        return getattr(dbus.Interface(self.polkit, dbusmock.MOCK_IFACE), method)(*args)

    def log(self):
        return [tuple(str(x) for x in row) for row in self.mock("GetLog")]

    # -- the two-step check ----------------------------------------------------------------

    def test_approve(self):
        self.mock("SetPromptMode", "allow", 2.5)
        r = self.run_driver("prompt")
        self.assertEqual(r["pre"]["state"], "ready")
        self.assertEqual(r["pre"]["sessionId"], "c2")
        self.assertTrue(r["result"]["isAuthorized"])
        log = self.log()
        self.assertEqual([(f, c) for _a, f, c, _k, _n in log], [("0", ""), ("1", "psyche-test")])
        # a unix-session subject and EMPTY details, every time
        self.assertTrue(all(k == "unix-session" and n == "0" for _a, _f, _c, k, n in log))
        self.assertTrue(all(a == "com.psyche.presence.confirm" for a, *_ in log))

    def test_deny_dismissed(self):
        self.mock("SetPromptMode", "dismiss", 0.1)
        r = self.run_driver("prompt")
        self.assertFalse(r["result"]["isAuthorized"])
        self.assertIn("polkit.dismissed", r["result"]["details"])

    def test_wrong_password_is_a_slow_refusal(self):
        self.mock("SetPromptMode", "wrong", 2.5)
        r = self.run_driver("prompt")
        self.assertFalse(r["result"]["isAuthorized"])
        self.assertNotIn("polkit.dismissed", r["result"]["details"])
        self.assertGreaterEqual(r["elapsedMs"], 2000)

    def test_no_agent_is_an_instant_refusal(self):
        self.mock("SetPromptMode", "no_agent", 0)
        r = self.run_driver("prompt")
        self.assertFalse(r["result"]["isAuthorized"])
        self.assertNotIn("polkit.dismissed", r["result"]["details"])
        self.assertLess(r["elapsedMs"], 2000)

    def test_cancel(self):
        self.mock("SetPromptMode", "hang", 0)
        r = self.run_driver("cancel")
        self.assertEqual(r["error"], "org.freedesktop.PolicyKit1.Error.Cancelled")
        self.assertEqual([c for _a, f, c, _k, _n in self.log() if f == "1"], ["psyche-test"])

    def test_already_authorized_never_reaches_the_dialog(self):
        self.mock("SetAuthorizedWithoutPrompt", True)
        r = self.run_driver("prompt")
        self.assertEqual(r["pre"]["state"], "not_enforced")
        self.assertNotIn("result", r)
        self.assertEqual([f for _a, f, _c, _k, _n in self.log()], ["0"])

    def test_policy_missing(self):
        self.mock("SetRegistered", False)
        r = self.run_driver("prompt")
        self.assertEqual(r["pre"]["state"], "policy_missing")
        self.assertNotIn("result", r)

    # -- logind ------------------------------------------------------------------------------

    def test_no_session(self):
        self.restart_logind()
        r = self.run_driver("prompt")
        self.assertEqual(r["pre"]["state"], "no_session")
        self.assertEqual(self.log(), [])

    def test_only_an_active_local_graphical_session_of_this_user_counts(self):
        self.restart_logind()
        self.session("t1", "tty")
        self.session("w2", "wayland", active=False)
        self.session("o3", "wayland", uid=os.getuid() + 1)
        r = self.run_driver("preflight")
        self.assertEqual(r["pre"]["state"], "no_session")
        self.assertEqual(self.log(), [])
        self.session("x4", "x11")
        r = self.run_driver("preflight")
        self.assertEqual((r["pre"]["state"], r["pre"]["sessionType"]), ("ready", "x11"))

    def test_a_locked_session_does_not_count(self):
        self.restart_logind()
        self.session("c9", "wayland")
        obj = self.bus.get_object(LOGIN, "/org/freedesktop/login1/session/c9")
        obj.UpdateProperties(
            "org.freedesktop.login1.Session", {"LockedHint": True}, dbus_interface=dbusmock.MOCK_IFACE
        )
        r = self.run_driver("preflight")
        self.assertEqual(r["pre"]["state"], "no_session")
        self.assertEqual(self.log(), [])

    def test_the_bus_address_from_the_environment_is_ignored_in_production(self):
        # The production factory uses the fixed system socket and reads no environment, so the
        # private test bus named by DBUS_SYSTEM_BUS_ADDRESS (and its mock session c2) is never seen.
        out = self.run_driver("preflight-production", check=False)
        self.assertEqual(self.log(), [])
        self.assertNotIn('"sessionId":"c2"', out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
