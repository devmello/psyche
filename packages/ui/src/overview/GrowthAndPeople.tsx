import type { ReactElement } from "react";
import { GrowthSection } from "./GrowthSection.tsx";
import { PeopleSection } from "./PeopleSection.tsx";
import type { OverviewPeriod } from "./period.ts";

/**
 * Growth beside People & projects at wide widths (agent-overview-2026 §5.2), stacked below that
 * (Growth above People between 720 and 1100 px, and at compact width).
 */
export function GrowthAndPeople({
  period,
  now,
  compact,
}: {
  period: OverviewPeriod;
  now?: number;
  compact?: boolean;
}): ReactElement {
  return (
    <div className="grid grid-cols-1 items-start gap-4 @min-[1100px]/overview:grid-cols-2">
      <GrowthSection period={period} {...(now === undefined ? {} : { now })} />
      <PeopleSection
        period={period}
        {...(now === undefined ? {} : { now })}
        {...(compact === undefined ? {} : { compact })}
      />
    </div>
  );
}
