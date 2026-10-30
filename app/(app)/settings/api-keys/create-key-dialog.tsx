"use client";

import { useActionState, useState } from "react";
import { PlusIcon, WarningIcon } from "@phosphor-icons/react";
import { CopyField } from "@/components/auth/copy-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { API_SCOPES, SCOPE_INFO, type ApiScope } from "@/lib/api/scopes";
import { createApiKey } from "./actions";
import { ExpiryField } from "./expiry-field";

export function CreateKeyDialog() {
  // Bumped on close so the form (and the one-time key) is discarded.
  const [session, setSession] = useState(0);

  return (
    <Dialog onOpenChange={(open) => !open && setSession((n) => n + 1)}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        New key
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <CreateKeyForm key={session} />
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyForm() {
  const [state, formAction, pending] = useActionState(createApiKey, undefined);
  const [scope, setScope] = useState<ApiScope | null>(null);
  // Controlled so React's post-action form reset doesn't wipe it on a validation error.
  const [name, setName] = useState("");

  if (state && "created" in state) {
    const { key, name, scope, expires_at: expiresAt } = state.created;
    return (
      <>
        <DialogHeader>
          <DialogTitle>Key created: {name}</DialogTitle>
          <DialogDescription>
            Send it as <code>x-workdesk-key</code> to <code>POST {SCOPE_INFO[scope].endpoint}</code>. Expires{" "}
            {new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <WarningIcon />
          <AlertTitle>Copy it now</AlertTitle>
          <AlertDescription>This key is shown only once. If you lose it, revoke it and create a new one.</AlertDescription>
        </Alert>
        <CopyField value={key} label="API key" />
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>New API key</DialogTitle>
        <DialogDescription>Each key is tied to one API and identifies one sender.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="key-name">Name</FieldLabel>
          <Input
            id="key-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Desk sensor"
            maxLength={64}
            required
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="key-scope">API</FieldLabel>
          <Combobox
            name="scope"
            items={API_SCOPES}
            autoHighlight
            value={scope}
            onValueChange={(v: ApiScope | null) => setScope(v)}
            itemToStringLabel={(v: ApiScope) => SCOPE_INFO[v].label}
          >
            <ComboboxInput id="key-scope" placeholder="Type to search: module, events, usage…" required />
            <ComboboxContent>
              <ComboboxEmpty>No matching API.</ComboboxEmpty>
              <ComboboxList>
                {(item: ApiScope) => (
                  <ComboboxItem key={item} value={item}>
                    <div className="flex flex-col">
                      <span>{SCOPE_INFO[item].label}</span>
                      <span className="text-muted-foreground">{SCOPE_INFO[item].endpoint}</span>
                    </div>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          {scope && (
            <FieldDescription>
              {SCOPE_INFO[scope].sender}.
              {scope === "module" && " Registers the first device it reports, and works only for that device."}
            </FieldDescription>
          )}
        </Field>
        <ExpiryField />
        {state && "error" in state && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create key"}
        </Button>
      </DialogFooter>
    </form>
  );
}
