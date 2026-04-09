import React, { useEffect, useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

const CUSTOM_SENTINEL = "__custom__";
const CLEAR_SENTINEL = "__clear__";

/**
 * A controlled <Select> that exposes a fixed list of options plus a
 * "Custom..." entry. Selecting the custom entry reveals an inline text input
 * the user can fill with any value, which is then propagated to `onChange`.
 *
 * Free-form values that don't match any option are rendered as-is and the
 * select trigger shows the raw string.
 */
export function SelectWithCustom({
  value,
  onChange,
  options = [],
  placeholder = "Select option…",
  allowClear = true,
  className = "",
  customLabel = "Custom…",
}) {
  const isCustomValue = useMemo(() => {
    if (value == null || value === "") return false;
    return !options.some((option) => option.value === value);
  }, [value, options]);

  const [customMode, setCustomMode] = useState(isCustomValue);
  const [customDraft, setCustomDraft] = useState(isCustomValue ? String(value) : "");

  // Sync internal state when the controlled value changes (e.g. parent reset).
  useEffect(() => {
    if (isCustomValue) {
      setCustomMode(true);
      setCustomDraft(String(value));
    } else if (value === "" || value == null) {
      setCustomMode(false);
      setCustomDraft("");
    } else {
      setCustomMode(false);
    }
  }, [value, isCustomValue]);

  const handleSelectChange = (next) => {
    if (next === CUSTOM_SENTINEL) {
      setCustomMode(true);
      setCustomDraft("");
      return;
    }
    if (next === CLEAR_SENTINEL) {
      setCustomMode(false);
      setCustomDraft("");
      onChange?.("");
      return;
    }
    setCustomMode(false);
    setCustomDraft("");
    onChange?.(next);
  };

  const commitCustom = () => {
    const trimmed = customDraft.trim();
    if (!trimmed) {
      setCustomMode(false);
      onChange?.("");
      return;
    }
    onChange?.(trimmed);
  };

  const cancelCustom = () => {
    setCustomMode(false);
    setCustomDraft("");
    if (isCustomValue) onChange?.("");
  };

  // Build the trigger value: empty string when nothing selected, custom sentinel when in edit mode.
  const triggerValue = customMode
    ? CUSTOM_SENTINEL
    : value && options.some((option) => option.value === value)
      ? value
      : isCustomValue
        ? CUSTOM_SENTINEL
        : "";

  return (
    <div className={`space-y-2 ${className}`}>
      <Select value={triggerValue || undefined} onValueChange={handleSelectChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder}>
            {customMode || isCustomValue
              ? value || customLabel
              : options.find((option) => option.value === value)?.label || placeholder}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SENTINEL}>
            <span className="flex items-center gap-1.5 text-blue-600">
              <Plus className="w-3.5 h-3.5" />
              {customLabel}
            </span>
          </SelectItem>
          {allowClear && value ? (
            <SelectItem value={CLEAR_SENTINEL}>
              <span className="flex items-center gap-1.5 text-slate-500">
                <X className="w-3.5 h-3.5" />
                Clear selection
              </span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>

      {customMode && (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCustom();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelCustom();
              }
            }}
            placeholder="Type a custom value…"
            className="flex-1"
          />
          <Button type="button" size="sm" onClick={commitCustom} className="bg-blue-600 hover:bg-blue-700">
            Add
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={cancelCustom}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

export default SelectWithCustom;
