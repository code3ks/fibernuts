import { ChevronRight } from "lucide-react";

import { presentOperation, type WalletOperation } from "../domain/operations";
import { fmt } from "../lib/wallet";
import { OperationGlyph, StatusBadge } from "./Primitives";

function operationTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function mintHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function OperationList({
  operations,
  onOpen,
  compact = false,
}: {
  operations: WalletOperation[];
  onOpen: (operation: WalletOperation) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "operation-list operation-list--compact" : "operation-list"}>
      {operations.map((operation) => {
        const presentation = presentOperation(operation);
        const sign = presentation.direction === "in" ? "+" : "-";
        return (
          <button type="button" className="operation-row" key={operation.id} onClick={() => onOpen(operation)}>
            <span className={`operation-row__glyph operation-row__glyph--${presentation.tone}`}>
              <OperationGlyph operation={operation} />
            </span>
            <span className="operation-row__main">
              <strong>{operation.note ? `${presentation.title} - ${operation.note}` : presentation.title}</strong>
              <span>{operationTime(operation.updatedAt)}{compact ? "" : ` - ${mintHost(operation.mintUrl)}`}</span>
            </span>
            <span className="operation-row__value">
              <strong>
                {sign}
                {fmt(operation.amount)}
              </strong>
              <StatusBadge tone={presentation.tone}>{presentation.stateShort}</StatusBadge>
            </span>
            <ChevronRight className="operation-row__chevron" size={16} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
