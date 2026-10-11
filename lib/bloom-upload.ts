// The hosted contract mirrors the reviewed and verified upload release.
export const HOSTED_UPLOAD_LIMIT = 5 * 1024 * 1024;
export const UPLOAD_IMPLEMENTATION = "d71bbd03a95a909b2b08e5da5c0182dd12ff46db";
export function hostedUploadStatus(bytes: Buffer, type: string): number {
  if (bytes.length > HOSTED_UPLOAD_LIMIT) return 413;
  const valid =
    type === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216
        : type === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  return valid ? 201 : 415;
}
export function hostedUploadHealth() {
  return {
    app: "Bloom",
    maxUploadBytes: HOSTED_UPLOAD_LIMIT,
    build: UPLOAD_IMPLEMENTATION,
    hosting: "cloud",
    release: process.env.CUE_RELEASE_COMMIT || null,
  };
}
