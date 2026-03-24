import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useModuleAccess } from "@/lib/ModuleAccessContext";

/**
 * A cross-module link component that only renders if the target module/page is enabled.
 * If the module is disabled, it renders nothing (or an optional fallback).
 * 
 * Usage:
 *   <ModuleLink page="Billing" className="text-blue-600">View Billing</ModuleLink>
 *   <ModuleLink page="Vendors" fallback={<span className="text-slate-400">Vendors</span>}>View Vendors</ModuleLink>
 */
export default function ModuleLink({ page, params, children, fallback = null, className, ...rest }) {
  const { isPageEnabled } = useModuleAccess();

  if (!isPageEnabled(page)) {
    return fallback;
  }

  const url = params ? createPageUrl(page) + `?${params}` : createPageUrl(page);

  return (
    <Link to={url} className={className} {...rest}>
      {children}
    </Link>
  );
}