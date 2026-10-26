import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { activeI18n, setActiveI18n } from "../../i18n/core.ts";
import { I18nProvider } from "../../i18n/I18nProvider.tsx";
import { CalendarHeatmap } from "./CalendarHeatmap.tsx";
import { ACTIVITY_SERIES, sampleDays } from "./fixtures.ts";
import { StackedBars } from "./StackedBars.tsx";
import { StatTile } from "./StatTile.tsx";

/**
 * Overview chart primitives (docs/design/agent-overview-2026.md §5.4, §5.7). Light and dark come
 * from the toolbar and the visual suite; `Rtl*` runs the Arabic catalogue with a mirrored axis.
 */

const meta = { title: "Charts/Primitives" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const LAST = "2025-10-14"; // a Tuesday
const noop = () => {};

/** Arabic text and a right-to-left layout; the previous locale returns when the story unmounts. */
function Arabic({ children }: { children: ReactNode }) {
  const previous = useRef(activeI18n());
  useEffect(() => () => setActiveI18n(previous.current), []);
  return (
    <I18nProvider locale="ar" language="ar">
      {children}
    </I18nProvider>
  );
}

const arabicSeries = ACTIVITY_SERIES({
  tasks: "المهام",
  automations: "الأتمتة",
  chat: "المحادثة",
}).map(({ describe: _describe, ...s }) => s);

function Tiles({ rtl = false }: { rtl?: boolean }) {
  const week = [3, 5, 4, 8, 6, 9, 12];
  return (
    <div className="grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4" dir={rtl ? "rtl" : undefined}>
      <StatTile
        label={rtl ? "المهام المنجزة" : "Tasks done"}
        value={47}
        previous={35}
        periodLabel={rtl ? "الشهر الماضي" : "last month"}
        spark={week}
        href="#tasks"
      />
      <StatTile
        label={rtl ? "تشغيل الأتمتة" : "Automations run"}
        value={128}
        previous={140}
        periodLabel={rtl ? "الشهر الماضي" : "last month"}
        spark={[0, 0, 0, 0, 0, 0, 4]}
        subline={rtl ? "98٪ ناجحة" : "98% ok · 4 failed"}
        onClick={noop}
      />
      <StatTile
        label={rtl ? "الموافقات" : "Approvals"}
        value={9}
        previous={null}
        href="#approvals"
      />
      <StatTile label={rtl ? "الدروس" : "Lessons learned"} value={3} subline="2 confirmed" />
    </div>
  );
}

export const TilesRow: Story = { render: () => <Tiles /> };
export const TilesRtl: Story = {
  render: () => (
    <Arabic>
      <Tiles rtl />
    </Arabic>
  ),
};
export const TileNoComparison: Story = {
  render: () => (
    <div className="max-w-60">
      <StatTile label="Tasks done" value={12} previous={0} periodLabel="last week" href="#t" />
    </div>
  ),
};
export const TileFlat: Story = {
  render: () => (
    <div className="max-w-60">
      <StatTile
        label="Tasks done"
        value={12}
        previous={12}
        periodLabel="last week"
        spark={[1, 2, 3, 2, 1]}
        href="#t"
      />
    </div>
  ),
};

function BarsDemo({ days, selected }: { days: number; selected?: string }) {
  const [day, setDay] = useState<string | null>(selected ?? null);
  return (
    <div className="max-w-3xl">
      <StackedBars
        days={sampleDays(LAST, days)}
        series={ACTIVITY_SERIES()}
        selectedDate={day}
        onSelectDay={setDay}
        caption="Busiest day: Oct 9 · 26 runs"
      />
    </div>
  );
}

export const BarsWeek: Story = { render: () => <BarsDemo days={7} selected="2025-10-10" /> };
export const BarsMonth: Story = { render: () => <BarsDemo days={30} /> };
export const BarsSparse: Story = {
  render: () => (
    <div className="max-w-3xl">
      <StackedBars
        days={sampleDays(LAST, 14, 0.25, 3)}
        series={ACTIVITY_SERIES()}
        caption="Busiest day: Oct 6 · 5 runs"
      />
    </div>
  ),
};
export const BarsEmpty: Story = {
  render: () => (
    <div className="max-w-3xl">
      <StackedBars
        days={sampleDays(LAST, 7, 0)}
        series={ACTIVITY_SERIES()}
        caption="Nothing ran in this period."
      />
    </div>
  ),
};
export const BarsRtl: Story = {
  render: () => (
    <Arabic>
      <div className="max-w-3xl">
        <StackedBars days={sampleDays(LAST, 14)} series={arabicSeries} />
      </div>
    </Arabic>
  ),
};

function HeatDemo({ weeks, density }: { weeks: number; density: number }) {
  const [day, setDay] = useState<string | null>(null);
  return (
    <div className="max-w-3xl">
      <CalendarHeatmap
        days={sampleDays(LAST, weeks * 7, density, 11)}
        series={ACTIVITY_SERIES()}
        selectedDate={day}
        onSelectDay={setDay}
        caption="Busiest day: Sep 18 · 31 runs"
      />
    </div>
  );
}

export const HeatmapYear: Story = { render: () => <HeatDemo weeks={52} density={0.85} /> };
export const HeatmapSparse: Story = { render: () => <HeatDemo weeks={26} density={0.12} /> };
export const HeatmapEmpty: Story = {
  render: () => (
    <div className="max-w-3xl">
      <CalendarHeatmap days={sampleDays(LAST, 84, 0)} series={ACTIVITY_SERIES()} />
    </div>
  ),
};
export const HeatmapRtl: Story = {
  render: () => (
    <Arabic>
      <div className="max-w-3xl">
        <CalendarHeatmap days={sampleDays(LAST, 26 * 7, 0.7, 5)} series={arabicSeries} />
      </div>
    </Arabic>
  ),
};
