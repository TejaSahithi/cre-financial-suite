import * as React from "react";

function getReducedMotionPreference() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function parseFormattedNumber(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "—" || text === "-") return null;
  if (text.includes("/") && !text.endsWith("/SF")) return null;

  const match = text.match(/^(-?)(\$?)(\d[\d,]*(?:\.\d+)?)(\s?(?:K|M|B|SF|K SF|M SF|B SF|%|\/SF)?)$/i);
  if (!match) return null;

  const [, sign, prefix, rawNumber, suffix = ""] = match;
  const numeric = Number(rawNumber.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;

  return {
    target: sign === "-" ? -numeric : numeric,
    prefix,
    suffix,
    decimals: rawNumber.includes(".") ? rawNumber.split(".")[1].length : 0,
    useGrouping: rawNumber.includes(","),
  };
}

function formatFrame(value, parsed) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const number = absolute.toLocaleString("en-US", {
    minimumFractionDigits: parsed.decimals,
    maximumFractionDigits: parsed.decimals,
    useGrouping: parsed.useGrouping,
  });

  return `${sign}${parsed.prefix}${number}${parsed.suffix}`;
}

export default function CountUpValue({ value, duration = 800 }) {
  const finalText = String(value ?? "—");
  const [displayText, setDisplayText] = React.useState(finalText);

  React.useEffect(() => {
    const parsed = parseFormattedNumber(finalText);
    if (!parsed || getReducedMotionPreference()) {
      setDisplayText(finalText);
      return undefined;
    }

    let frameId;
    const start = performance.now();

    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      if (progress >= 1) {
        setDisplayText(finalText);
        return;
      }

      setDisplayText(formatFrame(parsed.target * eased, parsed));
      frameId = requestAnimationFrame(tick);
    };

    setDisplayText(formatFrame(0, parsed));
    frameId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameId);
  }, [duration, finalText]);

  return (
    <>
      <span aria-hidden="true">{displayText}</span>
      <span className="sr-only">{finalText}</span>
    </>
  );
}
