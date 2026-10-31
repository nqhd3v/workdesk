import { CopyField } from "@/components/auth/copy-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { generateSecret, getQrDataUrl } from "@/lib/auth/totp";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { SetupConfirm } from "./setup-confirm";

export const metadata: Metadata = { title: "Setup TOTP · Workdesk" };

// Access is gated in proxy.ts.
export default function SetupPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up authenticator</CardTitle>
          <CardDescription>
            1. Scan this QR code with Google Authenticator.
            <br />
            2. Enter the code it shows to confirm.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="mx-auto size-60" />}>
            <SetupBody />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}

async function SetupBody() {
  // Fresh secret per request; it only becomes active once you put it in .env.
  await connection();
  const secret = generateSecret();
  const qr = await getQrDataUrl(secret);

  return (
    <div className="flex flex-col gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
      <img
        src={qr}
        alt="TOTP QR code"
        width={240}
        height={240}
        className="mx-auto bg-white"
      />
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="group/trigger self-start"
            />
          }
        >
          Can&apos;t scan? Enter key manually
          <CaretDownIcon className="transition-transform group-data-[panel-open]/trigger:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CopyField value={secret} label="secret key" />
        </CollapsibleContent>
      </Collapsible>
      <SetupConfirm secret={secret} />
    </div>
  );
}
