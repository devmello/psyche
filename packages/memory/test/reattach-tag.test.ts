import { describe, expect, it } from "vitest";
import { reattachTag } from "../src/learned.ts";

describe("reattachTag", () => {
  it("keeps a one-line match's tag on the edited line", () => {
    expect(reattachTag("- Likes tea <!--lf_abc123 lesson:ls_abc-->", "- Likes tea a lot")).toBe(
      "- Likes tea a lot <!--lf_abc123 lesson:ls_abc-->",
    );
  });

  it("drops the tag rather than move it onto another line of a multi-line edit", () => {
    expect(
      reattachTag(
        "- Likes tea <!--lf_abc123 lesson:ls_abc-->\n- Owner line",
        "- Likes tea\n- Owner line edited",
      ),
    ).toBe("- Likes tea\n- Owner line edited");
  });
});
