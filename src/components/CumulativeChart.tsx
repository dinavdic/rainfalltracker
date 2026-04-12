"use client";

import { useRef, useEffect, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { HistoricalData } from "@/lib/types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

interface CumulativeChartProps {
  historical: HistoricalData;
  stations: string[];
  month: number;
  dayOfMonth: number;
  mtdValues: Record<string, number | null>;
}

export default function CumulativeChart({
  historical,
  stations,
  month,
  dayOfMonth,
  mtdValues,
}: CumulativeChartProps) {
  const [selectedStation, setSelectedStation] = useState(stations[0] || "SFO");
  const chartRef = useRef<ChartJS<"line">>(null);

  const stationData = historical.stations[selectedStation];
  const monthData = stationData?.months[String(month)];
  const dim = monthData?.days_in_month ?? 30;

  // Build labels: day 1 through dim
  const labels = Array.from({ length: dim }, (_, i) => String(i + 1));

  // Historical percentile bands
  const cumPerc = monthData?.cumulative_percentiles ?? {};
  const p10: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p90: number[] = [];

  for (let d = 1; d <= dim; d++) {
    const cp = cumPerc[String(d)];
    p10.push(cp?.p10 ?? 0);
    p25.push(cp?.p25 ?? 0);
    p50.push(cp?.p50 ?? 0);
    p75.push(cp?.p75 ?? 0);
    p90.push(cp?.p90 ?? 0);
  }

  // Actual cumulative rainfall through today (we only have MTD, not daily)
  // Show a single point at the current day
  const actualData: (number | null)[] = Array(dim).fill(null);
  const mtd = mtdValues[selectedStation];
  if (mtd !== null && mtd !== undefined && dayOfMonth >= 1 && dayOfMonth <= dim) {
    actualData[dayOfMonth - 1] = mtd;
  }

  const data = {
    labels,
    datasets: [
      {
        label: "90th percentile",
        data: p90,
        borderColor: "transparent",
        backgroundColor: "rgba(59, 130, 246, 0.08)",
        fill: "+1",
        pointRadius: 0,
        tension: 0.3,
      },
      {
        label: "75th percentile",
        data: p75,
        borderColor: "transparent",
        backgroundColor: "rgba(59, 130, 246, 0.10)",
        fill: "+1",
        pointRadius: 0,
        tension: 0.3,
      },
      {
        label: "Median",
        data: p50,
        borderColor: "rgba(59, 130, 246, 0.5)",
        borderDash: [5, 5],
        backgroundColor: "rgba(59, 130, 246, 0.10)",
        fill: "+1",
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.3,
      },
      {
        label: "25th percentile",
        data: p25,
        borderColor: "transparent",
        backgroundColor: "rgba(59, 130, 246, 0.08)",
        fill: "+1",
        pointRadius: 0,
        tension: 0.3,
      },
      {
        label: "10th percentile",
        data: p10,
        borderColor: "transparent",
        backgroundColor: "transparent",
        fill: false,
        pointRadius: 0,
        tension: 0.3,
      },
      {
        label: `${selectedStation} actual`,
        data: actualData,
        borderColor: "rgb(239, 68, 68)",
        backgroundColor: "rgb(239, 68, 68)",
        pointRadius: 6,
        pointStyle: "circle",
        showLine: false,
        fill: false,
      },
    ],
  };

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
          filter: (item: { text: string }) => {
            return ["Median", `${selectedStation} actual`].includes(item.text);
          },
        },
      },
      tooltip: {
        callbacks: {
          label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => {
            const label = context.dataset.label || "";
            const val = context.parsed.y;
            return val !== null ? `${label}: ${val.toFixed(2)}"` : "";
          },
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: "Day of month", font: { size: 12 } },
        grid: { display: false },
      },
      y: {
        title: { display: true, text: "Cumulative rainfall (in)", font: { size: 12 } },
        beginAtZero: true,
        grid: { color: "rgba(0,0,0,0.05)" },
      },
    },
  };

  // Force chart update when station changes
  useEffect(() => {
    chartRef.current?.update();
  }, [selectedStation]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Cumulative rainfall vs. historical range
        </h2>
        <select
          value={selectedStation}
          onChange={(e) => setSelectedStation(e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-700 bg-white"
        >
          {stations.map((s) => (
            <option key={s} value={s}>
              {s} — {historical.stations[s]?.city}
            </option>
          ))}
        </select>
      </div>
      <div className="h-72">
        <Line ref={chartRef} data={data} options={options} />
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Shaded area: 10th–90th percentile range. Dashed line: historical median.
        Red dot: current MTD.
      </p>
    </div>
  );
}
