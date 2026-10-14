import { caseIdToNumber, numberToCaseId, PANTS_CASE_COUNT } from "../../helpers/caseNumbering";
import type { CaseId } from "../../helpers/search";

// What a reader can type or paste into the dataset search box or the compare
// tray's field: a library number ("17", "9902", or "9,902" and "#9,902" as the
// cards print it), or an id copied from a card or a link ("PanTS_00000017",
// "CV_00000001", in any letter case).

export const CASE_INPUT_HINT =
  "Enter a case number such as 17 or 9902, or an ID like PanTS_00000017 or CV_00000001.";
export const PANTS_RANGE_HINT = "PanTS IDs run from PanTS_00000001 to PanTS_00009901.";

export type CaseInput =
  // A library number: 1 to 9,901 are PanTS, CancerVerse continues from 9,902.
  | { kind: "number"; n: number }
  // An exact id, opened as it is and never clamped to another case.
  | { kind: "id"; id: CaseId }
  | { kind: "invalid"; message: string };

/** Drops what the field never needs: spaces, and the "#" and commas of a card's number. */
export const cleanCaseInput = (value: string): string => value.replace(/[\s,#]/g, "");

/** Reads the field; null when it is empty (Search then applies the filters instead). */
export function parseCaseInput(value: string): CaseInput | null {
  const raw = cleanCaseInput(value);
  if (!raw) return null;
  const pants = /^PanTS_/i.test(raw);
  const n = caseIdToNumber(raw);
  if (n === null) return { kind: "invalid", message: pants ? PANTS_RANGE_HINT : CASE_INPUT_HINT };
  if (/^\d+$/.test(raw)) return { kind: "number", n };
  if (pants) {
    return n <= PANTS_CASE_COUNT ? { kind: "id", id: n } : { kind: "invalid", message: PANTS_RANGE_HINT };
  }
  // A CV_ id: its own number maps back to the same id, zero padded.
  return { kind: "id", id: numberToCaseId(n) as string };
}
