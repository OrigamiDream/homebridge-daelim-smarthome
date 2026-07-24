import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import path from "node:path";

export default function createNextConfig(phase: string): NextConfig {
  return {
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    experimental: {
      externalDir: true,
      webpackBuildWorker: false,
    },
    serverExternalPackages: [
      "@eneris/push-receiver",
      "canvas",
      "ffmpeg-for-homebridge",
      "homebridge",
      "node-fetch",
      "ws",
    ],
    outputFileTracingRoot: path.join(__dirname, ".."),
  };
}
