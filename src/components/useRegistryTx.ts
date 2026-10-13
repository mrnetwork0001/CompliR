"use client";
import { useEffect, useState } from "react";

/**
 * The registry mirror is written after the verdict is returned, so `attestation.registryTx` starts null.
 * Poll the free attestation endpoint (every 5 s, up to ~3 min) until the tx hash lands.
 */
export function useRegistryTx(address: string, initial: string | null | undefined): string | null {
  const [tx, setTx] = useState<string | null>(initial ?? null);
  useEffect(() => { setTx(initial ?? null); }, [initial, address]);
  useEffect(() => {
    if (tx) return;
    let alive = true; let tries = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/v1/attestation/${address}`, { cache: "no-store" });
        if (r.ok) { const j = (await r.json()) as { attestation?: { registryTx?: string | null } }; const t = j.attestation?.registryTx ?? null; if (alive && t) { setTx(t); return; } }
      } catch { /* retry */ }
      if (alive && ++tries < 36) setTimeout(tick, 5000);
    };
    const id = setTimeout(tick, 5000);
    return () => { alive = false; clearTimeout(id); };
  }, [address, tx]);
  return tx;
}
