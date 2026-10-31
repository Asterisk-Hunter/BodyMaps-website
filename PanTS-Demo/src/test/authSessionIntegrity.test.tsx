import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { addRecentUpload, loadRecentUploads, recentUploadsStorageKey } from "../helpers/recentUploads";
import { getLocalNiftiFile, setLocalNiftiFile } from "../helpers/localNifti";
import { getLocalDicomFiles, setLocalDicomFiles } from "../helpers/dicomLocal";
import AuthButton from "../components/AuthButton";

afterEach(() => vi.restoreAllMocks());
const USER = { id: "u1", email: "researcher@example.com", name: "Researcher", roles: [] };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const Identity = () => { const { user } = useAuth(); return <output aria-label="Session identity">{user?.id ?? "signed out"}</output>; };
const mount = () => render(<AuthProvider><MemoryRouter><AuthButton variant="sidebar" /><Identity /></MemoryRouter></AuthProvider>);
const defaultFetch = async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/auth/me")) return json({ user: USER });
    if (String(url).includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
    return json({});
};
beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    global.fetch = vi.fn(defaultFetch);
});

describe("session integrity across account actions", () => {
    it("waits for server revocation before broadcasting logout to other tabs", async () => {
        const user = userEvent.setup();
        let finish!: (response: Response) => void;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/api/auth/logout")
            ? await new Promise<Response>((resolve) => { finish = resolve; }) : defaultFetch(url));
        mount();
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("u1");
        expect(localStorage.getItem("authChangePing")).toBeNull();
        await act(async () => finish(json({ ok: true })));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("signed out");
        expect(localStorage.getItem("authChangePing")).not.toBeNull();
    });

    it.each(["network", "http"])("reports a %s logout failure without pretending the session was revoked", async (kind) => {
        const user = userEvent.setup();
        global.fetch = vi.fn(async (url: RequestInfo | URL) => {
            if (String(url).includes("/api/auth/logout")) {
                if (kind === "network") throw new Error("Offline");
                return json({ error: "Unavailable" }, 503);
            }
            return defaultFetch(url);
        });
        mount();
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't sign out");
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("u1");
        expect(localStorage.getItem("authChangePing")).toBeNull();
        expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeEnabled();
    });

    it("does not restore an old in-flight /me response after logout", async () => {
        const user = userEvent.setup();
        let finishRefresh!: (response: Response) => void;
        let meCount = 0;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => {
            if (String(url).includes("/api/auth/me") && ++meCount > 1) return await new Promise<Response>((resolve) => { finishRefresh = resolve; });
            return defaultFetch(url);
        });
        mount();
        await screen.findByRole("button", { name: "Settings" });
        act(() => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "other-tab" })));
        await waitFor(() => expect(meCount).toBe(2));
        await user.click(screen.getByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
        await waitFor(() => expect(screen.getByLabelText("Session identity")).toHaveTextContent("signed out"));
        await act(async () => finishRefresh(json({ user: USER })));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("signed out");
    });

    it("preserves the room key while removing an OAuth error from the URL", async () => {
        window.history.replaceState({}, "", "/live/example?mode=review&auth_error=Cancelled#room-key");
        mount();
        await screen.findByRole("button", { name: "Settings" });
        expect(window.location.pathname + window.location.search + window.location.hash).toBe("/live/example?mode=review#room-key");
    });
});


const historyEntry = (sessionId: string) => ({ sessionId, label: sessionId, model: "epai", status: "Completed", timestamp: 1 });

