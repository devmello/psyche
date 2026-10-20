import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ReactElement, ReactNode } from "react";
import { RadioGroupItem } from "../../components/ui/radio-group.tsx";
import { TableCell, TableRow } from "../../components/ui/table.tsx";

/**
 * A matrix row whose cells hold one choice each (docs/ui-audit.md decision 2): the row is one
 * radio group, so Tab enters it once and the arrow keys move between its cells, and each cell
 * is a kit `RadioGroupItem` labelled "row: column". The row keeps its table role.
 */
export function RadioTableRow<T extends string>({
  label,
  header,
  options,
  value,
  onChange,
  disabled = false,
  rowProps,
}: {
  /** Names the row in each cell's label ("Notes: Ask"). */
  label: string;
  /** The row's leading cells (its name, a key at level 2). */
  header: ReactNode;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  rowProps?: Record<string, string>;
}): ReactElement {
  return (
    <RadioGroupPrimitive
      render={<TableRow {...rowProps} />}
      role="row"
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(v) => onChange(v as T)}
    >
      {header}
      {options.map((o) => (
        <TableCell key={o.value} className="text-center">
          <span className="inline-flex justify-center">
            <RadioGroupItem value={o.value} aria-label={`${label}: ${o.label}`} />
          </span>
        </TableCell>
      ))}
    </RadioGroupPrimitive>
  );
}
