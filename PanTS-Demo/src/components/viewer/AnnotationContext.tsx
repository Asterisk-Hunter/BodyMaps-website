import { IconHelpCircle } from "@tabler/icons-react";
import "./AnnotationContext.css";

interface AnnotationContextProps {
	tourOpen: boolean;
	onToggleTour: () => void;
}

/** Keep the annotation ribbon visually quiet while preserving an accessible tour entry point. */
export default function AnnotationContext({ tourOpen, onToggleTour }: AnnotationContextProps) {
	return (
		<aside className="atb-context" aria-label="Annotation help">
			<button type="button" className="atb-context__tour" aria-label="Open annotation tour" title="Annotation help" aria-expanded={tourOpen} onClick={onToggleTour}>
				<IconHelpCircle size={17} aria-hidden="true" />
			</button>
		</aside>
	);
}
