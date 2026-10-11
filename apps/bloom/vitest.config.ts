import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["convex/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "edge-runtime",
  },
});
