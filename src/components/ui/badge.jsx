import * as React from "react"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex min-h-[22px] items-center whitespace-nowrap rounded-full border px-2 py-[3px] text-[10px] font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--info-soft)] text-[var(--info)]",
        secondary:
          "border-transparent bg-[var(--surface-2)] text-[var(--muted)]",
        destructive:
          "border-transparent bg-[var(--danger-soft)] text-[var(--danger)]",
        outline: "border-[var(--border-cre)] bg-[var(--surface)] text-[var(--ink)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}) {
  return (<div className={cn(badgeVariants({ variant }), className)} {...props} />);
}

export { Badge, badgeVariants }
