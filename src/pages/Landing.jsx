import React from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

import HeroSection from "@/components/landing/HeroSection";
import FeaturesSection from "@/components/landing/FeaturesSection";
import DashboardPreview from "@/components/landing/DashboardPreview";
import PricingSection from "@/components/landing/PricingSection";
import FeatureComparisonTable from "@/components/landing/FeatureComparisonTable";
import LandingNav from "@/components/landing/LandingNav";
import LandingFooter from "@/components/landing/LandingFooter";
import FAQSection from "@/components/landing/FAQSection";
import CTASection from "@/components/landing/CTASection";
import ContactSection from "@/components/landing/ContactSection";

export default function Landing() {
  const navigate = useNavigate();
  const handleRequestAccess = () => {
    navigate(createPageUrl("RequestAccess"));
  };

  const handleRequestDemo = () => {
    navigate(createPageUrl("RequestDemo"));
  };
  const handleSignIn = () => navigate(createPageUrl("Login"));

  return (
    <div className="min-h-screen bg-white">
      <LandingNav 
        onSignIn={handleSignIn} 
        onRequestAccess={handleRequestAccess} 
        onRequestDemo={handleRequestDemo} 
      />
      <HeroSection onRequestAccess={handleRequestAccess} onRequestDemo={handleRequestDemo} />
      <FeaturesSection />
      <DashboardPreview onRequestAccess={handleRequestAccess} />
      <PricingSection 
        onRequestAccess={handleRequestAccess} 
        onRequestDemo={handleRequestDemo}
        onContactSales={() => document.getElementById("contact-us")?.scrollIntoView({ behavior: "smooth" })} 
      />
      <FeatureComparisonTable />
      <FAQSection />
      <ContactSection />
      <CTASection onRequestAccess={handleRequestAccess} />
      <LandingFooter />
    </div>
  );
}