import { KeyIcon, SquaresFourIcon, type Icon } from "@phosphor-icons/react";

export type NavItem = { title: string; href: string; icon: Icon };

export const NAV: { label?: string; items: NavItem[] }[] = [
  { items: [{ title: "Dashboard", href: "/", icon: SquaresFourIcon }] },
  { label: "Settings", items: [{ title: "API keys", href: "/settings/api-keys", icon: KeyIcon }] },
];

// Breadcrumb label per path segment prefix. Unknown segments are skipped.
export const CRUMB_LABELS: Record<string, string> = {
  "/settings": "Settings",
  "/settings/api-keys": "API keys",
};
