import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex min-h-[38px] items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[var(--border-strong)] px-[13px] text-sm font-semibold text-[var(--ink)] transition-[transform,box-shadow,background,border,color] [transition-duration:160ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:translate-y-0 active:scale-[.98] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[var(--accent)] bg-[var(--accent)] text-white shadow-sm hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--accent-2)] hover:shadow-[var(--shadow-soft)]",
        destructive:
          "border-[var(--danger)] bg-[var(--danger)] text-white shadow-sm hover:-translate-y-0.5 hover:border-[var(--danger)] hover:bg-[var(--danger)] hover:shadow-[var(--shadow-soft)]",
        outline:
          "bg-[var(--surface)] hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--surface-2)] hover:shadow-[var(--shadow-soft)]",
        secondary:
          "border-[var(--border-cre)] bg-[var(--surface-2)] text-[var(--ink)] shadow-sm hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-[var(--shadow-soft)]",
        ghost: "border-transparent bg-transparent hover:-translate-y-0.5 hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
        link: "min-h-0 border-transparent bg-transparent p-0 text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[38px]",
        sm: "h-8 min-h-8 rounded-lg px-3 text-xs",
        lg: "h-10 rounded-lg px-8",
        icon: "h-[38px] w-[38px] px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    (<Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />)
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
