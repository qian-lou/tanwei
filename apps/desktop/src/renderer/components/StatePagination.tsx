import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";

interface StatePaginationProps {
  readonly ariaLabel: string;
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly previousDisabled: boolean;
  readonly nextDisabled: boolean;
  readonly summary?: ReactNode;
  readonly className?: string;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

export default function StatePagination({
  ariaLabel,
  previousLabel,
  nextLabel,
  previousDisabled,
  nextDisabled,
  summary,
  className,
  onPrevious,
  onNext,
}: StatePaginationProps) {
  return (
    <Pagination className={className} aria-label={ariaLabel}>
      <PaginationContent className="w-full justify-between">
        <PaginationItem>
          <Button
            type="button"
            variant="outline"
            disabled={previousDisabled}
            aria-label={previousLabel}
            onClick={onPrevious}
          >
            {previousLabel}
          </Button>
        </PaginationItem>
        {summary !== undefined && (
          <PaginationItem>
            <span data-slot="pagination-summary" aria-live="polite">
              {summary}
            </span>
          </PaginationItem>
        )}
        <PaginationItem>
          <Button
            type="button"
            variant="outline"
            disabled={nextDisabled}
            aria-label={nextLabel}
            onClick={onNext}
          >
            {nextLabel}
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
