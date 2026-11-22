import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, Label } from "@rakazo/ui-web";
import { useState } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../../lib/auth/auth";
import { useSave } from "../../lib/query/query";
import { AuthFrame, submitClass } from "./Auth";

type Step =
  | { kind: "enter" }
  | { kind: "confirm"; userCode: string }
  | { kind: "done"; approved: boolean };

/**
 * Signs in a device that shows a code, such as one without a keyboard. The code is typed here
 * rather than taken from a link, so a link someone else sent cannot sign their device in as you.
 */
export function DeviceSignInPage() {
  const { t } = useLingui();
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [code, setCode] = useState("");
  // Signing a device in belongs to the account, not a space, so it never needs the API client.
  const change = useSave({
    save: async (action: () => Promise<Step | null>) => {
      const next = await action().catch(() => {
        throw new Error(t`Could not reach the server`);
      });
      if (!next) throw new Error(t`That code is invalid or expired`);
      return next;
    },
    onSaved: setStep,
  });
  const pending = change.pending;
  const error = change.error?.message || null;

  function lookUp() {
    const userCode = code.trim();
    if (!userCode) return;
    change.run(async () => {
      const result = await authClient.device({ query: { user_code: userCode } });
      return !result.error && result.data?.status === "pending"
        ? { kind: "confirm", userCode }
        : null;
    });
  }

  function answer(userCode: string, approve: boolean) {
    change.run(async () => {
      const result = approve
        ? await authClient.device.approve({ userCode })
        : await authClient.device.deny({ userCode });
      return result.error ? null : { kind: "done", approved: approve };
    });
  }

  const alert = error ? (
    <p role="alert" className="mt-3 w-full text-body text-destructive">
      {error}
    </p>
  ) : null;

  if (step.kind === "done") {
    return (
      <AuthFrame
        title={
          step.approved ? <Trans>Device signed in</Trans> : <Trans>Device not signed in</Trans>
        }
        onSubmit={(event) => event.preventDefault()}
      >
        <Link to="/app" className="font-medium">
          <Trans>Open Rakazo</Trans>
        </Link>
      </AuthFrame>
    );
  }

  if (step.kind === "confirm") {
    return (
      <AuthFrame
        title={<Trans>Sign in this device?</Trans>}
        onSubmit={(event) => {
          event.preventDefault();
          answer(step.userCode, true);
        }}
      >
        <p className="-mt-6 text-center text-muted-foreground">
          <Trans>It will have full access to your account.</Trans>
        </p>
        {alert}
        <Button type="submit" size="xl" disabled={pending} className={submitClass}>
          <Trans>Sign in</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xl"
          disabled={pending}
          className={submitClass}
          onClick={() => answer(step.userCode, false)}
        >
          <Trans>Cancel</Trans>
        </Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={<Trans>Sign in a device</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        lookUp();
      }}
    >
      <div className="w-full">
        <Label htmlFor="device-code">
          <Trans>Code shown on the device</Trans>
        </Label>
        <Input
          id="device-code"
          className="mt-2"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      {alert}
      <Button type="submit" size="xl" disabled={pending || !code.trim()} className={submitClass}>
        <Trans>Continue</Trans>
      </Button>
    </AuthFrame>
  );
}
