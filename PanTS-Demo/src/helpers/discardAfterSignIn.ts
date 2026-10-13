// A request to delete an upload that could not be answered (the sign-in had
// lapsed and it met a 401, the network dropped, the server erred or was busy)
// did nothing, and has to be made again. The session ids wait here, in this
// browser, until the server has answered one for good: a reload in between
// does not lose them, and they are sent again at the next sign-in or page load
// of the account that asked. Another account on the same browser would only be
// refused (the upload is not its own), and the request would be lost with it.

const KEY = "bodymaps-discard-after-sign-in";
const MAX_WAITING = 50;

// ownerId is null for an id saved before the account was kept with it.
type Waiting = { sid: string; ownerId: string | null };

const read = (): Waiting[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): Waiting[] => {
      if (typeof entry === "string") return [{ sid: entry, ownerId: null }];
      if (entry && typeof entry.sid === "string" && typeof entry.ownerId === "string") {
        return [{ sid: entry.sid, ownerId: entry.ownerId }];
      }
      return [];
    });
  } catch {
    return [];
  }
};

const write = (entries: Waiting[]) => {
  try {
    if (entries.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_WAITING)));
  } catch {
    // Storage is unavailable: the file stays on the server, as it did before.
  }
};

// Whether an entry is one this account sends: its own, or one with no owner.
const sentBy = (ownerId: string) => (entry: Waiting) => entry.ownerId === ownerId || entry.ownerId === null;

export function queueDiscardAfterSignIn(sessionId: string, ownerId: string): void {
  const waiting = read();
  if (waiting.some((entry) => entry.sid === sessionId && entry.ownerId === ownerId)) return;
  // An id that waited without an owner now has one.
  const others = waiting.filter((entry) => !(entry.sid === sessionId && entry.ownerId === null));
  write([...others, { sid: sessionId, ownerId }]);
}

/** The session ids still waiting for this account to discard them; they stay until forgotten. */
export function queuedDiscards(ownerId: string): string[] {
  return read().filter(sentBy(ownerId)).map((entry) => entry.sid);
}

/** The server has answered this account's one for good, so it is not waiting any more. */
export function forgetQueuedDiscard(sessionId: string, ownerId: string): void {
  const waiting = read();
  const ours = sentBy(ownerId);
  const left = waiting.filter((entry) => !(entry.sid === sessionId && ours(entry)));
  if (left.length !== waiting.length) write(left);
}
