import { afterEach, describe, expect, it, vi } from "vitest";
import { avatarMaxBytes, avatarSizeLabel, liveRoomsEnabled } from "./deploymentCapabilities";

afterEach(() => vi.unstubAllEnvs());

describe("deployment capability defaults", () => {
	it("keeps live collaboration enabled unless explicitly disabled", () => {
		vi.stubEnv("VITE_LIVE_ROOMS_ENABLED", undefined);
		expect(liveRoomsEnabled()).toBe(true);
		vi.stubEnv("VITE_LIVE_ROOMS_ENABLED", "false");
		expect(liveRoomsEnabled()).toBe(false);
	});
	it("uses the conservative proxy cap with matching visible units", () => {
		vi.stubEnv("VITE_AVATAR_MAX_BYTES", "921600");
		expect(avatarMaxBytes()).toBe(921600);
		expect(avatarSizeLabel()).toBe("900 KB");
	});
	it.each([undefined, "", "0", "-1", "invalid", "1.5", "9000000"])("keeps the server maximum for invalid or oversized cap %s", (value) => {
		vi.stubEnv("VITE_AVATAR_MAX_BYTES", value);
		expect(avatarMaxBytes()).toBe(5 * 1024 * 1024);
		expect(avatarSizeLabel()).toBe("5 MB");
	});
});
