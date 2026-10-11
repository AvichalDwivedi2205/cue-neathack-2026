import sharp from "sharp";
import { api, db, secret } from "./server-store";
import type { Id } from "../convex/_generated/dataModel";
export async function saveAttachment(
  data: string,
  owner: string,
  caseId: Id<"cases">,
) {
  const match = data.match(
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
  );
  if (!match || data.length > 6 * 1024 * 1024)
    throw new Error("Invalid screenshot");
  const bytes = Buffer.from(match[2], "base64"),
    meta = await sharp(bytes, { limitInputPixels: 16000000 }).metadata();
  if (meta.format !== match[1])
    throw new Error("Screenshot type does not match its contents");
  const store = db(),
    auth = secret(),
    url = await store.mutation(api.bloom.uploadUrl, { secret: auth });
  const upload = await fetch(url, {
    method: "POST",
    headers: { "content-type": "image/" + match[1] },
    body: bytes,
  });
  if (!upload.ok) throw new Error("Attachment storage failed");
  const { storageId } = await upload.json();
  await store.mutation(api.bloom.attachment, {
    secret: auth,
    owner,
    caseId,
    fileId: storageId,
    name: "Customer screenshot",
  });
}
