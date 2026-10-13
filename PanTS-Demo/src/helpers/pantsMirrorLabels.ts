const PAN_T_S_MIRROR_MASK_PATH =
	/^\/datasets\/BodyMaps\/iPanTSMini\/resolve\/[^/]+\/mask_only\/PanTS_\d{8}\/combined_labels\.nii\.gz$/;

const PAN_T_S_LABEL_LUT = Uint8Array.from({ length: 29 }, (_, label) => label);
PAN_T_S_LABEL_LUT[22] = 23;
PAN_T_S_LABEL_LUT[23] = 24;
PAN_T_S_LABEL_LUT[24] = 25;
PAN_T_S_LABEL_LUT[25] = 26;
PAN_T_S_LABEL_LUT[26] = 27;
PAN_T_S_LABEL_LUT[27] = 28;
PAN_T_S_LABEL_LUT[28] = 22;

export interface LoadedMaskVolume {
	voxelManager?: {
		getCompleteScalarDataArray?: () => ArrayLike<number> | null | undefined;
		setCompleteScalarDataArray?: (data: Uint8Array) => void;
	};
}

const remappedVolumes = new WeakSet<object>();

/** True only for the raw combined label volume in the PanTS Hugging Face mirror. */
export function isPanTSMirrorCombinedMaskUrl(sourceUrl: string): boolean {
	try {
		const url = new URL(sourceUrl);
		return url.protocol === "https:" &&
			url.hostname === "huggingface.co" &&
			PAN_T_S_MIRROR_MASK_PATH.test(url.pathname);
	} catch {
		return false;
	}
}

/** Convert raw PanTS dataset ids 22–28 into the viewer's 1-based label scheme. */
export function remapPanTSMirrorLabels(labels: ArrayLike<number>): Uint8Array {
	const remapped = new Uint8Array(labels.length);
	for (let index = 0; index < labels.length; index += 1) {
		const label = labels[index];
		if (!Number.isInteger(label) || label < 0 || label > 28) {
			throw new Error(`Unsupported PanTS mirror label ${String(label)} at voxel ${index}`);
		}
		remapped[index] = PAN_T_S_LABEL_LUT[label];
	}
	return remapped;
}

/** Remap only a recognized raw mirror volume, once per loaded Cornerstone volume. */
export function remapPanTSMirrorMaskVolume(volume: LoadedMaskVolume, sourceUrl: string): boolean {
	if (!isPanTSMirrorCombinedMaskUrl(sourceUrl) || remappedVolumes.has(volume)) return false;

	const voxelManager = volume.voxelManager;
	const getScalars = voxelManager?.getCompleteScalarDataArray;
	const setScalars = voxelManager?.setCompleteScalarDataArray;
	if (!getScalars || !setScalars) {
		throw new Error("PanTS mirror label volume does not expose complete scalar data");
	}

	const scalars = getScalars.call(voxelManager);
	if (!scalars) throw new Error("PanTS mirror label volume has no complete scalar data");
	const remapped = remapPanTSMirrorLabels(scalars);
	setScalars.call(voxelManager, remapped);
	remappedVolumes.add(volume);
	return true;
}
