import { useTranslations } from "next-intl";

import { StatusChip } from "@/components/ui/surface";
import type { FundingStatus } from "@/lib/imprest/funding";

const TONES = {
  requested: "neutral",
  approved: "neutral",
  provided: "attention",
  disputed: "danger",
  received: "success",
  rejected: "danger",
} as const;

export function FundingStatusChip({ status }: { status: FundingStatus }) {
  const t = useTranslations("imprest.status");
  return <StatusChip tone={TONES[status]}>{t(status)}</StatusChip>;
}
