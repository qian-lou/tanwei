import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface DisclosureProps
  extends Omit<
    React.ComponentProps<typeof Collapsible>,
    "children" | "defaultOpen"
  > {
  readonly trigger: React.ReactNode;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly triggerClassName?: string;
  readonly contentClassName?: string;
}

/** A shadcn Collapsible composition for inspector evidence sections. */
function Disclosure({
  trigger,
  children,
  defaultOpen = false,
  className,
  triggerClassName,
  contentClassName,
  ...props
}: DisclosureProps) {
  return (
    <Collapsible {...props} className={className} defaultOpen={defaultOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "h-auto w-full justify-between whitespace-normal",
            triggerClassName,
          )}
        >
          {trigger}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className={contentClassName}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export { Disclosure };
