import React from "react";

const markSrc = "/assets/proforma-os-mark.png";

export default function ProFormaBrand({ className = "", compact = false, tone = "default" }) {
  const toneClass = tone === "light" ? "pf-brand-lockup-light" : "pf-brand-lockup-default";

  return (
    <span className={`pf-brand-lockup ${toneClass} ${compact ? "pf-brand-lockup-compact" : ""} ${className}`.trim()} aria-label="ProForma OS. Budget. Forecast. Plan. Decide.">
      <img src={markSrc} alt="" aria-hidden="true" className="pf-brand-mark" />
      {!compact && (
        <span className="pf-brand-copy" aria-hidden="true">
          <span className="pf-brand-name">ProForma <span>OS</span></span>
          <span className="pf-brand-tagline">Budget. Forecast. Plan. Decide.</span>
        </span>
      )}
    </span>
  );
}
