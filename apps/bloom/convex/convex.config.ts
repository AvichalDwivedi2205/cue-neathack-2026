import { defineApp } from "convex/server";
import { v } from "convex/values";
export default defineApp({
  env: {
    BLOOM_SERVER_SECRET: v.optional(v.string()),
    BLOOM_ALLOWED_ORIGINS: v.optional(v.string()),
    BLOOM_GROWTH_EVENT_SECRET: v.optional(v.string()),
    CUE_PUBLIC_URL: v.optional(v.string()),
    CUE_WIDGET_APP_ID: v.optional(v.string()),
  },
});
