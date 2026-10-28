"use client";

import { useState } from "react";
import { addDays, endOfDay, format, startOfDay } from "date-fns";
import { CalendarBlankIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MAX_KEY_LIFETIME_DAYS } from "@/lib/api/scopes";

const PRESETS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "6 months" },
  { value: String(MAX_KEY_LIFETIME_DAYS), label: "1 year (max)" },
  { value: "custom", label: "Custom date…" },
];
const DEFAULT_PRESET = "90";

/** Expiry picker; submits `expires_at` as an ISO timestamp (server re-validates the 1-year cap). */
export function ExpiryField() {
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(() => addDays(new Date(), Number(DEFAULT_PRESET)));
  // Bounds for the custom date picker, fixed when the form opens.
  const [bounds] = useState(() => {
    const now = new Date();
    return { min: startOfDay(addDays(now, 1)), max: addDays(now, MAX_KEY_LIFETIME_DAYS) };
  });

  function choosePreset(value: string | null) {
    if (!value) return;
    setPreset(value);
    setExpiresAt(value === "custom" ? undefined : addDays(new Date(), Number(value)));
  }

  return (
    <Field>
      <FieldLabel htmlFor="key-expiry">Expires</FieldLabel>
      <input type="hidden" name="expires_at" value={expiresAt?.toISOString() ?? ""} />
      <div className="flex gap-2">
        <Select items={PRESETS} value={preset} onValueChange={choosePreset}>
          <SelectTrigger id="key-expiry" className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset === "custom" && (
          <Popover>
            <PopoverTrigger render={<Button variant="outline" type="button" className="flex-1 justify-start" />}>
              <CalendarBlankIcon data-icon="inline-start" />
              {expiresAt ? format(expiresAt, "d MMM yyyy") : "Pick a date"}
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={expiresAt}
                // Custom dates expire at the end of the chosen day, still inside the 1-year cap.
                onSelect={(d) => setExpiresAt(d && new Date(Math.min(endOfDay(d).getTime(), bounds.max.getTime())))}
                disabled={[{ before: bounds.min }, { after: bounds.max }]}
                startMonth={bounds.min}
                endMonth={bounds.max}
                defaultMonth={expiresAt ?? bounds.min}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
      <FieldDescription>
        {expiresAt
          ? `Expires ${format(expiresAt, "d MMM yyyy, HH:mm")}. Max ${MAX_KEY_LIFETIME_DAYS} days.`
          : "Pick a date within the next year."}
      </FieldDescription>
    </Field>
  );
}
