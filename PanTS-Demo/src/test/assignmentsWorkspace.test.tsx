import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AssignmentsPage from "../routes/AssignmentsPage";
import AssignmentRouteAlias from "../routes/AssignmentRouteAlias";

vi.mock("../routes/AnnotationWork", () => ({ default: ({ embedded }: { embedded?: boolean }) => <div data-testid="project-work">Project work {String(embedded)}</div> }));
vi.mock("../routes/AssignmentsPage/DirectRangeAssignments", () => ({ default: () => <div data-testid="range-work">Assigned range cases</div> }));
vi.mock("../routes/Settings/AnnotationProjects", () => ({ default: ({ onJoin }: { onJoin?: () => void }) => <div data-testid="project-management"><button type="button" onClick={onJoin}>Join a team</button>Project setup and review</div> }));
vi.mock("../routes/Settings/TeamAccessSettings", () => ({ default: ({ onBack }: { onBack?: () => void }) => <div data-testid="join-team"><button type="button" onClick={onBack}>Back to projects</button>Join form</div> }));

function LocationText() {
	const location = useLocation();
	return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>;
}

describe("single assignment workspace", () => {
	it("shows project work under My work", () => {
		render(<MemoryRouter initialEntries={["/assignments"]}><AssignmentsPage /></MemoryRouter>);
		expect(screen.getByRole("button", { name: "My work" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("project-work")).toBeInTheDocument();
		expect(screen.queryByTestId("range-work")).not.toBeInTheDocument();
	});

	it("keeps Manage focused on project setup and review", () => {
		render(<MemoryRouter initialEntries={["/assignments?view=manage"]}><AssignmentsPage /></MemoryRouter>);
		expect(screen.getByTestId("project-management")).toBeInTheDocument();
		expect(screen.queryByTestId("range-management")).not.toBeInTheDocument();
		expect(screen.queryByText("Direct handouts")).not.toBeInTheDocument();
	});

	it("opens and returns from the join panel without leaving the route", () => {
		render(<MemoryRouter initialEntries={["/assignments?view=manage"]}><AssignmentsPage /><LocationText /></MemoryRouter>);
		fireEvent.click(screen.getByRole("button", { name: "Join a team" }));
		expect(screen.getByTestId("join-team")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back to projects" }));
		expect(screen.getByTestId("project-management")).toBeInTheDocument();
		expect(screen.getByTestId("location")).toHaveTextContent("/assignments?view=manage");
	});
});

describe("legacy assignment routes", () => {
	const show = (path: string) => render(<MemoryRouter initialEntries={[path]}>
		<Routes>
			<Route path="/work" element={<AssignmentRouteAlias view="mine" />} />
			<Route path="/work/projects" element={<AssignmentRouteAlias view="manage" />} />
			<Route path="/work/join" element={<AssignmentRouteAlias view="manage" panel="join" />} />
			<Route path="/assignments" element={<LocationText />} />
		</Routes>
	</MemoryRouter>);

	it.each([
		["/work", "/assignments?view=mine"],
		["/work/projects?project=p1", "/assignments?project=p1&view=manage"],
		["/work/join#code=once", "/assignments?view=manage&panel=join#code=once"],
	])("redirects %s to the one canonical route", async (from, expected) => {
		show(from);
		expect(await screen.findByTestId("location")).toHaveTextContent(expected);
	});
});
