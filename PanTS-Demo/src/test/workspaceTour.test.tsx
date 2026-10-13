import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceTour from "../components/WorkspaceTour";

const SEEN_KEY = "bodymaps.workspace-tour.v6";
const INTRO = "A quick tour of BodyMaps";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  // jsdom has no layout: mark only controls visible on this desktop/mobile page.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    const rects = this.dataset.testVisible === "true" ? [this.getBoundingClientRect()] : [];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testVisible === "true" ? new DOMRect(100, 200, 150, 40) : new DOMRect(0, 0, 0, 0);
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const startTour = () => act(() => { vi.advanceTimersByTime(900); });
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
const dotLabels = () => screen.getAllByRole("button", { name: /^Go to .* step$/ }).map((button) => button.getAttribute("aria-label"));

function DesktopTargets({ onUpload, onRun }: { onUpload?: () => void; onRun?: () => void }) {
  return <>
    <section data-tour="scan-input" data-test-visible="true"><button type="button" onClick={onUpload}>Choose scan</button></section>
    <section data-tour="preprocessing" data-test-visible="true">Preprocessing control</section>
    <section data-tour="model" data-test-visible="true">Model control</section>
    <section data-tour="postprocessing" data-test-visible="true">Postprocessing control</section>
    <button type="button" data-tour="run" data-test-visible="true" onClick={onRun}>Run scan</button>
    <nav data-tour="explore" data-test-visible="true">Dataset and team links</nav>
    <section data-tour="recent" data-test-visible="true">Recent run list</section>
    <aside data-tour="settings" data-test-visible="true">Account controls</aside>
  </>;
}

