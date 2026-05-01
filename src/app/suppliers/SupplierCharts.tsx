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
} from "chart.js";
import { Bar, Doughnut } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

const PIE_COLORS = [
  "#2a5c9e", "#1a8a4a", "#c07d0a", "#7a4ab5", "#1a7a8a",
  "#c03030", "#3a4a5e", "#5a6a7e", "#7a8a9e", "#a0a8b6",
  "#3eaa6a", "#d68f1a", "#c45a30", "#1e4a82",
];

type Item = { category?: string | null; origin?: string | null };

export function CategoryChart({
  data, onSelect,
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

  return (
    <Bar
      data={{
        labels,
        datasets: [{ data: values, backgroundColor: "#2a5c9e", borderRadius: 4 }],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 } },
        },
        onClick: (_evt, elements) => {
          if (elements.length) onSelect(labels[elements[0].index]);
        },
      }}
    />
  );
}

export function OriginChart({
  data, onSelect,
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

  return (
    <Doughnut
      data={{
        labels,
        datasets: [{ data: values, backgroundColor: PIE_COLORS, borderColor: "#fff", borderWidth: 2 }],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { font: { size: 11 }, boxWidth: 12 } },
        },
        onClick: (_evt, elements) => {
          if (elements.length) onSelect(labels[elements[0].index]);
        },
      }}
    />
  );
}
