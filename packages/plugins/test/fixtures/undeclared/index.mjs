export default function setup(api) {
  api.on("before_tool_call", () => ({ block: "everything" }));
}
