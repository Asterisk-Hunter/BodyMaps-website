import { useCallback, useEffect, useState } from "react";
import { type Assignment, fetchMine } from "./assignments";

/** The signed-in person's own assignments. Nothing is requested unless `enabled` (annotators and managers only). */
export function useMyAssignments(enabled: boolean) {
	const [assignments, setAssignments] = useState<Assignment[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		void fetchMine().then((res) => {
			if (cancelled) return;
			if (res.ok) {
				setAssignments(res.data.assignments);
				setError(null);
			} else {
				setError(res.message);
			}
		});
		return () => { cancelled = true; };
	}, [enabled, attempt]);

	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	return { assignments, error, reload };
}

/** Cases still to do across a list of assignments. */
export const pendingTotal = (list: Assignment[] | null): number => (list ?? []).reduce((sum, a) => sum + a.todo, 0);
