import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef(({ className, type, ...props }, ref) => {
  return (
    (<input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1 text-sm text-[var(--ink)] shadow-none transition-[border,box-shadow,transform] [transition-duration:160ms] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[var(--ink)] placeholder:text-[var(--muted)] focus-visible:-translate-y-px focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-[0_0_0_4px_rgba(183,138,72,.12)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props} />)
  );
})
Input.displayName = "Input"

export { Input }
