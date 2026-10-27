import { NOTIFICATION_SETTING_DEFAULTS as D } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationsPanel } from "../src/screens/settings/NotificationsSection.tsx";
import { matchSections, sectionForKey } from "../src/screens/settings/SettingsScreen.tsx";
import { settingLabel } from "../src/screens/settings/setting-labels.ts";

/** Settings → Notifications → Quiet hours (#953). */

describe("Settings → Notifications", () => {
  it("is a section that settings search and keys find", () => {
    expect(matchSections("notifications").has("notifications")).toBe(true);
    expect(sectionForKey("notifications.quietHours.start")).toBe("notifications");
    expect(settingLabel("notifications.quietHours.enabled")).toBe("Quiet hours");
  });

  it("starts off with 22:00 to 08:00 and the times set aside", () => {
    render(<NotificationsPanel values={{}} onChange={() => {}} />);
    expect(D["notifications.quietHours.enabled"]).toBe(false);
    expect(screen.getByRole("switch", { name: "Quiet hours" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    const from = screen.getByLabelText("Quiet from") as HTMLInputElement;
    const until = screen.getByLabelText("Quiet until") as HTMLInputElement;
    expect(from.value).toBe("22:00");
    expect(until.value).toBe("08:00");
    expect(from.disabled).toBe(true);
    expect(until.disabled).toBe(true);
  });

  it("writes the switch and the times to their keys", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<NotificationsPanel values={{}} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(onChange).toHaveBeenCalledWith("notifications.quietHours.enabled", true);

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
