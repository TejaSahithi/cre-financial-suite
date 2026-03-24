import React from "react";
import { Building2, Mail, Phone, MapPin } from "lucide-react";
import { Link } from "react-router-dom";

export default function LandingFooter() {
  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <footer className="bg-[#0a1122] pt-16 pb-8 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
          {/* Brand */}
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-9 h-9 bg-gradient-to-br from-blue-400 to-blue-600 rounded-lg flex items-center justify-center shadow-md">
                <Building2 className="w-5 h-5 text-white" />
              </div>
              <div>
                <span className="text-white font-bold text-sm block leading-tight">CRE PLATFORM</span>
                <span className="text-blue-300/50 text-[9px] font-semibold tracking-[0.15em]">BUDGETING & CAM</span>
              </div>
            </div>
            <p className="text-white/25 text-sm leading-relaxed max-w-xs mb-5">
              Enterprise budgeting, CAM calculation, and lease management for commercial real estate professionals.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-white/25 text-xs">
                <Mail className="w-3.5 h-3.5" /> support@creplatform.io
              </div>
              <div className="flex items-center gap-2 text-white/25 text-xs">
                <Phone className="w-3.5 h-3.5" /> +1 (800) 555-0199
              </div>
              <div className="flex items-center gap-2 text-white/25 text-xs">
                <MapPin className="w-3.5 h-3.5" /> New York, NY
              </div>
            </div>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-white/60 font-semibold text-xs tracking-wider uppercase mb-4">Product</h4>
            <ul className="space-y-2.5">
              <li><button onClick={() => scrollTo("features")} className="text-white/30 hover:text-white/60 text-sm transition-colors">Features</button></li>
              <li><Link to="/Pricing" className="text-white/30 hover:text-white/60 text-sm transition-colors">Pricing</Link></li>
              <li><button onClick={() => scrollTo("platform-preview")} className="text-white/30 hover:text-white/60 text-sm transition-colors">Platform Preview</button></li>
              <li><button onClick={() => scrollTo("features")} className="text-white/30 hover:text-white/60 text-sm transition-colors">Security</button></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-white/60 font-semibold text-xs tracking-wider uppercase mb-4">Company</h4>
            <ul className="space-y-2.5">
              <li><button onClick={() => scrollTo("faq")} className="text-white/30 hover:text-white/60 text-sm transition-colors">About Us</button></li>
              <li><button onClick={() => scrollTo("faq")} className="text-white/30 hover:text-white/60 text-sm transition-colors">Blog</button></li>
              <li><button onClick={() => scrollTo("faq")} className="text-white/30 hover:text-white/60 text-sm transition-colors">Careers</button></li>
              <li><Link to="/ContactUs" className="text-white/30 hover:text-white/60 text-sm transition-colors">Contact</Link></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-white/60 font-semibold text-xs tracking-wider uppercase mb-4">Legal</h4>
            <ul className="space-y-2.5">
              <li><button className="text-white/30 hover:text-white/60 text-sm transition-colors">Privacy Policy</button></li>
              <li><button className="text-white/30 hover:text-white/60 text-sm transition-colors">Terms of Service</button></li>
              <li><button className="text-white/30 hover:text-white/60 text-sm transition-colors">MSA Template</button></li>
            </ul>
          </div>
        </div>

        <div className="pt-6 border-t border-white/5 text-xs text-white/15 text-center">
          © {new Date().getFullYear()} CRE Platform, Inc. All rights reserved.
        </div>
      </div>
    </footer>
  );
}