describe("restored sessions and account-scoped history", () => {
    it('populates a fresh device from owned server jobs without a legacy local key', async () => {
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/api/me/jobs')
            ? json({ user_id: 'u1', jobs: [{ session_id: 'finished', model: 'LesionSegmenter', status: 'completed', created_at: '2026-10-23T12:00:00' }] }) : defaultFetch(url));
        mount();
        await waitFor(() => expect(loadRecentUploads()).toEqual([expect.objectContaining({ sessionId: 'finished', status: 'Completed' })]));
        expect(localStorage.getItem('recentUploads')).toBeNull();
    });

    it('ignores a fresh-device history response that finishes after logout', async () => {
        const user = userEvent.setup();
        let finish!: (response: Response) => void;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/api/me/jobs')
            ? new Promise<Response>(resolve => { finish = resolve; }) : defaultFetch(url));
        mount();
        await waitFor(() => expect(finish).toBeTypeOf('function'));
        await user.click(await screen.findByRole('button', { name: 'Settings' }));
        await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
        await waitFor(() => expect(screen.getByLabelText('Session identity')).toHaveTextContent('signed out'));
        await act(async () => finish(json({ user_id: 'u1', jobs: [{ session_id: 'finished', model: 'LesionSegmenter', status: 'completed', created_at: '2026-10-23T12:00:00' }] })));
        expect(loadRecentUploads('u1')).toEqual([]);
    });

    it('does not hydrate another account from a complete but wrong-owner response', async () => {
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/api/me/jobs')
            ? json({ user_id: 'u2', jobs: [{ session_id: 'other-private-scan', model: 'LesionSegmenter', status: 'completed', created_at: '2026-10-23T12:00:00' }] }) : defaultFetch(url));
        mount();
        await screen.findByRole('button', { name: 'Settings' });
        await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/me/jobs'), expect.anything()));
        expect(loadRecentUploads('u1')).toEqual([]);
        expect(loadRecentUploads('u2')).toEqual([]);
    });

    it("activates restored account history and switches it on a cross-tab account change", async () => {
        let current = USER;
        localStorage.setItem(recentUploadsStorageKey("u1"), JSON.stringify([historyEntry("scan-a")]));
        localStorage.setItem(recentUploadsStorageKey("u2"), JSON.stringify([historyEntry("scan-b")]));
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/api/auth/me") ? json({ user: current }) : defaultFetch(url));
        mount();
        await screen.findByRole("button", { name: "Settings" });
        expect(loadRecentUploads().map((entry) => entry.sessionId)).toEqual(["scan-a"]);
        current = { ...USER, id: "u2", email: "second@example.com" };
        act(() => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "switch" })));
        await waitFor(() => expect(screen.getByLabelText("Session identity")).toHaveTextContent("u2"));
        expect(loadRecentUploads().map((entry) => entry.sessionId)).toEqual(["scan-b"]);
    });

    it("migrates archived history only after a matching owner response verifies its IDs", async () => {
        const legacy = JSON.stringify([historyEntry("owned"), historyEntry("somebody-else")]);
        localStorage.setItem("recentUploads", legacy);
        let finish!: (response: Response) => void;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/api/me/jobs")
            ? await new Promise<Response>((resolve) => { finish = resolve; }) : defaultFetch(url));
        mount();
        await screen.findByRole("button", { name: "Settings" });
        // History migration starts asynchronously after the session is restored.
        await waitFor(() => expect(finish).toBeTypeOf("function"));
        expect(loadRecentUploads()).toEqual([]);
        await act(async () => finish(json({ user_id: "u1", jobs: [{ session_id: "owned" }] })));
        expect(loadRecentUploads().map((entry) => entry.sessionId)).toEqual(["owned"]);
        expect(localStorage.getItem("recentUploads")).toBe(legacy);
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/me/jobs"), expect.objectContaining({ credentials: "include" }));
    });

    it.each(["u2", null])("does not assign legacy data from an unverified %s owner response", async (owner) => {
        const legacy = JSON.stringify([historyEntry("legacy")]);
        localStorage.setItem("recentUploads", legacy);
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/api/me/jobs")
            ? json({ user_id: owner, jobs: [{ session_id: "legacy" }] }) : defaultFetch(url));
        mount();
        await screen.findByRole("button", { name: "Settings" });
        expect(loadRecentUploads()).toEqual([]);
        expect(localStorage.getItem("recentUploads")).toBe(legacy);
    });

    it("ignores a migration that finishes after logout and closes the history scope", async () => {
        const user = userEvent.setup();
        localStorage.setItem("recentUploads", JSON.stringify([historyEntry("owned")]));
        let finish!: (response: Response) => void;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/api/me/jobs")
            ? await new Promise<Response>((resolve) => { finish = resolve; }) : defaultFetch(url));
        mount();
        await waitFor(() => expect(finish).toBeTypeOf("function"));
        await user.click(await screen.findByRole("button", { name: "Settings" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
        await waitFor(() => expect(screen.getByLabelText("Session identity")).toHaveTextContent("signed out"));
        await act(async () => finish(json({ user_id: "u1", jobs: [{ session_id: "owned" }] })));
        expect(loadRecentUploads()).toEqual([]);
        expect(localStorage.getItem(recentUploadsStorageKey("u1"))).toBeNull();
    });

    it.each(["network", "http"])("preserves an established session through a transient %s refresh failure", async (kind) => {
        mount();
        await screen.findByRole("button", { name: "Settings" });
        global.fetch = vi.fn(async () => { if (kind === "network") throw new Error("VPN disconnected"); return json({}, 503); });
        await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "refresh" })));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("u1");
    });

    it("revalidates a returning tab at most once per 15 seconds and gates an expired session", async () => {
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        mount();
        await screen.findByRole("button", { name: "Settings" });
        global.fetch = vi.fn(async () => json({ error: "Session expired" }, 401));
        act(() => window.dispatchEvent(new Event("focus")));
        expect(global.fetch).not.toHaveBeenCalled();
        now += 15_001;
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("signed out");
        expect(loadRecentUploads()).toEqual([]);
    });

    it("immediately gates a server-confirmed expired socket session", async () => {
        mount();
        await screen.findByRole("button", { name: "Settings" });
        addRecentUpload({ ...historyEntry("scan"), status: "Completed" });
        act(() => window.dispatchEvent(new Event("bodymaps:session-expired")));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("signed out");
        expect(loadRecentUploads()).toEqual([]);
        expect(loadRecentUploads("u1")).toHaveLength(1);
    });
});


