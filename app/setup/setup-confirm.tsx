"use client";

import Link from "next/link";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { CopyField } from "@/components/auth/copy-field";
import { OtpForm } from "@/components/auth/otp-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { confirmSetupAction } from "@/lib/auth/actions";

export function SetupConfirm({ secret }: { secret: string }) {
  return (
    <OtpForm
      action={confirmSetupAction}
      hidden={{ secret }}
      label="6-digit code"
      submitLabel="Confirm"
      onSuccess={(confirmed) => (
        <div className="flex flex-col gap-3">
          <Alert>
            <CheckCircleIcon />
            <AlertTitle>Code confirmed</AlertTitle>
            <AlertDescription>
              Add this line to <code>.env</code> and restart the server.
            </AlertDescription>
          </Alert>
          <CopyField value={`TOTP_SECRET=${confirmed}`} label="env line" />
          <Link href="/verify" className={buttonVariants()}>
            Go to login
          </Link>
        </div>
      )}
    />
  );
}
