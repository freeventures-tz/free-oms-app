import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Locale is a per-user preference, not a URL segment: there is no `/en/…` or `/sw/…` routing.
  // Switching language never changes the address, so a link shared between two staff members opens
  // the same screen in each of their own languages.
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
