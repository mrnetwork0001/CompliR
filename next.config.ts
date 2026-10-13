import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** pdf-parse ships its own pdf.js build that must run unbundled (used by POST /api/v1/check/invoice). */
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
