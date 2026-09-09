/**
 * Object storage for proof-of-delivery evidence.
 *
 * Neon's S3-compatible branchable storage, chosen over a platform-proprietary blob API
 * for two reasons that outlast convenience: it is the SAME vendor and region as the
 * database — one BAA conversation rather than two if the medical-courier work lands, and
 * no cross-region transfer on the largest objects in the system — and the S3 API is
 * portable, so moving later is a config change rather than a rewrite.
 *
 * UPLOADS ARE PRESIGNED AND GO DIRECT FROM THE DEVICE. This is not a preference:
 * Vercel's serverless functions cap a request body at roughly 4.5MB, and a
 * full-resolution phone photo routinely exceeds that. Proxying the bytes through a
 * server action would fail exactly the "full resolution" requirement POD exists for —
 * and it would fail on the good phones first, which is the worst possible failure curve.
 *
 * READS are presigned too, and short-lived. The bucket is private: a delivery photo can
 * show a doorway, a face, or a label with a patient's name on it. A permanent public URL
 * to that is the leak, so nothing here ever returns one.
 */
import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Only what a camera or a signature pad produces. An allowlist, never a denylist. */
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ProofContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export function isAllowedContentType(value: string): value is ProofContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * 20MB. Generous enough for a modern phone's full-resolution JPEG — the point of the
 * feature — and bounded so a bad client cannot fill the bucket. Enforced in the presign
 * request, which is the only place we still control before the bytes leave the device.
 */
export const MAX_PROOF_BYTES = 20 * 1024 * 1024;

export class StorageNotConfiguredError extends Error {
  constructor(missing: readonly string[]) {
    super(`Object storage is not configured — missing: ${missing.join(", ")}`);
    this.name = "StorageNotConfiguredError";
  }
}

interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function readConfig(): StorageConfig {
  const endpoint = process.env.STORAGE_S3_ENDPOINT;
  const region = process.env.STORAGE_REGION ?? "us-east-2";
  const bucket = process.env.STORAGE_BUCKET;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;

  // Names are safe to report and make the failure actionable; values never are.
  const missing = [
    !endpoint ? "STORAGE_S3_ENDPOINT" : null,
    !bucket ? "STORAGE_BUCKET" : null,
    !accessKeyId ? "STORAGE_ACCESS_KEY_ID" : null,
    !secretAccessKey ? "STORAGE_SECRET_ACCESS_KEY" : null,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) throw new StorageNotConfiguredError(missing);

  return {
    endpoint: endpoint!,
    region,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
  };
}

/** Is storage usable? Lets a surface degrade honestly instead of throwing at the user. */
export function isStorageConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

function client(config: StorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    // Neon's endpoint addresses buckets by path, not by virtual host. Without this the
    // SDK builds `https://<bucket>.<endpoint>` and every request fails DNS.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Where an object lives.
 *
 * Tenant-scoped as the FIRST path segment, so a bucket listing is segregated by licensee
 * and a future per-tenant policy or export has a prefix to work with. The random suffix
 * means a key cannot be guessed from an order id — belt and braces behind the private
 * bucket, because a leaked key should not be a leaked photo.
 */
function proofKey(
  tenantId: string,
  orderId: string,
  kind: "photo" | "signature",
  contentType: ProofContentType,
): string {
  const ext = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
  return `tenants/${tenantId}/orders/${orderId}/${kind}-${randomUUID()}.${ext}`;
}

export interface PresignedUpload {
  /** PUT the bytes here, with the same Content-Type. Expires quickly. */
  readonly url: string;
  /** Persist THIS, never the URL — the URL is derived and short-lived. */
  readonly key: string;
}

/** A short-lived URL the device can PUT one object to. */
export async function presignProofUpload(args: {
  tenantId: string;
  orderId: string;
  kind: "photo" | "signature";
  contentType: ProofContentType;
  contentLength: number;
}): Promise<PresignedUpload> {
  if (!Number.isInteger(args.contentLength) || args.contentLength <= 0) {
    throw new Error("Content length must be a positive whole number of bytes.");
  }
  if (args.contentLength > MAX_PROOF_BYTES) {
    throw new Error(`That file is larger than the ${MAX_PROOF_BYTES / (1024 * 1024)}MB limit.`);
  }

  const config = readConfig();
  const key = proofKey(args.tenantId, args.orderId, args.kind, args.contentType);

  // ContentLength is signed into the URL, so the holder cannot upload something larger
  // than they declared — the size limit survives leaving our process.
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: args.contentType,
    ContentLength: args.contentLength,
  });

  const url = await getSignedUrl(client(config), command, { expiresIn: 300 });
  return { url, key };
}

/**
 * A short-lived URL to READ one object.
 *
 * Fifteen minutes: long enough to render a page and for someone to look at the photo,
 * short enough that a URL copied out of devtools and pasted elsewhere stops working.
 */
export async function presignProofDownload(key: string, expiresIn = 900): Promise<string> {
  const config = readConfig();
  const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  return getSignedUrl(client(config), command, { expiresIn });
}
