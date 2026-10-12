import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useContext } from "react";
import { FileContext } from "../contexts/fileContexts";
import { AnnotationContext } from "../contexts/annotationContexts";

const mocks = vi.hoisted(() => ({ warm: vi.fn(), shell: vi.fn() }));
vi.mock("../helpers/curatedCache", () => ({ warmCuratedCache: mocks.warm }));
vi.mock("../helpers/analytics", () => ({ track: vi.fn() }));
vi.mock("../components/AnalyticsRouteTracker", () => ({ default: () => null }));
vi.mock("../components/ScrollToTopButton", () => ({ default: () => null }));
vi.mock("../components/DesignShell", async () => {
    const { Outlet, Link } = await import("react-router-dom");
    return { default: () => { mocks.shell(); return <div data-testid="shell"><Link to="/dashboard">Dataset</Link><Outlet /></div>; } };
});
vi.mock("../routes/UploadPage", () => ({ default: () => <h1>Workspace feature</h1> }));
vi.mock("../routes/Homepage", () => ({ default: () => <h1>Dataset feature</h1> }));
vi.mock("../routes/TeamPage/index", () => ({ default: () => <h1>Team feature</h1> }));
vi.mock("../routes/VisualizationPage", () => ({ default: () => {
    const { files, setFiles } = useContext(FileContext);
    const { segmentationOpacity, setSegmentationOpacity } = useContext(AnnotationContext);
    return <><h1>Viewer feature</h1><output aria-label="Private viewer state">{files.length}:{segmentationOpacity}</output>
        <button onClick={() => {
            setFiles([{ id: "private-scan", type: "test", metadata: { "PanTS ID": "private", shape: [1, 1, 1], spacing: [1, 1, 1], age: "", sex: "", manufacturer: "", "manufacturer model": "", "study type": "", site: "", "site detail": "", "site nationality": "", "study year": "", tumor: 0 } }]);
            setSegmentationOpacity(0.9);
        }}>Load private scan</button></>;
} }));
vi.mock("../liveRooms/LiveRoomPage", () => ({ default: () => <h1>Live room feature</h1> }));
vi.mock("../education/SoloChallengePage", () => ({ default: () => <h1>Challenge feature</h1> }));
vi.mock("../education/QuizPracticePage", () => ({ default: () => <h1>Quiz feature</h1> }));
vi.mock("../routes/SharePatientCard", () => ({ default: () => <h1>Shared report feature</h1> }));
vi.mock("../routes/ComparePage", () => ({ default: () => <h1>Compare feature</h1> }));
vi.mock("../routes/CompareViewerPage", () => ({ default: () => <h1>Compare viewer feature</h1> }));
vi.mock("../routes/LegalPage", () => ({ default: ({ kind }: { kind: string }) => <h1>{kind} public page</h1> }));
vi.mock("../routes/ResetPassword", () => ({ default: () => <h1>Password recovery page</h1> }));
vi.mock("../routes/VerifyEmail", () => ({ default: () => <h1>Email verification page</h1> }));
import App from "../App";

const account = { id: "u1", name: "Researcher", email: "researcher@example.com", roles: [] };
let authenticated = false;
let currentAccount = account;
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const mount = (path: string) => { window.history.replaceState({}, "", path); return render(<App />); };
beforeEach(() => {
    vi.clearAllMocks();
    authenticated = false;
    currentAccount = account;
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const path = String(url);
        if (path.includes("/api/auth/me")) return authenticated ? json({ user: currentAccount }) : json({ error: "Authentication required" }, 401);
        if (path.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
        if (path.includes("/api/auth/login")) { authenticated = true; return json({ user: account }); }
        if (path.includes("/api/auth/signup")) { authenticated = true; return json({ user: account }); }
        return json({});
    });
});

