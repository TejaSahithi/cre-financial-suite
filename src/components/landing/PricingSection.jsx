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

export default function PricingSection({ onRequestAccess, onRequestDemo, onContactSales }) {
  const [billingCycle, setBillingCycle] = React.useState("monthly");

  const getPrice = (plan) => {
    if (plan.isCustom) return "Custom pricing";
    if (billingCycle === "monthly") return plan.price;
    
    // Yearly pricing with 25% off
    const basePrice = parseInt(plan.price.replace(/[$,]/g, ""));
    const yearlyMonthlyPrice = Math.floor(basePrice * 0.75);
    return `$${yearlyMonthlyPrice.toLocaleString()}`;
  };

  const handleCtaClick = (cta) => {
    if (cta === "Request Demo") {
      return onRequestDemo || onRequestAccess;
    }
    if (cta === "Contact Sales") {
      return onContactSales || onRequestAccess;
    }
    return onRequestAccess;
  };

  return (
    <section id="pricing" className="py-20 px-6 bg-[var(--surface-2)]">
      <div className="max-w-6xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-[var(--surface)] border border-[var(--border-cre)] rounded-[8px] px-4 py-1.5 mb-4">
            <span className="text-[var(--accent)] text-xs font-bold tracking-wide uppercase">Pricing Plans</span>
          </div>
          <h2 className="text-[28px] font-bold text-[var(--ink)] tracking-[-0.03em]">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-[var(--muted)] max-w-xl mx-auto mb-8 text-sm">
            Choose the plan that fits your portfolio. All plans include core CRE financial tools.
          </p>

          {/* Pricing Toggle */}
          <div className="flex items-center justify-center gap-4 mb-8">
            <span className={`text-sm font-bold transition-colors ${billingCycle === 'monthly' ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Monthly</span>
            <button 
              onClick={() => setBillingCycle(billingCycle === 'monthly' ? 'yearly' : 'monthly')}
              className={`relative w-14 h-7 rounded-[999px] border border-[var(--border-cre)] transition-all duration-300 ${billingCycle === 'yearly' ? 'bg-[var(--accent)]' : 'bg-[var(--surface)]'}`}
            >
              <motion.div 
                animate={{ x: billingCycle === 'yearly' ? 30 : 4 }} 
                className="absolute top-1 w-5 h-5 bg-white rounded-full shadow-[var(--shadow-soft)]"
              />
              <span className="absolute -top-3 -right-3 px-2 py-0.5 bg-[var(--success)] text-white text-[9px] font-black rounded-[999px] shadow-[var(--shadow-soft)]">
                -25%
              </span>
            </button>
            <span className={`text-sm font-bold transition-colors ${billingCycle === 'yearly' ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Yearly</span>
          </div>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((plan, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <div className={`relative h-full rounded-[8px] border bg-[var(--surface)] transition-all duration-300 ${plan.popular ? "border-[var(--accent)] shadow-[var(--shadow)]" : "border-[var(--border-cre)] shadow-[var(--card-shadow)]"}`}>
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10">
                    <Badge className="bg-[var(--accent)] text-white border-0 text-[10px] font-black uppercase tracking-widest px-4 py-1.5 shadow-[var(--shadow-soft)] rounded-[8px]">
                      Most Popular
                    </Badge>
                  </div>
                )}
                <div className="p-6 md:p-7">
                  <h3 className="text-lg font-bold text-[var(--ink)] tracking-tight">{plan.name}</h3>
                  <p className="text-sm text-[var(--muted)] mt-2 mb-7 min-h-[40px] font-medium leading-relaxed">{plan.desc}</p>
                  <div className="mb-7">
                    {plan.isCustom ? (
                      <span className="text-[28px] font-bold text-[var(--ink)] tracking-tight">Custom pricing</span>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-baseline gap-1.5">
                          <motion.span 
                            key={billingCycle}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="text-[30px] font-bold text-[var(--ink)] tracking-tight tabular-nums"
                          >
                            {getPrice(plan)}
                          </motion.span>
                          <span className="text-[var(--muted)] text-sm font-bold">/month</span>
                        </div>
                        {billingCycle === 'yearly' && (
                          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[var(--success)] text-[10px] font-black uppercase tracking-widest">
                            Billed annually
                          </motion.p>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={handleCtaClick(plan.cta)}
                    className={`w-full mb-7 h-11 font-bold text-sm rounded-[8px] gap-2 transition-all active:scale-[0.98] ${
                      plan.popular
                        ? "bg-[var(--accent)] hover:bg-[var(--accent)] text-white shadow-[var(--shadow-soft)]"
                        : "bg-[var(--ink)] hover:bg-[var(--ink)] text-white shadow-[var(--shadow-soft)]"
                    }`}
                  >
                    {plan.cta} <ArrowRight className="w-4 h-4" />
                  </Button>
                  <div className="space-y-3.5">
                    <p className="text-[10px] font-black text-[var(--muted)] uppercase tracking-widest mb-2">What's included:</p>
                    {plan.features.map((f, fi) => (
                      <div key={fi} className="flex items-start gap-3">
                        {f.included ? (
                          <CheckCircle2 className="w-4 h-4 text-[var(--success)] mt-0.5 flex-shrink-0" />
                        ) : (
                          <X className="w-4 h-4 text-[var(--border-strong)] mt-0.5 flex-shrink-0" />
                        )}
                        <span className={`text-[13px] font-semibold tracking-tight ${f.included ? "text-[var(--muted)]" : "text-[var(--border-strong)]"}`}>{f.text}</span>
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
