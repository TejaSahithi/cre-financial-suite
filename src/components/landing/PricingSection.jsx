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
    <section id="pricing" className="py-24 px-6 bg-[#0f1a2e]">
      <div className="max-w-6xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-400/20 rounded-full px-4 py-1.5 mb-4">
            <span className="text-blue-400 text-xs font-bold tracking-wide uppercase">Pricing Plans</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-extrabold text-white">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-white/40 max-w-xl mx-auto mb-10">
            Choose the plan that fits your portfolio. All plans include core CRE financial tools.
          </p>

          {/* Pricing Toggle */}
          <div className="flex items-center justify-center gap-4 mb-8">
            <span className={`text-sm font-bold transition-colors ${billingCycle === 'monthly' ? 'text-white' : 'text-white/40'}`}>Monthly</span>
            <button 
              onClick={() => setBillingCycle(billingCycle === 'monthly' ? 'yearly' : 'monthly')}
              className={`relative w-14 h-7 rounded-full transition-all duration-300 ${billingCycle === 'yearly' ? 'bg-blue-600' : 'bg-white/10'}`}
            >
              <motion.div 
                animate={{ x: billingCycle === 'yearly' ? 30 : 4 }} 
                className="absolute top-1 w-5 h-5 bg-white rounded-full shadow-lg"
              />
              <span className="absolute -top-3 -right-3 px-2 py-0.5 bg-emerald-500 text-white text-[9px] font-black rounded-full shadow-xl border border-emerald-400/20 animate-pulse">
                -25%
              </span>
            </button>
            <span className={`text-sm font-bold transition-colors ${billingCycle === 'yearly' ? 'text-white' : 'text-white/40'}`}>Yearly</span>
          </div>
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
              <div className={`relative h-full rounded-3xl bg-white p-1 transition-all duration-500 hover:scale-[1.02] ${plan.popular ? "ring-4 ring-blue-500/20 shadow-2xl shadow-blue-500/10" : "shadow-xl"}`}>
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10">
                    <Badge className="bg-blue-600 text-white border-0 text-[10px] font-black uppercase tracking-widest px-5 py-1.5 shadow-xl rounded-full">
                      Most Popular
                    </Badge>
                  </div>
                )}
                <div className="rounded-[1.4rem] p-8 md:p-10">
                  <h3 className="text-2xl font-black text-slate-900 tracking-tight">{plan.name}</h3>
                  <p className="text-sm text-slate-400 mt-2 mb-8 min-h-[40px] font-medium leading-relaxed">{plan.desc}</p>
                  <div className="mb-8">
                    {plan.isCustom ? (
                      <span className="text-3xl font-black text-slate-900 tracking-tight">Custom pricing</span>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-baseline gap-1.5">
                          <motion.span 
                            key={billingCycle}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="text-5xl font-black text-slate-900 tracking-tighter"
                          >
                            {getPrice(plan)}
                          </motion.span>
                          <span className="text-slate-400 text-sm font-bold">/month</span>
                        </div>
                        {billingCycle === 'yearly' && (
                          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-emerald-500 text-[10px] font-black uppercase tracking-widest">
                            Billed annually
                          </motion.p>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={handleCtaClick(plan.cta)}
                    className={`w-full mb-8 h-12 font-black text-base rounded-2xl gap-2 transition-all active:scale-[0.98] ${
                      plan.popular
                        ? "bg-blue-600 hover:bg-blue-700 text-white shadow-xl shadow-blue-600/20"
                        : "bg-slate-900 hover:bg-slate-800 text-white shadow-xl shadow-slate-900/10"
                    }`}
                  >
                    {plan.cta} <ArrowRight className="w-4 h-4" />
                  </Button>
                  <div className="space-y-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 italic">What's included:</p>
                    {plan.features.map((f, fi) => (
                      <div key={fi} className="flex items-start gap-3">
                        {f.included ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                        ) : (
                          <X className="w-4 h-4 text-slate-200 mt-0.5 flex-shrink-0" />
                        )}
                        <span className={`text-[13px] font-semibold tracking-tight ${f.included ? "text-slate-600" : "text-slate-300"}`}>{f.text}</span>
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