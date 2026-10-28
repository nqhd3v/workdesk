import "server-only";
import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client. Uses the secret key, which bypasses RLS:
// every caller must check who the user is before querying.
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
