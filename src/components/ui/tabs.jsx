import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex min-h-[38px] items-center justify-center gap-1 rounded-[9px] border border-[var(--border-cre)] bg-[var(--surface)] p-2 text-[var(--muted)] shadow-[var(--shadow-soft)]",
      className
    )}
    {...props} />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex min-h-[38px] items-center justify-center whitespace-nowrap rounded-[7px] border border-transparent px-[14px] py-1 text-sm font-semibold text-[var(--muted)] ring-offset-background transition-[transform,background,color,box-shadow,border] [transition-duration:160ms] hover:-translate-y-0.5 hover:bg-[var(--surface-2)] hover:text-[var(--ink)] hover:shadow-[0_8px_16px_rgba(60,46,36,.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-[color-mix(in_srgb,var(--accent)_45%,var(--border-cre))] data-[state=active]:bg-[var(--accent-soft)] data-[state=active]:text-[var(--ink)] data-[state=active]:after:absolute data-[state=active]:after:bottom-[3px] data-[state=active]:after:left-3 data-[state=active]:after:right-3 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-[var(--accent)]",
      className
    )}
    {...props} />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props} />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
