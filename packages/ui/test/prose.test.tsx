import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/blocks/Markdown.tsx";

afterEach(cleanup);

const LISTS = "- one\n  - nested\n- [x] done\n\n1. first\n2. second\n";

describe("chat prose", () => {
  it("applies the prose class and renders lists with nesting and task items", async () => {
    const { container } = render(<Markdown>{LISTS}</Markdown>);
    expect(container.querySelector(".psy-prose")).not.toBeNull();
    expect(container.querySelectorAll("ul").length).toBe(2);
    expect(container.querySelector("ul ul li")?.textContent).toBe("nested");
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelector("li.task-list-item input[type=checkbox]")).not.toBeNull();
  });

  it("keeps the prose class and structure for a half-streamed list and code block", async () => {
    const { container, rerender } = render(<Markdown streaming>{"Plan:\n\n- one\n- tw"}</Markdown>);
    const root = container.querySelector(".psy-prose");
    expect(root).not.toBeNull();
    await waitFor(() => expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(1));
    rerender(<Markdown streaming>{"Plan:\n\n- one\n- two\n\n```ts\nconst a ="}</Markdown>);
    expect(container.querySelector(".psy-prose")).toBe(root);
    await waitFor(() =>
      expect(container.querySelector("[data-streamdown=code-block]")).not.toBeNull(),
    );
    expect(container.querySelector("ul")).not.toBeNull();
  });

  it("still drops raw HTML and unsafe links", () => {
    const { container } = render(
      <Markdown>{"<script>x</script>[bad](javascript:alert(1))"}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
  });
});
