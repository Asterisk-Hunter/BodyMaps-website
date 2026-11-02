export function isIndexInsideGrid(index: readonly number[], dimensions: readonly number[]): boolean {
	return index.length >= 3 && dimensions.length >= 3 &&
		index.slice(0, 3).every((value, axis) => Number.isInteger(value) && value >= 0 && value < dimensions[axis]);
}

export function hasThickSliceSpacing(spacing: readonly number[] | null | undefined, ratio = 3): boolean {
	if (!spacing || spacing.length < 3 || spacing.some((value) => !Number.isFinite(value) || value <= 0)) return false;
	return Math.max(...spacing.slice(0, 3)) / Math.min(...spacing.slice(0, 3)) >= ratio;
}

export function boxSamplesTouchGrid(
	start: readonly number[],
	end: readonly number[],
	contains: (point: number[]) => boolean,
	samplesPerAxis = 9,
): boolean {
	const steps = [0, 1, 2].map((axis) => start[axis] === end[axis] ? 1 : samplesPerAxis);
	for (let x = 0; x < steps[0]; x++) for (let y = 0; y < steps[1]; y++) for (let z = 0; z < steps[2]; z++) {
		const point = [x, y, z].map((sample, axis) => steps[axis] === 1
			? start[axis]
			: start[axis] + ((end[axis] - start[axis]) * sample) / (steps[axis] - 1));
		if (contains(point)) return true;
	}
	return false;
}
