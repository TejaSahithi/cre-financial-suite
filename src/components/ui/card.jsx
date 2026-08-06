import * as React from "react"

import { cn } from "@/lib/utils"

const Card = React.forwardRef(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("rounded-[var(--radius)] border border-[var(--border-cre)] bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-soft)] transition-[border,box-shadow,transform] [transition-duration:180ms]", className)}
    {...props}>
    {children}
  </div>
))
Card.displayName = "Card"

const CardHeader = React.forwardRef(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 border-b border-[var(--border-cre)] p-[13px_15px]", className)}
    {...props}>
    {children}
  </div>
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm font-semibold leading-none tracking-normal text-[var(--ink)]", className)}
    {...props}>
    {children}
  </div>
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-[11px] text-[var(--muted)]", className)}
    {...props} />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef(({ className, children, ...props }, ref) => (
  <div ref={ref} className={cn("p-[14px_15px]", className)} {...props}>
    {children}
  </div>
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center border-t border-[var(--border-cre)] p-[13px_15px]", className)}
    {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