describe("site-wide account boundary", () => {
    it.each([["/", "Workspace feature"], ["/upload", "Workspace feature"], ["/team", "Team feature"], ["/local-nifti", "Viewer feature"], ["/dicom", "Viewer feature"]])("opens the public %s feature without prompting for login or requesting dataset records", async (path, feature) => {
        mount(path);
        expect(await screen.findByText(feature)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(mocks.warm).not.toHaveBeenCalled();
        expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/search"))).toBe(false);
    });

    it("Dataset navigation asks for sign-in and returns there after email login", async () => {
        const user = userEvent.setup(); mount("/");
        await user.click(await screen.findByRole("link", { name: "Dataset" }));
        const dialog = await screen.findByRole("dialog", { name: "Sign in" });
        expect(dialog).toBeInTheDocument();
        expect(screen.queryByText("Dataset feature")).not.toBeInTheDocument();
        expect(window.location.pathname).toBe("/dashboard");
        expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Keep me signed in" })).not.toBeChecked();
        await user.click(screen.getByRole("button", { name: "Continue with email" }));
        await user.type(screen.getByLabelText("Email"), "researcher@example.com");
        await user.type(screen.getByLabelText("Password"), "safe-password");
        await user.click(screen.getByRole("button", { name: "Sign in", exact: true }));
        expect(await screen.findByText("Dataset feature")).toBeInTheDocument();
        expect(window.location.pathname).toBe("/dashboard");
    });

    it("offers a dismissible sign-up prompt on the public overview", async () => {
        const user = userEvent.setup(); mount("/signup");
        expect(await screen.findByRole("dialog", { name: "Create your account" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Close", exact: true }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(window.location.pathname).toBe("/");
    });

    it.each([["/login", "Sign in"], ["/signup", "Create your account"]])("preserves the legacy %s account entry point", async (path, title) => {
        mount(path);
        expect(await screen.findByRole("dialog", { name: title })).toBeInTheDocument();
        expect(window.location.pathname).toBe("/");
    });

    it("opens the signed-in workspace at the home address", async () => {
        authenticated = true; mount("/");
        // Session hydration replaces the guest provider tree; query the live
        // document instead of retaining a node from that initial tree.
        await waitFor(() => expect(screen.getByText("Workspace feature")).toBeInTheDocument());
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it.each(["/dashboard", "/case/8854", "/case/9902?mode=3d#slice=4", "/session/test", "/reconstruction/test", "/live/example#room-key", "/share/example", "/learn/quiz/example", "/compare", "/compare-viewer", "/account"])("blocks a guest at %s without mounting the feature", async (path) => {
        mount(path);
        expect(await screen.findByRole("dialog", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.queryByText(/feature$/)).not.toBeInTheDocument();
        expect(mocks.shell).not.toHaveBeenCalled();
        expect(mocks.warm).not.toHaveBeenCalled();
        expect(window.location.pathname + window.location.search + window.location.hash).toBe(path);
    });

    it("does not mount private content while restoring the session", async () => {
        let resolve!: (result: Response) => void;
        global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/api/auth/me")
            ? await new Promise<Response>((done) => { resolve = done; }) : json({}));
        mount("/dashboard");
        expect(screen.queryByText("Dataset feature")).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
        resolve(json({ user: account }));
        expect(await screen.findByText("Dataset feature")).toBeInTheDocument();
    });

    it("opens the exact signed-in deep link including its query and room key", async () => {
        authenticated = true;
        mount("/live/example?mode=review#room-key");
        expect(await screen.findByText("Live room feature")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(window.location.pathname + window.location.search + window.location.hash).toBe("/live/example?mode=review#room-key");
    });

    it.each([
        ["/case/8854?review=1#slice-20", "/case/8854?review=1#slice-20"],
        ["/case/9902?mode=3d#slice=4", "/case/CV_00000001?mode=3d#slice=4"],
    ])("email sign-in unlocks the requested viewer at %s", async (requested, expected) => {
        const user = userEvent.setup();
        mount(requested);
        await user.click(await screen.findByRole("button", { name: "Continue with email" }));
        await user.type(screen.getByLabelText("Email"), "researcher@example.com");
        await user.type(screen.getByLabelText("Password"), "safe-password");
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        expect(await screen.findByText("Viewer feature")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(window.location.pathname + window.location.search + window.location.hash).toBe(expected);
    });

    it.each([["/terms", "terms public page"], ["/privacy", "privacy public page"], ["/reset-password?token=test", "Password recovery page"], ["/verify-email?token=test", "Email verification page"]])("leaves %s reachable without a session", async (path, heading) => {
        mount(path);
        expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(mocks.shell).not.toHaveBeenCalled();
    });
});


it("releases the previous account's scan and annotation state on an authenticated account switch", async () => {
    const user = userEvent.setup();
    authenticated = true;
    mount("/case/8854?review=1#slice-20");
    await user.click(await screen.findByRole("button", { name: "Load private scan" }));
    expect(screen.getByLabelText("Private viewer state")).toHaveTextContent("1:0.9");
    currentAccount = { ...account, id: "u2", email: "second@example.com" };
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "authChangePing", newValue: "new-account" })));
    await waitFor(() => expect(screen.getByLabelText("Private viewer state")).toHaveTextContent("0:0.5"));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/case/8854?review=1#slice-20");
});
