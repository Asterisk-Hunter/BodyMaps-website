import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesignShell from "../components/DesignShell";
import { recentUploadsStorageKey, setRecentUploadsAccount } from "../helpers/recentUploads";

const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock("../contexts/authContext", () => ({ useAuth: () => auth }));

vi.mock("../components/AuthButton", () => ({ default: ({ onWalkthrough }: { onWalkthrough?: () => void }) => <>
    <button type="button">Account controls</button>
    <button type="button" onClick={onWalkthrough}>Replay walkthrough</button>
</> }));
vi.mock("../components/WorkspaceTour", () => ({ default: ({ replay }: { replay: number }) => <output aria-label="Walkthrough replay request">{replay}</output> }));
vi.mock("../components/SiteFooter", () => ({ default: () => <footer>Site footer</footer> }));
const Location = () => { const { pathname, search } = useLocation(); return <output aria-label="Current route">{pathname + search}</output>; };
const mount = (path = "/dashboard", element: ReactElement = <Location />) => render(<MemoryRouter initialEntries={[path]}>
    <Routes><Route element={<DesignShell />}><Route path="*" element={element} /></Route></Routes>
</MemoryRouter>);
beforeEach(() => { localStorage.clear(); setRecentUploadsAccount("u1"); auth.isAuthenticated = true; });

