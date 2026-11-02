import { NOTIFICATION_SETTING_DEFAULTS as D } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationsPanel } from "../src/screens/settings/NotificationsSection.tsx";
import { paneForKey, searchSettings } from "../src/screens/settings/SettingsScreen.tsx";
import { settingLabel } from "../src/screens/settings/setting-labels.ts";

/** Settings → Notifications → Quiet hours (#953). */

describe("Settings → Notifications", () => {
  it("is a section that settings search and keys find", () => {
    expect(searchSettings("notifications").some((h) => h.pane === "notifications")).toBe(true);
    expect(paneForKey("notifications.quietHours.start")).toBe("notifications");
    expect(settingLabel("notifications.quietHours.enabled")).toBe("Quiet hours");
  });

  it("starts on, 22:00 to 08:00, until the owner turns it off (settings-2026 §7)", () => {
    render(<NotificationsPanel values={{}} onChange={() => {}} />);
    expect(D["notifications.quietHours.enabled"]).toBe(true);
    expect(screen.getByRole("switch", { name: "Quiet hours" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const from = screen.getByLabelText("Quiet from") as HTMLInputElement;
    const until = screen.getByLabelText("Quiet until") as HTMLInputElement;
    expect(from.value).toBe("22:00");
    expect(until.value).toBe("08:00");
    expect(from.disabled).toBe(false);
  });

  it("writes the switch and the times to their keys", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<NotificationsPanel values={{}} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(onChange).toHaveBeenCalledWith("notifications.quietHours.enabled", false);

    rerender(
      <NotificationsPanel
        values={{ "notifications.quietHours.enabled": true }}
        onChange={onChange}
      />,
    );
    const from = screen.getByLabelText("Quiet from");
    await user.clear(from);
    await user.type(from, "23:30");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith("notifications.quietHours.start", "23:30");
  });
});
