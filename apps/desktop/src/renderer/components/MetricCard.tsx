import { t } from "../i18n";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";

export interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly points: readonly number[];
  readonly pattern?: "solid" | "dashed" | "dotted";
}

function createPath(points: readonly number[]): string {
  const finitePoints = points.filter(Number.isFinite);
  if (finitePoints.length === 0) {
    return "";
  }
  let minimum = finitePoints[0] ?? 0;
  let maximum = minimum;
  for (let index = 1; index < finitePoints.length; index += 1) {
    const point = finitePoints[index];
    if (point === undefined) {
      continue;
    }
    minimum = Math.min(minimum, point);
    maximum = Math.max(maximum, point);
  }
  const measuredRange = maximum - minimum;
  const minimumVisibleRange = Math.max(Math.abs(maximum) * 0.01, 0.01);
  const visibleRange = Math.max(measuredRange, minimumVisibleRange);
  const domainCenter = (minimum + maximum) / 2;
  const domainPadding = visibleRange * 0.1;
  const domainMinimum = domainCenter - visibleRange / 2 - domainPadding;
  const domainRange = visibleRange + domainPadding * 2;
  const denominator = Math.max(finitePoints.length - 1, 1);
  return finitePoints
    .map((point, index) => {
      const x = (index / denominator) * 100;
      const y = 36 - ((point - domainMinimum) / domainRange) * 32;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function MetricCard({
  label,
  value,
  detail,
  points,
  pattern = "solid",
}: MetricCardProps) {
  return (
    <Card
      data-runtime-metric
      className="grid min-h-36 grid-cols-1 gap-5 p-5 py-5 sm:grid-cols-2"
    >
      <div className="grid content-start gap-2">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </p>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </div>
      <svg
        className="text-foreground h-full min-h-20 w-full"
        viewBox="0 0 100 40"
        role="img"
        aria-label={t("{label}最近趋势：{points}", {
          label,
          points: points.join(", "),
        })}
        preserveAspectRatio="none"
      >
        <path
          d={createPath(points)}
          vectorEffect="non-scaling-stroke"
          className={cn(
            "fill-none stroke-current [stroke-width:2px]",
            pattern === "dashed" && "[stroke-dasharray:8_6]",
            pattern === "dotted" && "[stroke-dasharray:2_6]",
          )}
        />
      </svg>
    </Card>
  );
}
