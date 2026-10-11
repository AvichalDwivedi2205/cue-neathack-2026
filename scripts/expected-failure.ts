import { ConvexError } from "convex/values";

// Production deployments mask the transport message. ConvexError.data retains
// the deliberately safe application error; infrastructure errors must still fail.
export function expectedFailure(pattern: RegExp) {
  return (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const text =
      error instanceof ConvexError && typeof error.data === "string"
        ? error.data
        : error.message;
    return pattern.test(text);
  };
}
