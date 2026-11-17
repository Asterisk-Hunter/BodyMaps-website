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
  fireEvent.click(await screen.findByRole("button", { name: "View cases" }));
  const link = await screen.findByRole("link", { name: "Open" });
  expect(link.getAttribute("href")).toBe("/case/PanTS_00000055?assignment=assignment-1&hd=1");
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Continue with PanTS_00000055" })).toBeTruthy();
});
