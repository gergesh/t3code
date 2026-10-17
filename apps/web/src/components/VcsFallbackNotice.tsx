import * as Schema from "effect/Schema";
import { useLocalStorage } from "../hooks/useLocalStorage";

export function VcsFallbackNotice(props: {
  environmentId: string;
  repository: string;
  notice: string | null;
  reason: string | null;
}) {
  const [dismissed, setDismissed] = useLocalStorage(
    `vcs-fallback-notice:${JSON.stringify([props.environmentId, props.repository])}`,
    "",
    Schema.String,
  );
  const fingerprint = JSON.stringify([props.notice, props.reason]);
  if (!props.notice || dismissed === fingerprint) return null;
  return (
    <div
      role="status"
      className="pointer-events-auto flex items-start gap-3 border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground"
    >
      <span className="flex-1">{props.notice}</span>
      <button
        type="button"
        aria-label="Dismiss repository fallback notice"
        className="shrink-0 underline underline-offset-2"
        onClick={() => setDismissed(fingerprint)}
      >
        Dismiss
      </button>
    </div>
  );
}
