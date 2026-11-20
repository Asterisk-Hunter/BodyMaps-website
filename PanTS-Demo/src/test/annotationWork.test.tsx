import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AnnotationWork from "../routes/AnnotationWork";

afterEach(() => vi.restoreAllMocks());

it("opens an assigned case with its private context and full resolution", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true, json: async () => String(input).includes("/cases")
      ? { cases: [{ case_key: "PanTS_00000055", status: "in_progress" }, { case_key: "PanTS_00000056", status: "unavailable" }] }
      : { assignments: [{ id: "assignment-1", project: { name: "Ducts", target_names: { "7": "Bile duct" } }, case_count: 2, counts: {} }] },
  })));
  render(<MemoryRouter><AnnotationWork /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /view cases/i }));
  const link = await screen.findByRole("link", { name: /open/i });
  expect(link.getAttribute("href")).toBe("/assignments/assignment-1/cases/PanTS_00000055");
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: /continue with pants_00000055/i })).toBeTruthy();
});

it("offers the same create and join actions from the worklist", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ assignments: [] }) })));
  render(<MemoryRouter><AnnotationWork /></MemoryRouter>);
  expect(await screen.findByText("No assigned projects")).toBeInTheDocument();
  const helpButton = screen.getByRole("button", { name: "How annotation projects work" });
  expect(helpButton).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(helpButton);
  expect(screen.getByRole("region", { name: "How annotation projects work" })).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("region", { name: "How annotation projects work" })).not.toBeInTheDocument();
  fireEvent.click(helpButton);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "How annotation projects work" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh worklist" })).toBeInTheDocument();
});
