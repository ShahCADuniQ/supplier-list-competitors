// Microsoft Graph outbound — POST /me/sendMail. Graph accepts either a
// structured Message JSON or a raw MIME blob (Content-Type:
// text/plain). We use the structured form because it sidesteps base64
// MIME quirks and gives us a saveToSentItems flag for free.

import type { EmailAddress, SendEmailInput } from "./types";

function toRecipients(
  a: EmailAddress | EmailAddress[] | undefined,
): Array<{ emailAddress: { address: string; name?: string } }> {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).map((addr) =>
    typeof addr === "string"
      ? { emailAddress: { address: addr } }
      : { emailAddress: { address: addr.email, name: addr.name } },
  );
}

export async function sendGraphMail(args: {
  accessToken: string;
  fromAddress: string;
  input: SendEmailInput;
}): Promise<string> {
  const { accessToken, input } = args;
  const message: Record<string, unknown> = {
    subject: input.subject,
    body: {
      contentType: input.html ? "HTML" : "Text",
      content: input.html ?? input.text,
    },
    toRecipients: toRecipients(input.to),
    ccRecipients: toRecipients(input.cc),
    bccRecipients: toRecipients(input.bcc),
  };
  if (input.replyTo) {
    message.replyTo = [{ emailAddress: { address: input.replyTo } }];
  }
  if (input.attachments?.length) {
    message.attachments = await Promise.all(
      input.attachments.map(async (att) => {
        let b64 = att.content;
        let contentType = att.contentType ?? "application/octet-stream";
        if (!b64 && att.path) {
          const r = await fetch(att.path);
          if (!r.ok) {
            throw new Error(
              `Could not fetch attachment ${att.filename}: ${r.status}`,
            );
          }
          b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
          contentType =
            att.contentType ??
            r.headers.get("content-type") ??
            "application/octet-stream";
        }
        return {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: att.filename,
          contentType,
          contentBytes: b64 ?? "",
        };
      }),
    );
  }

  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (res.status !== 202) {
    const body = await res.text();
    throw new Error(`Microsoft Graph sendMail failed (${res.status}): ${body}`);
  }
  // sendMail returns 202 with no body and no message id. Synthesise one
  // so the caller (rfqEmailDrafts.providerMessageId) has something.
  return `graph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
