// Gmail outbound — POST users/me/messages/send. Gmail wants a raw MIME
// blob, base64-url encoded. We build the MIME via the shared helper so
// attachments + HTML + Reply-To all behave consistently.

import { buildMime } from "./mime";
import type { SendEmailInput } from "./types";

export async function sendGmail(args: {
  accessToken: string;
  fromAddress: string;
  input: SendEmailInput;
}): Promise<string> {
  const mime = await buildMime({
    fromAddress: args.fromAddress,
    input: args.input,
  });
  const raw = Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { id?: string };
  return data.id ?? `gmail-${Date.now().toString(36)}`;
}
