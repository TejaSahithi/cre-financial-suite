import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { me } from "@/services/auth";
import { createPageUrl } from "@/utils";
import LandingNav from "@/components/landing/LandingNav";
import PricingSection from "@/components/landing/PricingSection";
import FeatureComparisonTable from "@/components/landing/FeatureComparisonTable";
import FAQSection from "@/components/landing/FAQSection";
import LandingFooter from "@/components/landing/LandingFooter";
import RequestAccessModal from "@/components/landing/RequestAccessModal";

export default function Pricing() {
  const [showRequestAccess, setShowRequestAccess] = useState(false);
  const navigate = useNavigate();

  const handleContactSales = () => navigate(createPageUrl("ContactUs"));

  React.useEffect(() => {
    me().then(user => {
      if (user) window.location.href = createPageUrl("Dashboard");
    }).catch(() => {});
  }, []);

  const handleSignIn = () => navigate(createPageUrl("Login"));

  return (
    <div className="min-h-screen bg-white">
      <LandingNav 
        onSignIn={handleSignIn} 
        onRequestAccess={() => navigate(createPageUrl("RequestAccess"))} 
        onRequestDemo={() => navigate(createPageUrl("RequestDemo"))}
      />
      <div className="pt-16">
        <PricingSection onRequestAccess={() => setShowRequestAccess(true)} onContactSales={handleContactSales} />
      </div>
      <FeatureComparisonTable />
      <FAQSection />
      <LandingFooter />
      {showRequestAccess && <RequestAccessModal onClose={() => setShowRequestAccess(false)} />}
    </div>
  );
}