/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as background from "../background.js";
import type * as bloom from "../bloom.js";
import type * as crons from "../crons.js";
import type * as cue from "../cue.js";
import type * as deliveries from "../deliveries.js";
import type * as growth from "../growth.js";
import type * as growthAttribution from "../growthAttribution.js";
import type * as growthExecution from "../growthExecution.js";
import type * as growthPolicy from "../growthPolicy.js";
import type * as growthSchema from "../growthSchema.js";
import type * as growthTasks from "../growthTasks.js";
import type * as hosted from "../hosted.js";
import type * as intake from "../intake.js";
import type * as jobs from "../jobs.js";
import type * as prospectResearch from "../prospectResearch.js";
import type * as prospectSchema from "../prospectSchema.js";
import type * as prospects from "../prospects.js";
import type * as releases from "../releases.js";
import type * as serverState from "../serverState.js";
import type * as triageQueue from "../triageQueue.js";
import type * as voice from "../voice.js";
import type * as workspace from "../workspace.js";
import type * as workspaceAnswers from "../workspaceAnswers.js";
import type * as workspaceValidators from "../workspaceValidators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  background: typeof background;
  bloom: typeof bloom;
  crons: typeof crons;
  cue: typeof cue;
  deliveries: typeof deliveries;
  growth: typeof growth;
  growthAttribution: typeof growthAttribution;
  growthExecution: typeof growthExecution;
  growthPolicy: typeof growthPolicy;
  growthSchema: typeof growthSchema;
  growthTasks: typeof growthTasks;
  hosted: typeof hosted;
  intake: typeof intake;
  jobs: typeof jobs;
  prospectResearch: typeof prospectResearch;
  prospectSchema: typeof prospectSchema;
  prospects: typeof prospects;
  releases: typeof releases;
  serverState: typeof serverState;
  triageQueue: typeof triageQueue;
  voice: typeof voice;
  workspace: typeof workspace;
  workspaceAnswers: typeof workspaceAnswers;
  workspaceValidators: typeof workspaceValidators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  triagePool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"triagePool">;
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