describe("browser-only scan caches", () => {
    const seedFiles = () => {
        const nifti = new File(["local-scan"], "private.nii");
        const dicom = new File(["local-series"], "private.dcm");
        setLocalNiftiFile(nifti); setLocalDicomFiles([dicom]);
        return { nifti, dicom };
    };
    it("clears stale module caches before initial session restoration finishes", async () => {
        seedFiles();
        let finish!: (response: Response) => void;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/api/auth/me")
            ? await new Promise<Response>((resolve) => { finish = resolve; }) : defaultFetch(url));
        mount();
        expect(getLocalNiftiFile()).toBeNull();
        expect(getLocalDicomFiles()).toEqual([]);
        await act(async () => finish(json({ user: USER })));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("u1");
    });

    it("clears local NIfTI and DICOM files when the signed-in identity changes", async () => {
        let current = USER;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/api/auth/me") ? json({ user: current }) : defaultFetch(url));
        mount();
        await screen.findByRole("button", { name: "Settings" });
        seedFiles();
        current = { ...USER, id: "u2", email: "second@example.com" };
        await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "switch-account" })));
        expect(screen.getByLabelText("Session identity")).toHaveTextContent("u2");
        expect(getLocalNiftiFile()).toBeNull();
        expect(getLocalDicomFiles()).toEqual([]);
    });

    it("retains a signed-in user's locally selected files through a same-account refresh", async () => {
        mount();
        await screen.findByRole("button", { name: "Settings" });
        const { nifti, dicom } = seedFiles();
        await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "profile-refresh" })));
        expect(getLocalNiftiFile()).toBe(nifti);
        expect(getLocalDicomFiles()).toEqual([dicom]);
    });

    it("clears both local viewer caches immediately when the session expires", async () => {
        mount();
        await screen.findByRole("button", { name: "Settings" });
        seedFiles();
        act(() => window.dispatchEvent(new Event("bodymaps:session-expired")));
        expect(getLocalNiftiFile()).toBeNull();
        expect(getLocalDicomFiles()).toEqual([]);
    });
});
