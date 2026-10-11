import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { expectedFailure } from "../scripts/expected-failure";
test("cloud rejection checks inspect structured application errors", () => {
  const error = new ConvexError("Approval must match the pending commit");
  error.message = "[Request ID: opaque] Server Error";
  expect(expectedFailure(/pending commit/)(error)).toBe(true);
  expect(expectedFailure(/pending commit/)(new Error("Server Error"))).toBe(
    false,
  );
  expect(expectedFailure(/Unauthorized/)(new ConvexError("Unauthorized"))).toBe(
    true,
  );
  expect(expectedFailure(/Unauthorized/)({ data: "Unauthorized" })).toBe(false);
});
