"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";

const THEMES = [
  { value: "system", label: "System", icon: DesktopIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

type ThemeValue = (typeof THEMES)[number]["value"];

/**
 * Switch theme inside a View Transition so the page crossfades instead of snapping.
 * The class is applied synchronously in the callback (next-themes applies it in an effect,
 * which would be too late for the "new" snapshot). Falls back to an instant switch.
 */
function switchTheme(value: ThemeValue, setTheme: (theme: string) => void) {
  const apply = () => {
    const dark = value === "dark" || (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    setTheme(value);
  };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!document.startViewTransition || reduceMotion) return apply();
  document.startViewTransition(apply);
}

// The stored theme is only known in the browser; render a neutral state on the server.
const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

export function ThemeToggle({ variant = "icon" }: { variant?: "icon" | "sidebar" }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const current = THEMES.find((t) => t.value === (mounted ? theme : "system")) ?? THEMES[0];

  const trigger =
    variant === "sidebar" ? (
      <SidebarMenuButton tooltip="Theme" />
    ) : (
      <Button variant="ghost" size="icon-sm" aria-label="Theme" />
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>
        <current.icon />
        {variant === "sidebar" && <span>Theme: {current.label}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={variant === "sidebar" ? "start" : "end"} side={variant === "sidebar" ? "top" : "bottom"}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current.value} onValueChange={(v) => switchTheme(v as ThemeValue, setTheme)}>
            {THEMES.map((t) => (
              <DropdownMenuRadioItem key={t.value} value={t.value} closeOnClick>
                <t.icon />
                {t.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
