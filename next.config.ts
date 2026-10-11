import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist", "mammoth"],
  turbopack: { root: process.cwd() },
};

export default nextConfig;
