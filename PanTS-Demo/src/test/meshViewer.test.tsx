import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentationMeshViewer } from "../components/viewer/MeshViewer";

describe("SegmentationMeshViewer mesh recovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a clear fallback and switches to CT volume when requested", async () => {
		const onSwitchToVolume = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 503,
		} as Response);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		render(
			<SegmentationMeshViewer
				caseId="case-1"
				checkState={[true]}
				loading={false}
				opacity={100}
				crosshairMm={null}
				onSwitchToVolume={onSwitchToVolume}
			/>,
		);

		expect(await screen.findByText("3D structures unavailable")).toBeInTheDocument();
		expect(screen.getByText("You can still view this scan in 3D.")).toBeInTheDocument();
		expect(screen.queryByText(/Failed to fetch mesh manifest/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "View CT volume" }));
		expect(onSwitchToVolume).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		expect(errorSpy).toHaveBeenCalledWith(
			"Failed to load 3D segmentation manifest",
			expect.objectContaining({ message: "Failed to fetch mesh manifest: 503" }),
		);
	});

	it("keeps the fallback usable when no switch callback is provided", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		render(
			<SegmentationMeshViewer caseId="case-2" checkState={[true]} loading={false} opacity={100} crosshairMm={null} />,
		);

		expect(await screen.findByText("3D structures unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "View CT volume" })).not.toBeInTheDocument();
	});
});
