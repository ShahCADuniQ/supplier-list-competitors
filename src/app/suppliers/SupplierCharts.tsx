"use client";

import { useMemo } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  type ScriptableContext,
} from "chart.js";
import { Bar, Doughnut } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

// Multi-hue palette for the donut — dark-mode friendly, vivid against
// both light and dark surfaces. Pulled from the Dribbble reference.
const DONUT_PALETTE = [
  "#2563ff", // cobalt
  "#4ade80", // lime
  "#ff4d2e", // orange
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#34d399", // teal
  "#60a5fa", // sky
  "#f97316", // tangerine
  "#a3e635", // chartreuse
  "#e879f9", // magenta
  "#94a3b8", // slate
  "#fb7185", // rose
];

// Read a CSS custom property at render time so charts respect theme.
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

// Linear top-to-bottom gradient (lime → cobalt) for bar fills.
function makeBarGradient(ctx: ScriptableContext<"bar">) {
  const chart = ctx.chart;
  const { ctx: c, chartArea } = chart;
  if (!chartArea) return "#2563ff";
  const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, cssVar("--lb-chart-bar-top", "#4ade80"));
  gradient.addColorStop(1, cssVar("--lb-chart-bar-bottom", "#1740d4"));
  return gradient;
}

type Item = { category?: string | null; origin?: string | null };

export function CategoryChart({
  data,
  onSelect,
}: {
  data: Item[];
  onSelect: (category: string) => void;
}) {
  const { labels, values } = useMemo(() => {
    const counts: Record<string, number> = {};
    data.forEach((s) => {
      if (s.category) counts[s.category] = (counts[s.category] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { labels: sorted.map((e) => e[0]), values: sorted.map((e) => e[1]) };
  }, [data]);

  const tickColor = cssVar("--lb-text-2", "#a0a3ad");
  const gridColor = cssVar("--lb-border", "rgba(255,255,255,0.06)");

  return (
    <Bar
      data={{
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: (ctx) => makeBarGradient(ctx),
            borderRadius: 6,
            borderSkipped: false,
            maxBarThickness: 36,
          },
        ],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0, color: tickColor, font: { size: 11 } },
            grid: { color: gridColor },
            border: { display: false },
          },
          x: {
            ticks: {
              autoSkip: false,
              maxRotation: 35,
              minRotation: 0,
              color: tickColor,
              font: { size: 11 },
            },
            grid: { display: false },
            border: { color: gridColor },
          },
        },
        onClick: (_evt, elements) => {
          if (elements.length) onSelect(labels[elements[0].index]);
        },
      }}
    />
  );
}

export function OriginChart({
  data,
  onSelect,
}: {
  data: Item[];
  onSelect: (origin: string) => void;
}) {
  const { labels, values } = useMemo(() => {
    const counts: Record<string, number> = {};
    data.forEach((s) => {
      if (s.origin) counts[s.origin] = (counts[s.origin] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return { labels: sorted.map((e) => e[0]), values: sorted.map((e) => e[1]) };
  }, [data]);

  const surfaceColor = cssVar("--lb-bg-elev", "#1a1c22");
  const labelColor = cssVar("--lb-text-2", "#a0a3ad");

  return (
    <Doughnut
      data={{
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: DONUT_PALETTE,
            borderColor: surfaceColor,
            borderWidth: 3,
            spacing: 1,
          },
        ],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: labelColor,
              font: { size: 11 },
              boxWidth: 10,
              boxHeight: 10,
              padding: 8,
              usePointStyle: true,
              pointStyle: "circle",
            },
          },
        },
        onClick: (_evt, elements) => {
          if (elements.length) onSelect(labels[elements[0].index]);
        },
      }}
    />
  );
}
