"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { FormResult } from "@/app/settings/actions";

export function SubmitButton({ children, pending: pendingLabel, className }: { children: ReactNode; pending?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}

/** A form bound to a server action that returns FormResult; shows the outcome under the fields. */
export function ActionForm({
  action,
  children,
  submit,
  pending,
  className,
  submitClassName,
}: {
  action: (prev: FormResult | null, form: FormData) => Promise<FormResult>;
  children: ReactNode;
  submit: string;
  pending?: string;
  className?: string;
  submitClassName?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className ?? "form"}>
      {children}
      <div className="form-actions">
        <SubmitButton pending={pending} className={submitClassName}>
          {submit}
        </SubmitButton>
      </div>
      {state?.error && (
        <div className="callout error-callout" role="alert">
          {state.error}
        </div>
      )}
      {state?.message && (
        <div className="callout ok-callout" role="status">
          {state.message}
        </div>
      )}
    </form>
  );
}
