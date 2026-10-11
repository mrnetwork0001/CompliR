import type { Tier } from "@/lib/types";

export function TierBadge({ tier, size = "md" }: { tier: Tier | "UNKNOWN" | null | undefined; size?: "sm" | "md" | "lg" }) {
  const t = tier ?? "UNKNOWN";
  const style = size === "lg" ? { fontSize: "0.95rem", padding: "4px 12px" } : size === "sm" ? { fontSize: "0.7rem", padding: "1px 7px" } : undefined;
  return (
    <span className={`badge badge${t}`} style={style} title={`Tier ${t}`}>
      {t}
    </span>
  );
}
