/**
 * The proof-of-delivery certificate.
 *
 * This is the first artifact that leaves the platform and reaches a TENANT'S OWN
 * CUSTOMER, which makes it the first real test of the "100% platform anonymity" the
 * Agency tier is sold on. The rule is absolute and asserted by a test: nothing in this
 * document names PorterDirect. The letterhead is the operator's name and their domain,
 * because as far as the recipient is concerned the operator is who delivered the parcel.
 *
 * Built with `pdf-lib` rather than a headless browser. A browser would give nicer
 * typography and needs a ~300MB binary that cannot run in a serverless function; this is
 * pure JavaScript, renders in milliseconds, and a delivery receipt is a form, not a
 * magazine. The constraint and the requirement agree for once.
 *
 * The signature and photo are embedded at their ORIGINAL resolution. Downscaling them
 * here would quietly undo the decision made when they were captured — a compressed proof
 * is compressed evidence, and it only matters at the moment someone disputes a delivery.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface ProofPdfInput {
  /** The OPERATOR. This is the brand on the page — never ours. */
  readonly operatorName: string;
  readonly operatorDomain: string | null;
  readonly reference: string;
  readonly customerName: string;
  readonly pickupLines: readonly string[];
  readonly dropoffLines: readonly string[];
  readonly recipientName: string | null;
  readonly capturedAt: Date;
  readonly lat: string | null;
  readonly lng: string | null;
  readonly accuracyM: number | null;
  /** Raw image bytes, or null when that piece was not captured. */
  readonly signature: Uint8Array | null;
  readonly photo: Uint8Array | null;
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const INK = rgb(0.07, 0.1, 0.13);
const MUTED = rgb(0.28, 0.33, 0.37);
const RULE = rgb(0.83, 0.855, 0.88);

/** PNG or JPEG, decided by magic bytes rather than by trusting a stored content type. */
async function embed(doc: PDFDocument, bytes: Uint8Array) {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return isPng ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

function line(page: PDFPage, y: number) {
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4.width - MARGIN, y },
    thickness: 0.75,
    color: RULE,
  });
}

/** A label/value pair. Returns the new cursor position. */
function field(
  page: PDFPage,
  fonts: { label: PDFFont; body: PDFFont },
  y: number,
  label: string,
  values: readonly string[],
): number {
  page.drawText(label.toUpperCase(), {
    x: MARGIN,
    y,
    size: 7.5,
    font: fonts.label,
    color: MUTED,
  });
  let cursor = y - 13;
  for (const value of values) {
    page.drawText(value, { x: MARGIN, y: cursor, size: 11, font: fonts.body, color: INK });
    cursor -= 14;
  }
  return cursor - 8;
}

export async function buildProofPdf(input: ProofPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  // No Producer/Creator naming us either. PDF metadata is not visible on the page and is
  // trivially readable — an anonymity promise that only holds until someone opens
  // Document Properties is not a promise.
  doc.setTitle(`Proof of delivery — ${input.reference}`);
  doc.setAuthor(input.operatorName);
  doc.setProducer(input.operatorName);
  doc.setCreator(input.operatorName);
  doc.setSubject("Proof of delivery");

  const page = doc.addPage([A4.width, A4.height]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const fonts = { label: bold, body };

  let y = A4.height - MARGIN;

  // Letterhead: the OPERATOR's name, at the top, in the largest type on the page.
  page.drawText(input.operatorName, { x: MARGIN, y, size: 20, font: bold, color: INK });
  y -= 16;
  if (input.operatorDomain) {
    page.drawText(input.operatorDomain, { x: MARGIN, y, size: 9.5, font: body, color: MUTED });
    y -= 6;
  }
  y -= 14;
  line(page, y);
  y -= 26;

  page.drawText("Proof of delivery", { x: MARGIN, y, size: 15, font: bold, color: INK });
  page.drawText(input.reference, {
    x: A4.width - MARGIN - bold.widthOfTextAtSize(input.reference, 11),
    y,
    size: 11,
    font: bold,
    color: MUTED,
  });
  y -= 26;

  y = field(page, fonts, y, "Delivered to", [input.customerName, ...input.dropoffLines]);
  y = field(page, fonts, y, "Collected from", input.pickupLines);
  y = field(page, fonts, y, "Received by", [input.recipientName ?? "Not recorded"]);

  const when = input.capturedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const where =
    input.lat && input.lng
      ? `${input.lat}, ${input.lng}${input.accuracyM ? ` (±${input.accuracyM}m)` : ""}`
      : "Location not recorded";
  y = field(page, fonts, y, "Captured", [when, where]);

  line(page, y);
  y -= 24;

  // Evidence. Scaled to FIT rather than cropped: a receipt that crops the photograph is
  // deciding which part of the evidence matters, which is not its job.
  const boxW = (A4.width - MARGIN * 2 - 18) / 2;
  const boxH = 190;

  const drawImage = async (bytes: Uint8Array | null, label: string, x: number) => {
    page.drawText(label.toUpperCase(), {
      x,
      y,
      size: 7.5,
      font: bold,
      color: MUTED,
    });
    if (!bytes) {
      page.drawText("Not captured", {
        x,
        y: y - 16,
        size: 10,
        font: body,
        color: MUTED,
      });
      return;
    }
    const img = await embed(doc, bytes);
    const scale = Math.min(boxW / img.width, boxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawRectangle({
      x,
      y: y - 12 - boxH,
      width: boxW,
      height: boxH,
      borderColor: RULE,
      borderWidth: 0.75,
    });
    page.drawImage(img, {
      x: x + (boxW - w) / 2,
      y: y - 12 - boxH + (boxH - h) / 2,
      width: w,
      height: h,
    });
  };

  await drawImage(input.signature, "Signature", MARGIN);
  await drawImage(input.photo, "Photograph", MARGIN + boxW + 18);

  // Footer states what the document IS and who stands behind it — the operator. A
  // certificate that does not say what it certifies is decoration.
  const footer = `This document certifies delivery of ${input.reference} by ${input.operatorName}.`;
  page.drawText(footer, {
    x: MARGIN,
    y: MARGIN,
    size: 8.5,
    font: body,
    color: MUTED,
  });

  return doc.save();
}
