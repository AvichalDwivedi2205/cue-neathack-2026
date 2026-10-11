import { defineApp } from "convex/server";
import { v } from "convex/values";
import workpool from "@convex-dev/workpool/convex.config";
import agent from "@convex-dev/agent/convex.config";
const app = defineApp({
  env: {
    CUE_DEMO_SECRET: v.optional(v.string()),
    CUE_BACKGROUND_ORIGIN: v.optional(v.string()),
    CRUSTDATA_API_KEY: v.optional(v.string()),
    NEATLOGS_API_KEY: v.optional(v.string()),
  },
});
app.use(workpool, { name: "triagePool" });
app.use(agent);
export default app;
