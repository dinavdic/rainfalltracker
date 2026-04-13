"use client";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
);

export interface TrendDataPoint {
  timestamp: string;
  combinedProb: number;
  gefsProb: number | null;
  ecmwfProb: number | null;
  marketProb: number | null; // cents 0-100 (= percent)
}

interface ProbabilityTrendChartProps {
  stationCode: string;
  threshold: string;
  climatologyProb: number; // 0-1
  data: TrendDataPoint[];
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function ProbabilityTrendChart({
  stationCode,
  threshold,
  climatologyProb,
  data,
  onClose,
}: ProbabilityTrendChartProps) {
  if (data.length < 2) {
    return (
      <div
        className="relative border-t border-gray-100 px-4 py-6 text-center"
        style={{ animation: "expandChart 0.2s ease-out" }}
      >
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
          aria-label="Close chart"
        >
          &#x2715;
        </button>
        <p className="text-sm text-gray-400 italic">
          Not enough history yet &mdash; check back after a few cron cycles
        </p>
      </div>
    );
  }

  const labels = data.map((d) => formatTimestamp(d.timestamp));
  const climoLine = data.map(() => climatologyProb * 100);

  const hasGefs = data.some((d) => d.gefsProb !== null);
  const hasEcmwf = data.some((d) => d.ecmwfProb !== null);
  const hasMarket = data.some((d) => d.marketProb !== null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const datasets: any[] = [
    {
      label: "Climatology",
      data: climoLine,
      borderColor: "rgba(156, 163, 175, 0.5)",
      borderDash: [8, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
      order: 5,
    },
    {
      label: "Ensemble (combined)",
      data: data.map((d) => Math.round(d.combinedProb * 1000) / 10),
      borderColor: "rgb(59, 130, 246)",
      backgroundColor: "rgb(59, 130, 246)",
      borderWidth: 2.5,
      pointRadius: 3,
      pointHoverRadius: 5,
      fill: false,
      tension: 0.2,
      order: 1,
    },
  ];

  if (hasGefs) {
    datasets.push({
      label: "GEFS",
      data: data.map((d) =>
        d.gefsProb !== null ? Math.round(d.gefsProb * 1000) / 10 : null
      ),
      borderColor: "rgba(34, 197, 94, 0.7)",
      backgroundColor: "rgba(34, 197, 94, 0.7)",
      borderDash: [4, 3],
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      order: 2,
    });
  }

  if (hasEcmwf) {
    datasets.push({
      label: "ECMWF",
      data: data.map((d) =>
        d.ecmwfProb !== null ? Math.round(d.ecmwfProb * 1000) / 10 : null
      ),
      borderColor: "rgba(168, 85, 247, 0.7)",
      backgroundColor: "rgba(168, 85, 247, 0.7)",
      borderDash: [4, 3],
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      order: 3,
    });
  }

  if (hasMarket) {
    datasets.push({
      label: "Market (Kalshi)",
      data: data.map((d) => d.marketProb),
      borderColor: "rgba(107, 114, 128, 0.7)",
      backgroundColor: "rgba(107, 114, 128, 0.7)",
      borderDash: [2, 2],
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      order: 4,
    });
  }

  const chartData = { labels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "top" as const,
        labels: {
          usePointStyle: true,
          boxWidth: 8,
          font: { size: 11 },
        },
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        callbacks: {
          title: (items: { label: string }[]) => items[0]?.label ?? "",
          label: (context: {
            dataset: { label?: string };
            parsed: { y: number | null };
          }) => {
            const label = context.dataset.label || "";
            const val = context.parsed.y;
            return val !== null ? `${label}: ${val.toFixed(1)}%` : "";
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 10 }, maxRotation: 45 },
      },
      y: {
        min: 0,
        max: 100,
        title: {
          display: true,
          text: "Probability (%)",
          font: { size: 11 },
        },
        grid: { color: "rgba(0,0,0,0.05)" },
        ticks: {
          callback: (value: number | string) => `${value}%`,
          font: { size: 10 },
        },
      },
    },
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
  };

  return (
    <div
      className="relative border-t border-gray-100 px-3 py-3"
      style={{ animation: "expandChart 0.2s ease-out" }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600">
          {stationCode} &gt;{threshold}&quot; probability trend
        </span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
          aria-label="Close chart"
        >
          &#x2715;
        </button>
      </div>
      <div style={{ height: 300 }}>
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
