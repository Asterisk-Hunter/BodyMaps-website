import { type ReactNode, useLayoutEffect } from "react";
import { Link } from "react-router-dom";
import { DARK_ROUTE_CLASS, isDarkRoute } from "../../helpers/routeSurface";
import styles from "./MessagePage.module.css";

/**
 * A full-page dead end: one heading, a short explanation and a way back, on
 * the light page surface. Used where a route cannot show what it was asked
 * for (the route error page), so the visitor is never left on a blank screen
 * with nowhere to go.
 */
export type MessageAction =
	| { label: string; to: string; href?: never; onClick?: never }
	/** A plain anchor, for links that should leave the app state behind (a full page load). */
	| { label: string; href: string; to?: never; onClick?: never }
	/** A button, for an action that opens something over this page (the sign-in popup) instead of leaving it. */
	| { label: string; onClick: () => void; to?: never; href?: never };

export default function MessagePage({
	eyebrow,
	title,
	children,
	actions,
	alert = false,
}: {
	eyebrow?: string;
	title: string;
	children?: ReactNode;
	/** The first action is the primary button; the rest are quieter links. */
	actions: MessageAction[];
	/** Announce the message on arrival (it replaced a loading state). */
	alert?: boolean;
}) {
	// The message page is light even on a route that is otherwise dark (a viewer
	// or live-room page that failed to load), so the page ground under it, seen
	// on overscroll, matches. RouteSurface only re-runs when the path changes, so on the way
	// out this puts back whatever the current path calls for.
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.classList.remove(DARK_ROUTE_CLASS);
		return () => {
			root.classList.toggle(DARK_ROUTE_CLASS, isDarkRoute(window.location.pathname));
		};
	}, []);

	return (
		<div className={styles.page}>
			<main className={styles.main}>
				<div className={styles.message} role={alert ? "alert" : undefined}>
					{eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
					<h1 className={styles.title}>{title}</h1>
					{children && <div className={styles.text}>{children}</div>}
				</div>
				{actions.length > 0 && (
					<div className={styles.actions}>
						{actions.map((action, i) => {
							const className = i === 0 ? styles.primary : styles.secondary;
							if (action.to !== undefined) {
								return (
									<Link key={action.label} className={className} to={action.to}>
										{action.label}
									</Link>
								);
							}
							if (action.onClick !== undefined) {
								return (
									<button key={action.label} type="button" className={className} onClick={action.onClick}>
										{action.label}
									</button>
								);
							}
							return (
								<a key={action.label} className={className} href={action.href}>
									{action.label}
								</a>
							);
						})}
					</div>
				)}
			</main>
		</div>
	);
}
