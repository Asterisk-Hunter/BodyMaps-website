import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";

const state = vi.hoisted(() => ({
    authPrompt: { open: true, mode: "signin" },
    closeAuthPrompt: vi.fn(), promptAuth: vi.fn(), signIn: vi.fn(), signUp: vi.fn(),
    requestPasswordReset: vi.fn(), signInWithProvider: vi.fn(),
    oauthProviders: { google: true, github: true } as { google: boolean; github: boolean } | null,
    oauthError: null, clearOauthError: vi.fn(),
}));
vi.mock("../contexts/authContext", () => ({ useAuth: () => state }));

beforeEach(() => {
    vi.clearAllMocks();
    state.authPrompt = { open: true, mode: "signin" };
    state.oauthProviders = { google: true, github: true };
});
const show = (standalone = false) => render(<MemoryRouter><AuthModal standalone={standalone} /></MemoryRouter>);

describe("V6 authentication card", () => {
    it("keeps both provider actions connected to real auth with explicit persistence", async () => {
        const user = userEvent.setup();
        show();
        await user.click(screen.getByRole("button", { name: "Continue with Google" }));
        expect(state.signInWithProvider).toHaveBeenLastCalledWith("google", false);
        await user.click(screen.getByRole("checkbox", { name: "Keep me signed in" }));
        await user.click(screen.getByRole("button", { name: "Continue with GitHub" }));
        expect(state.signInWithProvider).toHaveBeenLastCalledWith("github", true);
    });

    it("does not launch OAuth before provider availability is known", () => {
        state.oauthProviders = null;
        show();
        expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeDisabled();
    });

    it("passes email credentials and the unchecked session preference to the existing action", async () => {
        const user = userEvent.setup();
        show();
        await user.click(screen.getByRole("button", { name: "Continue with email" }));
        await user.type(screen.getByLabelText("Email"), "researcher@example.com");
        await user.type(screen.getByLabelText("Password"), "safe-password");
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        expect(state.signIn).toHaveBeenCalledWith("researcher@example.com", "safe-password", false);
        expect(state.signUp).not.toHaveBeenCalled();
    });

    it("renders an undismissable card for guarded routes while retaining recovery and legal links", async () => {
        const user = userEvent.setup();
        state.authPrompt.open = false;
        show(true);
        expect(screen.getByRole("dialog", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(state.closeAuthPrompt).not.toHaveBeenCalled();
        expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
        await user.click(screen.getByRole("button", { name: "Sign up" }));
        expect(state.promptAuth).toHaveBeenCalledWith("signup");
        await user.click(screen.getByRole("button", { name: "Continue with email" }));
        await user.click(screen.getByRole("button", { name: "Forgot password?" }));
        expect(state.promptAuth).toHaveBeenCalledWith("forgot");
    });

    it("traps focus and returns it to the opener when a normal dialog closes", async () => {
        const user = userEvent.setup();
        const opener = document.createElement("button");
        document.body.append(opener); opener.focus();
        const { unmount } = show();
        expect(screen.getByRole("dialog")).toHaveFocus();
        await user.tab({ shift: true });
        expect(screen.getByRole("button", { name: "Sign up" })).toHaveFocus();
        await user.tab();
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
        await user.keyboard("{Escape}");
        expect(state.closeAuthPrompt).toHaveBeenCalledOnce();
        unmount();
        expect(opener).toHaveFocus();
        opener.remove();
    });
});
