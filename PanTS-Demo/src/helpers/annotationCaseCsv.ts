/** Import one case ID per row, optionally headed case_id or case. */
export function parseAnnotationCaseCsv(text: string): string[] {
  if (text.length > 1_000_000) throw new Error("The case list is too large.");
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === "," || c === "\n" || c === "\r") {
      row.push(field.trim()); field = ""; closed = false;
      if (c !== ",") { rows.push(row); row = []; if (c === "\r" && text[i + 1] === "\n") i++; }
    } else if (c === '"' || (closed && !/\s/.test(c))) throw new Error("Invalid quoted CSV field.");
    else field += c;
  }
  if (quoted) throw new Error("Unclosed quoted CSV field.");
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  const populated = rows.filter(cells => cells.some(Boolean));
  if (populated[0] && /^(case|case_id)$/i.test(populated[0][0])) populated.shift();
  if (!populated.length || populated.some(cells => cells.length !== 1 || !cells[0]))
    throw new Error("Use one case ID per CSV row, with an optional case_id header.");
  return populated.map(cells => cells[0]);
}
