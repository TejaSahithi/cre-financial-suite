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
  if (value === true) return <div className="w-6 h-6 rounded-full bg-emerald-100 flex items-center justify-center mx-auto"><Check className="w-3.5 h-3.5 text-emerald-600" /></div>;
  if (value === false) return <Minus className="w-4 h-4 text-gray-300 mx-auto" />;
  return <span className={`text-sm font-medium ${value === "Unlimited" || value === "99.9% uptime" ? "text-emerald-600" : "text-gray-700"}`}>{value}</span>;
}

export default function FeatureComparisonTable() {
  return (
    <section className="py-20 px-6 bg-slate-50">
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 text-center mb-10">Full Feature Comparison</h2>
        <div className="overflow-x-auto bg-white rounded-xl border border-gray-200 shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left py-4 px-5 text-xs font-bold text-gray-500 uppercase tracking-wider">Feature</th>
                <th className="text-center py-4 px-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Starter</th>
                <th className="text-center py-4 px-4 text-xs font-bold text-blue-600 uppercase tracking-wider">Professional</th>
                <th className="text-center py-4 px-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                  <td className="py-3.5 px-5 text-gray-900 font-medium">{row.feature}</td>
                  <td className="py-3.5 px-4 text-center"><CellValue value={row.starter} /></td>
                  <td className="py-3.5 px-4 text-center bg-blue-50/30"><CellValue value={row.pro} /></td>
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