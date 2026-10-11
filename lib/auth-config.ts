// A server-controlled runtime callback avoids baking one hosting domain into
// a portable container. Never derive the callback from incoming Host headers.
export function workosRedirectUri() {
  return (
    process.env.CUE_WORKOS_REDIRECT_URI ||
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
  );
}
