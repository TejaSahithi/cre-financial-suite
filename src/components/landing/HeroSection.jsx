import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Building2, CheckCircle2, Play, ShieldCheck, Zap } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

const proofItems = [
  { icon: ShieldCheck, label: "Purpose-Built for CRE Finance" },
  { icon: Zap, label: "99.9% Uptime SLA" },
  { icon: Building2, label: "Enterprise Ready" },
];

const platformCards = [
  {
    icon: Building2,
    label: "Portfolio Planning",
    copy: "Real-time variance and performance context across complex property portfolios.",
  },
  {
    icon: CheckCircle2,
    label: "CAM Automation",
    copy: "Automated reconciliation workflows connected to lease and recovery rules.",
  },
  {
    icon: ShieldCheck,
    label: "Lease Intelligence",
    copy: "Centralized lease intelligence for finance teams managing decisions at scale.",
  },
];

export default function HeroSection({ onRequestAccess, onRequestDemo }) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <section className="pf-hero-section">
      <div className="pf-hero-shell relative">
        {/* Defines the exact curved right edge of the left building panel —
            traced from the approved design mock (design-reference/proforma-os-reference.html),
            not eyeballed. objectBoundingBox scales it to the panel's actual
            rendered size, so the curve's proportions hold at any viewport height. */}
        <svg width="0" height="0" aria-hidden="true" focusable="false" className="absolute">
          <defs>
            <clipPath id="pfHeroLeftCurve" clipPathUnits="objectBoundingBox">
              <path d="M0,0 L0.8644,0.0048 C0.8276,0.1300 0.7770,0.2852 0.7540,0.4537 C0.7333,0.6197 0.7908,0.8123 0.9195,1 L0,1 Z" />
            </clipPath>
          </defs>
        </svg>
        <div aria-hidden="true" className="pf-hero-left-architecture pointer-events-none" />
        <div aria-hidden="true" className="pf-hero-blue-ribbons pointer-events-none" />
        <div aria-hidden="true" className="pf-hero-right-architecture pointer-events-none" />
        <div aria-hidden="true" className="pf-hero-contours pointer-events-none" />

        <div className="pf-hero-frame relative z-10 flex w-full flex-col px-6 sm:px-10 lg:px-16">
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, y: 18 }}
            animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="pf-hero-content w-full text-center"
          >
            <div className="pf-hero-trust inline-flex items-center gap-2.5 rounded-full border border-[rgba(20,86,199,.18)] bg-[rgba(255,255,255,.46)] px-4 py-2 font-bold text-[var(--pf-navy)] backdrop-blur-md">
              <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
              <span>Trusted by 500+ commercial properties nationwide</span>
            </div>

            <h1 className="pf-hero-title font-extrabold tracking-normal text-[var(--pf-navy)]">
              The Planning Backbone for
              <br />
              <span className="text-[var(--accent)]">Commercial Real Estate</span>
            </h1>

            <p className="pf-hero-description mx-auto text-[var(--muted)]">
              Enterprise-grade budgeting, CAM automation, and lease intelligence purpose-built for asset managers, property managers, and CRE finance teams managing complex portfolios.
            </p>

            <div className="pf-hero-running font-semibold leading-[1.2] text-[var(--pf-blue)]">
              Budget. Forecast. Plan. Decide.
            </div>

            <div className="pf-hero-actions flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-5">
              <Button
                onClick={onRequestAccess}
                className="pf-hero-primary h-[52px] rounded-[10px] border-[var(--pf-blue)] bg-[var(--pf-blue)] px-6 font-bold text-white shadow-[0_14px_30px_rgba(20,86,199,.22)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--pf-blue-bright)] hover:shadow-[0_18px_34px_rgba(20,86,199,.26)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                Request Platform Access <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
              <Button
                variant="outline"
                onClick={onRequestDemo}
                className="pf-hero-secondary h-[52px] rounded-[10px] border-[rgba(20,86,199,.38)] bg-[rgba(255,255,255,.68)] px-7 font-bold text-[var(--pf-navy)] shadow-none backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:bg-white motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                <Play className="h-5 w-5" /> Request Video Demo
              </Button>
            </div>

            <div className="pf-hero-proof flex flex-wrap items-center justify-center gap-y-3 font-semibold text-[var(--pf-navy)]">
              {proofItems.map((item, index) => (
                <div key={item.label} className="flex items-center gap-2">
                  <item.icon className="h-5 w-5 text-[var(--accent)]" />
                  <span>{item.label}</span>
                  {index < proofItems.length - 1 && <span className="ml-6 hidden h-5 w-px bg-[rgba(20,86,199,.14)] sm:inline-block" />}
                </div>
              ))}
            </div>
          </motion.div>

          <div className="pf-hero-card-row w-full">
            <div className="grid gap-5 text-left md:grid-cols-3">
              {platformCards.map((item, index) => (
                <motion.div
                  key={item.label}
                  className="pf-glass pf-hero-feature-card rounded-[12px]"
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 18 }}
                  animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, delay: 0.18 + index * 0.08, ease: "easeOut" }}
                >
                  <div className="pf-hero-feature-icon flex items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                    <item.icon className="h-6 w-6" />
                  </div>
                  <h3 className="text-[13px] font-extrabold uppercase tracking-[0.14em] text-[var(--accent)]">{item.label}</h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-[var(--muted)]">{item.copy}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
