import type { BrowserTab } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { OpenTabs } from "../src/agent/timeline/OpenTabs.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, runTraceWorld } from "../src/fixtures/index.ts";

/** Every link in the Open tabs list goes through SafeLink, never a raw anchor. */
const safeLinkHrefs = vi.hoisted(() => [] as string[]);
vi.mock("../src/links/SafeLink.tsx", () => ({
  SafeLink: ({
    href,
    children,
    className,
  }: {
    href: string;
    children?: ReactNode;
    className?: string;
  }) => {
    safeLinkHrefs.push(href);
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
}));

const TASK = "task-open-tabs";

function tab(id: string, over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    tabId: id,
    url: `https://docs.example.org/${id}`,
    title: `Page ${id}`,
    profile: "logged-in",
    controller: "agent",
    taskId: TASK,
    driver: "cdp",
    ...over,
  } as BrowserTab;
}

function setup(tabs: BrowserTab[]) {
  const world = { ...runTraceWorld(), browserTabs: tabs };
  const gateway = new MockGateway(world as never, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, wrapper };
}

describe("Open tabs in the run Timeline", () => {
  it("lists each tab of the task with its title and host, linked through SafeLink", async () => {
    safeLinkHrefs.length = 0;
    const { wrapper } = setup([tab("a"), tab("b", { title: "" })]);
    render(<OpenTabs taskId={TASK} refreshKey="running|3|" />, { wrapper });

    const section = await screen.findByTestId("timeline-open-tabs");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Page a")).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText("docs.example.org")).toBeTruthy();
    // A tab without a title shows its host as the link text (and beside it).
    expect(within(items[1] as HTMLElement).getAllByText("docs.example.org")).toHaveLength(2);
    expect(new Set(safeLinkHrefs)).toEqual(
      new Set(["https://docs.example.org/a", "https://docs.example.org/b"]),
    );
  });

  it("renders nothing while the task has no tabs", async () => {
    const { wrapper } = setup([]);
    const { container } = render(<OpenTabs taskId={TASK} refreshKey="running|1|" />, { wrapper });
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("renders nothing for a run with no task, even when the browser has tabs", async () => {
    const { wrapper } = setup([tab("a")]);
    const { container } = render(<OpenTabs taskId={null} refreshKey="running|1|" />, { wrapper });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("timeline-open-tabs")).toBeNull();
  });

  it("reloads the tabs when the run moves on, and not on an unchanged render", async () => {
    const { gateway, wrapper } = setup([tab("a")]);
    const request = vi.spyOn(gateway, "request");
    const tabsCalls = () => request.mock.calls.filter((c) => c[0] === "browser.tabs").length;
    const { rerender } = render(<OpenTabs taskId={TASK} refreshKey="running|1|" />, { wrapper });
    await screen.findByText("Page a");
    const afterMount = tabsCalls();

    rerender(<OpenTabs taskId={TASK} refreshKey="running|1|" />);
    expect(tabsCalls()).toBe(afterMount);

    rerender(<OpenTabs taskId={TASK} refreshKey="running|2|" />);
    await waitFor(() => expect(tabsCalls()).toBeGreaterThan(afterMount));
  });
});
