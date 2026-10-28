import type { Metadata } from "next";
import { Suspense } from "react";
import { WarningIcon } from "@phosphor-icons/react/dist/ssr";
import { OtpForm } from "@/components/auth/otp-form";
import { SystemIllustration } from "@/components/auth/system-illustration";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { verifyAction } from "@/lib/auth/actions";
import { safeNextPath } from "@/lib/auth/session";
import { getConfiguredSecret } from "@/lib/auth/totp";

export const metadata: Metadata = { title: "Workdesk" };

export default function VerifyPage({ searchParams }: PageProps<"/verify">) {
  return (
    <main className="flex flex-1 items-center justify-center bg-muted p-6 md:p-10">
      <Card className="w-full max-w-sm overflow-hidden p-0 duration-500 animate-in fade-in-0 slide-in-from-bottom-2 md:max-w-3xl">
        <CardContent className="grid p-0 md:grid-cols-2">
          <div className="flex flex-col justify-center gap-6 p-6 md:p-10">
            <div className="flex flex-col items-center gap-1 text-center">
              <h1 className="text-xl font-bold">Welcome back</h1>
              <p className="text-balance text-muted-foreground">Enter your passcode to continue.</p>
            </div>
            <Suspense fallback={<Skeleton className="mx-auto h-24 w-60" />}>
              <VerifyForm searchParams={searchParams} />
            </Suspense>
          </div>
          <div className="relative hidden aspect-square bg-muted/60 md:block">
            <SystemIllustration />
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

async function VerifyForm({ searchParams }: Pick<PageProps<"/verify">, "searchParams">) {
  // Awaiting searchParams makes this request-time, so TOTP_SECRET is read per request, not at build.
  const { next } = await searchParams;

  // Deliberately vague: don't reveal how auth works. Owner finishes setup at /setup.
  if (!getConfiguredSecret()) {
    return (
      <Alert>
        <WarningIcon />
        <AlertTitle>Sign-in is unavailable right now</AlertTitle>
        <AlertDescription>Please try again later.</AlertDescription>
      </Alert>
    );
  }

  return <OtpForm action={verifyAction} hidden={{ next: safeNextPath(next) }} label="Passcode" submitLabel="Continue" />;
}
