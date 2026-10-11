import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval(
  "Deliver private-safe growth event outbox",
  { minutes: 1 },
  internal.growthDelivery.deliver,
  {},
);
crons.interval(
  "Clean expired upload tickets and unused temporary photos",
  { hours: 1 },
  internal.uploads.cleanup,
  {},
);
export default crons;
