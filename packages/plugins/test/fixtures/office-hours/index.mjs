export default function setup(api) {
  api.on("context", () => [
    { title: "Office hours", text: "The owner works 09:00-17:00 Pacific." },
  ]);
  api.on("before_tool_call", (call) =>
    call.tool === "notify" ? { block: "notifications wait until office hours" } : undefined,
  );
}
