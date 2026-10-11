import { design } from "@/lib/design";
import { operator, workosReady } from "@/lib/access";
import { workosRedirectUri } from "@/lib/auth-config";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await operator(request);
  } catch (e) {
    if (
      e instanceof Error &&
      e.message === "This account does not have operator access"
    )
      return Response.json({ error: e.message }, { status: 403 });
    if (workosReady()) {
      if (e instanceof Error && e.message === "Sign in to Cue first")
        return new Response(null, {
          status: 302,
          headers: {
            location: new URL("/auth/login", workosRedirectUri()).toString(),
            "cache-control": "no-store",
          },
        });
      console.error(
        "Cue operator authentication failed:",
        e instanceof Error ? e.message : "Unknown error",
      );
      return Response.json(
        {
          error: "Operator authentication could not be verified. Please retry.",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Operator unavailable" },
      { status: 401 },
    );
  }
  return design("cue");
}
