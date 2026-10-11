/**
 * Canonical JSON: object keys sorted recursively, arrays in order, no whitespace, `undefined` members
 * dropped (like JSON.stringify), bigint → decimal string, non-finite numbers rejected.
 * decisionHash = keccak256(utf8(canonical(payload))).
 */
import { keccak256, stringToHex, type Hex } from "viem";

export function canonicalize(value: unknown): string {
  const out = build(value);
  if (out === undefined) throw new Error("canonicalize: top-level value is not JSON-serialisable");
  return out;
}

function build(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => build(v) ?? "null").join(",") + "]";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const obj = value as Record<string, unknown>;
  if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
    return build((obj as { toJSON: () => unknown }).toJSON());
  }
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = build(obj[k]);
    if (v !== undefined) parts.push(JSON.stringify(k) + ":" + v);
  }
  return "{" + parts.join(",") + "}";
}

/** keccak256 over the UTF-8 bytes of the canonical JSON. */
export function hashCanonical(canonical: string): Hex {
  return keccak256(stringToHex(canonical));
}

export function decisionHash(payload: unknown): Hex {
  return hashCanonical(canonicalize(payload));
}
