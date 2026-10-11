import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval(
  "Paused-by-default Growth discovery",
  { hours: 1 },
  internal.growthExecution.schedule,
  {},
);
crons.interval("Hosted X mentions", { minutes: 1 }, internal.hosted.pollX, {});
export default crons;
