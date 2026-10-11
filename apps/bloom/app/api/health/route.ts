export async function GET() {
  return Response.json(
    {
      appId: process.env.CUE_WIDGET_APP_ID,
      release:
        process.env.BLOOM_RELEASE ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        "local",
      captionSearch: "owned-caption-all-terms",
      maxUploadBytes: 5 * 1024 * 1024,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
