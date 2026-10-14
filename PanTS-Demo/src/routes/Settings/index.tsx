import {
	IconChartBar, IconHeart, IconHistory, IconShieldLock, IconUser, IconUsers,
} from "@tabler/icons-react";
import React, { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { track } from "../../helpers/analytics";
import { SettingsContext } from "./context";
import "./Settings.css";

// Settings shell: a left nav and a panel, one URL per section.
//
// Replaces the single scrolling page this used to be. The layout follows
// Claude's settings — a narrow rail of sections, and a panel of rows where each
// row is a label on the left and its control on the right, separated by a
// hairline. The old page explained every control in a paragraph underneath it;
// almost all of that prose is gone. "Export data" does not need three lines
// telling you what exporting data is.
//
// Sections own their own content (ProfileSettings, PlanSettings, ...); this
// file owns the chrome, the signed-out redirect, and the shared busy/notice
// state so every action reports success and failure the same way.

// Notifications is deliberately not a section: it's one switch, and a whole
// page for one switch is a mostly-empty panel. It lives on Profile, the way
// Claude keeps small preferences inside General.
type Section = {
	to: string;
	label: string;
	icon: typeof IconUser;
	/** Exact-match the URL, so "/account" isn't active on every child route. */
	end?: boolean;
};

const SECTIONS: Section[] = [
	{ to: "/account", label: "Profile", icon: IconUser, end: true },
	{ to: "/account/plan", label: "Plan", icon: IconHeart },
	{ to: "/account/history", label: "History", icon: IconHistory },
	{ to: "/account/privacy", label: "Privacy", icon: IconShieldLock },
];

// Admin-only sections, appended below the rest so the rail's ordinary shape
// doesn't shift for the people who have them. Hiding these is presentation, not
// protection — both pages and both APIs check the role themselves.
const ADMIN_SECTIONS: Section[] = [
	{ to: "/account/analytics", label: "Usage", icon: IconChartBar },
	{ to: "/account/people", label: "People", icon: IconUsers },
];

const SettingsPage: React.FC = () => {
	const navigate = useNavigate();
	// Once per visit to the settings area, not once per section.
	useEffect(() => {
		track("account_open_settings");
	}, []);
	const { isAuthenticated, loading, promptAuth, user } = useAuth();
	const sections = user?.roles.includes("admin")
		? [...SECTIONS, ...ADMIN_SECTIONS]
		: SECTIONS;

	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const errorScope = useRef<string | undefined>(undefined);

	// The shell stays mounted while the sections swap underneath it, so a
	// banner from one section ("Couldn't save your name") would otherwise sit
	// on top of the next. Each section starts clean.
	const { pathname } = useLocation();
	const pathnameRef = useRef(pathname);
	useEffect(() => {
		pathnameRef.current = pathname;
		setNotice("");
		setError("");
		errorScope.current = undefined;
	}, [pathname]);

	// Wait for the initial /me check before deciding. Without the `loading` guard
	// a hard refresh on /account bounces you to the landing page, because the
	// session cookie hasn't been exchanged for a user yet on first render.
	useEffect(() => {
		if (!loading && !isAuthenticated) {
			navigate("/", { replace: true });
			promptAuth();
		}
	}, [loading, isAuthenticated, navigate, promptAuth]);

	// Success messages clear themselves — they confirm something that already
	// happened, so leaving one pinned makes the page look stuck. Errors stay up.
	useEffect(() => {
		if (!notice) return;
		const t = setTimeout(() => setNotice(""), 6000);
		return () => clearTimeout(t);
	}, [notice]);

	// A notice from the moment a section started an action goes to the banner
	// only while that section is still the one on screen. A save that finishes
	// after the person has moved on would otherwise land its "updated" message on
	// top of another section. A failure is different: it means an edit was lost,
	// and nothing else would tell them, so it is shown wherever they are now.
	// Each render's copy of these is bound to that render's section.
	const here = pathname;
	const current = () => pathnameRef.current === here;
	// Actions run one at a time, so `scope` is the one the running action was
	// given, and `errorScope` is the one that put the current error up. A queued
	// action that succeeds for the same thing (the name fixed and saved again)
	// takes the old error down with it; one for another field leaves it, since
	// that edit is still unsaved. A failure takes down a notice from an earlier
	// action, which a queued action no longer clears when it starts.
	const scope = useRef<string | undefined>(undefined);
	const notify = (message: string) => {
		if (!current()) return;
		if (scope.current !== undefined && errorScope.current === scope.current) {
			setError("");
			errorScope.current = undefined;
		}
		setNotice(message);
	};
	const fail = (message: string) => {
		// fail("") only takes the error down (a new picture picked, Discard),
		// leaving any notice where it is.
		if (!message) {
			setError("");
			errorScope.current = undefined;
			return;
		}
		errorScope.current = scope.current;
		setNotice("");
		setError(message);
	};

	// Actions run one after another, so two overlapping saves can't race and the
	// last response can't overwrite a newer account. A pending count rather than
	// a flag: busy only drops once the last queued action has finished, so the
	// first to finish no longer clears it while others are still going.
	const queue = useRef<Promise<void>>(Promise.resolve());
	const pending = useRef(0);
	const run = (fn: () => Promise<void>, actionScope?: string) => {
		// An action queued behind another leaves the banner alone when it starts:
		// whatever the one ahead reported (a failed save, say) is still the news,
		// and clearing it would hide that the edit was never saved. Its own result
		// still replaces the notice.
		const queued = pending.current > 0;
		pending.current += 1;
		setBusy(true);
		const task = queue.current.then(async () => {
			if (!queued) {
				setError("");
				setNotice("");
				errorScope.current = undefined;
			}
			scope.current = actionScope;
			try {
				await fn();
			} catch (e) {
				fail(e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");
			} finally {
				// A fail() from outside run() (a picture refused on pick) has no scope.
				scope.current = undefined;
				pending.current -= 1;
				if (!pending.current) setBusy(false);
			}
		});
		queue.current = task;
		return task;
	};

	if (!isAuthenticated) return null;

	return (
		<div className="set-wrapper">
			<main className="set-main">
				<header className="set-page-heading"><span className="set-eyebrow">Account</span><h1 className="set-title">Settings</h1><p>Your profile, access and preferences, in one place.</p></header>

				<div className="set-layout">
					<nav className="set-nav" aria-label="Settings sections">
						{sections.map((s) => (
							<NavLink
								key={s.to}
								to={s.to}
								end={s.end}
								className={({ isActive }) =>
									`set-nav-item${isActive ? " set-nav-item--on" : ""}`
								}
							>
								<s.icon size={17} stroke={1.7} aria-hidden="true" />
								{s.label}
							</NavLink>
						))}
					</nav>

					<section className="set-panel">
						{/* Both stay mounted (empty, with no box, until needed) so
						    screen readers announce a notice or an error when it lands. */}
						<div className="set-banners">
							<div className="set-banner" role="status">{notice}</div>
							<div className="set-banner set-banner--error" role="alert">{error}</div>
						</div>
						<SettingsContext.Provider
							value={{ busy, run, notify, fail }}
						>
							{/* Each section is its own chunk. Its first load waits here, inside
							    the panel, so the heading and the section nav stay on screen
							    instead of the whole page giving way to the route spinner. */}
							<Suspense
								fallback={
									<div className="set-section-loading" role="status" aria-label="Loading section">
										<div className="set-section-loading__spinner animate-spin" />
									</div>
								}
							>
								<Outlet />
							</Suspense>
						</SettingsContext.Provider>
					</section>
				</div>
			</main>
		</div>
	);
};

export default SettingsPage;
