type Touch = { _id: string; status: string; publicationUrl?: string };
type Browser = {
  touchId: string;
  internal: boolean;
  returning: boolean;
  confirmedAt?: number;
  savedAt?: number;
  activatedAt?: number;
};
export function growthOutcomeSummary(touches: Touch[], browsers: Browser[]) {
  const verified = touches.filter((t) => t.status === "verified");
  const ids = new Set(verified.map((t) => t._id));
  const attributed = browsers.filter((b) => ids.has(b.touchId));
  const counts = (rows: Browser[]) =>
    `confirmed ${rows.filter((b) => b.confirmedAt !== undefined).length} · first save ${rows.filter((b) => b.savedAt !== undefined).length} · caption match ${rows.filter((b) => b.activatedAt !== undefined).length}`;
  return [
    verified.length
      ? `Verified publication: ${verified
          .map((t) => t.publicationUrl)
          .filter(Boolean)
          .join(" · ")}`
      : "Publication not verified.",
    `Controlled browsers: ${counts(attributed.filter((b) => b.internal))}.`,
    `Organic new browsers: ${counts(attributed.filter((b) => !b.internal && !b.returning))}.`,
    `Returning browsers: ${counts(attributed.filter((b) => !b.internal && b.returning))}.`,
    "Redirect previews are not confirmed visitors. Retention not measured.",
  ].join("\n");
}
