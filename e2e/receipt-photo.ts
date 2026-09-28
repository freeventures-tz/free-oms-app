import type { Page } from "@playwright/test";

/**
 * A phone photo of a till receipt, made in the browser for the receipt tests (issue #65).
 *
 * 4032 × 3024 px, the size a 12-megapixel phone camera takes, and about 3 MB as a JPEG: a slip of
 * paper with printed text lying on a grainy table, saved at whatever quality lands it nearest 3 MB.
 * The grain is there because a real photo has it and it is what makes a photo large. The text is
 * there so a test can open the shrunk receipt and see that it is still readable.
 *
 * Made with the page's own canvas, so no image library is needed and nothing binary is committed.
 */
export type ReceiptPhoto = { name: string; mimeType: string; buffer: Buffer; width: number; height: number };

export const RECEIPT_TEXT = [
  "FREE VENTURES TEST STATION",
  "MBEZI BEACH, DAR ES SALAAM",
  "RECEIPT NO 004211",
  "DIESEL 8.4 L @ 952",
  "TOTAL TZS 8,000",
  "PAID CASH",
];

/** The small print under the heading, at the size a till prints item lines. */
export const RECEIPT_SMALL_PRINT = [
  "TIN 123-456-789   VRN 40-012345-K",
  "PUMP 04   ATTENDANT: REHEMA",
  "DATE 28/09/2026   TIME 08:14",
  "ITEM          QTY    PRICE     AMOUNT",
  "DIESEL        8.40   952.00   8,000.00",
  "SUBTOTAL                      8,000.00",
  "VAT 18% INCL                  1,220.34",
  "CASH                          8,000.00",
  "CHANGE                            0.00",
  "Z-NO 0412   RECEIPT VERIFIED BY TRA",
  "THANK YOU, KARIBU TENA",
];

/**
 * `size` is the photo's size in pixels. The scene is drawn at 4032 × 3024 and scaled to fit, so a
 * small photo, for seeding a test quickly, shows the same receipt.
 */
export async function receiptPhoto(
  page: Page,
  name = "IMG_4211.jpg",
  targetBytes = 3 * 1024 * 1024,
  size: { width: number; height: number } = { width: 4032, height: 3024 },
): Promise<ReceiptPhoto> {
  const made = await page.evaluate(
    async ({ lines, small, target, width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.scale(width / 4032, height / 3024);

      // A wooden table: a warm gradient, then grain.
      const table = context.createLinearGradient(0, 0, 4032, 3024);
      table.addColorStop(0, "#6b4a2f");
      table.addColorStop(1, "#8a6240");
      context.fillStyle = table;
      context.fillRect(0, 0, 4032, 3024);

      // The receipt, a little turned, as it lies on the table.
      context.save();
      context.translate(2016, 1512);
      context.rotate(-0.04);
      context.fillStyle = "#f4f1ea";
      context.fillRect(-900, -1300, 1800, 2600);
      context.fillStyle = "#1c1c1c";
      context.font = "bold 96px monospace";
      context.textBaseline = "top";
      lines.forEach((line, i) => context.fillText(line, -820, -1180 + i * 190));
      // Till print: 40 px capitals, about 20 px once shrunk to 2,048 px.
      context.font = "40px monospace";
      small.forEach((line, i) => context.fillText(line, -820, -20 + i * 62));
      context.restore();

      // Sensor grain over everything, deterministic so every run makes the same photo.
      const pixels = context.getImageData(0, 0, width, height);
      let seed = 42;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const grain = ((seed >>> 24) - 128) / 10;
        pixels.data[i] += grain;
        pixels.data[i + 1] += grain;
        pixels.data[i + 2] += grain;
      }
      context.putImageData(pixels, 0, 0);

      // No named functions in here: a transpiler may wrap them in a helper the page does not have.
      let low = 0.5;
      let high = 1;
      let best: Blob | null = null;
      for (let step = 0; step < 9; step += 1) {
        const quality = step === 0 ? 0.92 : (low + high) / 2;
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((made) => resolve(made!), "image/jpeg", quality),
        );
        if (step === 0) {
          best = blob;
          continue;
        }
        if (Math.abs(blob.size - target) < Math.abs(best!.size - target)) best = blob;
        if (blob.size > target) high = quality;
        else low = quality;
      }
      const bytes = new Uint8Array(await best!.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { base64: btoa(binary), width, height };
    },
    { lines: RECEIPT_TEXT, small: RECEIPT_SMALL_PRINT, target: targetBytes, ...size },
  );
  return {
    name,
    mimeType: "image/jpeg",
    buffer: Buffer.from(made.base64, "base64"),
    width: made.width,
    height: made.height,
  };
}
