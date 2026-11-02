"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ModuleOption = { value: string; label: string; href: string };

/** Picks the module in focus; the URL holds the choice, so it survives refreshes. */
export function ModuleSelect({ options, value }: { options: ModuleOption[]; value: string }) {
  const router = useRouter();
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(id) => {
        const option = options.find((o) => o.value === id);
        if (option) router.push(option.href, { scroll: false });
      }}
    >
      <SelectTrigger size="sm" aria-label="IoT module" className="max-w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
