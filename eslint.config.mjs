import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  globalIgnores(["convex/_generated", ".cue/**", "apps/**"]),
  {files:["lib/browser/*.js"],rules:{"@next/next/no-location-assign-relative-destination":"off"}},
]);
