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

export interface SpreadDataPoint {
  timestamp: string;
  iqr: number | null; // combinedIQR
  median: number | null; // combinedMedian
}

interface SpreadAnalysisChartProps {
  stationCode: string;
  data: SpreadDataPoint[];
  climoShape: number | null; // gamma shape for stdev calc
  climoScale: number | null; // gamma scale for stdev calc
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function SpreadAnalysisChart({
  stationCode,
  data,
  climoShape,
  climoScale,
  onClose,
}: SpreadAnalysisChartProps) {
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

  // Filter to points with valid IQR
  const valid = data.filter(
    (d): d is SpreadDataPoint & { iqr: number } => d.iqr !== null,
  );

  if (valid.length < 2) {
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
          Not enough spread data yet
        </p>
      </div>
    );
  }

  const labels = valid.map((d) => formatTimestamp(d.timestamp));

  // Metric 1: IQR / median QPF (%)
  const iqrOverQpf = valid.map((d) => {
    if (d.median == null || d.median <= 0) return null;
    return (d.iqr / d.median) * 100;
  });

  // Metric 2: IQR / climatological stdev (%)
  // Gamma stdev = sqrt(shape) * scale
  const climoStdev =
    climoShape != null && climoScale != null && climoShape > 0
      ? Math.sqrt(climoShape) * climoScale
      : null;
  const iqrOverClimo = valid.map((d) => {
    if (climoStdev == null || climoStdev <= 0) return null;
    return (d.iqr / climoStdev) * 100;
  });

  // Metric 3: IQR z-score (based on mean/stdev of IQR across history)
  const iqrValues = valid.map((d) => d.iqr);
  const hasEnoughForZscore = iqrValues.length >= 10;
  let iqrZscores: (number | null)[] = valid.map(() => null);

  if (hasEnoughForZscore) {
    const mean = iqrValues.reduce((a, b) => a + b, 0) / iqrValues.length;
    const variance =
      iqrValues.reduce((a, b) => a + (b - mean) ** 2, 0) / iqrValues.length;
    const stdev = Math.sqrt(variance);
    if (stdev > 1e-6) {
      iqrZscores = iqrValues.map((v) => (v - mean) / stdev);
    }
  }

  const hasIqrQpf = iqrOverQpf.some((v) => v !== null);
  const hasIqrClimo = iqrOverClimo.some((v) => v !== null);
  const hasZscore = iqrZscores.some((v) => v !== null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const datasets: any[] = [];

  if (hasIqrQpf) {
    datasets.push({
      label: "IQR/QPF %",
      data: iqrOverQpf,
      borderColor: "rgb(59, 130, 246)",
      backgroundColor: "rgb(59, 130, 246)",
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      yAxisID: "yPct",
    });
  }

  if (hasIqrClimo) {
    datasets.push({
      label: "IQR/climo %",
      data: iqrOverClimo,
      borderColor: "rgb(168, 85, 247)",
      backgroundColor: "rgb(168, 85, 247)",
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      yAxisID: "yPct",
    });
  }

  if (hasZscore) {
    datasets.push({
      label: "IQR z-score",
      data: iqrZscores,
      borderColor: "rgb(234, 179, 8)",
      backgroundColor: "rgb(234, 179, 8)",
      borderDash: [4, 3],
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      yAxisID: "yZ",
    });
  }

  const chartData = { labels, datasets };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scales: Record<string, any> = {
    x: {
      grid: { display: false },
      ticks: { font: { size: 10 }, maxRotation: 45 },
    },
  };

  if (hasIqrQpf || hasIqrClimo) {
    scales.yPct = {
      type: "linear" as const,
      position: "left" as const,
      title: {
        display: true,
        text: "% of reference",
        font: { size: 11 },
      },
      grid: { color: "rgba(0,0,0,0.05)" },
      ticks: {
        callback: (value: number | string) => `${value}%`,
        font: { size: 10 },
      },
      min: 0,
    };
  }

  if (hasZscore) {
    scales.yZ = {
      type: "linear" as const,
      position: "right" as const,
      title: {
        display: true,
        text: "z-score",
        font: { size: 11 },
      },
      grid: { drawOnChartArea: false },
      ticks: { font: { size: 10 } },
    };
  }

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
            dataset: { label?: string; yAxisID?: string };
            parsed: { y: number | null };
          }) => {
            const label = context.dataset.label || "";
            const val = context.parsed.y;
            if (val === null) return "";
            if (context.dataset.yAxisID === "yZ") {
              return `${label}: ${val.toFixed(2)}`;
            }
            return `${label}: ${val.toFixed(1)}%`;
          },
        },
      },
    },
    scales,
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
          {stationCode} spread analysis
        </span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
          aria-label="Close chart"
        >
          &#x2715;
        </button>
      </div>
      {!hasEnoughForZscore && (
        <p className="text-[11px] text-amber-500 mb-1">
          IQR z-score: accumulating data ({valid.length}/10 snapshots)
        </p>
      )}
      <div style={{ height: 280 }}>
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
