export function createMultipartPayload(
  parts: Array<
    | { name: string; value: string }
    | {
        name: string;
        fileName: string;
        contentType: string;
        value: Buffer;
      }
  >
) {
  const boundary = `test-boundary-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));

    if ("fileName" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          "utf8"
        )
      );
      chunks.push(part.value);
      chunks.push(Buffer.from("\r\n", "utf8"));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          "utf8"
        )
      );
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}
