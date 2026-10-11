import { cookies } from "next/headers";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { secret } from "./server-store";
import { slackConfig } from "./integration-config";
import { memberForEmail } from "./roles";

export const workosReady = () =>
  !!(
    process.env.WORKOS_API_KEY &&
    process.env.WORKOS_CLIENT_ID &&
    process.env.WORKOS_COOKIE_PASSWORD
  );
const sign = (value: string) =>
  createHmac("sha256", secret()).update(value).digest("hex");
const local = (request: Request) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL("http://" + (request.headers.get("host") || "invalid")).hostname,
  );
export async function guest(request: Request) {
  const jar = await cookies();
  const raw = jar.get("bloom_guest")?.value;
  if (raw) {
    const [id, sig] = raw.split(".");
    if (
      id &&
      sig?.length === 64 &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(sign(id)))
    )
      return id;
  }
  const id = randomUUID();
  jar.set("bloom_guest", `${id}.${sign(id)}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: !local(request),
    path: "/",
    maxAge: 86400 * 30,
  });
  return id;
}
export async function operator(request: Request) {
  if (workosReady()) {
    const { user, organizationId } = await withAuth();
    if (!user) throw new Error("Sign in to Cue first");
    const member = memberForEmail(
      user.email,
      user.emailVerified,
      process.env.CUE_OPERATOR_EMAIL,
      (await slackConfig())?.members,
    );
    return {
      id: user.id,
      role: member.role,
      name:
        ("name" in member ? member.name : undefined) ||
        `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
        user.email,
      email: user.email,
      organizationId,
    };
  }
  if (!local(request) || process.env.CUE_LOCAL_DEMO !== "true")
    throw new Error("Configure WorkOS before exposing the operator workspace");
  return {
    id: "local-operator",
    role: "owner" as const,
    name: "Avi Dwivedi",
    email: "local operator",
    organizationId: undefined,
  };
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin"),
    host = request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host)
    throw new Error("Request origin rejected");
}
