import { useEffect, useId, useRef, useState } from "react";
import { Form, useNavigation } from "react-router";

export function CopyWeekForm({ week, busy }: { week: string; busy: boolean }) {
  const [mode, setMode] = useState("skip");
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const navigation = useNavigation();
  const copying =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "copy";
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (navigation.state === "idle" && submitted.current) {
      submitted.current = false;
      dialog.current?.close();
    }
  }, [navigation.state]);

  return (
    <div className="schedule-copy-form">
      <label>
        When copying last week
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value)}
          disabled={busy}
        >
          <option value="skip">Keep existing sessions · skip conflicts</option>
          <option value="replace">Replace conflicting sessions</option>
        </select>
      </label>
      <button
        type="button"
        disabled={busy}
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          cancel.current?.focus();
        }}
      >
        {copying ? "Copying previous week…" : "Copy previous week"}
      </button>
      <dialog
        ref={dialog}
        className="feedback-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          if (submitted.current) event.preventDefault();
        }}
      >
        <h2 id={titleId}>Copy previous week?</h2>
        <p id={descriptionId}>
          {mode === "skip"
            ? "Copy only non-conflicting classes from the previous week as drafts? Existing sessions and bookings will be kept. Past or unavailable occurrences will be skipped."
            : "Copy the previous week? Conflicting sessions will be replaced. Their bookings will be cancelled and credits returned. Identical sessions and their bookings will be kept."}
        </p>
        <Form
          method="post"
          onSubmit={(event) => {
            if (busy || submitted.current) {
              event.preventDefault();
              return;
            }
            submitted.current = true;
          }}
        >
          <input type="hidden" name="intent" value="copy" />
          <input type="hidden" name="week" value={week} />
          <input type="hidden" name="copyMode" value={mode} />
          <div className="actions">
            <button
              ref={cancel}
              type="button"
              disabled={busy}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy}
              aria-busy={copying}
            >
              {copying ? "Copying previous week…" : "Confirm copy"}
            </button>
          </div>
        </Form>
      </dialog>
    </div>
  );
}
