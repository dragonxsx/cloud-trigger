import { Center, Text, useMantineColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { EChartsOption } from 'echarts';
import ReactEChartsCore from 'echarts-for-react/esm/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { type ReactNode, useMemo } from 'react';
import { z } from 'zod';

import type { ApiClient } from '../lib/api';
import { chartTime, duration } from '../lib/format';
import { CHART_STACK_ORDER, STATUS } from '../lib/status';

echarts.use([
  BarChart,
  LineChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type Point = Awaited<ReturnType<ApiClient['analytics']['timeseries']>>[number];
type ChartStatus = (typeof CHART_STACK_ORDER)[number];

const LIGHT = {
  text: '#18212f',
  muted: '#5f6b7e',
  grid: '#e7ebf1',
  surface: '#ffffff',
  latency: '#2a5bd7',
  latencyArea: 'rgba(42, 91, 215, 0.08)',
  status: {
    succeeded: '#2f9e44',
    failed: '#c92a2a',
    timed_out: '#b35900',
    cancelled: '#495057',
    skipped: '#868e96',
  },
} as const;

const DARK = {
  text: '#e6ebf2',
  muted: '#93a0b4',
  grid: '#273141',
  surface: '#161d27',
  latency: '#74a0ff',
  latencyArea: 'rgba(116, 160, 255, 0.12)',
  status: {
    succeeded: '#51cf66',
    failed: '#ff8787',
    timed_out: '#fcc419',
    cancelled: '#ced4da',
    skipped: '#7d8896',
  },
} as const;

type Ink = typeof LIGHT | typeof DARK;

const useInk = (): Ink => (useMantineColorScheme().colorScheme === 'dark' ? DARK : LIGHT);

interface Decal {
  readonly symbol: string;
  readonly symbolSize: number;
  readonly dashArrayX: number | number[];
  readonly dashArrayY: number | number[];
  readonly rotation: number;
}

const DECAL: Partial<Record<ChartStatus, Decal>> = {
  failed: {
    symbol: 'rect',
    symbolSize: 1,
    dashArrayX: [1, 0],
    dashArrayY: [2, 5],
    rotation: -Math.PI / 4,
  },
  timed_out: { symbol: 'circle', symbolSize: 0.6, dashArrayX: 5, dashArrayY: 5, rotation: 0 },
};

const AxisParam = z.object({
  axisValue: z.union([z.number(), z.string()]),
  seriesName: z.string(),
  marker: z.string(),
  value: z.tuple([z.unknown(), z.number().nullable()]),
});
const AxisParams = z.array(AxisParam);

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const tooltipFor =
  (format: (value: number) => string, emptyText: string) =>
  (raw: unknown): string => {
    const parsed = AxisParams.safeParse(Array.isArray(raw) ? raw : [raw]);
    if (!parsed.success || parsed.data.length === 0) {
      return '';
    }
    const [first] = parsed.data;
    const header = first === undefined ? '' : escapeHtml(chartTime(first.axisValue));
    const rows = parsed.data.flatMap((p) => {
      const value = p.value[1];

      return value === null || value === 0
        ? []
        : [`${p.marker}${escapeHtml(p.seriesName)}&nbsp;&nbsp;<b>${escapeHtml(format(value))}</b>`];
    });

    return [`<b>${header}</b>`, ...(rows.length > 0 ? rows : [escapeHtml(emptyText)])].join(
      '<br/>',
    );
  };

const chartTimeOf = (value: unknown): string =>
  typeof value === 'number' || typeof value === 'string' ? chartTime(value) : '';

const axisTime = (ink: Ink, window?: { from: string; to: string }) => ({
  type: 'time' as const,
  ...(window && { min: window.from, max: window.to }),
  axisLine: { lineStyle: { color: ink.grid } },
  axisLabel: { color: ink.muted, hideOverlap: true },
  axisPointer: { label: { formatter: (p: { value: unknown }) => chartTimeOf(p.value) } },
  splitLine: { show: false },
});

const axisValue = (ink: Ink, formatter?: (v: number) => string) => ({
  type: 'value' as const,
  axisLabel: { color: ink.muted, ...(formatter && { formatter }) },
  splitLine: { lineStyle: { color: ink.grid } },
});

const timeOf = (p: Point): number => Date.parse(p.bucket);

const smallestStep = (times: readonly number[]): number | undefined => {
  let step: number | undefined;
  for (let i = 1; i < times.length; i += 1) {
    const prev = times[i - 1];
    const current = times[i];
    if (prev !== undefined && current !== undefined && current > prev) {
      step = step === undefined ? current - prev : Math.min(step, current - prev);
    }
  }

  return step;
};

const withGaps = (
  points: readonly Point[],
  bucketMs: number | undefined,
): [number, number | null][] => {
  const sorted = points
    .map((p): [number, number | null] => [timeOf(p), p.p95Ms])
    .toSorted((a, b) => a[0] - b[0]);
  const step = bucketMs ?? smallestStep(sorted.map(([t]) => t));
  if (step === undefined) {
    return sorted;
  }

  return sorted.flatMap((point, i) => {
    const next = sorted[i + 1];

    return next !== undefined && next[0] - point[0] > step
      ? [point, [point[0] + step, null]]
      : [point];
  });
};

const hasIsolatedPoint = (data: readonly [number, number | null][]): boolean =>
  data.some(
    ([, value], i) =>
      value !== null && (data[i - 1]?.[1] ?? null) === null && (data[i + 1]?.[1] ?? null) === null,
  );

const countRuns = (points: readonly Point[], status: ChartStatus): number =>
  points.reduce((sum, p) => sum + (p.byStatus[status] ?? 0), 0);

const runsSummary = (points: readonly Point[]): string => {
  const parts = CHART_STACK_ORDER.flatMap((status) => {
    const count = countRuns(points, status);

    return count === 0 ? [] : [`${count.toLocaleString()} ${STATUS[status].label.toLowerCase()}`];
  });
  if (parts.length === 0) {
    return 'Runs by outcome: no runs in this period.';
  }
  const busiest = points
    .map((p) => ({
      at: timeOf(p),
      total: CHART_STACK_ORDER.reduce((sum, s) => sum + (p.byStatus[s] ?? 0), 0),
    }))
    .toSorted((a, b) => b.total - a.total)[0];

  return `Runs by outcome: ${parts.join(', ')}.${busiest ? ` Busiest: ${chartTime(busiest.at)} with ${busiest.total.toLocaleString()} runs.` : ''}`;
};

const latencySummary = (data: readonly [number, number | null][]): string => {
  const values = data.flatMap(([at, v]) => (v === null ? [] : [{ at, v }]));
  const highest = values.toSorted((a, b) => b.v - a.v)[0];
  const latest = values.at(-1);
  if (highest === undefined || latest === undefined) {
    return 'p95 latency: no finished runs in this period.';
  }

  return `p95 latency: highest ${duration(highest.v)} at ${chartTime(highest.at)}, latest ${duration(latest.v)} at ${chartTime(latest.at)}.`;
};

interface ChartProps {
  readonly points: readonly Point[];
  readonly height?: number;
  readonly pinnedWindow?: { from: string; to: string };
  readonly bucketMs?: number;
  readonly loading?: boolean;
}

function ChartFrame({
  summary,
  empty,
  height,
  children,
}: {
  summary: string;
  empty: string | undefined;
  height: number;
  children: ReactNode;
}) {
  return (
    <figure style={{ position: 'relative', height, margin: 0 }}>
      <figcaption className="ct-sr-only">{summary}</figcaption>
      <div aria-hidden>{children}</div>
      {empty !== undefined && (
        <Center style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <Text size="sm" color="dimmed">
            {empty}
          </Text>
        </Center>
      )}
    </figure>
  );
}

const NARROW_CHART_QUERY = '(max-width: 600px)';

export function RunsOverTimeChart({
  points,
  height = 260,
  pinnedWindow,
  loading = false,
}: ChartProps) {
  const ink = useInk();
  const empty = useMemo(
    () => CHART_STACK_ORDER.every((status) => countRuns(points, status) === 0),
    [points],
  );
  const summary = useMemo(() => runsSummary(points), [points]);
  const narrow = useMediaQuery(NARROW_CHART_QUERY);
  const option = useMemo<EChartsOption>(
    () => ({
      aria: { enabled: true, label: { description: summary } },
      grid: { left: 40, right: 12, top: narrow ? 60 : 36, bottom: 28 },
      legend: {
        type: 'plain',
        top: 0,
        left: 0,
        right: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: ink.text },
        pageTextStyle: { color: ink.muted },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: tooltipFor((v) => v.toLocaleString(), 'No runs'),
      },
      xAxis: axisTime(ink, pinnedWindow),
      yAxis: { ...axisValue(ink), minInterval: 1 },
      series: CHART_STACK_ORDER.map((status) => {
        const decal = DECAL[status];

        return {
          name: STATUS[status].label,
          type: 'bar',
          stack: 'runs',
          barMaxWidth: 18,
          itemStyle: {
            color: ink.status[status],
            borderColor: ink.surface,
            borderWidth: 1,
            ...(decal && { decal: { ...decal, color: 'rgba(255, 255, 255, 0.45)' } }),
          },
          emphasis: { focus: 'series' },
          data: points.map((p) => [timeOf(p), p.byStatus[status] ?? 0]),
        };
      }),
    }),
    [points, ink, pinnedWindow, summary, narrow],
  );

  return (
    <ChartFrame
      summary={summary}
      empty={empty && !loading ? 'No runs in this period' : undefined}
      height={height}
    >
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        style={{ height }}
        showLoading={loading}
        notMerge
      />
    </ChartFrame>
  );
}

export function LatencyChart({
  points,
  height = 260,
  pinnedWindow,
  bucketMs,
  loading = false,
}: ChartProps) {
  const ink = useInk();
  const data = useMemo(() => withGaps(points, bucketMs), [points, bucketMs]);
  const empty = data.every(([, v]) => v === null);
  const summary = useMemo(() => latencySummary(data), [data]);
  const option = useMemo<EChartsOption>(
    () => ({
      aria: { enabled: true, label: { description: summary } },
      grid: { left: 56, right: 12, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        formatter: tooltipFor((v) => duration(v), 'No finished runs'),
      },
      xAxis: axisTime(ink, pinnedWindow),
      yAxis: axisValue(ink, (v) => duration(v)),
      series: [
        {
          name: 'p95 latency',
          type: 'line',
          showSymbol: data.filter(([, v]) => v !== null).length <= 3 || hasIsolatedPoint(data),
          symbolSize: 6,
          lineStyle: { width: 2, color: ink.latency },
          itemStyle: { color: ink.latency },
          areaStyle: { color: ink.latencyArea },
          connectNulls: false,
          data,
        },
      ],
    }),
    [data, ink, pinnedWindow, summary],
  );

  return (
    <ChartFrame
      summary={summary}
      empty={empty && !loading ? 'No finished runs in this period' : undefined}
      height={height}
    >
      <ReactEChartsCore
        echarts={echarts}
        option={option}
        style={{ height }}
        showLoading={loading}
        notMerge
      />
    </ChartFrame>
  );
}
