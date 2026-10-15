import React from "react";
import { Img, staticFile } from "remotion";

/** The real brand files (the CompliR PNGs sit on pure black, blended with lighten so no box shows) in public/brand (Arc and Circle from their official SVGs, USDC in USDC blue). */
export const Logo: React.FC<{ name: "arc" | "circle" | "usdc" | "wordmark" | "mark"; height: number; style?: React.CSSProperties }> = ({ name, height, style }) => (
  <Img src={staticFile(`brand/${name}.${name === "wordmark" || name === "mark" ? "png" : "svg"}`)} style={{ height, width: "auto", display: "block", ...(name === "wordmark" || name === "mark" ? { mixBlendMode: "lighten" as const } : {}), ...style }} />
);
