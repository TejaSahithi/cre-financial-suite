import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { Link } from "react-router-dom";
import ProFormaBrand from "@/components/ProFormaBrand";

export default function LandingNav({ onSignIn, onRequestAccess }) {
  const [mobileOpen, setMobileOpen] = useState(false);

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
    <nav className="pf-landing-nav fixed top-0 left-0 right-0 z-50 transition-shadow duration-300">
      <div className="pf-nav-inner flex w-full items-start justify-between pr-4 sm:pr-6 lg:pr-10">
        <Link to="/" className="pf-nav-logo-plate flex shrink-0 items-center" aria-label="ProForma OS home">
          <ProFormaBrand className="pf-nav-brand" />
        </Link>

        <div className="pf-nav-menu hidden flex-1 items-center justify-center gap-9 lg:flex">
          {navLinks.map((link, i) =>
            link.to ? (
              <Link key={i} to={link.to} className="text-[15px] font-semibold text-[var(--ink)] transition-colors hover:text-[var(--accent)]">
                {link.label}
              </Link>
            ) : (
              <button key={i} onClick={link.action} className="text-[15px] font-semibold text-[var(--ink)] transition-colors hover:text-[var(--accent)]">
                {link.label}
              </button>
            )
          )}
        </div>

        <div className="pf-nav-actions hidden items-center gap-5 lg:flex">
          <button
            onClick={onSignIn}
            className="px-2 text-[15px] font-semibold text-[var(--ink)] transition-colors hover:text-[var(--accent)]"
          >
            Sign in
          </button>
          <Button
            onClick={onRequestAccess}
            className="h-12 rounded-[10px] border-[var(--accent)] bg-gradient-to-r from-[var(--pf-blue-deep)] to-[var(--pf-blue-bright)] px-8 text-[15px] font-bold text-white shadow-[0_14px_28px_rgba(20,86,199,.22)] hover:shadow-[0_18px_36px_rgba(20,86,199,.28)]"
          >
            Request access
          </Button>
        </div>

        <button className="mr-2 rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] p-2 text-[var(--ink)] lg:hidden" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation">
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden border-t border-[var(--border-cre)] bg-[var(--surface)] px-6 py-5 shadow-[var(--shadow)]">
          <div className="space-y-1">
            {navLinks.map((link, i) =>
              link.to ? (
                <Link key={i} to={link.to} onClick={() => setMobileOpen(false)} className="block rounded-[8px] px-3 py-2.5 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-2)]">
                  {link.label}
                </Link>
              ) : (
                <button key={i} onClick={link.action} className="block w-full rounded-[8px] px-3 py-2.5 text-left text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-2)]">
                  {link.label}
                </button>
              )
            )}
          </div>
          <div className="mt-4 flex flex-col gap-3 border-t border-[var(--border-cre)] pt-4">
            <button
              onClick={() => { onSignIn(); setMobileOpen(false); }}
              className="h-10 rounded-[8px] border border-[var(--border-cre)] text-sm font-semibold text-[var(--ink)]"
            >
              Sign in
            </button>
            <Button
              onClick={() => { onRequestAccess(); setMobileOpen(false); }}
              className="h-10 rounded-[8px] bg-gradient-to-r from-[var(--pf-blue-deep)] to-[var(--pf-blue-bright)] text-sm font-bold text-white"
            >
              Request access
            </Button>
          </div>
        </div>
      )}
    </nav>
  );
}
