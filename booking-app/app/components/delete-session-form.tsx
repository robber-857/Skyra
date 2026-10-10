import { useEffect, useId, useRef, useState } from "react";
import { Form } from "react-router";

export function DeleteSessionForm({
  name,
  id,
  version,
  busy,
}: {
  name: string;
  id?: string;
  version: number;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

  function dismiss() {
    setConfirming(false);
    trigger.current?.focus();
  }

  return (
    <Form
      method="post"
      className="schedule-remove-form"
      onSubmit={(event) => {
        if (!confirming || busy) event.preventDefault();
      }}
    >
      <input name="intent" type="hidden" value="remove" />
      {id && <input name="id" type="hidden" value={id} />}
      <input name="version" type="hidden" value={version} />
      <button
        ref={trigger}
        type="button"
        className="danger-text"
        disabled={busy}
        aria-expanded={confirming}
        onClick={() => setConfirming(true)}
      >
        Delete session
      </button>
      {confirming && (
        <div className="panel" role="group" aria-labelledby={headingId}>
          <p id={headingId}><strong>Delete {name} from Weekly Schedule?</strong></p>
          <p>This removes this session only. Bookings must be resolved and active checkout holds cleared before deletion.</p>
          <div className="actions">
            <button ref={cancel} type="button" disabled={busy} onClick={dismiss}>
              Cancel
            </button>
            <button type="submit" className="danger-text" disabled={busy}>
              {busy ? "Deleting session…" : "Confirm delete"}
            </button>
          </div>
        </div>
      )}
    </Form>
  );
}
