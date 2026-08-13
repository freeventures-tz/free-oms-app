import Image from "next/image";

import logo from "@/public/brand/free-ventures-logo.png";
import { cn } from "@/lib/utils";

/**
 * The Free Ventures lockup (design.md §7.1). The mark and the wordmark are one asset, so it is
 * never reassembled from parts and never recoloured — the artwork already carries Golden Bronze and
 * Deep Twilight at their approved values.
 *
 * It sits on White in every entry screen, which is the only background the artwork is drawn for.
 * `priority` because it is the largest element above the fold on the first screen anyone ever sees.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <Image
      src={logo}
      alt="Free Ventures"
      priority
      sizes="(max-width: 767px) 200px, 240px"
      className={cn("h-auto w-[200px] md:w-[220px] xl:w-[240px]", className)}
    />
  );
}
