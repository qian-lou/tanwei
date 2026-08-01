import type { RiskLevel } from "@shared/contracts";
import {
  EyeIcon,
  GaugeIcon,
  OctagonAlertIcon,
  ShieldAlertIcon,
  TimerIcon,
  type LucideIcon,
} from "lucide-react";

import { t } from "../i18n";
import { Badge } from "./ui/badge";

interface RiskPresentation {
  readonly description: string;
  readonly icon: LucideIcon;
  readonly variant: "outline" | "secondary" | "destructive";
}

const RISK_PRESENTATIONS: Readonly<Record<RiskLevel, RiskPresentation>> = {
  R0: {
    description: "只读低成本",
    icon: EyeIcon,
    variant: "outline",
  },
  R1: {
    description: "持续或中等成本",
    icon: TimerIcon,
    variant: "outline",
  },
  R2: {
    description: "增强或大结果",
    icon: GaugeIcon,
    variant: "secondary",
  },
  R3: {
    description: "运行时修改",
    icon: ShieldAlertIcon,
    variant: "secondary",
  },
  R4: {
    description: "进程级影响",
    icon: OctagonAlertIcon,
    variant: "destructive",
  },
};

export interface RiskPillProps {
  readonly level: RiskLevel;
  readonly compact?: boolean;
}

export default function RiskPill({ level, compact = false }: RiskPillProps) {
  const presentation = RISK_PRESENTATIONS[level];
  const Icon = presentation.icon;
  const description = t(presentation.description);

  return (
    <Badge
      variant={presentation.variant}
      className="min-h-8 gap-2 px-3"
      aria-label={`${level} · ${description}`}
      data-risk-level={level}
      title={`${level} · ${description}`}
    >
      <Icon
        aria-hidden="true"
        data-slot="risk-pill-icon"
        data-risk-level={level}
      />
      {compact ? level : `${level} · ${description}`}
    </Badge>
  );
}
