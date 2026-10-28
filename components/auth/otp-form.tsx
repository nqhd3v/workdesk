"use client";

import { Fragment, useActionState, useEffect, useRef, useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import type { FormState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";

// Slightly larger than the default 32px squares; the card sizes itself to this row.
const slotClassName = "size-9 text-sm";

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  hidden?: Record<string, string>;
  label: string;
  submitLabel: string;
  onSuccess?: (message: string) => React.ReactNode;
};

export function OtpForm({ action, hidden, label, submitLabel, onSuccess }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [code, setCode] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // On a failed attempt, keep the code and refocus with the last digit selected,
  // so typing replaces it and Backspace walks back from the end.
  useEffect(() => {
    const input = inputRef.current;
    if (pending || !state?.error || !input) return;
    input.focus();
    input.setSelectionRange(Math.max(input.value.length - 1, 0), input.value.length);
  }, [state, pending]);

  if (state?.success && onSuccess) return onSuccess(state.success);

  return (
    <form ref={formRef} action={formAction} className="mx-auto flex w-fit flex-col gap-4">
      {hidden && Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Field data-invalid={!!state?.error}>
        <FieldLabel htmlFor="code">{label}</FieldLabel>
        <InputOTP
          id="code"
          ref={inputRef}
          name="code"
          maxLength={6}
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={setCode}
          onComplete={() => formRef.current?.requestSubmit()}
          disabled={pending}
          aria-invalid={!!state?.error}
          containerClassName="gap-2"
        >
          {[0, 3].map((start, group) => (
            <Fragment key={start}>
              {group > 0 && <InputOTPSeparator />}
              <InputOTPGroup>
                {[start, start + 1, start + 2].map((index) => (
                  <InputOTPSlot key={index} index={index} className={slotClassName} />
                ))}
              </InputOTPGroup>
            </Fragment>
          ))}
        </InputOTP>
        {state?.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" size="lg" disabled={pending || code.length !== 6}>
        {pending ? "Checking…" : submitLabel}
      </Button>
    </form>
  );
}
