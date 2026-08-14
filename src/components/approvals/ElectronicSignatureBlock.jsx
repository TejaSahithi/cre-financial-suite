import React, { useEffect, useMemo, useRef, useState } from "react";
import { Lock, PenLine, UserCircle2 } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

function userDisplayName(user) {
  return (
    user?.full_name ||
    user?.profile?.full_name ||
    user?.user_metadata?.full_name ||
    user?.email?.split("@")?.[0] ||
    ""
  );
}

function userEmail(user) {
  return user?.email || user?.profile?.email || "";
}

function userRole(user) {
  return user?.role || user?.membership?.role || user?.memberships?.[0]?.role || "Approver";
}

function formatRole(value) {
  return String(value || "Approver")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatSigningTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function getCanvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

export default function ElectronicSignatureBlock({
  user,
  title = "Attestation & Electronic Signature",
  attestationText = "I reviewed this item and authorize this approval to be recorded.",
  defaultName = "",
  onChange,
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [attested, setAttested] = useState(false);
  const [signedBy, setSignedBy] = useState(defaultName || userDisplayName(user));
  const [signedAt] = useState(() => new Date().toISOString());
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const hasSignature = Boolean(signatureDataUrl);
  const approverName = userDisplayName(user) || signedBy || "Current approver";
  const approverEmail = userEmail(user);
  const approverRole = formatRole(userRole(user));

  useEffect(() => {
    if (!signedBy && (defaultName || userDisplayName(user))) {
      setSignedBy(defaultName || userDisplayName(user));
    }
  }, [defaultName, signedBy, user]);

  const payload = useMemo(
    () => ({
      attested,
      signedBy: signedBy.trim(),
      signedAt,
      signatureDataUrl,
      hasSignature,
      valid: attested && Boolean(signedBy.trim()) && hasSignature,
    }),
    [attested, hasSignature, signatureDataUrl, signedAt, signedBy]
  );

  useEffect(() => {
    onChange?.(payload);
  }, [onChange, payload]);

  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    const previous = signatureDataUrl;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f1f5f";
    if (previous) {
      const image = new Image();
      image.onload = () => ctx.drawImage(image, 0, 0, width, height);
      image.src = previous;
    }
  };

  useEffect(() => {
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, []);

  const beginStroke = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    const point = getCanvasPoint(canvas, event);
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    drawingRef.current = true;
  };

  const drawStroke = (event) => {
    const canvas = canvasRef.current;
    if (!canvas || !drawingRef.current) return;
    event.preventDefault();
    const point = getCanvasPoint(canvas, event);
    const ctx = canvas.getContext("2d");
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const endStroke = (event) => {
    const canvas = canvasRef.current;
    if (!canvas || !drawingRef.current) return;
    event?.preventDefault?.();
    drawingRef.current = false;
    setSignatureDataUrl(canvas.toDataURL("image/png"));
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setSignatureDataUrl("");
  };

  return (
    <div className="rounded-lg border border-blue-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-bold text-blue-950">{title}</h3>

      <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-blue-300 bg-white text-blue-700">
            <UserCircle2 className="h-6 w-6" />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-blue-700">Current approver</p>
            <p className="text-sm font-bold text-blue-950">{approverName}</p>
            <p className="text-xs text-slate-500">
              {approverRole}{approverEmail ? ` · ${approverEmail}` : ""}
            </p>
          </div>
        </div>
      </div>

      <label className="mt-4 flex items-start gap-3 text-sm text-blue-950">
        <Checkbox checked={attested} onCheckedChange={(checked) => setAttested(Boolean(checked))} />
        <span>{attestationText}</span>
      </label>

      <div className="mt-4">
        <Label className="text-xs font-semibold text-blue-950">
          Type your full legal name <span className="text-red-500">*</span>
        </Label>
        <Input className="mt-1" value={signedBy} onChange={(event) => setSignedBy(event.target.value)} />
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <Label className="text-xs font-semibold text-blue-950">
            Draw your signature <span className="text-red-500">*</span>
          </Label>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-blue-700" onClick={clearSignature}>
            Clear
          </Button>
        </div>
        <div className="rounded-lg border border-blue-200 bg-white p-2">
          <canvas
            ref={canvasRef}
            className="h-32 w-full touch-none rounded-md bg-white"
            onPointerDown={beginStroke}
            onPointerMove={drawStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            aria-label="Electronic signature drawing pad"
          />
          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
            <PenLine className="h-3.5 w-3.5 text-blue-700" />
            Use your mouse, trackpad, touchscreen, or stylus
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-blue-100 pt-3">
        <p className="text-xs font-bold text-blue-950">Signing time</p>
        <p className="text-sm text-slate-600">{formatSigningTime(signedAt)} · Recorded automatically</p>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-blue-100 pt-3 text-sm text-slate-600">
        <Lock className="h-4 w-4 text-blue-800" />
        This approval will be permanently recorded in the audit log.
      </div>
    </div>
  );
}
