"use client";
/**
 * SignalField - interactive page background. A matrix of tiny mono ticks that:
 *  • turn slowly with a drifting field (never still),
 *  • get swept by continuous pulse bands (data on a bus),
 *  • swing toward the pointer and brighten within reach,
 *  • flash tier colours in an expanding "screening" ring on click,
 *  • speed up briefly with scroll velocity.
 * Canvas, DPR-aware, ~30 fps, paused when hidden, static under reduced motion. Colours follow the theme tokens.
 */
import { useEffect, useRef } from "react";

const CELL = 26;         // px between ticks
const TICK = 5;          // half-length of a tick
const REACH = 240;       // pointer influence radius
const RING_SPEED = 0.55; // px per ms

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const v = parseInt(n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export default function SignalField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true }); if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0, h = 0, dpr = 1, cols = 0, rows = 0;
    let colors = { base: [155, 161, 169] as [number, number, number], acc: [63, 224, 200] as [number, number, number], low: [74, 222, 128] as [number, number, number], med: [251, 191, 36] as [number, number, number], high: [248, 113, 113] as [number, number, number], dark: true };
    const readTheme = () => {
      colors = {
        base: hexToRgb(cssVar("--faint", "#60656d")), acc: hexToRgb(cssVar("--acc", "#3fe0c8")),
        low: hexToRgb(cssVar("--low", "#4ade80")), med: hexToRgb(cssVar("--medium", "#fbbf24")), high: hexToRgb(cssVar("--high", "#f87171")),
        dark: document.documentElement.getAttribute("data-theme") !== "light",
      };
    };
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 1; rows = Math.ceil(h / CELL) + 1;
    };
    readTheme(); resize();

    const pointer = { x: -9999, y: -9999, active: false };
    const rings: { x: number; y: number; t0: number }[] = [];
    let scrollBoost = 0, lastScroll = window.scrollY, lastScrollT = performance.now();
    let hidden = document.hidden;

    const onMove = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true; };
    const onLeave = () => { pointer.active = false; };
    const onClick = (e: PointerEvent) => { if (rings.length > 4) rings.shift(); rings.push({ x: e.clientX, y: e.clientY, t0: performance.now() }); };
    const onScroll = () => { const now = performance.now(); const dy = Math.abs(window.scrollY - lastScroll); const dt = Math.max(16, now - lastScrollT); scrollBoost = Math.min(3, scrollBoost + (dy / dt) * 0.6); lastScroll = window.scrollY; lastScrollT = now; };
    const onVis = () => { hidden = document.hidden; };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerdown", onClick, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    const mo = new MutationObserver(readTheme); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // deterministic per-cell tier for click flashes (mostly LOW, some MEDIUM, few HIGH)
    const tierOf = (i: number, j: number) => { const v = ((i * 73856093) ^ (j * 19349663)) >>> 0; const r = (v % 1000) / 1000; return r < 0.06 ? colors.high : r < 0.22 ? colors.med : colors.low; };

    let raf = 0, last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (hidden) return;
      if (now - last < 33 && !reduced) return; last = now;
      const t = reduced ? 0 : now / 1000;
      scrollBoost *= 0.92;
      ctx.clearRect(0, 0, w, h);
      const baseAlpha = colors.dark ? 0.15 : 0.2;
      ctx.lineWidth = 1; ctx.lineCap = "butt";
      const sy = window.scrollY * 0.15; // slight parallax so the field moves with the page

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = i * CELL + ((j % 2) * CELL) / 2;
          const y = j * CELL - (sy % CELL);
          // drifting field angle
          let ang = Math.sin(x * 0.011 + t * 0.35) * 0.9 + Math.cos(y * 0.013 - t * 0.27) * 0.9 + Math.sin((x + y) * 0.004 + t * 0.12) * 0.6;
          // pulse bands sweeping diagonally (two bands, offset phases)
          const band = (x + y * 0.6 + t * (160 + scrollBoost * 120)) % 900;
          const pulse = Math.max(0, 1 - Math.abs(band - 120) / 90) + 0.6 * Math.max(0, 1 - Math.abs(band - 620) / 60);
          let alpha = baseAlpha + pulse * 0.38;
          let rgb: [number, number, number] = colors.base;
          let len = TICK;
          // pointer influence
          if (pointer.active) {
            const dx = pointer.x - x, dy = pointer.y - y; const d = Math.hypot(dx, dy);
            if (d < REACH) {
              const k = 1 - d / REACH;
              ang = ang * (1 - k) + Math.atan2(dy, dx) * k;
              alpha += k * 0.55; len = TICK + k * 3;
              if (k > 0.35) rgb = colors.acc;
            }
          }
          // screening rings
          for (const r of rings) {
            const age = now - r.t0; const R = age * RING_SPEED; const d = Math.hypot(x - r.x, y - r.y);
            const dd = Math.abs(d - R);
            if (dd < 28) { const k = 1 - dd / 28; rgb = tierOf(i, j); alpha = Math.max(alpha, 0.35 + 0.65 * k); len = TICK + k * 4; }
          }
          if (pulse > 0.25 && rgb === colors.base) rgb = colors.acc;
          ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, alpha)})`;
          const cx = Math.cos(ang) * len, cy = Math.sin(ang) * len;
          ctx.beginPath(); ctx.moveTo(x - cx, y - cy); ctx.lineTo(x + cx, y + cy); ctx.stroke();
        }
      }
      // expire rings
      for (let k = rings.length - 1; k >= 0; k--) if ((now - rings[k].t0) * RING_SPEED > Math.hypot(w, h)) rings.splice(k, 1);
      if (reduced) cancelAnimationFrame(raf);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf); mo.disconnect();
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerdown", onClick); window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", resize); document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none" }} />;
}
