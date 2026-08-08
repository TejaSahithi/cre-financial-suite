import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Play, Shield, Zap, Building2, BarChart3, Calculator, FileCheck2 } from "lucide-react";
import { motion, useInView, useReducedMotion } from "framer-motion";

const stats = [
  { value: "500+", label: "Properties Managed" },
  { value: "$2.4B", label: "Assets Under Management" },
  { value: "98%", label: "CAM Accuracy Rate" },
  { value: "60%", label: "Time Saved on Reconciliation" },
];

const animatedLine = "Commercial Real Estate Finance";

const heroMetrics = [
  { icon: BarChart3, label: "Portfolio variance", value: "$2.4B AUM", meta: "Budget and actuals in one view" },
  { icon: Calculator, label: "CAM automation", value: "98% accuracy", meta: "Recoveries tied to lease rules" },
  { icon: FileCheck2, label: "Lease intelligence", value: "500+ properties", meta: "Document-backed finance workflows" },
];

function splitMetricValue(value) {
  const match = value.match(/^([^0-9-]*)([\d,]+(?:\.\d+)?)(.*)$/);
  if (!match) return null;

  const [, prefix, numericValue, suffix] = match;
  const decimalPlaces = numericValue.includes(".") ? numericValue.split(".")[1].length : 0;

  return {
    prefix,
    target: Number(numericValue.replace(/,/g, "")),
    suffix,
    decimalPlaces,
  };
}

function formatMetricValue(value, progress) {
  const parsed = splitMetricValue(value);
  if (!parsed) return value;

  const easedValue = parsed.target * progress;
  const numberValue = parsed.decimalPlaces
    ? easedValue.toFixed(parsed.decimalPlaces)
    : Math.round(easedValue).toLocaleString();

  return `${parsed.prefix}${numberValue}${parsed.suffix}`;
}

function CountUpValue({ value, active, className }) {
  const prefersReducedMotion = useReducedMotion();
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    if (prefersReducedMotion || !active) {
      setDisplayValue(value);
      return undefined;
    }

    const duration = 900;
    let frameId;
    let startTime;

    const animate = (time) => {
      if (!startTime) startTime = time;
      const rawProgress = Math.min((time - startTime) / duration, 1);
      const easedProgress = 1 - Math.pow(1 - rawProgress, 3);

      setDisplayValue(formatMetricValue(value, easedProgress));

      if (rawProgress < 1) {
        frameId = requestAnimationFrame(animate);
      }
    };

    setDisplayValue(formatMetricValue(value, 0));
    frameId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(frameId);
  }, [active, prefersReducedMotion, value]);

  return <div className={className}>{displayValue}</div>;
}

