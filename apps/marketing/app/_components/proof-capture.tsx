"use client";

/**
 * Proof of delivery capture — the driver's surface, at the door, on a phone.
 *
 * The third client component in this app, and it earns it: a signature is drawn, which
 * cannot exist without JavaScript. The photo and the name would work as a plain form;
 * they live here so the driver makes ONE submission rather than three, because the door
 * is the worst possible place to discover a multi-step flow.
 *
 * Two decisions worth stating, both learned from what POD is FOR:
 *
 *   Bytes go DIRECT to storage via a presigned URL, never through a server action. A
 *   full-resolution phone photo exceeds the platform's ~4.5MB request body limit, so
 *   proxying would fail on exactly the good cameras — the worst failure curve available.
 *
 *   The photo is NOT resized or re-encoded. "Full resolution" is the requirement; a
 *   compressed proof-of-delivery image is a compressed piece of evidence, and the
 *   compression is invisible until somebody needs to zoom in on it.
 */
import { useCallback, useRef, useState } from "react";

type Kind = "photo" | "signature";

interface Position {
  readonly lat: string;
  readonly lng: string;
  readonly accuracyM: number | null;
}

/** Ask for a fix, but never block delivery on it. A refused permission is not an error. */
async function currentPosition(): Promise<Position | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude.toFixed(6),
          lng: p.coords.longitude.toFixed(6),
          accuracyM: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

async function uploadDirect(args: {
  tenantId: string;
  orderId: string;
  kind: Kind;
  blob: Blob;
}): Promise<string> {
  const res = await fetch("/api/proof/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: args.tenantId,
      orderId: args.orderId,
      kind: args.kind,
      contentType: args.blob.type,
      contentLength: args.blob.size,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not prepare the upload.");
  }
  const { url, key } = (await res.json()) as { url: string; key: string };

  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": args.blob.type },
    body: args.blob,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
  return key;
}

export function ProofCapture({
  tenantId,
  orderId,
  action,
}: {
  tenantId: string;
  orderId: string;
  /**
   * Server action that records the keys. Genuinely async — typing it `=> void` made this
   * component claim otherwise, and `busy` would have cleared before the write landed.
   */
  action: (formData: FormData) => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pointAt = (canvas: HTMLCanvasElement, e: React.PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    // Canvas backing store is larger than its CSS box on a retina screen; without the
    // ratio the stroke lands away from the fingertip.
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const start = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Capture the pointer so a stroke that leaves the box still tracks — a signature
    // routinely overshoots, and losing the tail makes it look forged.
    canvas.setPointerCapture(e.pointerId);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointAt(canvas, e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawing.current = true;
  }, []);

  const move = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = pointAt(canvas, e);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#131a21";
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasSignature(true);
  }, []);

  const end = useCallback(() => {
    drawing.current = false;
  }, []);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  }, []);

  async function submit() {
    setProblem(null);
    if (!hasSignature && !photo && !recipient.trim()) {
      setProblem("Capture a signature, a photo, or the recipient's name.");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("tenantId", tenantId);
      form.set("orderId", orderId);
      form.set("recipientName", recipient.trim());

      if (photo) {
        form.set("photoKey", await uploadDirect({ tenantId, orderId, kind: "photo", blob: photo }));
      }

      if (hasSignature && canvasRef.current) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvasRef.current!.toBlob(resolve, "image/png"),
        );
        if (blob) {
          form.set(
            "signatureKey",
            await uploadDirect({ tenantId, orderId, kind: "signature", blob }),
          );
        }
      }

      const pos = await currentPosition();
      if (pos) {
        form.set("lat", pos.lat);
        form.set("lng", pos.lng);
        if (pos.accuracyM !== null) form.set("accuracyM", String(pos.accuracyM));
      }

      // Awaited: the driver must not see "saved" before the row exists. A server action
      // that redirects throws to signal it, which the catch below re-raises untouched.
      await action(form);
    } catch (err) {
      // The driver is standing at a door. Say what failed and let them retry, rather
      // than dropping a signature the recipient already gave.
      setProblem(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="proof">
      <div className="field">
        <label htmlFor="proof-recipient">Who took delivery?</label>
        <input
          id="proof-recipient"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          autoComplete="off"
          placeholder="Name at the door"
        />
      </div>

      <div className="field">
        <label htmlFor="proof-photo">Photo</label>
        <input
          id="proof-photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          // Opens the rear camera on a phone and the file picker on a desktop.
          capture="environment"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
        <span className="hint">
          {photo
            ? `${photo.name} — ${(photo.size / (1024 * 1024)).toFixed(1)}MB, sent at full resolution`
            : "Kept at full resolution: a compressed photo is compressed evidence."}
        </span>
      </div>

      <div className="field">
        <label htmlFor="proof-signature">Signature</label>
        <canvas
          id="proof-signature"
          ref={canvasRef}
          width={640}
          height={220}
          className="sig-pad"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        <div className="sig-actions">
          <button type="button" className="btn btn-quiet" onClick={clear} disabled={!hasSignature}>
            Clear signature
          </button>
        </div>
      </div>

      {problem ? (
        <p className="error" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            void submit();
          }}
          disabled={busy}
        >
          {busy ? "Saving proof…" : "Save proof of delivery"}
        </button>
      </div>
    </div>
  );
}
