import { bool, type CommandSpec } from "../command.ts";
import {
  flatten,
  GATEWAY_KEYS,
  getPath,
  parseValue,
  readConfig,
  setPath,
  validateConfig,
  writeConfig,
} from "../config-file.ts";
import { CliError } from "../errors.ts";
import { table } from "../output.ts";
import { callOrUnavailable } from "./util.ts";

/**
 * `gateway.*` keys live in `$PSYCHE_HOME/config.json` and take effect on the next Gateway start;
 * every other key is a Gateway setting (`settings.get` / `settings.set`, scope rules enforced by
 * the Gateway: security keys need `operator.admin`).
 */
const isFileKey = (key: string) => key === "gateway" || key.startsWith("gateway.");

export const configCommands: CommandSpec[] = [
  {
    path: ["config", "get"],
    summary: "Show settings (Gateway) or gateway.* keys (config.json)",
    args: [{ name: "keys", description: "Keys to show (default: all)", variadic: true }],
    options: {
      file: { type: "boolean", description: "Read config.json instead of Gateway settings" },
    },
    async run(ctx, { args, opts }) {
      const fileMode = bool(opts, "file") || (args.length > 0 && args.every(isFileKey));
      if (fileMode) {
        const { config } = readConfig(ctx.home);
        const data =
          args.length === 0
            ? config
            : Object.fromEntries(args.map((k) => [k, getPath(config, k) ?? null]));
        const rows = Object.entries(args.length === 0 ? flatten(config) : data).map(
          ([key, value]) => ({
            key,
            value: JSON.stringify(value),
          }),
        );
        return {
          data: { source: "config.json", values: data },
          human: table(rows, { key: "key", value: "value" }),
        };
      }
      const res = (await callOrUnavailable(
        await ctx.gateway(),
        "settings.get",
        args.length ? { keys: args } : {},
      )) as {
        settings: Record<string, unknown>;
        stateVersion: number;
      };
      const rows = Object.entries(res.settings).map(([key, value]) => ({
        key,
        value: JSON.stringify(value),
      }));
      return {
        data: { source: "settings", ...res },
        human: table(rows, { key: "key", value: "value" }),
      };
    },
  },
  {
    path: ["config", "set"],
    summary: "Set a setting (Gateway) or a gateway.* key (config.json, restart needed)",
    description: 'VALUE is parsed as JSON when it parses (true, 30, ["a"]), else used as a string.',
    args: [
      { name: "key", description: "Dotted key", required: true },
      { name: "value", description: "Value", required: true },
    ],
    async run(ctx, { args }) {
      const key = args[0] as string;
      const value = parseValue(args[1] as string);
      if (isFileKey(key)) {
        if (!GATEWAY_KEYS[key]) {
          throw new CliError(
            "usage",
            `Unknown config key ${key}; known: ${Object.keys(GATEWAY_KEYS).join(", ")}`,
          );
        }
        const { config } = readConfig(ctx.home);
        const next = setPath(config, key, value);
        const problems = validateConfig(next);
        if (problems.length) throw new CliError("usage", `Invalid config: ${problems.join("; ")}`);
        writeConfig(ctx.home, next);
        return {
          data: { source: "config.json", key, value, restartRequired: true },
          human: `Set ${key} in config.json. Restart the Gateway (\`psyche restart\`) to apply it.`,
        };
      }
      const res = await callOrUnavailable(await ctx.gateway(), "settings.set", { key, value });
      return { data: { source: "settings", ...(res as object) }, human: `Set ${key}` };
    },
  },
];
