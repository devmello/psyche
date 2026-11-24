import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerWatch } from "../src/screens/computer-watch/ComputerWatch.tsx";
import {
  fakeClient,
  RUNNING,
  STOPPED,
  TINY_JPEG,
  TINY_JPEG_2,
} from "../src/screens/computer-watch/fixtures.ts";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

/** The Virtual screen watch pane: polling rules, take-over forwarding, Stop, the parked card. */

/** Steps of 10 ms, each in its own act, so effects run between timers as they do in a browser. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 10)
    await act(() => vi.advanceTimersByTimeAsync(Math.min(10, left)));
  await act(() => vi.advanceTimersByTimeAsync(0));
}
const src = (jpeg: string) => `data:image/jpeg;base64,${jpeg}`;

/** The displayed image is 640x360 at (10, 20) while the guest screen is 1280x720. */
function sizeImage(): HTMLImageElement {
  const img = screen.getByRole("img", { name: "Live view of the virtual screen" });
  img.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380 }) as DOMRect;
  return img as HTMLImageElement;
}

const takeOver = () =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ComputerWatch polling", () => {
  it("does not poll at all while hidden", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible={false} />);
    await advance(5_000);
    expect(client.calls.status).toBe(0);
    expect(client.calls.frame).toHaveLength(0);
  });

  it("starts polling when shown and stops when hidden again", async () => {
    const client = fakeClient();
    const { rerender } = render(<ComputerWatch client={client} visible />);
    await advance(600);
    expect(client.calls.frame.length).toBeGreaterThan(0);
    rerender(<ComputerWatch client={client} visible={false} />);
    await advance(0);
    const frames = client.calls.frame.length;
    const statuses = client.calls.status;
    await advance(5_000);
    expect(client.calls.frame).toHaveLength(frames);
    expect(client.calls.status).toBe(statuses);
  });

  it("asks for frames at most 4 times a second, and status about once a second", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(999);
    expect(client.calls.frame.length).toBeGreaterThanOrEqual(3);
    expect(client.calls.frame.length).toBeLessThanOrEqual(4);
    expect(client.calls.status).toBe(1);
    await advance(3_000);
    expect(client.calls.frame.length).toBeLessThanOrEqual(16);
    expect(client.calls.status).toBeLessThanOrEqual(4);
  });

  it("keeps the old image when the frame did not change, and passes the last frameSeq", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();
    expect(img.getAttribute("src")).toBe(src(TINY_JPEG));
    await advance(1_000);
    expect(img.getAttribute("src")).toBe(src(TINY_JPEG));
    expect(client.calls.frame[0]).toBeUndefined();
    expect(client.calls.frame.at(-1)).toBe(RUNNING.frameSeq);
    client.nextFrame();
    await advance(300);
    expect(screen.getByRole("img").getAttribute("src")).toBe(src(TINY_JPEG_2));
  });

  it("shows the open apps with an unsaved-changes badge", async () => {
    render(<ComputerWatch client={fakeClient()} visible />);
    await advance(10);
    expect(screen.getByText("org.gnome.TextEditor")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByText("firefox")).toBeTruthy();
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(1);
  });

  it("shows the empty state when nothing is running, and asks for no frames", async () => {
    const client = fakeClient(STOPPED);
    render(<ComputerWatch client={client} visible />);
    await advance(2_000);
    expect(screen.getByText("No virtual screen is running")).toBeTruthy();
    expect(client.calls.frame).toHaveLength(0);
    expect(screen.queryByRole("img")).toBeNull();
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ComputerWatch take over", () => {
  it("forwards clicks scaled to the frame, keys and pasted text, and pauses the agent", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();

    // Not taken over: nothing is forwarded.
    fireEvent.pointerDown(img, { clientX: 330, clientY: 200, button: 0 });
    expect(client.inputs).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("The agent is in control.");

    await takeOver();
    expect(client.calls.takenOver).toEqual([true]);
    expect(screen.getByRole("status").textContent).toBe("You are in control. The agent is paused.");
    expect(screen.getByRole("button", { name: "Take over" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.pointerDown(img, { clientX: 330, clientY: 200, button: 0 });
    fireEvent.pointerUp(img, { clientX: 330, clientY: 200, button: 0 });
    fireEvent.pointerDown(img, { clientX: 10, clientY: 20, button: 2 });
    expect(client.inputs).toEqual([
      [{ type: "down", x: 640, y: 360, button: "left" }],
      [{ type: "up", x: 640, y: 360, button: "left" }],
      [{ type: "down", x: 0, y: 0, button: "right" }],
    ]);

    client.inputs.length = 0;
    fireEvent.pointerMove(img, { clientX: 650, clientY: 380 });
    fireEvent.wheel(img, { clientX: 330, clientY: 200, deltaX: 0, deltaY: 120 });
    expect(client.inputs).toEqual([
      [{ type: "move", x: 1280, y: 720 }],
      [{ type: "scroll", x: 640, y: 360, dx: 0, dy: 120 }],
    ]);

    client.inputs.length = 0;
    const region = img.parentElement as HTMLElement;
    fireEvent.keyDown(region, { key: "a" });
    fireEvent.keyUp(region, { key: "a" });
    fireEvent.keyDown(region, { key: "Enter" });
    fireEvent.paste(region, { clipboardData: { getData: () => "hello" } });
    expect(client.inputs).toEqual([
      [{ type: "key_down", key: "a" }],
      [{ type: "key_up", key: "a" }],
      [{ type: "key_down", key: "Enter" }],
      [{ type: "text", text: "hello" }],
    ]);

    await takeOver();
    expect(client.calls.takenOver).toEqual([true, false]);
    expect(screen.getByRole("status").textContent).toBe("The agent is in control.");
    client.inputs.length = 0;
    fireEvent.pointerDown(img, { clientX: 330, clientY: 200, button: 0 });
    fireEvent.keyDown(region, { key: "a" });
    expect(client.inputs).toHaveLength(0);
  });

  it("limits move events to a steady rate", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();
    await takeOver();
    for (let i = 0; i < 5; i++) fireEvent.pointerMove(img, { clientX: 20 + i, clientY: 30 });
    expect(client.inputs).toHaveLength(1);
    await advance(60);
    fireEvent.pointerMove(img, { clientX: 100, clientY: 30 });
    expect(client.inputs).toHaveLength(2);
  });

  it("lets go of held keys and buttons when focus leaves the pane", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();
    await takeOver();
    const region = img.parentElement as HTMLElement;

    // Ctrl held, then the owner Alt-Tabs away: the pane loses focus.
    fireEvent.keyDown(region, { key: "Control" });
    client.inputs.length = 0;
    fireEvent.blur(region);
    expect(client.inputs).toEqual([[{ type: "key_up", key: "Control" }]]);

    // A mouse button held when the window loses focus.
    fireEvent.pointerDown(img, { clientX: 330, clientY: 200, button: 0 });
    client.inputs.length = 0;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(client.inputs).toEqual([[{ type: "up", x: 640, y: 360, button: "left" }]]);

    // Nothing held: nothing sent.
    client.inputs.length = 0;
    fireEvent.blur(region);
    expect(client.inputs).toEqual([]);
  });

  it("lets go of held keys before handing control back", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();
    await takeOver();
    const region = img.parentElement as HTMLElement;
    fireEvent.keyDown(region, { key: "Shift" });
    fireEvent.keyDown(region, { key: "Alt" });
    fireEvent.keyUp(region, { key: "Alt" });
    client.inputs.length = 0;
    await takeOver();
    expect(client.inputs).toEqual([[{ type: "key_up", key: "Shift" }]]);
    expect(client.calls.takenOver).toEqual([true, false]);
  });

  it("gives control back when the pane is hidden or closed", async () => {
    const client = fakeClient();
    const { rerender, unmount } = render(<ComputerWatch client={client} visible />);
    await advance(10);
    await takeOver();
    rerender(<ComputerWatch client={client} visible={false} />);
    await advance(0);
    expect(client.calls.takenOver).toEqual([true, false]);

    rerender(<ComputerWatch client={client} visible />);
    await advance(10);
    await takeOver();
    expect(client.calls.takenOver).toEqual([true, false, true]);
    unmount();
    expect(client.calls.takenOver).toEqual([true, false, true, false]);
  });
});

