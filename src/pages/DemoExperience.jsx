import React, { useEffect } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { Building2, ArrowRight, Video, FileText, CheckCircle2, Shield, BarChart3, Users, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { markDemoViewed } from "@/services/api";
import { supabase } from "@/services/supabaseClient";
import { sendEmail } from "@/services/integrations";

// Fallback constants if not provided in route state
const FALLBACK_VIDEO_URL = "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/End-to-End_CRE_Budgeting_&_CAM.mp4";
const FALLBACK_SLIDE_URL = "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/Automated_CRE_Financial_Intelligence.pptx";

export default function DemoExperience() {
  const location = useLocation();
  const navigate = useNavigate();
  
  useEffect(() => {
    if (location.state?.requestId) {
      markDemoViewed(location.state.requestId).then(async () => {
        try {
          const { data, error } = await supabase
            .from('access_requests')
            .select('email, full_name, demo_viewed')
            .eq('id', location.state.requestId)
            .single();
            
          if (data && data.email && !sessionStorage.getItem(`demo_email_sent_${location.state.requestId}`)) {
            sessionStorage.setItem(`demo_email_sent_${location.state.requestId}`, "true");
            
            const requestAccessUrl = `${window.location.origin}${createPageUrl("RequestAccess")}?tab=access`;
            
            await sendEmail({
              to: data.email,
              subject: "Thanks for exploring CRE Suite",
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                  <p>Hi ${data.full_name},</p>
                  <p>Thanks for taking the time to explore our platform.</p>
                  <p>We hope the demo gave you a clear view of how you can:</p>
                  <ul>
                    <li>Automate budgeting and CAM</li>
                    <li>Manage portfolios and properties efficiently</li>
                    <li>Replace spreadsheets with a unified system</li>
                  </ul>
                  <p>If you're ready to move forward, you can request platform access below:</p>
                  <p>👉 Request Access:<br/>
                  <a href="${requestAccessUrl}">${requestAccessUrl}</a></p>
                  <p>If you'd like a live walkthrough or have specific questions, we’d be happy to help.</p>
                  <br/>
                  <p>Best regards,<br/>CRE Financial Suite Team</p>
                </div>
              `
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
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Bar */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-[#1a2744] rounded-lg flex items-center justify-center">
            <Building2 className="w-4.5 h-4.5 text-white" />
          </div>
          <span className="text-[#1a2744] font-bold text-lg tracking-tight">CRE Suite</span>
        </div>
        <Link to={createPageUrl("RequestAccess")}>
          <Button variant="default" className="bg-[#1a2744] hover:bg-[#243b67] gap-2">
            Get Full Access <ArrowRight className="w-4 h-4" />
          </Button>
        </Link>
      </div>

      {/* Hero Section */}
      <div className="w-full bg-[#1a2744] text-white py-16 px-4 text-center">
        <h1 className="text-4xl md:text-5xl font-extrabold mb-6 max-w-4xl mx-auto tracking-tight">
          See How CRE Teams Automate Budgeting & CAM
        </h1>
        <p className="text-lg text-slate-300 max-w-2xl mx-auto mb-8">
          Watch our end-to-end walkthrough and explore the presentation deck below to understand how our platform streamlines commercial real estate finance.
        </p>
        <Link to={createPageUrl("RequestAccess")}>
          <Button size="lg" className="bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl px-8 h-12 text-base">
            Request Platform Access
          </Button>
        </Link>
      </div>

      {/* Main Content Area */}
      <div className="max-w-4xl mx-auto w-full px-4 py-12 space-y-16">
        
        {/* Video Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 border-b pb-4">
            <div className="w-10 h-10 bg-violet-100 rounded-xl flex items-center justify-center">
              <Video className="w-5 h-5 text-violet-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Platform Walkthrough</h2>
              <p className="text-slate-500 text-sm">End-to-end demonstration of budgeting and CAM workflows.</p>
            </div>
          </div>
          <div className="bg-black rounded-2xl overflow-hidden shadow-xl border border-slate-200 aspect-video max-h-[480px] relative">
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
          <div className="bg-white rounded-2xl p-8 border shadow-sm">
            <h3 className="text-xl font-bold text-slate-900 mb-6">Key Benefits</h3>
            <ul className="space-y-4">
              {[
                { title: "Automate CAM", desc: "Instantly calculate complex reconciliations." },
                { title: "Eliminate Errors", desc: "Single source of truth for all financial data." },
                { title: "Real-Time Insights", desc: "Drill down from portfolio to unit-level actuals." },
                { title: "Data Isolation", desc: "Secure multi-tenant architecture on Supabase." },
                { title: "Role-Based Access", desc: "Granular permissions for asset & property managers." }
              ].map((benefit, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold text-slate-700 text-sm">{benefit.title}</p>
                    <p className="text-slate-500 text-xs">{benefit.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          
          <div className="bg-white rounded-2xl p-8 border shadow-sm flex flex-col justify-center">
            <h3 className="text-xl font-bold text-slate-900 mb-6">Core Product Flow</h3>
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-600">
              <span className="px-3 py-1.5 bg-slate-100 rounded-lg">Portfolio</span>
              <ArrowRight className="w-4 h-4 text-slate-300" />
              <span className="px-3 py-1.5 bg-slate-100 rounded-lg">Property</span>
              <ArrowRight className="w-4 h-4 text-slate-300" />
              <span className="px-3 py-1.5 bg-slate-100 rounded-lg">Building</span>
              <ArrowRight className="w-4 h-4 text-slate-300" />
              <span className="px-3 py-1.5 bg-slate-100 rounded-lg">Unit</span>
              <ArrowRight className="w-4 h-4 text-slate-300" />
              <div className="w-full h-2"></div>
              <span className="px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-100 rounded-lg">CAM</span>
              <ArrowRight className="w-4 h-4 text-slate-300" />
              <span className="px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-lg">Reports</span>
            </div>
            
            <div className="mt-8 grid grid-cols-2 gap-4">
               <div className="flex items-center gap-2 text-slate-500">
                 <Shield className="w-4 h-4" /> <span className="text-xs">SOC 2 Compliant</span>
               </div>
               <div className="flex items-center gap-2 text-slate-500">
                 <Users className="w-4 h-4" /> <span className="text-xs">For CRE Teams</span>
               </div>
            </div>
          </div>
        </section>

        {/* Slide Deck Section */}
        <section className="space-y-6">
          <div className="flex items-center gap-3 border-b pb-4">
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
              <FileText className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Presentation Deck</h2>
              <p className="text-slate-500 text-sm">Automated CRE Financial Intelligence</p>
            </div>
          </div>
          <div className="bg-white rounded-2xl overflow-hidden shadow-xl border border-slate-200 h-[450px] relative">
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
      <div className="bg-white border-t py-16 text-center mt-auto">
        <h2 className="text-2xl font-bold text-slate-900 mb-4">Ready to automate your properties?</h2>
        <Link to={createPageUrl("RequestAccess")}>
          <Button size="lg" className="bg-[#1a2744] hover:bg-[#243b67] text-white font-semibold rounded-xl px-8 h-12">
            Request Platform Access
          </Button>
        </Link>
      </div>
    </div>
  );
}
