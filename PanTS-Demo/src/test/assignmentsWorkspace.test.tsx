import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const mockAuth = vi.hoisted(() => ({ user: null as null | { id: string; name: string; roles: string[] } }));
vi.mock("../contexts/authContext", () => ({
	useAuthIfPresent: () => (mockAuth.user ? { user: mockAuth.user, isAuthenticated: true } : null),
}));

describe("single assignment workspace", () => {
	beforeEach(() => {
		mockAuth.user = null;
	});

	it("shows directly only Assigned to me without section tabs for normal users", () => {
		mockAuth.user = { id: "u2", name: "Normal User", roles: ["annotator"] };
		render(<MemoryRouter initialEntries={["/assignment?view=manage"]}><AssignmentsPage /></MemoryRouter>);
		expect(screen.queryByRole("button", { name: "Assigned to me" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "All Projects" })).not.toBeInTheDocument();
		expect(screen.queryByTestId("project-management")).not.toBeInTheDocument();
		expect(screen.getByTestId("project-work")).toBeInTheDocument();
	});

	it("shows project work under Assigned to me", () => {
		mockAuth.user = { id: "m1", name: "Manager", roles: ["annotation_manager"] };
		render(<MemoryRouter initialEntries={["/assignment"]}><AssignmentsPage /></MemoryRouter>);
		expect(screen.getByRole("button", { name: "Assigned to me" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("project-work")).toBeInTheDocument();
		expect(screen.queryByTestId("range-work")).not.toBeInTheDocument();
	});

	it("keeps All Projects focused on project setup and review", () => {
		mockAuth.user = { id: "m1", name: "Manager", roles: ["annotation_manager"] };
		render(<MemoryRouter initialEntries={["/assignment?view=manage"]}><AssignmentsPage /></MemoryRouter>);
		expect(screen.getByTestId("project-management")).toBeInTheDocument();
		expect(screen.queryByTestId("range-management")).not.toBeInTheDocument();
		expect(screen.queryByText("Direct handouts")).not.toBeInTheDocument();
	});

	it("opens and returns from the join panel without leaving the route", () => {
		mockAuth.user = { id: "m1", name: "Manager", roles: ["annotation_manager"] };
		render(<MemoryRouter initialEntries={["/assignment?view=manage"]}><AssignmentsPage /><LocationText /></MemoryRouter>);
		fireEvent.click(screen.getByRole("button", { name: "Join a team" }));
		expect(screen.getByTestId("join-team")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back to projects" }));
		expect(screen.getByTestId("project-management")).toBeInTheDocument();
		expect(screen.getByTestId("location")).toHaveTextContent("/assignment?view=manage");
	});
});

describe("legacy assignment routes", () => {
	const show = (path: string) => render(<MemoryRouter initialEntries={[path]}>
		<Routes>
			<Route path="/work" element={<AssignmentRouteAlias view="mine" />} />
			<Route path="/work/projects" element={<AssignmentRouteAlias view="manage" />} />
			<Route path="/work/join" element={<AssignmentRouteAlias view="manage" panel="join" />} />
			<Route path="/assignment" element={<LocationText />} />
		</Routes>
	</MemoryRouter>);

	it.each([
		["/work", "/assignment?view=mine"],
		["/work/projects?project=p1", "/assignment?project=p1&view=manage"],
		["/work/join#code=once", "/assignment?view=manage&panel=join#code=once"],
	])("redirects %s to the one canonical route", async (from, expected) => {
		show(from);
		expect(await screen.findByTestId("location")).toHaveTextContent(expected);
	});
});