describe("workspace sidebar", () => {
    it("carries an explicit replay from a protected account shell into a separate workspace shell once", async () => {
        const user = userEvent.setup();
        localStorage.setItem("bodymaps.workspace-tour.v6", "true");
        function RouteObservation() {
            const location = useLocation();
            return <><Location /><output aria-label="Pending route replay">{String(Boolean(location.state?.replayWorkspaceTour))}</output></>;
        }
        render(<MemoryRouter initialEntries={["/account"]}>
            <Routes>
                <Route element={<DesignShell />}><Route path="/" element={<RouteObservation />} /></Route>
                {/* Match App's protected wrapper: this shell really unmounts
                    when navigation switches into the public workspace tree. */}
                <Route element={<Outlet />}>
                    <Route element={<DesignShell />}><Route path="/account" element={<RouteObservation />} /></Route>
                </Route>
            </Routes>
        </MemoryRouter>);
        expect(screen.queryByLabelText("Walkthrough replay request")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Replay walkthrough" }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/$/);
        expect(screen.getByLabelText("Walkthrough replay request")).toHaveTextContent(/^1$/);
        expect(screen.getByLabelText("Pending route replay")).toHaveTextContent("false");
    });

    it("replays from Team in the workspace and closes mobile navigation", async () => {
        const user = userEvent.setup();
        mount("/team");
        expect(screen.queryByLabelText("Walkthrough replay request")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Open navigation" }));
        expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "true");
        await user.click(screen.getByRole("button", { name: "Replay walkthrough" }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/$/);
        expect(screen.getByLabelText("Walkthrough replay request")).toHaveTextContent("1");
        expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
    });

    it("replays on /upload without navigating or resetting the existing outlet state", async () => {
        function StatefulWorkspace() {
            const [selection, setSelection] = useState("");
            return <><Location /><input aria-label="Selected scan" value={selection} onChange={(event) => setSelection(event.target.value)} /></>;
        }
        const user = userEvent.setup();
        mount("/upload", <StatefulWorkspace />);
        const selectedScan = screen.getByRole("textbox", { name: "Selected scan" });
        await user.type(selectedScan, "unchanged-scan.nii.gz");
        expect(screen.getByLabelText("Walkthrough replay request")).toHaveTextContent("0");
        await user.click(screen.getByRole("button", { name: "Replay walkthrough" }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/upload$/);
        expect(screen.getByRole("textbox", { name: "Selected scan" })).toBe(selectedScan);
        expect(selectedScan).toHaveValue("unchanged-scan.nii.gz");
        expect(screen.getByLabelText("Walkthrough replay request")).toHaveTextContent("1");
        await user.click(screen.getByRole("button", { name: "Replay walkthrough" }));
        expect(screen.getByLabelText("Walkthrough replay request")).toHaveTextContent("2");
        expect(selectedScan).toHaveValue("unchanged-scan.nii.gz");
    });

    it.each(["/", "/upload"])("does not mount an automatic walkthrough for guests on %s", (path) => {
        auth.isAuthenticated = false;
        mount(path);
        expect(screen.queryByLabelText("Walkthrough replay request")).not.toBeInTheDocument();
    });

    it.each(["Workspace", "New run"])("guest %s keeps the public workspace mounted", async (action) => {
        auth.isAuthenticated = false;
        const user = userEvent.setup(); mount("/");
        await user.click(screen.getByRole(action === "Workspace" ? "link" : "button", { name: action }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/$/);
    });

    it("uses real routes for workspace, dataset and team", async () => {
        const user = userEvent.setup();
        mount();
        expect(screen.getByRole("link", { name: "Dataset" })).toHaveAttribute("aria-current", "page");
        await user.click(screen.getByRole("link", { name: "Team" }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/team");
        await user.click(screen.getByRole("link", { name: "Workspace" }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/");
    });

    it("persists collapsing while retaining labelled navigation", async () => {
        const user = userEvent.setup();
        mount();
        await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
        expect(localStorage.getItem("bodymaps.sidebar.collapsed")).toBe("true");
        expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
        expect(screen.getByRole("link", { name: "Dataset" })).toHaveAttribute("href", "/dashboard");
    });

    it("opens a completed result using its real session and retains other recent runs", async () => {
        const user = userEvent.setup();
        localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([
            { sessionId: "scan-a", label: "First scan", model: "cads551", status: "Completed", timestamp: Date.now() },
            { sessionId: "scan-b", label: "Second scan", model: "epai", status: "Processing", timestamp: Date.now() - 1 },
        ]));
        mount();
        await user.click(screen.getByRole("button", { name: /First scan/ }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/session/scan-a");
        expect(JSON.parse(localStorage.getItem(recentUploadsStorageKey("u1")) ?? "[]")).toHaveLength(2);
    });

    it("New run navigates to the composer without clearing previous runs", async () => {
        const user = userEvent.setup();
        const saved = JSON.stringify([{ sessionId: "scan-a", label: "Existing scan", model: "epai", status: "Completed", timestamp: Date.now() }]);
        localStorage.setItem(recentUploadsStorageKey("u1"), saved);
        mount();
        await user.click(screen.getByRole("button", { name: "New run" }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/upload");
        expect(localStorage.getItem(recentUploadsStorageKey("u1"))).toBe(saved);
    });

    it("opens archived batches directly in History with their identifier", async () => {
        const user = userEvent.setup();
        localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([
            { sessionId: "scan-a", label: "First scan", batchId: "batch-a", batchLabel: "Archived batch", model: "epai", status: "Completed", viewed: true, timestamp: Date.now() - 172800000 },
            { sessionId: "scan-b", label: "Second scan", batchId: "batch-a", batchLabel: "Archived batch", model: "epai", status: "Failed", timestamp: Date.now() - 172800000 },
        ]));
        mount();
        await user.click(screen.getByRole("button", { name: /Archived batch/ }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/account/history?batch=batch-a");
    });

    it("preserves the selected failed scan when opening History", async () => {
        const user = userEvent.setup();
        localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([
            { sessionId: "failed-a", label: "Failed scan", model: "epai", status: "Failed", timestamp: Date.now() },
        ]));
        mount();
        await user.click(screen.getByRole("button", { name: /Failed scan/ }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/account/history?session=failed-a");
    });

    it("keeps active batches in the workspace", async () => {
        const user = userEvent.setup();
        localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([
            { sessionId: "running-a", label: "Running scan", batchId: "batch-a", batchLabel: "Active batch", model: "epai", status: "Processing", timestamp: Date.now() },
        ]));
        mount();
        await user.click(screen.getByRole("button", { name: /Active batch/ }));
        expect(screen.getByLabelText("Current route")).toHaveTextContent("/upload");
    });

    it("mobile navigation closes on Escape and returns focus to its opener", async () => {
        const user = userEvent.setup();
        mount();
        await user.click(screen.getByRole("button", { name: "Open navigation" }));
        expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "true");
        await user.keyboard("{Escape}");
        expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
        expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
    });
});