export default function HeroSection({ onRequestAccess, onRequestDemo }) {
  const prefersReducedMotion = useReducedMotion();
  const heroMetricsRef = useRef(null);
  const statsRef = useRef(null);
  const heroMetricsVisible = useInView(heroMetricsRef, { once: true, margin: "-80px" });
  const statsVisible = useInView(statsRef, { once: true, margin: "-80px" });
  const [typedLine, setTypedLine] = useState(prefersReducedMotion ? animatedLine : "");

  const scrollToFeatures = () => {
    document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (prefersReducedMotion) {
      setTypedLine(animatedLine);
      return undefined;
    }

    let index = 0;
    setTypedLine("");

    const intervalId = window.setInterval(() => {
      index += 1;
      setTypedLine(animatedLine.slice(0, index));

      if (index >= animatedLine.length) {
        window.clearInterval(intervalId);
      }
    }, 62);

    return () => window.clearInterval(intervalId);
  }, [prefersReducedMotion]);

  return (
    <section className="pt-16">
      {/* Hero */}
      <div className="relative overflow-hidden border-b border-[var(--border-cre)] bg-[var(--bg)]">
        <div className="absolute inset-x-0 top-0 h-px bg-[var(--border-cre)]" />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(circle at 50% 18%, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 32%), linear-gradient(rgba(15,42,68,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(15,42,68,0.06) 1px, transparent 1px)",
            backgroundSize: "140% 140%, 72px 72px, 72px 72px",
          }}
          animate={prefersReducedMotion ? undefined : { backgroundPosition: ["0% 0%, 0 0, 0 0", "100% 45%, 18px 12px, 18px 12px", "0% 0%, 0 0, 0 0"] }}
          transition={prefersReducedMotion ? undefined : { duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />

        <div className="max-w-6xl mx-auto px-6 py-20 md:py-24 relative z-10">
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, y: 30 }}
            animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
            className="text-center"
          >
            <div className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] px-4 py-2 mb-7 shadow-[var(--shadow-soft)]">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-[var(--muted)] text-sm font-semibold">Trusted by 500+ commercial properties nationwide</span>
            </div>

            <h1 className="text-[33px] font-bold text-[var(--ink)] leading-[1.08] tracking-[-0.03em]">
              The Operating System for
              <br />
              <span className="text-[var(--accent)]">
                {typedLine}
                {!prefersReducedMotion && (
                  <motion.span
                    aria-hidden="true"
                    className="ml-1 inline-block h-[0.9em] w-[2px] translate-y-[0.08em] rounded-full bg-[var(--accent)]"
                    animate={{ opacity: [1, 0.22, 1] }}
                    transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </span>
            </h1>

            <p className="mt-6 text-base text-[var(--muted)] max-w-2xl mx-auto leading-relaxed">
              Enterprise-grade budgeting, CAM automation, and lease intelligence purpose-built for asset managers, property managers, and CRE finance teams managing complex portfolios.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button
                onClick={onRequestAccess}
                className="bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-semibold px-7 h-11 text-sm shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow)] rounded-[8px] transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100"
              >
                Request Platform Access <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button
                variant="outline"
                onClick={onRequestDemo}
                className="border-[var(--border-cre)] text-[var(--ink)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] bg-[var(--surface)] font-semibold px-7 h-11 text-sm rounded-[8px] gap-2 shadow-[var(--shadow-soft)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow)] active:translate-y-0 active:scale-[0.98] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100"
              >
                <Play className="w-4 h-4" /> Request Video Demo
              </Button>
            </div>

            {/* Trust signals */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-5 text-[var(--muted)] text-xs">
              <div className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5 text-[var(--accent)]" /> SOC 2 Compliant</div>
              <div className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-[var(--accent)]" /> 99.9% Uptime SLA</div>
              <div className="flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5 text-[var(--accent)]" /> Enterprise Ready</div>
            </div>

            <div ref={heroMetricsRef} className="mt-10 grid gap-3 text-left md:grid-cols-3">
              {heroMetrics.map((item, i) => (
                <div key={i} className="rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] p-4 shadow-[var(--shadow-soft)]">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[color-mix(in_srgb,var(--accent)_50%,var(--border-cre))] bg-[var(--surface-2)] text-[var(--accent)]">
                      <item.icon className="h-4 w-4" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">{item.label}</span>
                  </div>
                  <CountUpValue value={item.value} active={heroMetricsVisible} className="text-[22px] font-bold tabular-nums text-[var(--ink)]" />
                  <p className="mt-1 text-xs text-[var(--muted)]">{item.meta}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="bg-[var(--surface)] border-b border-[var(--border-cre)]">
        <div className="max-w-6xl mx-auto px-6 py-9">
          <div ref={statsRef} className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            {stats.map((s, i) => (
              <motion.div
                key={i}
                initial={prefersReducedMotion ? false : { opacity: 0, y: 15 }}
                whileInView={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 + i * 0.1 }}
              >
                <CountUpValue value={s.value} active={statsVisible} className="text-[28px] font-bold text-[var(--ink)] tabular-nums" />
                <div className="text-xs text-[var(--muted)] mt-1 font-medium">{s.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
