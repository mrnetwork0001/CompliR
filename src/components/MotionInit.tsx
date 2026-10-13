"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Scroll-reveal bootstrap. Adds `js-motion` to <html> when motion is allowed, then an IntersectionObserver
 * marks every `.reveal` element `.in` as it enters the viewport. Under prefers-reduced-motion nothing is
 * hidden and nothing animates. Re-scans on every route change.
 */
export function MotionInit() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      root.classList.remove("js-motion");
      return;
    }
    root.classList.add("js-motion");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    const scan = () => document.querySelectorAll<HTMLElement>(".reveal:not(.in)").forEach((el) => io.observe(el));
    scan();
    // content that mounts after fetches (demo panels, tables) gets observed as it appears
    const mo = new MutationObserver(() => scan());
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [pathname]);
  return null;
}
