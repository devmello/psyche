import { PsycheError } from "@psyche/protocol";

/** Parameter checks shared by connector tools; every failure is `invalid_params`. */

export function asObject(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new PsycheError("invalid_params", "parameters must be an object");
  }
  return params as Record<string, unknown>;
}

export function strArray(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new PsycheError("invalid_params", `${name} must be a list of strings`);
  }
  return v as string[];
}

export function reqString(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "")
    throw new PsycheError("invalid_params", `${name} is required`);
  return v;
}

export function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new PsycheError("invalid_params", `${name} must be an integer ${min}..${max}`);
  }
  return v;
}

/** JSON Schema fragments for tool input schemas. */
export const schema = {
  obj: (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }),
  str: { type: "string" } as Record<string, unknown>,
  strs: { type: "array", items: { type: "string" }, maxItems: 100 } as Record<string, unknown>,
  bool: { type: "boolean" } as Record<string, unknown>,
  int: (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum }),
};
