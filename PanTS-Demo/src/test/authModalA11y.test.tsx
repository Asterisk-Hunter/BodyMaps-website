/**
 * The sign-in popup as a keyboard or screen-reader user meets it: focus goes
 * in and stays in, Escape gives it back, a screen swap keeps focus in the
 * card, a text selection released over the backdrop does not throw the form
 * away, errors are tied to the fields they are about, and a request that never
 * reaches the server says so in plain words.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";
import BatchDetailsModal from "../components/BatchDetailsModal";
import { AuthProvider, useAuth } from "../contexts/authContext";

const json = (body: unknown, status = 200) => ({
	ok: status < 400,
	status,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	localStorage.clear();
	document.body.style.overflow = "";
	window.history.replaceState({}, "", "/");
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/me")) return json({ user: null });
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const Opener: React.FC = () => {
	const { promptAuth } = useAuth();
	return (
		<>
			<button type="button" onClick={() => promptAuth()}>Open sign in</button>
			<a href="#page">A link on the page</a>
		</>
	);
};

const renderModal = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<Opener />
				<AuthModal />
			</MemoryRouter>
		</AuthProvider>,
	);

const open = async (user: ReturnType<typeof userEvent.setup>) => {
	const opener = await screen.findByRole("button", { name: "Open sign in" });
	await user.click(opener);
	return { opener, dialog: await screen.findByRole("dialog", { name: "Sign in" }) };
};

const openEmailForm = async (user: ReturnType<typeof userEvent.setup>) => {
	const opened = await open(user);
	await user.click(within(opened.dialog).getByRole("button", { name: "Continue with email" }));
	return opened;
};

describe("sign-in popup focus", () => {
	it("moves focus in, keeps Tab inside, locks the page, and returns focus on Escape", async () => {
		const user = userEvent.setup();
		renderModal();
		const { opener, dialog } = await open(user);

		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.body.style.overflow).toBe("hidden");
		for (let i = 0; i < 10; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
		}
		await user.tab({ shift: true });
		expect(dialog.contains(document.activeElement)).toBe(true);

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
		expect(document.body.style.overflow).toBe("");
	});

	it("keeps focus in the card when a screen swap removes the focused button", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		expect(document.activeElement).toBe(within(dialog).getByLabelText("Email"));

		await user.click(within(dialog).getByRole("button", { name: "Forgot password?" }));
		const resetDialog = await screen.findByRole("dialog", { name: "Reset your password" });
		expect(document.activeElement).toBe(within(resetDialog).getByLabelText("Email"));

		// "Remembered it? Sign in" is not reused as the next screen's Sign up link.
		await user.click(within(resetDialog).getByRole("button", { name: "Sign in" }));
		const signIn = await screen.findByRole("dialog", { name: "Sign in" });
		expect(document.activeElement).toBe(within(signIn).getByLabelText("Email"));

		await user.click(within(signIn).getByRole("button", { name: /Other options/ }));
		expect(document.activeElement).toBe(within(signIn).getByRole("button", { name: "Continue with email" }));
	});
});

describe("sign-in popup over another dialog", () => {
	// A lapsed sign-in can bring the popup up over a dialog that is already open (the
	// batch details dialog's download meets a 401). The popup is drawn on top, so its
	// own keys must not be taken by the dialog underneath.
	const renderOverBatch = () =>
		render(
			<AuthProvider>
				<MemoryRouter>
					<Opener />
					<BatchDetailsModal
						label="Batch 1"
						uploads={[]}
						onClose={onBatchClose}
						onView={vi.fn()}
						onDownloadScan={vi.fn()}
						onDownloadAll={vi.fn()}
					/>
					<AuthModal />
				</MemoryRouter>
			</AuthProvider>,
		);
	const onBatchClose = vi.fn();
	beforeEach(() => onBatchClose.mockClear());

	it("keeps Tab inside the sign-in card", async () => {
		const user = userEvent.setup();
		renderOverBatch();
		const batch = screen.getByRole("dialog", { name: "Batch 1 details" });
		expect(batch.contains(document.activeElement)).toBe(true);
		const { dialog } = await open(user);

		for (let i = 0; i < 6; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
		}
		for (let i = 0; i < 6; i++) {
			await user.tab({ shift: true });
			expect(dialog.contains(document.activeElement)).toBe(true);
		}
	});

	it("closes only the sign-in card on Escape, and the dialog under it stays open", async () => {
		const user = userEvent.setup();
		renderOverBatch();
		const { dialog } = await open(user);
		expect(dialog.contains(document.activeElement)).toBe(true);

		await user.keyboard("{Escape}");

		expect(screen.queryByRole("dialog", { name: "Sign in" })).not.toBeInTheDocument();
		expect(onBatchClose).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "Batch 1 details" })).toBeInTheDocument();
	});
});

describe("sign-in popup backdrop", () => {
	it("a drag that starts in a field and ends on the backdrop keeps the popup and the text", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		const email = within(dialog).getByLabelText("Email");
		await user.type(email, "ada@example.com");

		const backdrop = dialog.parentElement as HTMLElement;
		fireEvent.mouseDown(email);
		fireEvent.click(backdrop);
		expect(screen.getByRole("dialog", { name: "Sign in" })).toBeInTheDocument();
		expect(within(dialog).getByLabelText("Email")).toHaveValue("ada@example.com");

		fireEvent.mouseDown(backdrop);
		fireEvent.click(backdrop);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("a plain click on the backdrop still closes it", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await open(user);
		await user.click(dialog.parentElement as HTMLElement);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});

describe("sign-in popup messages", () => {
	it("announces a validation error and ties it to the fields", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

		const alert = within(dialog).getByRole("alert");
		expect(alert).toHaveTextContent("Enter an email and password.");
		expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-describedby", alert.id);
		expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
		expect(document.activeElement).toBe(within(dialog).getByLabelText("Email"));
	});

	it("names the one blank field and focuses it", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

		expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a password.");
		expect(within(dialog).getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
		expect(within(dialog).getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
		expect(document.activeElement).toBe(within(dialog).getByLabelText("Password"));
	});

	it("marks both fields when the server refuses the pair", async () => {
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/login")) return json({ error: "Invalid email or password" }, 401);
			if (u.includes("/api/auth/me")) return json({ user: null });
			return json({ google: true, github: true });
		}) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
		await user.type(within(dialog).getByLabelText("Password"), "hunter22");
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

		expect(await within(dialog).findByRole("alert")).toHaveTextContent("Invalid email or password");
		expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
		expect(within(dialog).getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
		expect(document.activeElement).toBe(within(dialog).getByLabelText("Password"));
	});

	it("refuses a sign-up password under 8 code points before asking the server", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.click(within(dialog).getByRole("button", { name: "Sign up" }));
		const signUp = await screen.findByRole("dialog", { name: "Create your account" });
		await user.type(within(signUp).getByLabelText("Email"), "ada@example.com");
		// Seven emoji: fourteen UTF-16 units, seven characters as the server counts them.
		await user.type(within(signUp).getByLabelText("Password"), "\u{1F600}".repeat(7));
		await user.click(within(signUp).getByRole("button", { name: "Create account" }));

		expect(within(signUp).getByRole("alert")).toHaveTextContent("Use at least 8 characters.");
		expect(within(signUp).getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
		expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes("/api/auth/register"))).toBe(false);
	});

	it("says so plainly when the server can't be reached", async () => {
		let failLogin: (err: Error) => void = () => {};
		global.fetch = vi.fn((url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/login")) {
				return new Promise((_, reject) => {
					failLogin = reject;
				});
			}
			if (u.includes("/api/auth/me")) return Promise.resolve(json({ user: null }));
			return Promise.resolve(json({ google: true, github: true }));
		}) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
		await user.type(within(dialog).getByLabelText("Password"), "hunter22");
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

		// What fetch() itself throws when the request never reaches a server.
		failLogin(new TypeError("Failed to fetch"));
		const alert = await within(dialog).findByRole("alert");
		expect(alert).toHaveTextContent("Can't reach the server. Check your connection and try again.");
		expect(alert).not.toHaveTextContent(/Failed to fetch/);
		// Not about either field.
		expect(within(dialog).getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
		expect(within(dialog).getByRole("button", { name: "Sign in" })).toBeEnabled();
	});

	it("drops a late answer once Other options has left the form", async () => {
		let failLogin: (err: Error) => void = () => {};
		global.fetch = vi.fn((url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/login")) {
				return new Promise((_, reject) => {
					failLogin = reject;
				});
			}
			if (u.includes("/api/auth/me")) return Promise.resolve(json({ user: null }));
			return Promise.resolve(json({ google: true, github: true }));
		}) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
		await user.type(within(dialog).getByLabelText("Password"), "hunter22");
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
		await user.click(within(dialog).getByRole("button", { name: /Other options/ }));

		failLogin(new TypeError("Failed to fetch"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(within(dialog).queryByRole("alert")).toBeNull();
		expect(within(dialog).getByRole("button", { name: "Continue with email" })).toBeInTheDocument();
	});

	it("announces the reset-link message and uses no em dash on the reset screen", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await openEmailForm(user);
		await user.click(within(dialog).getByRole("button", { name: "Forgot password?" }));
		const reset = await screen.findByRole("dialog", { name: "Reset your password" });
		expect(reset).toHaveTextContent(/Google or GitHub/);
		expect(reset.textContent).not.toMatch(/—/);

		await user.type(within(reset).getByLabelText("Email"), "ada@example.com");
		await user.click(within(reset).getByRole("button", { name: "Send reset link" }));
		expect(await within(reset).findByRole("status")).toHaveTextContent(/If an account exists for/);
	});
});
