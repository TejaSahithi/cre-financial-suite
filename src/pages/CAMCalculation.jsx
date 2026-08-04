/**
 * CAMCalculation alias — redirects to CAMRun.
 */
import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function CAMCalculation() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(createPageUrl("CAMRun"), { replace: true });
  }, [navigate]);

  return null;
}
