import { describe, expect, it, vi } from "vitest";

import {
  RECEIPT_JPEG_QUALITY,
  RECEIPT_LONG_EDGE,
  jpegName,
  shrinkReceipt,
  shrunkSize,
  type PhotoTools,
} from "@/lib/imprest/receipt-shrink";

/**
 * Receipt photos are made smaller before upload (issue #65). The browser's decoder and encoder are
 * stood in for here, so the rule itself is what is tested: the size a photo is redrawn at, which
 * files are touched at all, and that the smaller of the two is what goes up. The real decoder and
 * encoder are exercised in Chromium by the settlement E2E and its benchmark.
 */

function fileOf(bytes: number, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1 });
}

/** A decoder that reads every photo as `width` × `height`, and an encoder that writes `outBytes`. */
function tools(width: number, height: number, outBytes: (w: number, h: number) => number) {
  const close = vi.fn();
  const encode = vi.fn(async (_photo: unknown, w: number, h: number) => new Blob([new Uint8Array(outBytes(w, h))]));
  const decode = vi.fn(async () => ({ width, height, source: "bitmap", close }));
  return { decode, encode, close, tools: { decode, encode } as unknown as PhotoTools };
}

describe("the size a receipt photo is redrawn at", () => {
  it("brings the long edge of a large photo down to 2,048 px and keeps its proportions", () => {
    expect(shrunkSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(shrunkSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(shrunkSize(8000, 1000)).toEqual({ width: 2048, height: 256 });
  });

  it("never enlarges a photo already within it", () => {
    expect(shrunkSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
    expect(shrunkSize(RECEIPT_LONG_EDGE, 10)).toEqual({ width: RECEIPT_LONG_EDGE, height: 10 });
  });
});

describe("shrinking a receipt photo", () => {
  it("returns a large photo as a JPEG no more than 2,048 px on its long edge, and smaller than it went in", async () => {
    const photo = fileOf(3_000_000, "IMG_2041.jpg", "image/jpeg");
    const t = tools(4032, 3024, () => 420_000);

    const out = await shrinkReceipt(photo, t.tools);

    expect(t.encode).toHaveBeenCalledWith(expect.anything(), 2048, 1536, RECEIPT_JPEG_QUALITY);
    expect(out).not.toBe(photo);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_2041.jpg");
    expect(out.size).toBe(420_000);
    expect(out.size).toBeLessThan(photo.size);
    expect(t.close).toHaveBeenCalledOnce();
  });

  it("does not enlarge a small photo, and re-saves it only when that is smaller", async () => {
    const small = fileOf(500_000, "small.png", "image/png");
    const t = tools(800, 600, () => 90_000);
    const out = await shrinkReceipt(small, t.tools);
    expect(t.encode).toHaveBeenCalledWith(expect.anything(), 800, 600, RECEIPT_JPEG_QUALITY);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("small.jpg");
    expect(out.size).toBe(90_000);
  });

  it("keeps a smaller original rather than a larger re-encode", async () => {
    const tight = fileOf(120_000, "tight.jpg", "image/jpeg");
    const t = tools(1200, 900, () => 180_000);
    expect(await shrinkReceipt(tight, t.tools)).toBe(tight);
    const same = tools(1200, 900, () => 120_000);
    expect(await shrinkReceipt(tight, same.tools)).toBe(tight);
    expect(t.close).toHaveBeenCalledOnce();
  });

  it("turns a HEIC photo the browser can decode into a JPEG", async () => {
    const heic = fileOf(2_500_000, "IMG_2042.HEIC", "image/heic");
    const out = await shrinkReceipt(heic, tools(4032, 3024, () => 380_000).tools);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_2042.jpg");
  });

  it("uploads a PDF exactly as chosen, without trying to decode it", async () => {
    const pdf = fileOf(2_000_000, "invoice.pdf", "application/pdf");
    const t = tools(1, 1, () => 1);
    expect(await shrinkReceipt(pdf, t.tools)).toBe(pdf);
    expect(t.decode).not.toHaveBeenCalled();
  });

  it("uploads a photo this browser cannot decode exactly as chosen", async () => {
    const heic = fileOf(2_500_000, "IMG_2043.heic", "");
    const undecodable: PhotoTools = { decode: async () => null, encode: vi.fn() };
    expect(await shrinkReceipt(heic, undecodable)).toBe(heic);
    expect(undecodable.encode).not.toHaveBeenCalled();

    const broken: PhotoTools = {
      decode: async () => {
        throw new Error("The source image could not be decoded.");
      },
      encode: vi.fn(),
    };
    const damaged = fileOf(1_000_000, "damaged.jpg", "image/jpeg");
    expect(await shrinkReceipt(damaged, broken)).toBe(damaged);
  });

  it("uploads the original when the encoder fails", async () => {
    const photo = fileOf(3_000_000, "IMG_2044.jpg", "image/jpeg");
    const close = vi.fn();
    const failing: PhotoTools = {
      decode: async () => ({ width: 4032, height: 3024, source: null, close }),
      encode: async () => null,
    };
    expect(await shrinkReceipt(photo, failing)).toBe(photo);
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves a file of a type receipts do not accept to the type check", async () => {
    const text = fileOf(100, "notes.txt", "text/plain");
    const t = tools(1, 1, () => 1);
    expect(await shrinkReceipt(text, t.tools)).toBe(text);
    expect(t.decode).not.toHaveBeenCalled();
  });
});

describe("the name of a shrunk photo", () => {
  it("says it is now a JPEG", () => {
    expect(jpegName("IMG_2041.HEIC")).toBe("IMG_2041.jpg");
    expect(jpegName("scan.final.png")).toBe("scan.final.jpg");
    expect(jpegName("photo")).toBe("photo.jpg");
    expect(jpegName(".png")).toBe("receipt.jpg");
  });
});
