const SERVER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

// These are build-time deployment limits, not replacements for server authorization.
export function liveRoomsEnabled(): boolean {
	return String(import.meta.env.VITE_LIVE_ROOMS_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

export const LIVE_ROOMS_UNAVAILABLE = "Collaborative Review and Individual Race are temporarily unavailable on this server. Solo activities remain available.";

export function avatarMaxBytes(): number {
	const configured = Number(import.meta.env.VITE_AVATAR_MAX_BYTES);
	return Number.isSafeInteger(configured) && configured > 0
		? Math.min(configured, SERVER_AVATAR_MAX_BYTES)
		: SERVER_AVATAR_MAX_BYTES;
}

export function avatarSizeLabel(): string {
	const bytes = avatarMaxBytes();
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
	return `${bytes} bytes`;
}
