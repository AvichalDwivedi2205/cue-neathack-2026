import { replyFacts, type ReplyContext } from "./reply-policy";

export function supportProgress(c: ReplyContext) {
  const facts = replyFacts(c);
  const feature = facts.kind === "feature";
  const steps = feature
    ? ["Received", "Product review", "Development", "Live"]
    : ["Received", "Investigating", "Proposed fix", "Verified release"];
  let stage = 0,
    label = "Received",
    detail = "Your report is saved and awaits review.";
  if (feature) detail = "Your request is saved for product review.";
  if (["investigating", "spec_ready", "approved"].includes(facts.status)) {
    stage = 1;
    label = feature
      ? facts.status === "approved"
        ? "Specification approved"
        : "Product review"
      : "Investigating";
    detail = feature
      ? facts.status === "approved"
        ? "The specification is approved for implementation."
        : "The request is awaiting product review."
      : "An investigation has started.";
  }
  if (facts.status === "awaiting_approval" || facts.status === "implementing") {
    stage = 2;
    label = feature ? "In development" : "Awaiting approval";
    detail = feature
      ? "Implementation is in progress."
      : "A proposed fix is awaiting engineering approval.";
  }
  if (facts.fixVerified || facts.featureVerified) {
    if (facts.customerSpokeAfterVerification) {
      stage = 1;
      label = "Needs review";
      detail =
        "The earlier release passed checks. Your latest report still needs review.";
    } else {
      stage = 3;
      label = feature ? "Live" : "Fix verified";
      detail =
        "The deployed release passed our checks. Please try it in the app.";
    }
  }
  return {
    label,
    detail,
    steps: steps.map((title, i) => ({
      title,
      state: i < stage ? "complete" : i === stage ? "current" : "pending",
    })),
  };
}
