import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../routes/VisualizationPage", () => ({ default: () => <div>Viewer</div> }));
vi.mock("./useLiveRoom", () => ({ useLiveRoom: vi.fn() }));
vi.mock("./protocol", async (importOriginal) => ({
	...await importOriginal<typeof import("./protocol")>(),
	bootstrapLiveRoom: vi.fn(),
	roomKeyFromFragment: () => "existing-room-key",
	getLiveRoomParticipantCredential: () => "existing-participant",
}));
import LiveRoomPage from "./LiveRoomPage";
import { bootstrapLiveRoom } from "./protocol";
import { useLiveRoom } from "./useLiveRoom";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); sessionStorage.clear(); });

it("explains disabled live rooms before loading scans or opening a socket for an existing participant", () => {
	vi.stubEnv("VITE_LIVE_ROOMS_ENABLED", "false");
	sessionStorage.setItem("bodymaps.live-room.name", "Researcher");
	render(<MemoryRouter initialEntries={["/live/existing-room#existing-room-key"]}>
		<Routes><Route path="/live/:roomId" element={<LiveRoomPage />} /></Routes>
	</MemoryRouter>);
	expect(screen.getByRole("alert")).toHaveTextContent("temporarily unavailable on this server");
	expect(screen.queryByRole("button", { name: "Join room" })).not.toBeInTheDocument();
	expect(bootstrapLiveRoom).not.toHaveBeenCalled();
	expect(useLiveRoom).not.toHaveBeenCalled();
	expect(screen.getByRole("link", { name: "Return to dashboard" })).toHaveAttribute("href", "/dashboard");
});
