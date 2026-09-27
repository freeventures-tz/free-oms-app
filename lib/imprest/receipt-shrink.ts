import { receiptType } from "@/lib/imprest/spending";

/**
 * Receipt photos are made smaller on the phone before they are encrypted and uploaded (issue #65,
 * Owner decision of 27 September 2026). A 3 MB phone photo took about 34 seconds on Slow 4G, and a
 * settlement sent back may need new receipts on every line.
 *
 * THE RULE. A JPEG, PNG, WebP or HEIC photo the browser can decode is redrawn at no more than
 * 2,048 px on its long edge and saved as JPEG. That keeps the text of a till receipt readable while a
 * typical phone photo comes out at a few hundred KB. Nothing is enlarged, and when the redrawn file
 * would be no smaller than the original, the original is kept. A PDF, and a photo this browser
 * cannot decode (HEIC outside Safari, a damaged file), goes up exactly as it was chosen.
 *
 * Whatever comes out is what is registered and uploaded: its own name, type and size.
 */

/** The long edge of a shrunk receipt photo, in pixels. */
export const RECEIPT_LONG_EDGE = 2048;
/** JPEG quality for a shrunk photo: small, and still sharp enough for printed text. */
export const RECEIPT_JPEG_QUALITY = 0.85;

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

/** A decoded photo. `source` is whatever the tools decoded it into; `close` frees its memory. */
export type DecodedPhoto = { width: number; height: number; source: unknown; close: () => void };

/** How a photo is read and redrawn. The browser's own by default; tests pass their own. */
export type PhotoTools = {
  /** The decoded photo, upright, or null when this browser cannot read the file. */
  decode: (file: File) => Promise<DecodedPhoto | null>;
  /** The photo redrawn at `width` × `height` as a JPEG, or null when it could not be. */
  encode: (photo: DecodedPhoto, width: number, height: number, quality: number) => Promise<Blob | null>;
};

/** The size a photo is redrawn at: the long edge at most `RECEIPT_LONG_EDGE`, never enlarged. */
export function shrunkSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, RECEIPT_LONG_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** `IMG_2041.HEIC` becomes `IMG_2041.jpg`, so the name says what the file now is. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "");
  return `${base || "receipt"}.jpg`;
}

/**
 * The file to register and upload for `file`: a smaller JPEG when that helps, otherwise `file`
 * itself. Never throws; anything that goes wrong on the way sends the original.
 */
export async function shrinkReceipt(file: File, tools: PhotoTools = browserPhotoTools): Promise<File> {
  const type = receiptType(file);
  if (!type || !PHOTO_TYPES.has(type)) return file;

  let photo: DecodedPhoto | null = null;
  try {
    photo = await tools.decode(file);
    if (!photo || photo.width < 1 || photo.height < 1) return file;
    const size = shrunkSize(photo.width, photo.height);
    const blob = await tools.encode(photo, size.width, size.height, RECEIPT_JPEG_QUALITY);
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    photo?.close();
  }
}

/**
 * The browser's decoder and encoder. `createImageBitmap` turns the photo upright from its EXIF
 * orientation, so a portrait receipt stays portrait. The canvas is filled white first, so a
 * transparent PNG does not turn black as a JPEG.
 */
export const browserPhotoTools: PhotoTools = {
  async decode(file) {
    if (typeof createImageBitmap !== "function") return null;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      return null;
    }
  },
  async encode(photo, width, height, quality) {
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = "high";
      context.drawImage(photo.source as ImageBitmap, 0, 0, width, height);
      return canvas.convertToBlob({ type: "image/jpeg", quality });
    }
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(photo.source as ImageBitmap, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  },
};
