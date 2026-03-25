import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Building2, Menu, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

export default function LandingNav({ onSignIn, onRequestAccess, onRequestDemo }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id) => {
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const navLinks = [
    { label: "Features", action: () => scrollTo("features") },
    { label: "Platform", action: () => scrollTo("platform-preview") },
    { label: "Pricing", to: "/Pricing" },
    { label: "FAQ", action: () => scrollTo("faq") },
    { label: "Contact", action: () => scrollTo("contact-us") },
  ];

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled ? "bg-[#0f1a2e]/95 backdrop-blur-md shadow-lg" : "bg-[#1a2744]"}`}>
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-gradient-to-br from-blue-400 to-blue-600 rounded-lg flex items-center justify-center shadow-md">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <span className="text-white font-bold text-sm tracking-wide block leading-tight">CRE PLATFORM</span>
            <span className="text-blue-300/60 text-[9px] font-semibold tracking-[0.15em] leading-tight">BUDGETING & CAM</span>
          </div>
        </Link>

        <div className="hidden lg:flex items-center gap-7">
          {navLinks.map((link, i) =>
            link.to ? (
              <Link key={i} to={link.to} className="text-white/60 hover:text-white text-[13px] font-medium transition-colors">
                {link.label}
              </Link>
            ) : (
              <button key={i} onClick={link.action} className="text-white/60 hover:text-white text-[13px] font-medium transition-colors">
                {link.label}
              </button>
            )
          )}
        </div>

        <div className="hidden lg:flex items-center gap-4">
          <button
            onClick={onSignIn}
            className="text-white/80 hover:text-white text-[13px] font-medium transition-colors px-2"
          >
            Sign in
          </button>
          <Button
            onClick={onRequestAccess}
            className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white text-[13px] font-semibold px-5 h-9 rounded-lg shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.02]"
          >
            Request access
          </Button>
        </div>

        <button className="lg:hidden text-white" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden bg-[#0f1a2e] border-t border-white/10 px-6 py-5 space-y-1">
          {navLinks.map((link, i) =>
            link.to ? (
              <Link key={i} to={link.to} onClick={() => setMobileOpen(false)} className="block text-white/70 hover:text-white text-sm py-2.5 font-medium">
                {link.label}
              </Link>
            ) : (
              <button key={i} onClick={link.action} className="block text-white/70 hover:text-white text-sm py-2.5 font-medium w-full text-left">
                {link.label}
              </button>
            )
          )}
          <div className="pt-4 border-t border-white/10 flex flex-col gap-3">
            <button
              onClick={() => { onSignIn(); setMobileOpen(false); }}
              className="w-full text-white/70 hover:text-white text-sm py-2.5 font-medium text-center border border-white/10 rounded-lg"
            >
              Sign in
            </button>
            <Button
              onClick={() => { onRequestAccess(); setMobileOpen(false); }}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold h-10 rounded-lg"
            >
              Request access
            </Button>
          </div>
        </div>
      )}
    </nav>
  );
}