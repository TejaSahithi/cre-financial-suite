import React from "react";
import { Check, Minus } from "lucide-react";
import { motion } from "framer-motion";

const rows = [
  { feature: "Properties", starter: "10", pro: "50", enterprise: "Unlimited" },
  { feature: "Users", starter: "5", pro: "Unlimited", enterprise: "Unlimited" },
  { feature: "Lease AI Extraction", starter: "Basic", pro: "Advanced", enterprise: "Advanced" },
  { feature: "CAM Engine", starter: true, pro: true, enterprise: true },
  { feature: "Budget Module", starter: true, pro: true, enterprise: true },
  { feature: "Accounting Integrations", starter: false, pro: "QuickBooks", enterprise: "All platforms" },
  { feature: "SSO / SAML", starter: false, pro: false, enterprise: true },
  { feature: "Custom Approval Workflows", starter: false, pro: true, enterprise: true },
  { feature: "Dedicated CSM", starter: false, pro: false, enterprise: true },
  { feature: "SLA Guarantee", starter: false, pro: false, enterprise: "99.9% uptime" },
];

function CellValue({ value }) {
  if (value === true) return <div className="w-6 h-6 rounded-[8px] bg-[var(--success-soft)] flex items-center justify-center mx-auto"><Check className="w-3.5 h-3.5 text-[var(--success)]" /></div>;
  if (value === false) return <Minus className="w-4 h-4 text-[var(--border-strong)] mx-auto" />;
  return <span className={`text-sm font-medium ${value === "Unlimited" || value === "99.9% uptime" ? "text-[var(--success)]" : "text-[var(--ink)]"}`}>{value}</span>;
}

export default function FeatureComparisonTable() {
  return (
    <section className="py-20 px-6 bg-[var(--bg)]">
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="max-w-4xl mx-auto">
        <h2 className="text-[28px] font-bold text-[var(--ink)] text-center mb-10 tracking-[-0.03em]">Full Feature Comparison</h2>
        <div className="overflow-x-auto bg-[var(--surface)] rounded-[8px] border border-[var(--border-cre)] shadow-[var(--card-shadow)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--surface-2)] border-b border-[var(--border-cre)]">
                <th className="text-left py-4 px-5 text-xs font-bold text-[var(--muted)] uppercase tracking-wider">Feature</th>
                <th className="text-center py-4 px-4 text-xs font-bold text-[var(--muted)] uppercase tracking-wider">Starter</th>
                <th className="text-center py-4 px-4 text-xs font-bold text-[var(--accent)] uppercase tracking-wider">Professional</th>
                <th className="text-center py-4 px-4 text-xs font-bold text-[var(--muted)] uppercase tracking-wider">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border-cre)] hover:bg-[var(--surface-2)] transition-colors">
                  <td className="py-3.5 px-5 text-[var(--ink)] font-medium">{row.feature}</td>
                  <td className="py-3.5 px-4 text-center"><CellValue value={row.starter} /></td>
                  <td className="py-3.5 px-4 text-center bg-[var(--accent-soft)]"><CellValue value={row.pro} /></td>
                  <td className="py-3.5 px-4 text-center"><CellValue value={row.enterprise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </section>
  );
}
