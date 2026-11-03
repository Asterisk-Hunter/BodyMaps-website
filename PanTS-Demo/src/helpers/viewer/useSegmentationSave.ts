import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type SegmentationSaveState =
	| { status: "idle" | "dirty" | "saving" | "saved" }
	| { status: "error"; message: string };

/** Keep save feedback truthful when edits or case changes happen during a request. */
export function useSegmentationSave(resourceKey: string, saveOperation: () => Promise<void>) {
	const [state, setState] = useState<SegmentationSaveState>({ status: "idle" });
	const revisionRef = useRef(0);
	const generationRef = useRef(0);
	const pendingRef = useRef<Promise<boolean> | null>(null);

	useLayoutEffect(() => {
		generationRef.current += 1;
		revisionRef.current = 0;
		pendingRef.current = null;
		setState({ status: "idle" });
		return () => { generationRef.current += 1; };
	}, [resourceKey]);

	const markEdited = useCallback(() => {
		revisionRef.current += 1;
		setState((previous) => previous.status === "saving" ? previous : { status: "dirty" });
	}, []);

	const save = useCallback((): Promise<boolean> => {
		if (pendingRef.current) return pendingRef.current;
		const generation = generationRef.current;
		const revision = revisionRef.current;
		setState({ status: "saving" });
		const request = (async () => {
			try {
				// Defer invocation so even a synchronous failure releases the stored request.
				await Promise.resolve().then(saveOperation);
				if (generation === generationRef.current) {
					setState({ status: revision === revisionRef.current ? "saved" : "dirty" });
				}
				return true;
			} catch {
				if (generation === generationRef.current) {
					setState({ status: "error", message: "Save failed. Your edits are still here." });
				}
				return false;
			} finally {
				if (generation === generationRef.current) pendingRef.current = null;
			}
		})();
		pendingRef.current = request;
		return request;
	}, [saveOperation]);

	return { state, save, markEdited };
}
