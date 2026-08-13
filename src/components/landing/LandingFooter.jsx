import React from "react";
import { Mail, MapPin } from "lucide-react";
import { Link } from "react-router-dom";
import ProFormaBrand from "@/components/ProFormaBrand";

export default function LandingFooter() {
  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <footer className="pt-14 pb-8 px-6 text-white" style={{ background: "linear-gradient(180deg, var(--pf-shell-sidebar) 0%, var(--pf-shell-sidebar-2) 100%)" }}>
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
          {/* Brand */}
          <div className="lg:col-span-2">
            <div className="mb-5">
              <ProFormaBrand tone="light" className="pf-footer-brand" />
            </div>
            <p className="text-white/55 text-sm leading-relaxed max-w-xs mb-5">
              Enterprise budgeting, CAM calculation, and lease management for commercial real estate professionals.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-white/50 text-xs">
                <Mail className="w-3.5 h-3.5" /> support@proformaos.ai
              </div>
              <div className="flex items-center gap-2 text-white/50 text-xs">
                <MapPin className="w-3.5 h-3.5" /> Knoxville, TN
              </div>
            </div>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-white/70 font-semibold text-xs tracking-wider uppercase mb-4">Product</h4>
            <ul className="space-y-2.5">
              <li><button onClick={() => scrollTo("features")} className="text-white/50 hover:text-white text-sm transition-colors">Features</button></li>
              <li><Link to="/Pricing" className="text-white/50 hover:text-white text-sm transition-colors">Pricing</Link></li>
              <li><button onClick={() => scrollTo("platform-preview")} className="text-white/50 hover:text-white text-sm transition-colors">Platform Preview</button></li>
              <li><button onClick={() => scrollTo("features")} className="text-white/50 hover:text-white text-sm transition-colors">Security</button></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-white/70 font-semibold text-xs tracking-wider uppercase mb-4">Company</h4>
            <ul className="space-y-2.5">
              <li><button onClick={() => scrollTo("faq")} className="text-white/50 hover:text-white text-sm transition-colors">About Us</button></li>
              <li><button onClick={() => scrollTo("faq")} className="text-white/50 hover:text-white text-sm transition-colors">Blog</button></li>
              <li><button onClick={() => scrollTo("faq")} className="text-white/50 hover:text-white text-sm transition-colors">Careers</button></li>
              <li><Link to="/ContactUs" className="text-white/50 hover:text-white text-sm transition-colors">Contact</Link></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-white/70 font-semibold text-xs tracking-wider uppercase mb-4">Legal</h4>
            <ul className="space-y-2.5">
              <li><button className="text-white/50 hover:text-white text-sm transition-colors">Privacy Policy</button></li>
              <li><button className="text-white/50 hover:text-white text-sm transition-colors">Terms of Service</button></li>
              <li><button className="text-white/50 hover:text-white text-sm transition-colors">MSA Template</button></li>
            </ul>
          </div>
        </div>

        <div className="pt-6 border-t border-white/10 text-xs text-white/40 text-center">
          &copy; {new Date().getFullYear()} ProForma OS, Inc. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
