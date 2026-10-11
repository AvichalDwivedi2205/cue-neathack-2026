import { describe, expect, test } from "vitest";
import { normalizeEmail, type ReceivedEmail } from "../lib/email-intake";

const mention: ReceivedEmail = {
  id: "receipt-x",
  from: "X <notify@x.com>",
  subject: "Alice mentioned you",
  html: '<table><tr><td><p>@bloomapp my 3 MB photo upload fails</p><a href="https://twitter.com/alice/status/123456?s=20&amp;ref=email">View post</a></td></tr></table>',
};
describe("Notification email intake", () => {
  test("notification import requires opt-in", () => {
    const report = normalizeEmail(mention).reports[0];
    expect(report.channel).toBe("email");
    expect(report.customer).toBe("notify@x.com");
    expect(report.body).toContain("3 MB photo upload fails");
    expect(report.messageKey).toBeUndefined();
  });
  test("X HTML notifications retain excerpts, direct links and unverified identity", () => {
    const report = normalizeEmail(mention, true).reports[0];
    expect(report).toMatchObject({
      channel: "x",
      transport: "notification_email",
      sourceKey: "x:123456",
      sourceUrl: "https://x.com/alice/status/123456",
      customer: "@alice (unverified)",
      eventKey: "email-notification:receipt-x:x:123456",
    });
    expect(report.body).toContain("3 MB photo upload fails");
    expect(report.body).toContain("full post was not fetched");
    expect(report.body).not.toContain("<table>");
  });
  test("multi-post digests keep per-post context and repeated links appear once", () => {
    const reports = normalizeEmail(
      {
        ...mention,
        subject: "New notifications",
        html: '<ul><li>3 MB upload fails <a href="https://x.com/alice/status/123456">View</a><a href="https://twitter.com/alice/status/123456?s=email">Again</a></li><li>Please add dark mode <a href="https://x.com/bob/status/789012">View</a></li></ul>',
      },
      true,
    ).reports;
    expect(reports).toHaveLength(2);
    expect(reports[0].body).toContain("3 MB upload fails");
    expect(reports[0].body).not.toContain("dark mode");
    expect(reports[1].body).toContain("dark mode");
    expect(reports[1].body).not.toContain("3 MB upload fails");
    expect(new Set(reports.map((r) => r.eventKey)).size).toBe(2);
    expect(reports.every((r) => r.messageKey === undefined)).toBe(true);
  });
  test("Reddit comments use their permalink identity rather than the parent post", () => {
    const reports = normalizeEmail(
      {
        ...mention,
        from: "Reddit <noreply@redditmail.com>",
        subject: "u/alice mentioned you",
        html: null,
        text: "u/bloom_support photo upload fails\nhttps://old.reddit.com/r/bloom/comments/abc123/help/def456/?context=3",
      },
      true,
    ).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      channel: "reddit",
      sourceKey: "reddit:comment:def456",
      customer: "Reddit author unverified",
    });
    expect(reports[0].body).toContain("photo upload fails");
  });
  test("newsletters and account security mail are excluded from social intake", () => {
    for (const subject of [
      "Your account verification code",
      "Reset password",
      "Recommended for you",
    ])
      expect(
        normalizeEmail({ ...mention, subject }, true).reports,
      ).toHaveLength(0);
  });
  test("tracking-only notifications require manual review and are never fetched", () => {
    const result = normalizeEmail(
      {
        ...mention,
        html: '<p>Someone mentioned you <a href="https://t.co/redirect">View</a></p>',
      },
      true,
    );
    expect(result.reports).toHaveLength(0);
    expect(result.ignored).toContain("capture it manually");
  });
  test("Reddit CL0 notification links expose their encoded permalink without a network request", () => {
    const permalink =
      "https://www.reddit.com/r/u_Fuzzy-Vast4353/comments/1x2djtw/cue_bloom_support_intake_test_cuereddit1010/pf17by5/?ref=username_mention_email&target_user=Big-Simple-7204";
    const wrapper =
      "https://click.redditmail.com/CL0/" +
      permalink
        .replaceAll("/", "%2F")
        .replaceAll("?", "%3F")
        .replaceAll("&", "%26") +
      "/1/notification-receipt/signature=452";
    const result = normalizeEmail(
      {
        ...mention,
        from: "Reddit <noreply@redditmail.com>",
        subject: "u/Fuzzy-Vast4353 mentioned you in r/u_Fuzzy-Vast4353",
        html: `<table><tr><td><a href="${wrapper}">A 3 MB journal photo fails to upload.</a><a href="${wrapper.replace("/1/notification-receipt/", "/2/notification-receipt/")}">Reply</a></td></tr></table>`,
      },
      true,
    );
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      channel: "reddit",
      sourceKey: "reddit:comment:pf17by5",
      sourceUrl: permalink.split("?")[0],
      customer: "Reddit author unverified",
    });
    expect(result.reports[0].body).toContain("3 MB journal photo");
    expect(result.reports[0].body).not.toContain("target_user");
  });
  test("Reddit tracking extraction rejects unknown wrappers and unsafe embedded destinations", () => {
    const target =
      "https:%2F%2Fwww.reddit.com%2Fr%2Fbloom%2Fcomments%2Fabc123%2Fhelp%2Fdef456%2F";
    for (const url of [
      `https://click.redditmail.com.evil.example/CL0/${target}/1/receipt/signature`,
      `https://user:pass@click.redditmail.com/CL0/${target}/1/receipt/signature`,
      `https://click.redditmail.com:444/CL0/${target}/1/receipt/signature`,
      `https://click.redditmail.com/unknown/${target}/1/receipt/signature`,
      "https://click.redditmail.com/CL0/https:%2F%2Fevil.example%2F/1/receipt/signature",
      "https://click.redditmail.com/CL0/https:%2F%2Fuser:pass@www.reddit.com%2Fr%2Fbloom%2Fcomments%2Fabc123%2Fhelp%2Fdef456%2F/1/receipt/signature",
      "https://click.redditmail.com/CL0/https:%2F%2Fclick.redditmail.com%2Fopaque/1/receipt/signature",
      "https://click.redditmail.com/CL0/https:%ZZ/1/receipt/signature",
    ]) {
      expect(
        normalizeEmail(
          {
            ...mention,
            from: "Reddit <noreply@redditmail.com>",
            html: `<a href="${url}">Mention</a>`,
          },
          true,
        ).reports,
      ).toHaveLength(0);
    }
  });
  test("ordinary support emails containing social links stay email conversations", () => {
    const report = normalizeEmail(
      {
        ...mention,
        from: "Alice <alice@example.com>",
        subject: "Here is my report",
      },
      true,
    ).reports[0];
    expect(report.channel).toBe("email");
    expect(report.customer).toBe("alice@example.com");
  });
  test("host impersonation, credentials, hidden links and script content cannot become posts", () => {
    const result = normalizeEmail(
      {
        ...mention,
        html: '<script>https://x.com/alice/status/123456</script><div hidden><a href="https://x.com/alice/status/123456">Hidden</a></div><a href="https://x.com.evil.example/alice/status/123456">Bad</a><a href="https://user:pass@x.com/alice/status/123456">Bad</a>',
      },
      true,
    );
    expect(result.reports).toHaveLength(0);
  });
  test("large digests are held for review without silently dropping posts", () => {
    const result = normalizeEmail(
      {
        ...mention,
        html: null,
        text: Array.from(
          { length: 21 },
          (_, i) => `https://x.com/alice/status/${1000 + i}`,
        ).join("\n"),
      },
      true,
    );
    expect(result.reports).toHaveLength(0);
    expect(result.ignored).toContain("exceeds 20");
  });
});
