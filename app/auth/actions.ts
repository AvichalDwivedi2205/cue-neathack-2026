"use server";
import { signOut } from "@workos-inc/authkit-nextjs";
import { workosRedirectUri } from "@/lib/auth-config";
export async function signOutAction() {
  const redirectUri = workosRedirectUri();
  if (!redirectUri) throw new Error("WorkOS redirect URI is not configured");
  await signOut({ returnTo: new URL("/", redirectUri).toString() });
}
