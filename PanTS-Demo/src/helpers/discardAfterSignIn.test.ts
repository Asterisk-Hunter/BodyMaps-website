import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetQueuedDiscard, queuedDiscards, queueDiscardAfterSignIn } from "./discardAfterSignIn";

describe("discardAfterSignIn", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("lists what was queued, without repeats, until each is forgotten", () => {
    queueDiscardAfterSignIn("a", "u1");
    queueDiscardAfterSignIn("b", "u1");
    queueDiscardAfterSignIn("a", "u1");

    expect(queuedDiscards("u1")).toEqual(["a", "b"]);
    expect(queuedDiscards("u1")).toEqual(["a", "b"]);
    forgetQueuedDiscard("a", "u1");
    expect(queuedDiscards("u1")).toEqual(["b"]);
    forgetQueuedDiscard("a", "u1");
    forgetQueuedDiscard("b", "u1");
    expect(queuedDiscards("u1")).toEqual([]);
    expect(localStorage.getItem("bodymaps-discard-after-sign-in")).toBeNull();
  });

  it("keeps the newest fifty", () => {
    for (let i = 0; i < 60; i++) queueDiscardAfterSignIn(`s${i}`, "u1");

    const taken = queuedDiscards("u1");

    expect(taken).toHaveLength(50);
    expect(taken[0]).toBe("s10");
    expect(taken[49]).toBe("s59");
  });

  it("gives each account only what it queued, and lets only that account forget it", () => {
    queueDiscardAfterSignIn("a", "u1");
    queueDiscardAfterSignIn("b", "u2");

    expect(queuedDiscards("u1")).toEqual(["a"]);
    expect(queuedDiscards("u2")).toEqual(["b"]);
    expect(queuedDiscards("u3")).toEqual([]);
    forgetQueuedDiscard("a", "u2");
    expect(queuedDiscards("u1")).toEqual(["a"]);
    forgetQueuedDiscard("a", "u1");
    expect(queuedDiscards("u1")).toEqual([]);
    expect(queuedDiscards("u2")).toEqual(["b"]);
  });

  it("hands an id saved without an owner to the next account, which then owns or forgets it", () => {
    localStorage.setItem("bodymaps-discard-after-sign-in", JSON.stringify(["old", "gone"]));

    expect(queuedDiscards("u1")).toEqual(["old", "gone"]);
    // Not answered for good: it waits as u1's from now on, not as anyone's.
    queueDiscardAfterSignIn("old", "u1");
    // Answered for good.
    forgetQueuedDiscard("gone", "u1");

    expect(queuedDiscards("u1")).toEqual(["old"]);
    expect(queuedDiscards("u2")).toEqual([]);
  });

  it("ignores what storage holds that is not a list of ids", () => {
    localStorage.setItem("bodymaps-discard-after-sign-in", JSON.stringify({ a: 1 }));
    expect(queuedDiscards("u1")).toEqual([]);
    localStorage.setItem("bodymaps-discard-after-sign-in", "not json");
    expect(queuedDiscards("u1")).toEqual([]);
    localStorage.setItem(
      "bodymaps-discard-after-sign-in",
      JSON.stringify(["a", 3, null, { sid: "b", ownerId: "u1" }, { sid: "c" }, { sid: 4, ownerId: "u1" }]),
    );
    expect(queuedDiscards("u1")).toEqual(["a", "b"]);
  });

  it("does nothing, and does not throw, when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => queueDiscardAfterSignIn("a", "u1")).not.toThrow();
    expect(queuedDiscards("u1")).toEqual([]);
  });
});
