import React, { useEffect } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { ArrowRight, Video, FileText, CheckCircle2, Shield, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createAbsolutePageUrl, createPageUrl } from "@/utils";
import { markDemoViewed } from "@/services/api";
import { supabase } from "@/services/supabaseClient";
import { sendEmail } from "@/services/integrations";
import ProFormaBrand from "@/components/ProFormaBrand";

// Fallback constants if not provided in route state
const FALLBACK_VIDEO_URL = "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/End-to-End_CRE_Budgeting_&_CAM.mp4";
const FALLBACK_SLIDE_URL = "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/Automated_CRE_Financial_Intelligence.pptx";

export default function DemoExperience() {
  const location = useLocation();
  const navigate = useNavigate();
  
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const requestId = location.state?.requestId || searchParams.get("requestId");
    
    if (requestId) {
      console.log('[DemoExperience] Marking demo as viewed for:', requestId);
      markDemoViewed(requestId).then(async () => {
        try {
          const { data, error } = await supabase
            .from('access_requests')
            .select('email, full_name, demo_viewed')
            .eq('id', requestId)
            .single();
            
          if (data && data.email && !sessionStorage.getItem(`demo_email_sent_${requestId}`)) {
            sessionStorage.setItem(`demo_email_sent_${requestId}`, "true");
            
            const requestAccessUrl = createAbsolutePageUrl("RequestAccess", { tab: "access" });
            
            await sendEmail({
              to: data.email,
              templateId: "demo_followup",
              variables: {
                name: data.full_name,
                action_url: requestAccessUrl,
              }
            });
          }
        } catch (e) {
          console.error("Failed to send demo follow-up email", e);
        }
      });
    }
  }, [location.state?.requestId]);
  
  const demoVideoUrl = location.state?.demoVideoUrl || FALLBACK_VIDEO_URL;
  const slideDeckUrl = location.state?.slideDeckUrl || FALLBACK_SLIDE_URL;

  // Use Google View for PPTX rendering in iframe
  const renderSlideUrl = slideDeckUrl.endsWith(".pptx") 
    ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(slideDeckUrl)}` 
    : slideDeckUrl;

  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col">
      {/* Top Bar */}
      <div className="bg-[var(--surface)] border-b px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center">
          <ProFormaBrand className="pf-page-brand" />
        </div>
        <Link to={createPageUrl("RequestAccess")}>
          <Button variant="default" className="bg-[var(--ink)] hover:bg-[var(--ink)] gap-2">
            Get Full Access <ArrowRight className="w-4 h-4" />
          </Button>
        </Link>
      </div>

      {/* Hero Section */}
      <div className="w-full bg-[var(--ink)] text-white py-16 px-4 text-center">
        <h1 className="text-[28px] font-extrabold mb-6 max-w-4xl mx-auto tracking-tight">
          See How CRE Teams Automate Budgeting & CAM
        </h1>
        <p className="text-lg text-[var(--muted)] max-w-2xl mx-auto mb-8">
          Watch our end-to-end walkthrough and explore the presentation deck below to understand how our platform streamlines commercial real estate finance.
        </p>
        <Link to={createPageUrl("RequestAccess")}>
          <Button size="lg" className="bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-semibold rounded-[8px] px-8 h-12 text-base">
            Request Platform Access
          </Button>
        </Link>
      </div>

      {/* Main Content Area */}
      <div className="max-w-4xl mx-auto w-full px-4 py-12 space-y-16">
        
        {/* Video Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 border-b pb-4">
            <div className="w-10 h-10 bg-blue-100 rounded-[8px] flex items-center justify-center">
              <Video className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-[var(--ink)]">Platform Walkthrough</h2>
              <p className="text-[var(--muted)] text-sm">End-to-end demonstration of budgeting and CAM workflows.</p>
            </div>
          </div>
          <div className="bg-black rounded-[8px] overflow-hidden shadow-[var(--shadow)] border border-[var(--border-cre)] aspect-video max-h-[480px] relative">
            <video 
              src={demoVideoUrl} 
              className="w-full h-full object-contain"
              controls 
              autoPlay={false}
              playsInline
            >
              Your browser does not support the video tag.
            </video>
          </div>
        </section>

        {/* Product Flow & Benefits */}
        <section className="grid md:grid-cols-2 gap-8">
          <div className="bg-[var(--surface)] rounded-[8px] p-8 border shadow-[var(--shadow-soft)]">
            <h3 className="text-xl font-bold text-[var(--ink)] mb-6">Key Benefits</h3>
            <ul className="space-y-4">
              {[
                { title: "Automate CAM", desc: "Instantly calculate complex reconciliations." },
                { title: "Eliminate Errors", desc: "Single source of truth for all financial data." },
                { title: "Real-Time Insights", desc: "Drill down from portfolio to unit-level actuals." },
                { title: "Data Isolation", desc: "Secure multi-tenant architecture on Supabase." },
                { title: "Role-Based Access", desc: "Granular permissions for asset & property managers." }
              ].map((benefit, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <CheckCircle2 className="w-5 h-5 text-[var(--success)] mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold text-[var(--muted)] text-sm">{benefit.title}</p>
                    <p className="text-[var(--muted)] text-xs">{benefit.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          
          <div className="bg-[var(--surface)] rounded-[8px] p-8 border shadow-[var(--shadow-soft)] flex flex-col justify-center">
            <h3 className="text-xl font-bold text-[var(--ink)] mb-6">Core Product Flow</h3>
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--muted)]">
              <span className="px-3 py-1.5 bg-[var(--surface-2)] rounded-lg">Portfolio</span>
              <ArrowRight className="w-4 h-4 text-[var(--muted)]" />
              <span className="px-3 py-1.5 bg-[var(--surface-2)] rounded-lg">Property</span>
              <ArrowRight className="w-4 h-4 text-[var(--muted)]" />
              <span className="px-3 py-1.5 bg-[var(--surface-2)] rounded-lg">Building</span>
              <ArrowRight className="w-4 h-4 text-[var(--muted)]" />
              <span className="px-3 py-1.5 bg-[var(--surface-2)] rounded-lg">Unit</span>
              <ArrowRight className="w-4 h-4 text-[var(--muted)]" />
              <div className="w-full h-2"></div>
              <span className="px-3 py-1.5 bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--border-cre)] rounded-lg">CAM</span>
              <ArrowRight className="w-4 h-4 text-[var(--muted)]" />
              <span className="px-3 py-1.5 bg-[var(--success-soft)] text-[var(--success)] border border-[var(--border-cre)] rounded-lg">Reports</span>
            </div>
            
            <div className="mt-8 grid grid-cols-2 gap-4">
               <div className="flex items-center gap-2 text-[var(--muted)]">
                 <Shield className="w-4 h-4" /> <span className="text-xs">SOC 2 Compliant</span>
               </div>
               <div className="flex items-center gap-2 text-[var(--muted)]">
                 <Users className="w-4 h-4" /> <span className="text-xs">For CRE Teams</span>
               </div>
            </div>
          </div>
        </section>

        {/* Slide Deck Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 border-b pb-4">
            <div className="w-10 h-10 bg-[var(--accent-soft)] rounded-[8px] flex items-center justify-center">
              <FileText className="w-5 h-5 text-[var(--accent)]" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-[var(--ink)]">Presentation Deck</h2>
              <p className="text-[var(--muted)] text-sm">Automated CRE Financial Intelligence</p>
            </div>
          </div>
          <div className="bg-[var(--surface)] rounded-[8px] overflow-hidden shadow-[var(--shadow)] border border-[var(--border-cre)] h-[450px] relative">
            <iframe 
              src={renderSlideUrl}
              className="w-full h-full border-none"
              title="Slide Deck Presentation"
              allowFullScreen
            />
          </div>
        </section>

      </div>

      {/* Bottom CTA */}
      <div className="bg-[var(--surface)] border-t py-16 text-center mt-auto">
        <h2 className="text-2xl font-bold text-[var(--ink)] mb-4">Ready to automate your properties?</h2>
        <Link to={createPageUrl("RequestAccess")}>
          <Button size="lg" className="bg-[var(--ink)] hover:bg-[var(--ink)] text-white font-semibold rounded-[8px] px-8 h-12">
            Request Platform Access
          </Button>
        </Link>
      </div>
    </div>
  );
}
