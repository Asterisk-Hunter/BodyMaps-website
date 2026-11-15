import { vi } from "vitest";
import type { Assignment } from "../helpers/assignments";

// A small stand-in for the assignments API, behaving like the real one for the paths the screens use.

export type Me = { id: string; email: string; name: string; plan: string; account_type: null; roles: string[] };

export const PEOPLE = [
	{ id: "u1", name: "Rad One", email: "r1@x.org" },
	{ id: "u2", name: "Rad Two", email: "r2@x.org" },
	{ id: "u3", name: null, email: "r3@x.org" },
];

export type Fake = {
	me: Me;
	assignments: Assignment[];
	calls: { method: string; url: string; body?: Record<string, unknown> }[];
	failNext: Partial<Record<string, number>>; // "PUT" | "POST" ... -> status to answer once
	delayMs: number;
	install: () => void;
};

const json = (body: unknown, status = 200) => ({
	ok: status < 400, status, json: async () => body, text: async () => "", headers: { get: () => "application/json" },
});

export function makeFake(me: Partial<Me> = {}): Fake {
	const fake: Fake = {
		me: { id: "u1", email: "r1@x.org", name: "Rad One", plan: "free", account_type: null, roles: ["annotator"], ...me },
		assignments: [],
		calls: [],
		failNext: {},
		delayMs: 0,
		install() {
			let counter = 0;
			global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const u = String(url);
				const method = init?.method ?? "GET";
				const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
				if (u.includes("/api/auth/me")) return json({ user: { ...fake.me } });
				if (u.includes("/api/auth/oauth/providers")) return json({});
				if (!u.includes("/api/assignments")) return json({});
				fake.calls.push({ method, url: u, body });
				if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
				const forced = fake.failNext[method];
				if (forced !== undefined) {
					delete fake.failNext[method];
					if (forced === 0) throw new TypeError("network down");
					return json({ error: "Server said no." }, forced);
				}
				const path = u.slice(u.indexOf("/api/assignments") + "/api/assignments".length);
				const manager = fake.me.roles.includes("annotation_manager");
				const mark = /^\/([^/]+)\/cases\/(\d+)$/.exec(path);
				if (method === "GET" && path === "/mine") {
					return json({ assignments: fake.assignments.filter((a) => a.assignee.id === fake.me.id).map((a) => ({ ...a, marks: { ...(a.marks ?? {}) } })) });
				}
				if (mark && method === "PUT") {
					const a = fake.assignments.find((x) => x.id === mark[1]);
					const n = Number(mark[2]);
					if (!a || (a.assignee.id !== fake.me.id && !manager)) return json({ error: "No such assignment" }, 404);
					if (n < a.start || n > a.end) return json({ error: "not in range", reason: "outside_range" }, 400);
					const status = (body as { status: string }).status;
					a.marks = a.marks ?? {};
					if (status === "todo") delete a.marks[String(n)];
					else a.marks[String(n)] = status as "done" | "flagged";
					const done = Object.values(a.marks).filter((v) => v === "done").length;
					const flagged = Object.values(a.marks).filter((v) => v === "flagged").length;
					Object.assign(a, { done, flagged, todo: a.total - done - flagged });
					const { marks: _m, ...rest } = a;
					return json(rest);
				}
				if (!manager) return json({ error: "You don't have access to this." }, 403);
				if (method === "GET" && path === "") return json({ assignments: fake.assignments.map(({ marks: _m, ...a }) => a) });
				if (method === "GET" && path === "/people") return json({ people: PEOPLE });
				if (method === "POST" && path === "") {
					const b = body as { assignee_id: string; start: number; end: number; task: string; force?: boolean; due?: string; note?: string };
					const clash = fake.assignments.filter((a) => a.start <= b.end && a.end >= b.start && a.task.toLowerCase() === b.task.toLowerCase());
					if (clash.length && !b.force) {
						return json({ error: "Part of this range is already assigned for the same task.", reason: "overlap", overlaps: clash.map((c) => ({
							id: c.id, assignee: c.assignee.name ?? c.assignee.email, start: c.start, end: c.end,
							shared_start: Math.max(b.start, c.start), shared_end: Math.min(b.end, c.end),
						})) }, 409);
					}
					const person = PEOPLE.find((p) => p.id === b.assignee_id);
					if (!person) return json({ error: "That account was not found.", reason: "no_such_person" }, 400);
					const total = b.end - b.start + 1;
					const made: Assignment = {
						id: `a${++counter}`, assignee: { id: person.id, name: person.name, email: person.email }, start: b.start, end: b.end,
						task: b.task, note: b.note ?? null, due_at: b.due ? `${b.due}T00:00:00Z` : null, created_at: "2026-11-14T00:00:00Z",
						total, done: 0, flagged: 0, todo: total, marks: {},
					};
					fake.assignments.push(made);
					return json(made, 201);
				}
				const one = /^\/([^/]+)$/.exec(path);
				if (one && method === "DELETE") {
					const before = fake.assignments.length;
					fake.assignments = fake.assignments.filter((a) => a.id !== one[1]);
					return fake.assignments.length < before ? json({ deleted: true }) : json({ error: "No such assignment" }, 404);
				}
				if (one && method === "PATCH") {
					const a = fake.assignments.find((x) => x.id === one[1]);
					if (!a) return json({ error: "No such assignment" }, 404);
					const to = PEOPLE.find((p) => p.id === (body as { assignee_id?: string }).assignee_id);
					if (to) a.assignee = { id: to.id, name: to.name, email: to.email };
					return json(a);
				}
				return json({ error: "unexpected" }, 500);
			}) as unknown as typeof fetch;
		},
	};
	return fake;
}

export const assignment = (over: Partial<Assignment> = {}): Assignment => ({
	id: "a0", assignee: { id: "u1", name: "Rad One", email: "r1@x.org" }, start: 55, end: 60, task: "Veins and arteries", note: null,
	due_at: null, created_at: "2026-11-14T00:00:00Z", total: 6, done: 0, flagged: 0, todo: 6, marks: {}, ...over,
});
