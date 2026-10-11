import { WorkOS } from "@workos-inc/node";
export async function providerToken(
  provider: string,
  userId: string,
  organizationId?: string,
) {
  if (!process.env.WORKOS_API_KEY) throw new Error("WorkOS is not configured");
  const result = await new WorkOS(
    process.env.WORKOS_API_KEY,
  ).pipes.getAccessToken({ provider, userId, organizationId });
  if (!result.active)
    throw new Error(`Connection ${result.error.replaceAll("_", " ")}`);
  if (result.accessToken.missingScopes.length)
    throw new Error(
      "Reconnect with required scopes: " +
        result.accessToken.missingScopes.join(", "),
    );
  return result.accessToken.accessToken;
}
