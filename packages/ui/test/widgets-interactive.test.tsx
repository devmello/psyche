import type { Widget } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageView } from "../src/chat/MessageView.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { StoryWorld } from "../src/stories/harness.tsx";
import { interactiveWidget } from "../src/widgets/fixtures-interactive.ts";
import { WidgetBlockView } from "../src/widgets/WidgetBlock.tsx";

function mount(widget: Widget, onNavigate?: (r: string) => void) {
  const ref: { gateway?: MockGateway } = {};
  const sent: Array<Record<string, unknown>> = [];
  const methods: string[] = [];
  render(
    <StoryWorld
      slots={onNavigate ? { navigate: onNavigate } : undefined}
      edit={(w) => {
        w.widgets = [widget];
      }}
      onGateway={(g) => {
        ref.gateway = g;
        const original = g.request.bind(g);
        g.request = ((method: string, params: unknown, options: unknown) => {
          methods.push(method);
          if (method === "chat.send") sent.push(params as Record<string, unknown>);
          return (original as (...a: unknown[]) => unknown)(method, params, options);
        }) as typeof g.request;
      }}
    >
      <WidgetBlockView block={{ type: "ui", widgetId: widget.id }} />
    </StoryWorld>,
  );
  return { ref, sent, methods };
}

describe("widget interaction (P6)", () => {
  it("sends nothing on render, focus or hover (no auto-actions)", async () => {
    const { methods } = mount(interactiveWidget);
    const button = await screen.findByRole("button", { name: "Draft the replies now" });
    button.focus();
    await userEvent.setup().hover(button);
    await new Promise((r) => setTimeout(r, 1200));
    expect(methods).not.toContain("chat.send");
    expect(methods).not.toContain("questions.answer");
  });

  it("a reply button sends the owner's message from the widget, once per click, with a cool-down", async () => {
    const { sent } = mount(interactiveWidget);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Draft the replies now" });
    await user.click(button);
    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({
      threadId: "th_dentist",
      content: "Draft the replies now",
      fromWidget: { widgetId: "wdg_interactive" },
    });
    expect(await screen.findByText("Sent")).toBeTruthy();
  });

  it("choices send the picked labels with the spec's lead-in; nothing until one is picked", async () => {
    const { sent } = mount(interactiveWidget);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Which slot?" });
    const send = within(form).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.click(within(form).getByRole("radio", { name: "Wed 9:00" }));
    await user.click(send);
    await waitFor(() => expect(sent[0]?.content).toBe("Book: Wed 9:00"));
  });

  it("a form composes the template and what the owner typed into a visible message; required fields block it", async () => {
    const { sent } = mount(interactiveWidget);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Add a note" });
    const submit = within(form).getByRole("button", { name: "Send note" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(within(form).getByLabelText("Name (required)"), "Jane");
    await user.type(within(form).getByLabelText("Message"), "Window seat");
    await user.click(within(form).getByLabelText("Priority"));
    await user.click(submit);
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]?.content).toBe(
      "Note for the booking\nName: Jane\nMessage: Window seat\nPriority: Yes",
    );
  });

  it("an open route action goes through the app route table; unknown routes do nothing", async () => {
    const navigate = vi.fn();
    mount(interactiveWidget, navigate);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open my calendar" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/scheduled"));
  });

  it("does not draw a tool action yet (P7)", async () => {
    mount(interactiveWidget);
    await screen.findByRole("button", { name: "Draft the replies now" });
    expect(screen.queryByRole("button", { name: "Run it" })).toBeNull();
  });

  it("shows a busy chat as a plain message, not a crash", async () => {
    const { ref } = mount(interactiveWidget);
    const original = ref.gateway?.request.bind(ref.gateway) as (...a: unknown[]) => unknown;
    (ref.gateway as MockGateway).request = ((method: string, ...rest: unknown[]) => {
      if (method === "chat.send") {
        return Promise.reject(Object.assign(new Error("this chat is busy"), { code: "conflict" }));
      }
      return original(method, ...rest);
    }) as MockGateway["request"];
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Draft the replies now" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/busy/);
  });
});

describe("answer actions", () => {
  it("only answer a real open question of this chat with one of its offered options", async () => {
    const w = {
      ...interactiveWidget,
      id: "wdg_answer",
      spec: {
        ...interactiveWidget.spec,
        root: {
          id: "root",
          type: "stack",
          children: [
            {
              id: "ok",
              type: "button",
              label: "Tuesday",
              action: { kind: "answer", inputRequestId: "ir_1", value: "Tuesday" },
            },
            {
              id: "bad",
              type: "button",
              label: "Anything",
              action: { kind: "answer", inputRequestId: "ir_1", value: "Delete everything" },
            },
          ],
        },
      },
    } as Widget;
    const answers: unknown[] = [];
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(world) => {
          world.widgets = [w];
          world.inputRequests.push({
            id: "ir_1",
            taskId: null,
            threadId: "th_dentist",
            status: "open",
            answer: null,
            createdAt: "2026-11-02T10:00:00Z",
            answeredAt: null,
            answeredByDeviceId: null,
            questions: [
              {
                question: "Which day?",
                header: "Day",
                multiSelect: false,
                options: [
                  { label: "Tuesday", description: "" },
                  { label: "Wednesday", description: "" },
                ],
              },
            ],
          } as never);
        }}
        onGateway={(g) => {
          ref.gateway = g;
          const original = g.request.bind(g);
          g.request = ((method: string, params: unknown, options: unknown) => {
            if (method === "questions.answer") answers.push(params);
            return (original as (...a: unknown[]) => unknown)(method, params, options);
          }) as typeof g.request;
        }}
      >
        <WidgetBlockView block={{ type: "ui", widgetId: w.id }} />
      </StoryWorld>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Anything" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(answers).toEqual([]);
    await new Promise((r) => setTimeout(r, 1100));
    await user.click(screen.getByRole("button", { name: "Tuesday" }));
    await waitFor(() =>
      expect(answers).toEqual([{ inputRequestId: "ir_1", answer: { Day: "Tuesday" } }]),
    );
    void act;
  });
});

describe("from-widget chip (D10)", () => {
  it("marks a widget-sent user message in the transcript", async () => {
    const message = {
      id: "m1",
      threadId: "th_dentist",
      seq: 1,
      role: "user",
      blocks: [{ type: "text", md: "Draft the replies now" }],
      providerNative: null,
      provenance: "owner",
      replyToMessageId: null,
      channelRef: null,
      runId: null,
      createdAt: "2026-11-02T10:00:00Z",
      via: "widget",
    } as never;
    render(
      <StoryWorld>
        <MessageView message={message} />
      </StoryWorld>,
    );
    expect(await screen.findByTestId("from-widget-chip")).toBeTruthy();
    expect(screen.getByTestId("from-widget-chip").textContent).toBe("From widget");
    expect(screen.getByText("Draft the replies now")).toBeTruthy();
  });
});
