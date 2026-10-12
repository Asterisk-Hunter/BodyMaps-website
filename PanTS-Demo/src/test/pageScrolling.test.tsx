import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScrollToTopButton from "../components/ScrollToTopButton";
import { scrollPageToTop } from "../helpers/pageScroll";
import { useDashboard } from "../routes/Homepage/hooks/useDashboard";

vi.mock("../helpers/prefetchViewer", () => ({ prefetchViewer: vi.fn() }));
vi.mock("../helpers/curatedCache", () => ({
  getCachedCurated: () => null,
  fetchCurated: async () => [{ case_id: "PanTS_00000035", sex: "F", age: 55, tumor: 0 }],
}));
vi.mock("../helpers/analytics", () => ({ track: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
let content: HTMLElement | null;

function mountContent() {
  content = document.createElement("main");
  content.className = "design-content";
  content.scrollTo = vi.fn();
  document.body.append(content);
  return content;
}

beforeEach(() => {
  content = null;
  localStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 100, page: 2 }) }));
});
afterEach(() => {
  content?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace content scrolling", () => {
  it("keeps the invisible control out of keyboard and accessibility navigation", () => {
    render(<ScrollToTopButton />, { wrapper });
    const button = screen.getByRole("button", { hidden: true });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("tabindex", "-1");
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: "Scroll to top" })).not.toBeInTheDocument();
  });

  it("observes a shell mounted later and scrolls that content instead of the window", () => {
    render(<ScrollToTopButton />, { wrapper });
    const shell = mountContent();
    shell.scrollTop = 450;
    fireEvent.scroll(shell);
    const button = screen.getByRole("button", { name: "Scroll to top" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("tabindex", "0");
    fireEvent.click(button);
    expect(shell.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(window.scrollTo).not.toHaveBeenCalled();
    shell.scrollTop = 0;
    fireEvent.scroll(shell);
    expect(button).toBeDisabled();
  });

  it("uses page scrolling on standalone routes without a shell", () => {
    vi.spyOn(window, "scrollY", "get").mockReturnValue(450);
    render(<ScrollToTopButton />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("does not show the control for unrelated pane or window scrolling inside the shell", () => {
    const shell = mountContent();
    vi.spyOn(window, "scrollY", "get").mockReturnValue(450);
    render(<ScrollToTopButton />, { wrapper });
    fireEvent.scroll(window);
    expect(shell.scrollTop).toBe(0);
    expect(screen.getByRole("button", { hidden: true })).toBeDisabled();
  });

  it("respects reduced motion when scrolling the content", () => {
    const shell = mountContent();
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    scrollPageToTop();
    expect(shell.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it.each([true, false])("returns paginated dataset results to the top with shell=%s", async (useShell) => {
    const shell = useShell ? mountContent() : null;
    const { result } = renderHook(useDashboard, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.handleBrowseAll(); });
    await act(async () => { result.current.goToPage(2); });
    expect(shell?.scrollTo ?? window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    if (shell) expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
