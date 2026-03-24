import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, X, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";

const plans = [
  {
    name: "Starter",
    price: "$499",
    desc: "For small portfolios getting started with CAM automation.",
    features: [
      { text: "Up to 10 properties", included: true },
      { text: "Up to 5 users", included: true },
      { text: "Lease PDF upload & extraction", included: true },
      { text: "CAM calculation engine", included: true },
      { text: "Budget creation & tracking", included: true },
      { text: "Standard reports (5 types)", included: true },
      { text: "CSV/Excel import", included: true },
      { text: "Email support", included: true },
      { text: "Advanced AI extraction", included: false },
      { text: "Accounting integrations", included: false },
      { text: "Custom approval workflows", included: false },
      { text: "SSO / SAML", included: false },
    ],
    cta: "Request Demo",
    popular: false,
  },
  {
    name: "Professional",
    price: "$1,499",
    desc: "For growing firms managing multiple properties and teams.",
    features: [
      { text: "Up to 50 properties", included: true },
      { text: "Unlimited users", included: true },
      { text: "Lease PDF upload & extraction", included: true },
      { text: "CAM calculation engine", included: true },
      { text: "Budget creation & tracking", included: true },
      { text: "Full reports library", included: true },
      { text: "CSV/Excel import", included: true },
      { text: "Email & phone support", included: true },
      { text: "Advanced AI extraction", included: true },
      { text: "QuickBooks integration", included: true },
      { text: "Custom approval workflows", included: true },
      { text: "SSO / SAML", included: false },
    ],
    cta: "Request Demo",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    isCustom: true,
    desc: "For large firms with complex portfolio structures and compliance needs.",
    features: [
      { text: "Unlimited properties", included: true },
      { text: "Unlimited users", included: true },
      { text: "Lease PDF upload & extraction", included: true },
      { text: "CAM calculation engine", included: true },
      { text: "Budget creation & tracking", included: true },
      { text: "Full reports library", included: true },
      { text: "CSV/Excel import", included: true },
      { text: "Priority support + SLA", included: true },
      { text: "Advanced AI extraction", included: true },
      { text: "All accounting integrations", included: true },
      { text: "Custom approval workflows", included: true },
      { text: "SSO / SAML + dedicated CSM", included: true },
    ],
    cta: "Contact Sales",
    popular: false,
  },
];

export default function PricingSection({ onRequestAccess, onContactSales }) {
  return (
    <section id="pricing" className="py-24 px-6 bg-[#0f1a2e]">
      <div className="max-w-6xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-400/20 rounded-full px-4 py-1.5 mb-4">
            <span className="text-blue-400 text-xs font-bold tracking-wide uppercase">Pricing Plans</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-extrabold text-white">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-white/40 max-w-xl mx-auto">
            Choose the plan that fits your portfolio. All plans include core CRE financial tools.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6">
          {plans.map((plan, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <div className={`relative h-full rounded-2xl bg-white p-1 ${plan.popular ? "ring-2 ring-blue-500 shadow-2xl shadow-blue-500/20" : "shadow-lg"}`}>
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                    <Badge className="bg-gradient-to-r from-blue-600 to-blue-500 text-white border-0 text-xs px-4 py-1 shadow-lg">
                      Most Popular
                    </Badge>
                  </div>
                )}
                <div className="rounded-xl p-7">
                  <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>
                  <p className="text-sm text-gray-500 mt-1 mb-5 min-h-[40px]">{plan.desc}</p>
                  <div className="mb-6">
                    {plan.isCustom ? (
                      <span className="text-2xl font-extrabold text-gray-900">Custom pricing</span>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-extrabold text-gray-900">{plan.price}</span>
                        <span className="text-gray-400 text-sm">/month</span>
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={plan.cta === "Contact Sales" ? (onContactSales || onRequestAccess) : onRequestAccess}
                    className={`w-full mb-6 h-11 font-semibold rounded-lg gap-2 ${
                      plan.popular
                        ? "bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white shadow-md"
                        : "bg-gray-900 hover:bg-gray-800 text-white"
                    }`}
                  >
                    {plan.cta} <ArrowRight className="w-4 h-4" />
                  </Button>
                  <div className="space-y-2.5">
                    {plan.features.map((f, fi) => (
                      <div key={fi} className="flex items-start gap-2.5">
                        {f.included ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                        ) : (
                          <X className="w-4 h-4 text-gray-300 mt-0.5 flex-shrink-0" />
                        )}
                        <span className={`text-sm ${f.included ? "text-gray-700" : "text-gray-400"}`}>{f.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}