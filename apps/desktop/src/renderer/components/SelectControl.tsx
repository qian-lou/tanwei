import type { ComponentProps, ReactNode } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SELECT_VALUE_PREFIX = "tanwei-select-value:";

function encodeValue(value: string | number): string {
  return `${SELECT_VALUE_PREFIX}${String(value)}`;
}

function decodeValue(value: string): string {
  return value.startsWith(SELECT_VALUE_PREFIX)
    ? value.slice(SELECT_VALUE_PREFIX.length)
    : value;
}

interface SelectControlProps {
  readonly children: ReactNode;
  readonly value: string | number;
  readonly disabled?: boolean;
  readonly onValueChange: (value: string) => void;
}

function SelectControl({
  children,
  value,
  disabled = false,
  onValueChange,
}: SelectControlProps) {
  return (
    <Select
      value={encodeValue(value)}
      disabled={disabled}
      onValueChange={(nextValue) => onValueChange(decodeValue(nextValue))}
    >
      <SelectTrigger className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

type SelectControlItemProps = Omit<
  ComponentProps<typeof SelectItem>,
  "value"
> & {
  readonly value: string | number;
};

function SelectControlItem({ value, ...props }: SelectControlItemProps) {
  return <SelectItem value={encodeValue(value)} {...props} />;
}

export { SelectControl, SelectControlItem };
