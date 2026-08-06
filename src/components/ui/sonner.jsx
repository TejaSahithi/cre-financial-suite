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
            "group toast group-[.toaster]:w-[min(340px,calc(100vw-32px))] group-[.toaster]:rounded-[9px] group-[.toaster]:border group-[.toaster]:border-[color-mix(in_srgb,var(--accent)_60%,var(--border-cre))] group-[.toaster]:bg-[var(--sidebar)] group-[.toaster]:p-[12px_14px] group-[.toaster]:text-white group-[.toaster]:shadow-[0_18px_38px_rgba(0,0,0,.20)]",
          title: "group-[.toast]:text-xs group-[.toast]:font-semibold group-[.toast]:text-[#fff7e8]",
          description: "group-[.toast]:text-[10px] group-[.toast]:text-white/75",
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
