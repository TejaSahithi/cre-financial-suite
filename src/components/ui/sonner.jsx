import { Toaster as Sonner } from "sonner"

const Toaster = ({
  ...props
}) => {
  return (
    (<Sonner
      theme="system"
      position="bottom-right"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:w-[min(340px,calc(100vw-32px))] group-[.toaster]:rounded-[9px] group-[.toaster]:border group-[.toaster]:border-[color-mix(in_srgb,var(--accent)_60%,var(--border-cre))] group-[.toaster]:bg-white group-[.toaster]:p-[12px_14px] group-[.toaster]:text-slate-900 group-[.toaster]:shadow-[0_18px_38px_rgba(15,23,42,.16)]",
          title: "group-[.toast]:text-xs group-[.toast]:font-semibold group-[.toast]:text-slate-950",
          description: "group-[.toast]:text-[10px] group-[.toast]:text-slate-600",
          actionButton:
            "group-[.toast]:bg-[var(--accent)] group-[.toast]:text-white",
          cancelButton:
            "group-[.toast]:bg-white/10 group-[.toast]:text-white",
        },
      }}
      {...props} />)
  );
}

export { Toaster }
