import { useMantineColorScheme } from '@mantine/core';
import type { EChartsOption } from 'echarts';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';

import type { ApiClient } from '../lib/api';
import { duration } from '../lib/format';
import { CHART_STACK_ORDER, STATUS } from '../lib/status';

type Point = Awaited<ReturnType<ApiClient['analytics']['timeseries']>>[number];

const useInk = () => {
  const dark = useMantineColorScheme().colorScheme === 'dark';

  return dark
    ? { text: '#e6ebf2', muted: '#93a0b4', grid: '#273141', surface: '#161d27' }
    : { text: '#18212f', muted: '#66738a', grid: '#e7ebf1', surface: '#ffffff' };
};

const axisTime = (ink: ReturnType<typeof useInk>, window?: { from: string; to: string }) => ({
  type: 'time' as const,
  ...(window && { min: window.from, max: window.to }),
  axisLine: { lineStyle: { color: ink.grid } },
  axisLabel: { color: ink.muted, hideOverlap: true },
  splitLine: { show: false },
});
const axisValue = (ink: ReturnType<typeof useInk>, formatter?: (v: number) => string) => ({
  type: 'value' as const,
  axisLabel: { color: ink.muted, ...(formatter && { formatter }) },
  splitLine: { lineStyle: { color: ink.grid } },
});

interface ChartProps {
  readonly points: readonly Point[];
  readonly height?: number;
  readonly pinnedWindow?: { from: string; to: string };
}

export function RunsOverTimeChart({ points, height = 260, pinnedWindow }: ChartProps) {
  const ink = useInk();
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 40, right: 12, top: 36, bottom: 28 },
      legend: {
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: ink.text },
      },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: axisTime(ink, pinnedWindow),
      yAxis: axisValue(ink),
      series: CHART_STACK_ORDER.map((status) => ({
        name: STATUS[status].label,
        type: 'bar',
        stack: 'runs',
        barMaxWidth: 18,
        itemStyle: { color: STATUS[status].color, borderColor: ink.surface, borderWidth: 1 },
        emphasis: { focus: 'series' },
        data: points.map((p) => [p.bucket, p.byStatus[status] ?? 0]),
      })),
    }),
    [points, ink, pinnedWindow],
  );

  return <ReactECharts option={option} style={{ height }} notMerge />;
}

export function LatencyChart({ points, height = 260, pinnedWindow }: ChartProps) {
  const ink = useInk();
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 56, right: 12, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? duration(v) : '—'),
      },
      xAxis: axisTime(ink, pinnedWindow),
      yAxis: axisValue(ink, (v) => duration(v)),
      series: [
        {
          name: 'p95 latency',
          type: 'line',
          showSymbol: false,
          symbolSize: 8,
          lineStyle: { width: 2, color: '#2a5bd7' },
          itemStyle: { color: '#2a5bd7' },
          areaStyle: { color: 'rgba(42, 91, 215, 0.08)' },
          connectNulls: false,
          data: points.map((p) => [p.bucket, p.p95Ms]),
        },
      ],
    }),
    [points, ink, pinnedWindow],
  );

  return <ReactECharts option={option} style={{ height }} notMerge />;
}
