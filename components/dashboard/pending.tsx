"use client";

import { createContext, useContext, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { cn } from "cn";

type Navigate = (href: string) => void;
type PendingState = { pending: boolean; target: string | null; navigate: Navigate };

const PendingContext = createContext<PendingState>({ pending: false, target: null, navigate: () => {} });

/**
 * Search-param changes (range, module) re-render the same page in a transition, so the Suspense
 * fallback never shows and the old data just sits there. This tracks that transition instead.
 */
export function DashboardPendingProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);
  const navigate: Navigate = (href) => {
    setTarget(href);
    startTransition(() => router.push(href, { scroll: false }));
  };
  return <PendingContext value={{ pending, target: pending ? target : null, navigate }}>{children}</PendingContext>;
}

export const useDashboardPending = () => useContext(PendingContext);

/** A link that navigates through the dashboard transition; modified clicks (new tab etc.) stay normal. */
export function PendingLink({ href, className, children, ...props }: React.ComponentProps<typeof Link> & { href: string }) {
  const { target, navigate } = useDashboardPending();
  const loading = target === href;
  return (
    <Link
      {...props}
      href={href}
      scroll={false}
      aria-busy={loading || undefined}
      className={cn(className, "gap-1")}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {loading && <CircleNotchIcon aria-hidden className="animate-spin" />}
      {children}
    </Link>
  );
}

/** Dims the dashboard and shows a spinner while new data loads. */
export function PendingContent({ className, children }: { className?: string; children: React.ReactNode }) {
  const { pending } = useDashboardPending();
  return (
    <div className="relative" aria-busy={pending || undefined}>
      <div className={cn(className, "transition-opacity", pending && "pointer-events-none animate-pulse opacity-50")}>{children}</div>
      {pending && (
        <div role="status" className="absolute inset-x-0 top-24 flex justify-center">
          <span className="flex items-center gap-2 border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <CircleNotchIcon aria-hidden className="animate-spin" />
            Loading…
          </span>
        </div>
      )}
    </div>
  );
}
