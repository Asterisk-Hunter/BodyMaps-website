import { describe, expect, it } from "vitest";
import {
	type Assignment,
	assignmentsFor,
	dueState,
	nextTodo,
	parseRange,
	percentDone,
	rangeLabel,
	splitRange,
	statusOf,
	whoLabel,
} from "../helpers/assignments";

const make = (over: Partial<Assignment> = {}): Assignment => ({
	id: "a1", assignee: { id: "u1", name: "Rad One", email: "r1@x.org" }, start: 55, end: 60, task: "Veins", note: null,
	due_at: null, created_at: null, total: 6, done: 0, flagged: 0, todo: 6, marks: {}, ...over,
});

describe("parseRange", () => {
	it.each([
		["55", [55, 55]], ["55-95", [55, 95]], ["55 to 95", [55, 95]], [" 55 – 95 ", [55, 95]], ["55—95", [55, 95]], ["145 TO 200", [145, 200]],
	])("reads %s", (text, expected) => expect(parseRange(text)).toEqual(expected));

	it.each(["", " ", "abc", "95-55", "0", "0-5", "-5", "5-", "5 6", "1,2", "1.5", "1e3", "1234567", "55 to", "to 55", "５５"])(
		"refuses %j", (text) => expect(parseRange(text)).toBeNull());
});

describe("splitRange", () => {
	it("splits evenly, the first blocks taking the extra case", () => {
		expect(splitRange(1, 10, 3)).toEqual([[1, 4], [5, 7], [8, 10]]);
		expect(splitRange(55, 95, 1)).toEqual([[55, 95]]);
		expect(splitRange(1, 4, 4)).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
	});

	it("refuses more people than cases, and bad counts", () => {
		expect(splitRange(1, 3, 4)).toBeNull();
		expect(splitRange(1, 3, 0)).toBeNull();
		expect(splitRange(1, 3, 1.5)).toBeNull();
		expect(splitRange(1, 3, -1)).toBeNull();
	});

	it("always covers every case exactly once, in order, with sizes differing by at most one", () => {
		for (let start = 1; start <= 40; start += 7) {
			for (let total = 1; total <= 120; total += 5) {
				for (let parts = 1; parts <= Math.min(total, 52); parts += 3) {
					const blocks = splitRange(start, start + total - 1, parts)!;
					expect(blocks).toHaveLength(parts);
					let expected = start;
					const sizes = new Set<number>();
					for (const [a, b] of blocks) {
						expect(a).toBe(expected);
						expect(b).toBeGreaterThanOrEqual(a);
						sizes.add(b - a + 1);
						expected = b + 1;
					}
					expect(expected).toBe(start + total);
					expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
				}
			}
		}
	});
});

describe("nextTodo", () => {
	it("starts at the first case when none is marked, and skips marked ones", () => {
		expect(nextTodo(make())).toBe(55);
		expect(nextTodo(make({ marks: { "55": "done", "56": "flagged" } }))).toBe(57);
	});

	it("goes on from the current case, then wraps to something skipped earlier", () => {
		const a = make({ marks: { "56": "done", "57": "done" } });
		expect(nextTodo(a, 55)).toBe(58);
		expect(nextTodo(a, 60)).toBe(55);
		expect(nextTodo(a, 58)).toBe(59);
	});

	it("is null once every case is marked, and for an empty range", () => {
		const marks = Object.fromEntries([55, 56, 57, 58, 59, 60].map((n) => [String(n), "done" as const]));
		expect(nextTodo(make({ marks }))).toBeNull();
		expect(nextTodo(make({ marks }), 57)).toBeNull();
		expect(nextTodo(make({ start: 5, end: 4 }))).toBeNull();
	});

	it("copes with a current case outside the range", () => {
		expect(nextTodo(make(), 10)).toBe(55);
		expect(nextTodo(make(), 999)).toBe(55);
	});

	it("walks a whole range once, visiting every case exactly once", () => {
		const a = make({ start: 1, end: 30, total: 30, marks: {} });
		const seen: number[] = [];
		let at: number | undefined;
		for (let i = 0; i < 40; i++) {
			const next = nextTodo(a, at);
			if (next === null) break;
			seen.push(next);
			a.marks![String(next)] = "done";
			at = next;
		}
		expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
		expect(nextTodo(a, at)).toBeNull();
	});
});

describe("small helpers", () => {
	it("finds the assignments that hold a case, those with work left first", () => {
		const finished = make({ id: "f", todo: 0, done: 6 });
		const open = make({ id: "o" });
		const elsewhere = make({ id: "e", start: 100, end: 110 });
		expect(assignmentsFor([finished, open, elsewhere], 57).map((a) => a.id)).toEqual(["o", "f"]);
		expect(assignmentsFor([finished, open, elsewhere], 61)).toEqual([]);
		expect(assignmentsFor([open], 55)).toHaveLength(1);
		expect(assignmentsFor([open], 60)).toHaveLength(1);
		expect(assignmentsFor([open], 54)).toHaveLength(0);
	});

	it("reports a case's status, defaulting to todo", () => {
		expect(statusOf(make({ marks: { "57": "flagged" } }), 57)).toBe("flagged");
		expect(statusOf(make(), 57)).toBe("todo");
		expect(statusOf(make({ marks: undefined }), 57)).toBe("todo");
	});

	it("labels people, ranges and percentages", () => {
		expect(whoLabel({ name: "Dr A", email: "a@x" })).toBe("Dr A");
		expect(whoLabel({ name: null, email: "a@x" })).toBe("a@x");
		expect(whoLabel({ name: null, email: null })).toBe("Unknown");
		expect(rangeLabel({ start: 55, end: 95 })).toBe("55 to 95");
		expect(rangeLabel({ start: 7, end: 7 })).toBe("7");
		expect(percentDone({ done: 1, total: 3 })).toBe(33);
		expect(percentDone({ done: 0, total: 0 })).toBe(0);
	});

	it("calls a due date overdue only after that whole day has ended", () => {
		const noon = Date.parse("2026-12-10T12:00:00Z");
		expect(dueState(null, noon)).toBe("none");
		expect(dueState("garbage", noon)).toBe("none");
		expect(dueState("2026-12-10T00:00:00Z", noon)).toBe("soon");
		expect(dueState("2026-12-09T00:00:00Z", noon)).toBe("overdue");
		expect(dueState("2026-12-11T00:00:00Z", noon)).toBe("soon");
		expect(dueState("2027-01-30T00:00:00Z", noon)).toBe("later");
	});
});
