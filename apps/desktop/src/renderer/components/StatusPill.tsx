import { CircleCheckIcon, CircleIcon, CircleXIcon } from "lucide-react";

import { t } from "../i18n";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";

export interface StatusPillProps {
  readonly state: "ready" | "idle" | "working" | "error";
  readonly label: string;
}

function StatusIcon({ state }: Pick<StatusPillProps, "state">) {
  const sharedProps = {
    "aria-hidden": true,
    "data-slot": "status-pill-icon",
    "data-state": state,
  } as const;

  switch (state) {
    case "ready":
      return <CircleCheckIcon {...sharedProps} />;
    case "working":
      return <Spinner {...sharedProps} />;
    case "error":
      return <CircleXIcon {...sharedProps} />;
    default:
      return <CircleIcon {...sharedProps} />;
  }
}

export default function StatusPill({ state, label }: StatusPillProps) {
  const variant = state === "error" ? "destructive" : "outline";
  return (
    <Badge
      variant={variant}
      className={`status-pill status-pill--${state}`}
    >
      <StatusIcon state={state} />
      {t(label)}
    </Badge>
  );
}