describe("workspace walkthrough", () => {
  it("starts with a greeting, then walks every granular desktop step without uploading or running inference", () => {
    const upload = vi.fn(), run = vi.fn(), fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<><DesktopTargets onUpload={upload} onRun={run} /><WorkspaceTour replay={0} name="Ahmad Example" /></>);
    startTour();
    expect(screen.getByRole("dialog", { name: INTRO })).toHaveFocus();
    expect(screen.getByText("Welcome, Ahmad")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    expect(dotLabels()).toEqual([
      "Go to welcome step", "Go to upload step", "Go to preprocessing step", "Go to model step",
      "Go to postprocessing step", "Go to run step", "Go to explore step", "Go to recent runs step", "Go to settings step",
    ]);
    expect(document.querySelector(".design-tour-target")).not.toBeInTheDocument();
    const ring = document.querySelector(".design-tour-ring");
    expect(ring).toHaveStyle({ opacity: "0" });
    for (const title of [
      "Start with a CT scan", "Prepare your scan", "Choose your model", "Refine the result", "Bring it all together",
      "Your imaging workspace", "Pick up where you left off", "Make it yours",
    ]) {
      next();
      expect(screen.getByRole("dialog", { name: title })).toHaveFocus();
      expect(ring).toHaveStyle({ opacity: "1" });
    }
    expect(screen.getByRole("button", { name: "Get started", exact: true })).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Get started", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(SEEN_KEY)).toBe("true");
  });

  it("supports a dot jump to a granular step, Back, and returning directly to the introduction", () => {
    render(<><DesktopTargets /><WorkspaceTour replay={0} /></>);
    startTour();
    const dot = screen.getByRole("button", { name: "Go to postprocessing step" });
    fireEvent.click(dot);
    expect(screen.getByRole("dialog", { name: "Refine the result" })).toHaveFocus();
    expect(dot).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
    expect(screen.getByRole("dialog", { name: "Choose your model" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Go to welcome step" }));
    expect(screen.getByRole("dialog", { name: INTRO })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    expect(document.querySelector(".design-tour-ring")).toHaveStyle({ opacity: "0" });
  });

  it("uses visible mobile navigation instead of hidden desktop controls and restores focus on Escape", () => {
    render(<>
      <button type="button" data-test-visible="true">Open walkthrough</button>
      <nav data-tour="explore">Hidden desktop links</nav>
      <header data-tour="mobile-navigation" data-test-visible="true">Mobile navigation control</header>
      <section data-tour="scan-input" data-test-visible="true">Scan composer</section>
      <section data-tour="settings">Hidden account controls</section>
      <WorkspaceTour replay={0} />
    </>);
    const opener = screen.getByRole("button", { name: "Open walkthrough" });
    opener.focus();
    startTour();
    expect(dotLabels()).toEqual(["Go to welcome step", "Go to upload step", "Go to explore step"]);
    fireEvent.click(screen.getByRole("button", { name: "Go to explore step" }));
    expect(screen.getByText(/Open the navigation menu to explore/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get started", exact: true })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(localStorage.getItem(SEEN_KEY)).toBe("true");
  });

  it("excludes hidden, aria-hidden, inert, CSS-hidden, and unrendered targets", () => {
    render(<>
      <section data-tour="scan-input" data-test-visible="true" hidden>Hidden upload</section>
      <section aria-hidden="true"><div data-tour="preprocessing" data-test-visible="true">Hidden preprocessor</div></section>
      <section inert><div data-tour="model" data-test-visible="true">Inert model</div></section>
      <section data-tour="postprocessing" data-test-visible="true" style={{ visibility: "hidden" }}>Invisible postprocessor</section>
      <section data-tour="run">No-layout run</section>
      <section data-tour="explore" data-test-visible="true">Visible explore</section>
      <WorkspaceTour replay={0} />
    </>);
    startTour();
    expect(dotLabels()).toEqual(["Go to welcome step", "Go to explore step"]);
  });

  it("still offers the introduction when the current page has no visible targets", () => {
    render(<><aside data-tour="settings">Hidden settings</aside><WorkspaceTour replay={0} /></>);
    startTour();
    expect(screen.getByRole("dialog", { name: INTRO })).toBeInTheDocument();
    expect(screen.getByText("Welcome to BodyMaps")).toBeInTheDocument();
    expect(dotLabels()).toEqual(["Go to welcome step"]);
    expect(screen.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Get started", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not include a zero-size target even when getClientRects returns an entry", () => {
    render(<><section data-tour="model" data-test-visible="true">Zero-size model</section><WorkspaceTour replay={0} /></>);
    screen.getByText("Zero-size model").getBoundingClientRect = vi.fn(() => new DOMRect(100, 200, 0, 0));
    startTour();
    expect(dotLabels()).toEqual(["Go to welcome step"]);
  });

  it.each(["model", "settings"])("updates desktop-to-mobile steps on resize while the current step is %s", (current) => {
    const view = (desktop: boolean) => <>
      <section data-tour="scan-input" data-test-visible="true">Scan composer</section>
      <section data-tour="model" data-test-visible="true">Model control</section>
      <nav data-tour="explore" data-test-visible={desktop}>Desktop navigation</nav>
      <header data-tour="mobile-navigation" data-test-visible={!desktop}>Mobile navigation</header>
      <aside data-tour="settings" data-test-visible={desktop}>Desktop account controls</aside>
      <WorkspaceTour replay={0} />
    </>;
    const { rerender } = render(view(true));
    startTour();
    fireEvent.click(screen.getByRole("button", { name: current === "model" ? "Go to model step" : "Go to settings step" }));
    rerender(view(false));
    fireEvent.resize(window);
    act(() => { vi.advanceTimersByTime(20); });
    expect(dotLabels()).toEqual(["Go to welcome step", "Go to upload step", "Go to model step", "Go to explore step"]);
    expect(screen.getByRole("dialog")).toHaveFocus();
    if (current === "model") {
      expect(screen.getByRole("dialog", { name: "Choose your model" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Go to model step" })).toHaveAttribute("aria-current", "step");
    } else {
      expect(screen.queryByRole("dialog", { name: "Make it yours" })).not.toBeInTheDocument();
      expect(screen.getByText(/Open the navigation menu to explore/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Go to explore step" })).toHaveAttribute("aria-current", "step");
    }
  });

  it("reveals a target clipped by its scroll container even if it is inside the browser viewport", () => {
    render(<>
      <main data-test-visible="true" style={{ overflowY: "auto" }}>
        <section data-tour="scan-input" data-test-visible="true">Clipped scan composer</section>
      </main>
      <WorkspaceTour replay={0} />
    </>);
    const composer = screen.getByText("Clipped scan composer");
    const container = screen.getByRole("main");
    container.getBoundingClientRect = vi.fn(() => new DOMRect(80, 150, 400, 200));
    composer.getBoundingClientRect = vi.fn(() => new DOMRect(100, 400, 200, 50));
    const reveal = vi.fn();
    composer.scrollIntoView = reveal;
    startTour();
    expect(reveal).not.toHaveBeenCalled();
    next();
    expect(reveal).toHaveBeenCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });
    expect(screen.getByRole("dialog", { name: "Start with a CT scan" })).toHaveFocus();
  });

  it("does not interrupt returning users but supports explicitly replaying the walkthrough", () => {
    localStorage.setItem(SEEN_KEY, "true");
    const { rerender } = render(<WorkspaceTour replay={0} />);
    startTour();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<WorkspaceTour replay={1} />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByRole("dialog", { name: INTRO })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps focus within the dialog, including dots, and skips disabled Back", () => {
    render(<WorkspaceTour replay={0} />);
    startTour();
    expect(screen.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Get started", exact: true })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Skip tour" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Get started", exact: true })).toHaveFocus();
    const dot = screen.getByRole("button", { name: "Go to welcome step" });
    dot.focus();
    expect(dot).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])("only reveals offscreen targets, never the intro (reduced motion: %s)", (reducedMotion) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reducedMotion })));
    render(<>
      <button type="button" data-test-visible="true">Launch guide</button>
      <section data-tour="scan-input" data-test-visible="true">Offscreen scan composer</section>
      <nav data-tour="explore" data-test-visible="true">Visible navigation</nav>
      <WorkspaceTour replay={0} />
    </>);
    const opener = screen.getByRole("button", { name: "Launch guide" });
    const navigation = screen.getByText("Visible navigation");
    const composer = screen.getByText("Offscreen scan composer");
    const revealNavigation = vi.fn(), revealComposer = vi.fn();
    navigation.scrollIntoView = revealNavigation;
    composer.scrollIntoView = revealComposer;
    composer.getBoundingClientRect = vi.fn(() => new DOMRect(0, 1800, 300, 200));
    opener.focus();
    startTour();
    expect(revealNavigation).not.toHaveBeenCalled();
    expect(revealComposer).not.toHaveBeenCalled();
    next();
    expect(revealComposer).toHaveBeenCalledWith({
      behavior: reducedMotion ? "instant" : "smooth", block: "center", inline: "nearest",
    });
    expect(screen.getByRole("dialog", { name: "Start with a CT scan" })).toHaveFocus();
    next();
    expect(revealNavigation).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(opener).toHaveFocus();
  });

  it.each([
    ["hidden", "mobile"],
    ["removed", "settings"],
    ["removed", "content"],
  ] as const)("restores useful focus when the replay launcher is %s using the %s fallback", (launcherState, fallback) => {
    const view = (launcher: "shown" | "hidden" | "removed") => <>
      {launcher !== "removed" && <button type="button" hidden={launcher === "hidden"} data-test-visible="true">Replay walkthrough</button>}
      <header data-tour="mobile-navigation">
        <button type="button" aria-controls="design-sidebar" data-test-visible={fallback === "mobile"}>Open navigation</button>
      </header>
      <aside data-tour="settings">
        <button type="button" aria-haspopup="menu" data-test-visible={fallback === "settings"}>Settings</button>
      </aside>
      <main id="workspace-content" tabIndex={-1} data-test-visible="true">Workspace</main>
      <WorkspaceTour replay={1} />
    </>;
    const { rerender } = render(view("shown"));
    screen.getByRole("button", { name: "Replay walkthrough" }).focus();
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByRole("dialog")).toHaveFocus();
    rerender(view(launcherState));
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    const target = fallback === "content" ? screen.getByRole("main")
      : screen.getByRole("button", { name: fallback === "mobile" ? "Open navigation" : "Settings" });
    expect(target).toHaveFocus();
  });
});
