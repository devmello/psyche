"""A polkitd stand-in for Psyche's password-presence test (python-dbusmock template).

The stock `polkitd` template always answers `(allowed, False, {})` and has no
CancelCheckAuthorization. This one follows the parts of polkit's contract Psyche relies on:

- an action that is not registered fails with org.freedesktop.PolicyKit1.Error.Failed
  ("Action ... is not registered"), like polkitd does;
- flags 0 (no interaction): (False, True, {}) for an action that needs authentication, or
  (True, False, {}) when SetAuthorizedWithoutPrompt(True) (a "nopasswd" rule);
- flags 1 (AllowUserInteraction): behaves per SetPromptMode:
    allow      the owner typed the password (after the delay)
    dismiss    the owner closed the dialog (details polkit.dismissed)
    wrong      the password was refused after the delay
    no_agent   no authentication agent: an immediate (False, True, {})
    hang       waits until CancelCheckAuthorization, then fails with ...Error.Cancelled
- only a `unix-session` subject with a session-id is accepted.
"""

import dbus
import dbus.service
from gi.repository import GLib

from dbusmock import MOCK_IFACE

BUS_NAME = "org.freedesktop.PolicyKit1"
MAIN_OBJ = "/org/freedesktop/PolicyKit1/Authority"
MAIN_IFACE = "org.freedesktop.PolicyKit1.Authority"
SYSTEM_BUS = True


def load(mock, _parameters):
    mock.registered = {"com.psyche.presence.confirm"}
    mock.no_prompt = False
    mock.mode = "allow"
    mock.delay = 0.0
    mock.waiting = {}
    mock.calls = []


@dbus.service.method(
    MAIN_IFACE,
    in_signature="(sa{sv})sa{ss}us",
    out_signature="(bba{ss})",
    async_callbacks=("ok_cb", "err_cb"),
)
def CheckAuthorization(self, subject, action_id, details, flags, cancellation_id, ok_cb, err_cb):
    kind, subject_details = subject
    self.calls.append((str(action_id), int(flags), str(cancellation_id), str(kind), str(len(details))))
    if kind != "unix-session" or "session-id" not in subject_details:
        err_cb(dbus.exceptions.DBusException("bad subject", name="org.freedesktop.PolicyKit1.Error.Failed"))
        return
    if action_id not in self.registered:
        err_cb(
            dbus.exceptions.DBusException(
                f"Action {action_id} is not registered", name="org.freedesktop.PolicyKit1.Error.Failed"
            )
        )
        return
    if self.no_prompt:
        ok_cb((True, False, {}))
        return
    if flags == 0:
        ok_cb((False, True, {}))
        return
    mode = self.mode
    if mode == "no_agent":
        ok_cb((False, True, {}))
    elif mode == "hang":
        self.waiting[str(cancellation_id)] = err_cb
    else:
        result = {
            "allow": (True, False, {}),
            "dismiss": (False, False, {"polkit.dismissed": "true"}),
            "wrong": (False, False, {}),
        }[mode]

        def reply():
            ok_cb(result)
            return False

        GLib.timeout_add(int(self.delay * 1000), reply)


@dbus.service.method(MAIN_IFACE, in_signature="s")
def CancelCheckAuthorization(self, cancellation_id):
    cb = self.waiting.pop(str(cancellation_id), None)
    if cb is not None:
        cb(dbus.exceptions.DBusException("Cancelled", name="org.freedesktop.PolicyKit1.Error.Cancelled"))


@dbus.service.method(MOCK_IFACE, in_signature="b")
def SetRegistered(self, registered):
    self.registered = {"com.psyche.presence.confirm"} if registered else set()


@dbus.service.method(MOCK_IFACE, in_signature="b")
def SetAuthorizedWithoutPrompt(self, on):
    self.no_prompt = bool(on)


@dbus.service.method(MOCK_IFACE, in_signature="sd")
def SetPromptMode(self, mode, delay):
    self.mode = str(mode)
    self.delay = float(delay)


@dbus.service.method(MOCK_IFACE, out_signature="a(sisss)")
def GetLog(self):
    return list(self.calls)
