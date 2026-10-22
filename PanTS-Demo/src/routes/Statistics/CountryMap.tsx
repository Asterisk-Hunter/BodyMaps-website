import { geoNaturalEarth1, geoPath } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { alpha2ForFeatureId } from "../Settings/analytics/isoCountries";
import type { StatRow } from "./statsApi";
import { JHU, count } from "./statsFormat";
import styles from "./Statistics.module.css";

// Scans per site country as a choropleth, drawn as plain SVG from d3-geo (no map library, no tiles:
// nothing leaves the server). The outline is fetched on demand, like the admin analytics map does, so
// the ~100 KB of JSON stays out of the chunk every visitor downloads.
//
// A sequential ramp of the brand blue, cut on the square root of the maximum: counts are long-tailed
// (the United States has several times any other country), and linear cuts would leave every other
// country in the palest band.

const WIDTH = 900;
const HEIGHT = Math.round(WIDTH * 0.49);
const RAMP = [0.16, 0.34, 0.54, 0.76, 1].map((alpha) => hexAlpha(JHU.heritage, alpha));
const NO_DATA = "rgba(15, 23, 42, 0.05)";

function hexAlpha(hex: string, alpha: number): string {
	const n = parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const bandFor = (value: number, max: number): number => {
	if (value <= 0 || max <= 0) return -1;
	return Math.min(RAMP.length - 1, Math.floor((Math.sqrt(value) / Math.sqrt(max)) * RAMP.length));
};

type Props = {
	rows: StatRow[];
	/** Country codes currently filtered on. */
	selected: string[];
	onSelect: (code: string) => void;
};

type Hover = { name: string; value: number; x: number; y: number; width: number };

const CountryMap: React.FC<Props> = ({ rows, selected, onSelect }) => {
	const [land, setLand] = useState<FeatureCollection<Geometry> | null>(null);
	const [failed, setFailed] = useState(false);
	const [hover, setHover] = useState<Hover | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		import("world-atlas/countries-110m.json")
			.then((mod) => {
				if (!live) return;
				// Through `unknown`: TypeScript infers the JSON's literal shape, which is not quite the
				// Topology type, though the file is topojson's own published atlas.
				const topology = (mod.default ?? mod) as unknown as Topology;
				setLand(feature(topology, topology.objects.countries) as FeatureCollection<Geometry>);
			})
			.catch(() => live && setFailed(true));
		return () => {
			live = false;
		};
	}, []);

	const byCode = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
	const max = useMemo(() => rows.reduce((m, row) => Math.max(m, row.count), 0), [rows]);
	const path = useMemo(() => geoPath(geoNaturalEarth1().fitSize([WIDTH, HEIGHT], { type: "Sphere" })), []);

	if (failed) return <p className={styles.empty}>The map outline could not be loaded; the list beside it has the same numbers.</p>;
	if (!land) return <p className={styles.empty}>Loading the map…</p>;

	const enter = (event: React.MouseEvent, row: StatRow) => {
		const box = wrapRef.current?.getBoundingClientRect();
		setHover({
			name: row.label,
			value: row.count,
			x: event.clientX - (box?.left ?? 0),
			y: event.clientY - (box?.top ?? 0),
			width: box?.width ?? 0,
		});
	};

	return (
		<div className={styles.map} ref={wrapRef}>
			<svg
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				className={styles.mapSvg}
				role="img"
				aria-label="Scans by site country. The same figures are listed beside the map."
			>
				{(land.features as Feature<Geometry>[]).map((shape, index) => {
					const code = alpha2ForFeatureId(shape.id as string | number | undefined);
					const row = code ? byCode.get(code) : undefined;
					const band = row ? bandFor(row.count, max) : -1;
					const d = path(shape) || undefined;
					if (!d) return null;
					const on = !!code && selected.includes(code);
					return (
						<path
							key={shape.id != null ? String(shape.id) : `shape-${index}`}
							d={d}
							className={`${styles.mapCountry} ${row ? styles.mapCountryLive : ""} ${on ? styles.mapCountryOn : ""}`}
							fill={band >= 0 ? RAMP[band] : NO_DATA}
							onMouseMove={row ? (event) => enter(event, row) : undefined}
							onMouseLeave={row ? () => setHover(null) : undefined}
							onClick={row && code ? () => onSelect(code) : undefined}
						/>
					);
				})}
			</svg>
			{hover && (
				<div
					className={`${styles.mapTip} ${hover.x > hover.width / 2 ? styles.mapTipLeft : ""}`}
					style={{ left: hover.x, top: hover.y }}
					aria-hidden="true"
				>
					<strong>{hover.name}</strong>
					<br />
					{count(hover.value)} {hover.value === 1 ? "scan" : "scans"}
				</div>
			)}
			<div className={styles.mapKey} aria-hidden="true">
				<span>Fewer</span>
				{RAMP.map((fill) => (
					<span key={fill} className={styles.mapKeyStep} style={{ background: fill }} />
				))}
				<span>More</span>
			</div>
		</div>
	);
};

export default CountryMap;
