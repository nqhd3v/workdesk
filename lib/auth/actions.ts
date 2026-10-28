"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  safeNextPath,
} from "@/lib/auth/session";
import { isAuthenticated } from "@/lib/auth/server";
import { checkCode, getConfiguredSecret, isRateLimited, verifyLoginCode } from "@/lib/auth/totp";

export type FormState = { error?: string; success?: string } | undefined;

async function clientKey() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

export async function verifyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!getConfiguredSecret()) {
    return { error: "Sign-in is unavailable right now." };
  }

  const key = await clientKey();
  if (isRateLimited(key)) {
    return { error: "Too many attempts. Try again later." };
  }

  const code = String(formData.get("code") ?? "");
  if (!verifyLoginCode(code, key)) {
    return { error: "Incorrect passcode." };
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  redirect(safeNextPath(formData.get("next")));
}

/** Confirms a freshly generated secret during setup. Does not log in. */
export async function confirmSetupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  // Once a secret is configured, only the logged-in owner may use setup.
  if (getConfiguredSecret() && !(await isAuthenticated())) {
    return { error: "Not allowed." };
  }

  const secret = String(formData.get("secret") ?? "");
  const code = String(formData.get("code") ?? "");
  if (checkCode(secret, code) === null) {
    return { error: "Code does not match. Check your device clock and try again." };
  }
  return { success: secret };
}

export async function logoutAction() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/verify");
}
