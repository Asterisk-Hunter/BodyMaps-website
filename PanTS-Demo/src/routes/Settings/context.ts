import { createContext, useContext } from "react";

// Shared busy/notice state for the settings sections, so every action reports
// success and failure through the one banner in the shell.
//
// Its own file rather than living in index.tsx: exporting a hook next to a
// component breaks fast refresh for the whole module.

export type SettingsContextValue = {
	busy: boolean;
	/**
	 * Runs an action after any already queued, reporting failure in the shared
	 * banner. `scope` names what it saves ("organization"), so a later success
	 * for the same thing takes down the error an earlier try left.
	 */
	run: (fn: () => Promise<void>, scope?: string) => Promise<void>;
	notify: (message: string) => void;
	fail: (message: string) => void;
};

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
	const ctx = useContext(SettingsContext);
	if (!ctx) throw new Error("useSettings must be used within the settings shell");
	return ctx;
}
