export type ViewerOperationTarget = {
	generation: number;
	segmentationId: string;
	volume: object | null;
};

/** Reject work whose captured viewer or labelmap has since been replaced. */
export function assertCurrentViewerTarget(
	captured: ViewerOperationTarget,
	current: ViewerOperationTarget,
): asserts captured is ViewerOperationTarget & { volume: object } {
	if (
		!captured.volume ||
		captured.generation !== current.generation ||
		captured.segmentationId !== current.segmentationId ||
		captured.volume !== current.volume
	) {
		throw new DOMException("Viewer changed before the operation completed.", "AbortError");
	}
}
