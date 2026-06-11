// Build a RFC 5322 MIME message from our SendEmailInput shape. Used by
// the Microsoft Graph (sendMail) and Gmail (users.messages.send)
// transports — both accept a raw MIME blob.

import type { EmailAddress, EmailAttachment, SendEmailInput } from "./types";

function formatAddress(addr: EmailAddress): string {
  if (typeof addr === "string") return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

function addrList(a: EmailAddress | EmailAddress[] | undefined): string {
  if (!a) return "";
  return (Array.isArray(a) ? a : [a]).map(formatAddress).join(", ");
}

function escapeHeader(value: string): string {
  // CRLF in headers is an injection vector. Strip it.
  return value.replace(/[\r\n]+/g, " ");
}

function boundary(): string {
  return "===_lb_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function fetchAttachmentBase64(att: EmailAttachment): Promise<{
  data: string;
  contentType: string;
}> {
  if (att.content) {
    return { data: att.content, contentType: att.contentType ?? "application/octet-stream" };
  }
  if (att.path) {
    const r = await fetch(att.path);
    if (!r.ok) {
      throw new Error(`Could not fetch attachment ${att.filename}: ${r.status}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      data: buf.toString("base64"),
      contentType:
        att.contentType ??
        r.headers.get("content-type") ??
        "application/octet-stream",
    };
  }
  throw new Error(`Attachment ${att.filename} has no content or path`);
}

function chunk76(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
}

export async function buildMime(args: {
  fromAddress: string;
  input: SendEmailInput;
}): Promise<string> {
  const { fromAddress, input } = args;
  const headers: string[] = [];
  headers.push(`From: ${escapeHeader(fromAddress)}`);
  headers.push(`To: ${escapeHeader(addrList(input.to))}`);
  if (input.cc) headers.push(`Cc: ${escapeHeader(addrList(input.cc))}`);
  // Bcc is intentionally NOT in headers — providers add the recipients
  // from the envelope. For Gmail/Graph the address list comes from the
  // MIME To/Cc; Bcc is handled by sending the same message to those
  // addresses without a header. We just append them to To at send time
  // via the input — but to keep semantics, providers below will read
  // input.bcc separately. (Both Graph + Gmail accept Bcc via their own
  // recipient lists alongside the MIME blob.)
  headers.push(`Subject: ${escapeHeader(input.subject)}`);
  if (input.replyTo) headers.push(`Reply-To: ${escapeHeader(input.replyTo)}`);
  headers.push(`MIME-Version: 1.0`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers.push(`${escapeHeader(k)}: ${escapeHeader(v)}`);
  }

  const hasHtml = !!input.html;
  const hasAttachments = (input.attachments?.length ?? 0) > 0;

  const textPart = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    input.text,
  ].join("\r\n");

  const htmlPart = hasHtml
    ? [
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        input.html ?? "",
      ].join("\r\n")
    : null;

  let body: string;

  if (!hasAttachments && !hasHtml) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: 7bit");
    body = input.text;
  } else if (!hasAttachments && hasHtml) {
    const alt = boundary();
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    body = [
      `--${alt}`,
      textPart,
      `--${alt}`,
      htmlPart,
      `--${alt}--`,
      "",
    ].join("\r\n");
  } else {
    // Has attachments. Wrap the body parts in mixed.
    const mixed = boundary();
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);

    const bodyChunks: string[] = [];
    if (hasHtml) {
      const alt = boundary();
      bodyChunks.push(`--${mixed}`);
      bodyChunks.push(
        `Content-Type: multipart/alternative; boundary="${alt}"`,
      );
      bodyChunks.push("");
      bodyChunks.push(`--${alt}`);
      bodyChunks.push(textPart);
      bodyChunks.push(`--${alt}`);
      bodyChunks.push(htmlPart!);
      bodyChunks.push(`--${alt}--`);
    } else {
      bodyChunks.push(`--${mixed}`);
      bodyChunks.push(textPart);
    }
    for (const att of input.attachments ?? []) {
      const { data, contentType } = await fetchAttachmentBase64(att);
      bodyChunks.push(`--${mixed}`);
      bodyChunks.push(`Content-Type: ${contentType}; name="${escapeHeader(att.filename)}"`);
      bodyChunks.push("Content-Transfer-Encoding: base64");
      bodyChunks.push(
        `Content-Disposition: attachment; filename="${escapeHeader(att.filename)}"`,
      );
      bodyChunks.push("");
      bodyChunks.push(chunk76(data));
    }
    bodyChunks.push(`--${mixed}--`);
    bodyChunks.push("");
    body = bodyChunks.join("\r\n");
  }

  return headers.join("\r\n") + "\r\n\r\n" + body;
}
