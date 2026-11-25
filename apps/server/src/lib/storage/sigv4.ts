import { createHash, createHmac } from "node:crypto";

// AWS Signature Version 4, just enough of it for the handful of S3 REST calls
// the file storage makes. Written here rather than pulled in as a dependency:
// the signer is about a hundred lines, while the AWS SDK would add tens of
// megabytes to an install whose only other HTTP client is global fetch.

export type SigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
};

export type SigV4Request = {
  method: string;
  url: URL;
  /**
   * Every header to sign and send, beyond host and x-amz-date which this
   * signer adds. S3's own x-amz-content-sha256 belongs here, set by the
   * caller: the canonical request needs the hash either way, but sending it
   * as a header is an S3 convention rather than part of SigV4, and keeping it
   * out of the signer is what lets the signer be checked against AWS's
   * published test vectors as-is.
   */
  headers: Record<string, string>;
  /** Hex sha256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  now?: Date;
};

const UNRESERVED = /[A-Za-z0-9\-._~]/;

// RFC 3986 encoding. encodeURIComponent leaves ! ' ( ) * alone, and S3 signs
// them encoded, so a key containing one would otherwise fail the signature.
function encodeRfc3986(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

// S3 signs the object key with each segment encoded but the separators left
// as-is, and - unlike most other AWS services - does not encode it twice.
export function encodeS3Path(path: string): string {
  return `/${path.split("/").map(encodeRfc3986).join("/")}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  pairs.sort((left, right) => (left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

/** Returns the headers to send, including Authorization. */
export function signSigV4(request: SigV4Request): Record<string, string> {
  const now = request.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    "x-amz-date": amzDate
  };
  if (request.credentials.sessionToken) headers["x-amz-security-token"] = request.credentials.sessionToken;

  const canonicalHeaderEntries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  const canonicalHeaders = `${canonicalHeaderEntries.map(([name, value]) => `${name}:${value}`).join("\n")}\n`;
  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(";");

  const canonicalRequest = [
    request.method.toUpperCase(),
    // The pathname is already percent-encoded by whoever built the URL, and
    // re-encoding it here would double-encode every key with a space in it.
    request.url.pathname,
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash
  ].join("\n");

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${request.credentials.secretAccessKey}`, dateStamp), request.region), request.service),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}