describe("ComputerWatch Stop and parked card", () => {
  it("Stop calls stop and shows the empty state", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    await advance(10);
    expect(client.calls.stop).toBe(1);
    expect(screen.getByText("No virtual screen is running")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows Look, Discard and Keep it open for a parked task", async () => {
    const onLook = vi.fn();
    const onDiscard = vi.fn();
    const onKeepOpen = vi.fn();
    render(
      <ComputerWatch
        client={fakeClient()}
        visible
        parked
        onLook={onLook}
        onDiscard={onDiscard}
        onKeepOpen={onKeepOpen}
      />,
    );
    await advance(10);
    expect(screen.getByText("An app has unsaved changes, so the task is paused.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Look" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it open" }));
    expect(onLook).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeepOpen).toHaveBeenCalledTimes(1);
  });

  it("shows no parked card by default", async () => {
    render(<ComputerWatch client={fakeClient()} visible />);
    await advance(10);
    expect(screen.queryByRole("button", { name: "Keep it open" })).toBeNull();
  });
});

describe("ComputerWatch failures are shown", () => {
  it("a dropped input shows an inline error instead of being swallowed", async () => {
    const client = fakeClient();
    client.input = async () => {
      throw new Error("the screen connection dropped");
    };
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();
    await takeOver();
    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 330, clientY: 200, button: 0 });
    });
    await advance(10);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "Your input didn't reach the virtual screen (the screen connection dropped).",
    );
  });

  it("a successful input shows no error (control case)", async () => {
    const client = fakeClient();
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    const img = sizeImage();
    await takeOver();
    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 330, clientY: 200, button: 0 });
    });
    expect(client.inputs).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed hand-back keeps the owner in control and offers Try again", async () => {
    const client = fakeClient();
    const real = client.setTakenOver.bind(client);
    let failNext = false;
    client.setTakenOver = async (on: boolean) => {
      if (!on && failNext) {
        failNext = false;
        throw new Error("the agent did not answer");
      }
      return real(on);
    };
    render(<ComputerWatch client={client} visible />);
    await advance(10);
    await takeOver();
    expect(screen.getByRole("status").textContent).toBe("You are in control. The agent is paused.");

    failNext = true;
    await takeOver();
    await advance(10);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't give control back to the agent");
    expect(alert.textContent).toContain("the agent did not answer");
    // Still in the "you have control" state: the agent never got it back.
    expect(screen.getByRole("status").textContent).toBe("You are in control. The agent is paused.");
    expect(screen.getByRole("button", { name: "Take over" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    // Try again hands it back for real this time.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await advance(10);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(client.calls.takenOver).toEqual([true, false]);
  });

  it("a failed hand-back when the pane is hidden shows a toast with Try again", async () => {
    const client = fakeClient();
    const real = client.setTakenOver.bind(client);
    let failNext = false;
    client.setTakenOver = async (on: boolean) => {
      if (!on && failNext) {
        failNext = false;
        throw new Error("the screen is busy");
      }
      return real(on);
    };
    const { rerender } = render(<ComputerWatch client={client} visible />);
    await advance(10);
    await takeOver();

    failNext = true;
    rerender(<ComputerWatch client={client} visible={false} />);
    await advance(10);
    expect(toastError).toHaveBeenCalledTimes(1);
    const [message, options] = toastError.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe(
      "Couldn't give control back to the agent (the screen is busy). You still have control.",
    );
    expect(options.action.label).toBe("Try again");

    // Try again from the toast: control really goes back to the agent.
    await act(async () => {
      options.action.onClick();
    });
    await advance(10);
    expect(client.calls.takenOver).toEqual([true, false]);
  });
});
