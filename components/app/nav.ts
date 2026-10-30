import { CpuIcon, KeyIcon, SquaresFourIcon, type Icon } from "@phosphor-icons/react";

export type NavItem = { title: string; href: string; icon: Icon };

export const NAV: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { title: "Dashboard", href: "/", icon: SquaresFourIcon },
      { title: "Devices", href: "/devices", icon: CpuIcon },
    ],
  },
  { label: "Settings", items: [{ title: "API keys", href: "/settings/api-keys", icon: KeyIcon }] },
];

// Breadcrumb label per path segment prefix. Unknown segments are skipped.
export const CRUMB_LABELS: Record<string, string> = {
  "/devices": "Devices",
  "/settings": "Settings",
  "/settings/api-keys": "API keys",
};
