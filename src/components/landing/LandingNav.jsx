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
    <nav className={`fixed top-0 left-0 right-0 z-50 border-b border-[var(--border-cre)] transition-all duration-300 ${scrolled ? "bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] shadow-[var(--shadow-soft)] backdrop-blur-md" : "bg-[var(--surface)]"}`}>
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-[9px] border border-[color-mix(in_srgb,var(--accent)_60%,var(--border-cre))] bg-[var(--surface-2)] flex items-center justify-center shadow-[var(--shadow-soft)]">
            <Building2 className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div>
            <span className="text-[var(--ink)] font-bold text-sm tracking-wide block leading-tight">CRE PLATFORM</span>
            <span className="text-[var(--muted)] text-[9px] font-semibold tracking-[0.15em] leading-tight">BUDGETING & CAM</span>
          </div>
        </Link>

        <div className="hidden lg:flex items-center gap-7">
          {navLinks.map((link, i) =>
            link.to ? (
              <Link key={i} to={link.to} className="text-[var(--muted)] hover:text-[var(--ink)] text-[13px] font-semibold transition-colors">
                {link.label}
              </Link>
            ) : (
              <button key={i} onClick={link.action} className="text-[var(--muted)] hover:text-[var(--ink)] text-[13px] font-semibold transition-colors">
                {link.label}
              </button>
            )
          )}
        </div>

        <div className="hidden lg:flex items-center gap-4">
          <button
            onClick={onSignIn}
            className="text-[var(--muted)] hover:text-[var(--ink)] text-[13px] font-semibold transition-colors px-2"
          >
            Sign in
          </button>
          <Button
            onClick={onRequestAccess}
            className="h-9 rounded-[8px] bg-[var(--accent)] px-5 text-[13px] font-semibold text-white shadow-[var(--shadow-soft)] hover:bg-[var(--accent)]"
          >
            Request access
          </Button>
        </div>

        <button className="lg:hidden text-[var(--ink)]" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden bg-[var(--surface)] border-t border-[var(--border-cre)] px-6 py-5 space-y-1 shadow-[var(--shadow)]">
          {navLinks.map((link, i) =>
            link.to ? (
              <Link key={i} to={link.to} onClick={() => setMobileOpen(false)} className="block text-[var(--muted)] hover:text-[var(--ink)] text-sm py-2.5 font-medium">
                {link.label}
              </Link>
            ) : (
              <button key={i} onClick={link.action} className="block text-[var(--muted)] hover:text-[var(--ink)] text-sm py-2.5 font-medium w-full text-left">
                {link.label}
              </button>
            )
          )}
          <div className="pt-4 border-t border-[var(--border-cre)] flex flex-col gap-3">
            <button
              onClick={() => { onSignIn(); setMobileOpen(false); }}
              className="w-full text-[var(--muted)] hover:text-[var(--ink)] text-sm py-2.5 font-medium text-center border border-[var(--border-cre)] rounded-[8px]"
            >
              Sign in
            </button>
            <Button
              onClick={() => { onRequestAccess(); setMobileOpen(false); }}
              className="w-full bg-[var(--accent)] hover:bg-[var(--accent)] text-white text-sm font-semibold h-10 rounded-[8px]"
            >
              Request access
            </Button>
          </div>
        </div>
      )}
    </nav>
  );
}
