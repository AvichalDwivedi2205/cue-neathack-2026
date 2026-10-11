import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderCueLanding } from "@/lib/landing";

export async function GET() {
  const source = await readFile(
    path.join(process.cwd(), "design/cue.html"),
    "utf8",
  );
  return new Response(renderCueLanding(source), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
