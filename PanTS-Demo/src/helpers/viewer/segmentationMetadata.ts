export type SavedStructure = { name: string; color: [number, number, number, number] };
export type SavedStructures = Record<number, SavedStructure>;
const revisions = new Map<string, string>();
const keyFor = (base: string, id: string | number, owner?: string | number) => `${base}:${owner ?? ""}:${id}`;

export function structureMetadataHeader(value: SavedStructures): string {
  // HTTP header values must remain byte-safe, including non-Latin class names.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function parseSavedStructures(value: unknown): SavedStructures {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SavedStructures = {};
  for (const [key, item] of Object.entries(value)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1 || index > 255 || !item || typeof item !== "object") {
      throw new Error("Invalid saved structure metadata.");
    }
    const { name, color } = item as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 128 || !Array.isArray(color)
        || color.length !== 4 || !color.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
      throw new Error("Invalid saved structure metadata.");
    }
    result[index] = { name: name.trim(), color: [...color] as SavedStructure["color"] };
  }
  return result;
}

export function savedRevision(base: string, id: string | number, owner?: string | number): string | undefined {
  return revisions.get(keyFor(base, id, owner));
}

export function rememberSavedRevision(base: string, id: string | number, revision: unknown, owner?: string | number) {
  if (typeof revision === "string") revisions.set(keyFor(base, id, owner), revision);
}

export async function loadSegmentationMetadata(base: string, id: string | number, signal: AbortSignal, owner?: string | number): Promise<SavedStructures> {
  const key = keyFor(base, id, owner);
  revisions.delete(key);
  const response = await fetch(`${base}/api/segmentation-metadata/${encodeURIComponent(id)}`, {
    signal, cache: "no-store", credentials: "include",
    headers: owner != null ? { "X-Upload-Owner": String(owner) } : {},
  });
  // Other datasets without a saved labelmap still use the built-in catalogue.
  if (response.status === 404) return {};
  if (!response.ok) throw new Error("Could not load saved segmentation metadata. Retry opening the case.");
  const data = await response.json();
  const structures = parseSavedStructures(data.custom_structures);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  rememberSavedRevision(base, id, data.revision, owner);
  return structures;
}
