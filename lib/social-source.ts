export function socialSource(channel: "x" | "reddit", value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Use a public HTTPS post URL");
  if (channel === "x") {
    const match = url.pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)\/?$/);
    if (
      !["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(
        url.hostname,
      ) ||
      !match
    )
      throw new Error("Use a complete X post URL");
    return {
      key: "x:" + match[1],
      url: "https://x.com" + url.pathname.replace(/\/$/, ""),
    };
  }
  const match = url.pathname.match(
    /^\/(?:r\/(?:[A-Za-z0-9_]+|u_[A-Za-z0-9_-]+)|user\/[A-Za-z0-9_-]+)\/comments\/([a-z0-9]+)\/(?:[^/]+\/)?([a-z0-9]+)?\/?$/i,
  );
  if (
    ![
      "reddit.com",
      "www.reddit.com",
      "old.reddit.com",
      "new.reddit.com",
    ].includes(url.hostname) ||
    !match
  )
    throw new Error(
      "Use a Reddit post or comment permalink under /r/.../comments/... or /user/.../comments/...",
    );
  return {
    key:
      "reddit:" +
      (match[2]
        ? "comment:" + match[2].toLowerCase()
        : "post:" + match[1].toLowerCase()),
    url: "https://www.reddit.com" + url.pathname,
  };
}
