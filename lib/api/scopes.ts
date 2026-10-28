// Client-safe metadata for the ingest APIs.

/** Keys live at most this long; also enforced by a DB check constraint. */
export const MAX_KEY_LIFETIME_DAYS = 365;

export const API_SCOPES = ["module", "events", "usage_state"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_INFO: Record<ApiScope, { label: string; endpoint: string; sender: string }> = {
  module: { label: "Module", endpoint: "/api/module", sender: "IoT module pushing environment readings" },
  events: { label: "Events", endpoint: "/api/events", sender: "Calendar source pushing upcoming events" },
  usage_state: { label: "Usage state", endpoint: "/api/usage-state", sender: "Client pushing plan usage limits" },
};
