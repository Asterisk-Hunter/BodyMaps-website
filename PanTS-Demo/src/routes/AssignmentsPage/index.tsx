import { useSearchParams } from "react-router-dom";
import home from "../Homepage/Homepage.module.css";
import AnnotationWork from "../AnnotationWork";
import DirectRangeAssignments from "./DirectRangeAssignments";
import AnnotationProjects from "../Settings/AnnotationProjects";
import TeamAccessSettings from "../Settings/TeamAccessSettings";
import "./AssignmentsPage.css";

type WorkspaceView = "mine" | "manage";

/** The single entry point for personal work, projects, and direct range handouts. */
export default function AssignmentsPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const view: WorkspaceView = searchParams.get("view") === "manage" ? "manage" : "mine";
	const joining = view === "manage" && searchParams.get("panel") === "join";

	const setWorkspace = (nextView: WorkspaceView, panel?: "join") => {
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			next.set("view", nextView);
			if (panel) next.set("panel", panel);
			else next.delete("panel");
			return next;
		});
	};

	return (
		<div className={home.page}>
			<main className={home.main} aria-labelledby="assignments-title" data-testid="assignments-page">
				<header className={home.heading}>
					<span className={home.eyebrow}>ANNOTATION WORKSPACE</span>
					<h1 id="assignments-title">Assignments</h1>
					<p>Find assigned cases or set up and manage an annotation project.</p>
				</header>

				<nav className="asg-views" role="group" aria-label="Assignments workspace">
					<button
						type="button"
						className={`asg-pill ${view === "mine" ? "asg-pill--on" : ""}`}
						aria-pressed={view === "mine"}
						onClick={() => setWorkspace("mine")}
					>
						My work
					</button>
					<button
						type="button"
						className={`asg-pill ${view === "manage" ? "asg-pill--on" : ""}`}
						aria-pressed={view === "manage"}
						onClick={() => setWorkspace("manage")}
					>
						Manage
					</button>
				</nav>

				{view === "mine" && (
					<div className="asg-mine-container">
						<AnnotationWork embedded />
						<DirectRangeAssignments />
					</div>
				)}

				{view === "manage" && (joining ? (
					<TeamAccessSettings embedded onBack={() => setWorkspace("manage")} />
				) : (
					<div className="assignment-workspace__sections">
						<AnnotationProjects onJoin={() => setWorkspace("manage", "join")} />
					</div>
				))}
			</main>
		</div>
	);
}
