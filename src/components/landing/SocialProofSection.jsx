import React from "react";
import { motion, useReducedMotion } from "framer-motion";

const trustedFirms = [
  "Westfield Commercial", "Pinnacle Properties", "Summit Group",
  "CoreLink Capital", "Pacific Realty", "Landmark Partners",
];

export default function SocialProofSection() {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.section
      className="bg-[var(--surface-2)] py-7 border-y border-[var(--border-cre)]"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
      whileInView={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <div className="max-w-6xl mx-auto px-6 text-center">
        <p className="text-[10px] font-bold text-[var(--muted)] tracking-[0.2em] uppercase mb-4">Trusted by Leading CRE Firms</p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
          {trustedFirms.map((firm, i) => (
            <motion.span
              key={firm}
              className="text-[var(--muted)] text-sm font-semibold tracking-wide"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
              whileInView={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.07, ease: "easeOut" }}
            >
              {firm}
            </motion.span>
          ))}
        </div>
      </div>
    </motion.section>
  );
}
