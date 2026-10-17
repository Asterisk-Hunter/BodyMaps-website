import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CaseId } from "../../../../helpers/search";
import { cleanCaseInput } from "../../caseInput";
import styles from "./CompareTray.module.css";

interface Props {
  compareIds: CaseId[];
  compareTyped: string;
  setCompareTyped: (s: string) => void;
  compareError?: string | null;
  // Resolves to whether the typed case was added.
  onSubmitTyped: () => boolean | Promise<boolean>;
  onClear: () => void;
  onCompare: () => void;
}

// The tray is fixed on screen but sits last in the page, so the page offers a
// shortcut to it; focus() lands on the Add field, or on Compare once there are
// two cases and the field is gone.
export interface CompareTrayHandle {
  focus: () => void;
}

const CompareTray = forwardRef<CompareTrayHandle, Props>(function CompareTray(
  {
    compareIds,
    compareTyped,
    setCompareTyped,
    compareError = null,
    onSubmitTyped,
    onClear,
    onCompare,
  },
  handleRef,
) {
  const compareBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(handleRef, () => ({
    focus: () => (inputRef.current ?? compareBtnRef.current)?.focus(),
  }));
  // Adding the second case unmounts the form with focus in it; Compare is what
  // comes next, so focus goes there instead of dropping to the page body.
  const submittedFromFormRef = useRef(false);
  useEffect(() => {
    if (!submittedFromFormRef.current || compareIds.length < 2) return;
    submittedFromFormRef.current = false;
    const dropped = !document.activeElement || document.activeElement === document.body;
    if (dropped) compareBtnRef.current?.focus();
  });
  // The message only shows while the form does.
  const showError = compareIds.length < 2 && !!compareError;
  return (
    <div className={styles.compareTray} role="region" aria-label="Compare cases">
      <span className={styles.compareTrayIds}>
        {compareIds.map((id) => `#${id}`).join("  vs  ")}
      </span>
      {compareIds.length < 2 && (
        <form
          className={styles.compareTrayForm}
          onSubmit={async (e) => {
            e.preventDefault();
            submittedFromFormRef.current = true;
            if (!(await onSubmitTyped())) submittedFromFormRef.current = false;
          }}
        >
          <input
            ref={inputRef}
            value={compareTyped}
            // Keeps an id pasted from a card (PanTS_00000017, CV_00000001, BDMAP_00000001);
            // Add says what is wrong with anything else.
            onChange={(e) => setCompareTyped(cleanCaseInput(e.target.value))}
            placeholder="type case #"
            inputMode="numeric"
            aria-label="Add a case by number"
            aria-invalid={showError || undefined}
            aria-describedby={showError ? "compare-tray-error" : undefined}
            className={styles.compareTrayInput}
          />
          <button
            type="submit"
            disabled={compareTyped.trim() === ""}
            className={styles.compareTrayAddBtn}
          >
            Add
          </button>
        </form>
      )}
      {/* Mounted even when empty, so a screen reader announces the message
          when it arrives. */}
      <p
        id="compare-tray-error"
        aria-live="polite"
        className={showError ? styles.compareTrayError : "sr-only"}
      >
        {showError ? compareError : null}
      </p>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear compare selection"
        className={styles.compareTrayBtn}
      >
        Clear
      </button>
      <button
        type="button"
        ref={compareBtnRef}
        disabled={compareIds.length < 2}
        onClick={onCompare}
        className={styles.compareTrayCompareBtn}
      >
        Compare <span aria-hidden="true">→</span>
      </button>
    </div>
  );
});

export default CompareTray;
