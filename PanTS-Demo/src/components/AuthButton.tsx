import { IconChevronDown, IconLogout, IconPlayerPlay, IconSettings, IconUser } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/authContext";
import { nameInitial } from "../liveRooms/composerHelpers";
import styles from "./AuthButton.module.css";

type Props = { variant?: "default" | "sidebar"; collapsed?: boolean; onWalkthrough?: () => void };

function sidebarMenuPosition(trigger: HTMLElement, collapsed: boolean) {
    const rect = trigger.getBoundingClientRect();
    // Portals use viewport coordinates but must retain the shell's display scale.
    const shell = trigger.closest(".design-shell");
    const scale = shell ? Number.parseFloat(getComputedStyle(shell).zoom) || 1 : 1;
    const width = Math.min(256 * scale, window.innerWidth - 24);
    const bottom = Math.max(12, Math.min(window.innerHeight - 24,
        window.innerHeight - (collapsed ? rect.bottom : rect.top) + (collapsed ? 0 : 8)));
    return {
        left: Math.max(12, Math.min(collapsed ? rect.right + 12 : rect.left, window.innerWidth - width - 12)),
        bottom, width, maxHeight: window.innerHeight - bottom - 12, scale,
    };
}

export default function AuthButton({ variant = "default", collapsed = false, onWalkthrough }: Props) {
    const { user, isAuthenticated, loading, signOut, promptAuth, authPrompt } = useAuth();
    const navigate = useNavigate();
    const [menuOpen, setMenuOpen] = useState(false);
    const [signingOut, setSigningOut] = useState(false);
    const [signOutError, setSignOutError] = useState("");
    const [position, setPosition] = useState({ left: 12, bottom: 80, width: 256, maxHeight: 400, scale: 1 });
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const signInRef = useRef<HTMLButtonElement>(null);
    const wasAuthenticated = useRef(isAuthenticated);
    const signedInFromPopup = useRef(false);
    const signedOutFromMenu = useRef(false);
    const menuId = useId();
    const sidebar = variant === "sidebar";
    const closeMenu = (restore = false) => { setMenuOpen(false); if (restore) triggerRef.current?.focus(); };

    // Signing in from the popup swaps the Sign in button (the popup's opener) for
    // the account trigger, so the popup has nowhere to return focus to and it
    // would fall to the page. Once the popup has closed, put it on the trigger.
    useEffect(() => {
        if (isAuthenticated && !wasAuthenticated.current && authPrompt.open) signedInFromPopup.current = true;
        wasAuthenticated.current = isAuthenticated;
        if (!signedInFromPopup.current || authPrompt.open) return;
        signedInFromPopup.current = false;
        const active = document.activeElement;
        if (!active || active === document.body) triggerRef.current?.focus({ preventScroll: true });
    }, [isAuthenticated, authPrompt.open]);

    // Signing out from the menu removes the focused menu item and swaps the
    // account trigger for the Sign in button, so focus would fall to the page.
    // Put it on the new Sign in button.
    useEffect(() => {
        if (isAuthenticated || !signedOutFromMenu.current) return;
        signedOutFromMenu.current = false;
        const active = document.activeElement;
        if (!active || active === document.body) signInRef.current?.focus({ preventScroll: true });
    }, [isAuthenticated]);

    useEffect(() => {
        if (!menuOpen) return;
        menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const outside = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
        };
        // Escape belongs to the open menu alone. Listening in the capture phase and
        // stopping it there keeps it from also reaching the phone drawer's own
        // Escape handler, which would close the drawer around the menu's trigger.
        const key = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); triggerRef.current?.focus(); }
        };
        const resize = () => setMenuOpen(false);
        document.addEventListener("mousedown", outside);
        document.addEventListener("keydown", key, true);
        if (!sidebar) window.addEventListener("resize", resize);
        return () => {
            document.removeEventListener("mousedown", outside);
            document.removeEventListener("keydown", key, true);
            window.removeEventListener("resize", resize);
        };
    }, [menuOpen, sidebar]);

    useEffect(() => {
        if (!menuOpen || !sidebar || !triggerRef.current) return;
        const trigger = triggerRef.current;
        const sidebarElement = trigger.closest(".design-sidebar");
        let frame = 0;
        const measure = () => {
            const next = sidebarMenuPosition(trigger, collapsed);
            setPosition((current) => Object.entries(next).every(([key, value]) => current[key as keyof typeof current] === value) ? current : next);
        };
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
        measure();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
        observer?.observe(trigger);
        if (sidebarElement) observer?.observe(sidebarElement);
        sidebarElement?.addEventListener("transitionend", schedule);
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        return () => {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            sidebarElement?.removeEventListener("transitionend", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("scroll", schedule, true);
        };
    }, [menuOpen, sidebar, collapsed]);

    // The session can end while the menu is open (signed out in another tab, or
    // expired). Nothing else closes it then, so it would be open again after
    // the next sign-in.
    if (!isAuthenticated && menuOpen) setMenuOpen(false);

    if (loading) return null;
    if (!isAuthenticated || !user) return (
        <button ref={signInRef} type="button" className={`${styles.signInBtn} ${sidebar ? styles.sidebarSignIn : ""}`} onClick={() => promptAuth()} title={collapsed ? "Sign in" : undefined} aria-label="Sign in">
            {sidebar && <IconUser size={19} aria-hidden="true" />}
            {(!sidebar || !collapsed) && <span>Sign in</span>}
        </button>
    );

    const toggle = () => {
        if (!menuOpen && sidebar && triggerRef.current) {
            setPosition(sidebarMenuPosition(triggerRef.current, collapsed));
        }
        setMenuOpen(!menuOpen);
    };
    const logout = async () => {
        if (signingOut) return;
        setSigningOut(true);
        setSignOutError("");
        signedOutFromMenu.current = true;
        try {
            await signOut();
            closeMenu();
            navigate("/");
        } catch {
            signedOutFromMenu.current = false;
            setSignOutError("Couldn't sign out. Check your connection and try again.");
        } finally { setSigningOut(false); }
    };
    const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        }
        if (event.key === "Tab") { event.stopPropagation(); closeMenu(true); }
    };
    const menu = menuOpen ? (
        <div ref={menuRef} id={menuId} className={`${styles.menu} ${sidebar ? styles.sidebarMenu : ""}`} role="menu" aria-label="Account" onKeyDown={menuKey}
            style={sidebar ? { left: position.left / position.scale, bottom: position.bottom / position.scale,
                width: position.width / position.scale, maxHeight: position.maxHeight / position.scale, zoom: position.scale } : undefined}>
            <div className={styles.menuHeader}>
                <span className={styles.menuAvatar}>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : nameInitial(user.name || user.email)}</span>
                <div className={styles.menuIdentity}><div className={styles.menuName}>{user.name}</div><div className={styles.menuEmail}>{user.email}</div></div>
            </div>
            <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { closeMenu(); navigate("/account"); }}>
                <span className={sidebar ? styles.menuIcon : undefined}><IconUser size={17} aria-hidden="true" /></span>
                <span>{sidebar ? "Profile" : "Account settings"}{sidebar && <small>Name, picture and email</small>}</span>
            </button>
            {onWalkthrough && <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { closeMenu(); onWalkthrough(); }}>
                <span className={sidebar ? styles.menuIcon : undefined}><IconPlayerPlay size={17} aria-hidden="true" /></span><span>Walkthrough<small>Replay the tour</small></span>
            </button>}
            <button type="button" className={`${styles.menuItem} ${styles.signOut}`} role="menuitem" disabled={signingOut} onClick={() => void logout()}>
                <span className={sidebar ? styles.menuIcon : undefined}><IconLogout size={17} aria-hidden="true" /></span>{signingOut ? "Signing out…" : "Sign out"}
            </button>
            {signOutError && <p className={styles.menuError} role="alert">{signOutError}</p>}
        </div>
    ) : null;

    return (
        <div className={`${styles.accountRoot} ${sidebar ? styles.sidebarRoot : ""}`} ref={rootRef}>
            <button ref={triggerRef} type="button" className={`${styles.accountTrigger} ${sidebar ? styles.sidebarTrigger : ""}`} onClick={toggle}
                aria-label={sidebar ? "Settings" : undefined} title={sidebar && collapsed ? "Settings" : undefined}
                aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
                onKeyDown={(event) => { if (event.key === "ArrowDown" && !menuOpen) { event.preventDefault(); toggle(); } }}>
                {sidebar ? <IconSettings size={19} aria-hidden="true" /> : <span className={styles.avatar}>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : nameInitial(user.name || user.email)}</span>}
                {(!sidebar || !collapsed) && <span className={styles.accountEmail}>{sidebar ? "Settings" : user.hasCustomName ? user.name : user.email}</span>}
                {!sidebar && <IconChevronDown size={15} className={styles.chevron} aria-hidden="true" />}
            </button>
            {sidebar && menu ? createPortal(menu, document.body) : menu}
        </div>
    );
}
