import type { Color } from "@cornerstonejs/core/types";
import { IconArrowLeft, IconCheck, IconChevronRight, IconCurrentLocation } from "@tabler/icons-react";
import React, { useState } from "react";
import {
	MiscColorMap, OrganSystems,
	OrganSystemsArray,
	segmentation_categories
} from "../helpers/constants";
import { deepIsEqual } from "../helpers/utils";
import {
	type AllSystems,
	type OrganSystemsAllType,
	type SubSystems,
	type CheckBoxData
} from "../types";

type ChipBoxProps = {
	labelColorMap: { [key: number]: number[] };
	system: AllSystems;
	setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
	checkState: boolean[];
	level: number;
	OrganSystem: OrganSystemsAllType;
	onJumpToOrgan?: (label: number) => void;
};

type Props = {
	labelColorMap: { [key: number]: Color };
	setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
	checkState: boolean[];
	sessionId: string | undefined;
	setShowOrganDetails: React.Dispatch<React.SetStateAction<boolean>>;
	showOrganDetails: boolean;
	onJumpToOrgan?: (label: number) => void;
	customOrgans?: CheckBoxData[];
	// The groups to list and what is in them. Defaults to the PanTS organ systems; a CancerVerse case
	// passes its single "Tumors" group (its masks hold tumors only, and only the types the scan has).
	systemList?: AllSystems[];
	systemMap?: OrganSystemsAllType;
	title?: string;
	// Shown instead of the groups when none of them has anything to toggle.
	emptyNote?: string;
};

const getOrganIdx = (organ: string) => {
	return segmentation_categories.indexOf(organ as never);
};

export function systemOrganSlots(system: OrganSystemsAllType, key: AllSystems): number[] {
	const members = system[key] ?? [];
	return members.flatMap((member) => {
		if (typeof member === "string") {
			const index = getOrganIdx(member);
			return index >= 0 ? [index + 1] : [];
		}
		const childKey = Object.keys(member)[0] as AllSystems | undefined;
		return childKey ? systemOrganSlots(member, childKey) : [];
	});
}

export function groupCheckState(slots: number[], checkState: boolean[]): boolean | "mixed" {
	const selected = slots.filter((slot) => checkState[slot]).length;
	return selected === 0 ? false : selected === slots.length ? true : "mixed";
}

function Checked({
	OrganSystem,
	system,
	labelColorMap,
	checkState,
	setCheckState,
	level = 0,
	onJumpToOrgan,
}: ChipBoxProps) {
	const [collapsed, setCollapsed] = useState(false);
	const groupState = groupCheckState(systemOrganSlots(OrganSystem, system), checkState);
	const partialToggled = groupState === true;
	const updateToggle = (toggled: boolean) => {
		if (!OrganSystem[system]) return;
		const slots = systemOrganSlots(OrganSystem, system);
		setCheckState((previous) => {
			const next = [...previous];
			slots.forEach((slot) => { next[slot] = toggled; });
			return deepIsEqual(next, previous) ? previous : next;
		});
	};
  let color = null;
  if (system in MiscColorMap) {
    color = MiscColorMap[system as SubSystems];
    color = `rgb(${color[0]}, ${color[1]}, ${color[2]})`
  }

	if (!OrganSystem[system] || level > 1) return null;
	return (
		<div className={`flex gap-2 flex-col ${level === 0 ? "" : "pl-8"}`}>
			<div className="flex justify-between items-center">
				{!color ? (
					<>
						<button
							type="button"
							className="flex items-center gap-2 cursor-pointer"
							aria-label={level === 0 ? system : `${system} organs`}
							aria-expanded={collapsed}
							aria-controls={`organ-group-${system.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
							onClick={() => setCollapsed((prev) => !prev)}
						>
							<IconChevronRight
								className={`vp-organs__chevron ${
									collapsed ? "is-open" : ""
								}`}
							/>
							<span className="text-white text-lg">
								{system}
							</span>
						</button>
						<button
							type="button"
							role="checkbox"
							aria-checked={groupState}
							aria-label={`Toggle ${system}`}
							className={`vp-checkbox ${partialToggled ? "vp-checkbox--on" : ""}`}
							onClick={() => updateToggle(!partialToggled)}
						>
							{partialToggled && <IconCheck size={13} stroke={3} />}
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							className="flex items-center gap-1 mb-1 cursor-pointer"
							aria-label={level === 0 ? system : `${system} organs`}
							aria-expanded={collapsed}
							aria-controls={`organ-group-${system.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
							onClick={() => setCollapsed((prev) => !prev)}
						>
							<IconChevronRight
								className={`vp-organs__chevron ${
									collapsed ? "is-open" : ""
								}`}
							/>
							<span
								className={`vp-organ-chip text-white text-md rounded-md p-1 cursor-pointer ${
										partialToggled ? "is-on" : ""
                }`}
                style={{ "--chip-color": color } as React.CSSProperties}
							>
								{system}
							</span>
						</button>
						<button type="button" role="checkbox" aria-checked={groupState} aria-label={system} className={`vp-checkbox ${partialToggled ? "vp-checkbox--on" : ""}`} onClick={() => updateToggle(!partialToggled)}>{partialToggled && <IconCheck size={13} stroke={3} />}</button>
					</>
				)}
			</div>
			<div
				hidden={!collapsed}
				className={`flex flex-col gap-2 transition-all duration-100 origin-top ${
					!collapsed ? "hidden scale-y-0" : "scale-y-100"
				}`}
				id={`organ-group-${system.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			>
				{OrganSystem[system].map((organ, idx) => {
					if (typeof organ === "string") {
						const color = labelColorMap[getOrganIdx(organ) + 1];
						const rgb = color
							? `rgb(${color[0]}, ${color[1]}, ${color[2]})`
							: "gray";
						return (
							<div className={`vp-organs__row flex items-center gap-2 ${level == 0 ? "pl-8" : "pl-5"} `} key={idx}>
								<span aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0 }} />
								<button
									type="button"
									role="checkbox"
									aria-checked={!!checkState[getOrganIdx(organ) + 1]}
									aria-label={organ.replaceAll('_', ' ')}
									className={`vp-organ-chip text-white text-md rounded-md p-1 cursor-pointer ${
										checkState[getOrganIdx(organ) + 1] ? "is-on" : ""
									}`}
									style={{ "--chip-color": rgb } as React.CSSProperties}
									onClick={() => {
										setCheckState((prev) => {
											const newCheckState = [...prev];
											newCheckState[getOrganIdx(organ) + 1] =
												!newCheckState[getOrganIdx(organ) + 1];
											return newCheckState;
										});
									}}
								>
									{organ.replaceAll('_', ' ')}
								</button>
								{onJumpToOrgan && (
									<button
										type="button"
										className="vp-organs__jump"
										title={`Jump to ${organ.replaceAll('_', ' ')}`}
										aria-label={`Jump to ${organ.replaceAll('_', ' ')}`}
										onClick={(e) => {
											e.stopPropagation();
											onJumpToOrgan(getOrganIdx(organ) + 1);
										}}
									>
										<IconCurrentLocation size={15} />
									</button>
								)}
							</div>
						);
					} else if (
						typeof organ === "object" &&
						Object.keys(organ).length === 1
					) {
						const organKey: AllSystems = Object.keys(organ)[0] as AllSystems;
						return (
							<Checked
								key={organKey}
								OrganSystem={organ}
								system={organKey}
								labelColorMap={labelColorMap}
								checkState={checkState}
								setCheckState={setCheckState}
								level={level + 1}
								onJumpToOrgan={onJumpToOrgan}
							/>
						);
					}
				})}
			</div>
		</div>
	);
}

function OrganCheckbox({
	setCheckState,
	checkState,
	labelColorMap,
	setShowOrganDetails,
	showOrganDetails,
	onJumpToOrgan,
	customOrgans = [],
	systemList = OrganSystemsArray,
	systemMap = OrganSystems,
	title = "Organs",
	emptyNote,
}: Props) {
	const toggleAll = () => {
		setCheckState((prev) => {
			let newState = [...prev];
			const trueCount = newState.filter((val) => val === true).length;
			if (trueCount > newState.length / 2) {
				newState = newState.map(() => false);
			} else {
				newState = newState.map(() => true);
			}
			return newState;
		});
	};

	// Docked in the viewer's body row (left of the stage), not a fixed overlay.
	// Kept mounted with display toggled so the expand/collapse state survives.
	return (
		<div
			role="region"
			aria-label={title}
			className={`vp-organs flex-col gap-4 w-72 px-4 pb-4 pt-4 ${
				showOrganDetails ? "vp-organs--open" : ""
			}`}
		>
			<div className="flex justify-between items-center w-full">

			<div className="flex gap-2 items-center justify-start">
				<button type="button" className="vp-organs__back" aria-label={`Close ${title.toLowerCase()} panel`} onClick={() => setShowOrganDetails(false)}>
					<IconArrowLeft aria-hidden="true" />
				</button>
			<div className="vp-organs__title">{title}</div>
			</div>
			<button className="vp-btn" onClick={() => toggleAll()}>
				Toggle all
			</button></div>
			<div className="vp-organs__list flex flex-col gap-1 overflow-y-auto">
				{emptyNote && systemList.every((system) => (systemMap[system] ?? []).length === 0) && (
					<div className="text-white text-md opacity-70">{emptyNote}</div>
				)}
				{systemList.map((system: AllSystems, idx) => {
					if (emptyNote && (systemMap[system] ?? []).length === 0) return null;
					return (
						<Checked
							level={0}
							OrganSystem={systemMap}
							key={idx}
							system={system}
							labelColorMap={labelColorMap}
							checkState={checkState}
							setCheckState={setCheckState}
							onJumpToOrgan={onJumpToOrgan}
						/>
					);
				})}
			</div>
			{customOrgans.length > 0 && (
				<div className="flex gap-2 flex-col">
					<div className="text-white text-lg">Custom Classes</div>
					<div className="flex flex-col gap-2">
						{customOrgans.map((organ) => {
							const color = labelColorMap[organ.id];
							const rgb = color
								? `rgb(${color[0]}, ${color[1]}, ${color[2]})`
								: "gray";
							return (
								<div className="flex items-center gap-2 pl-8" key={organ.id}>
									<span aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0 }} />
									<div
										className={`vp-organ-chip text-white text-md rounded-md p-1 cursor-pointer ${
											checkState[organ.id] ? "is-on" : ""
										}`}
										style={{ "--chip-color": rgb } as React.CSSProperties}
										onClick={() => {
											setCheckState((prev) => {
												const newCheckState = [...prev];
												newCheckState[organ.id] = !newCheckState[organ.id];
												return newCheckState;
											});
										}}
									>
										{organ.label}
									</div>
									{onJumpToOrgan && (
										<button
											type="button"
											className="vp-organs__jump"
											title={`Jump to ${organ.label}`}
											aria-label={`Jump to ${organ.label}`}
											onClick={(e) => {
												e.stopPropagation();
												onJumpToOrgan(organ.id);
											}}
										>
											<IconCurrentLocation size={15} />
										</button>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
			<div className="w-full"></div>
		</div>
	);
}
export default OrganCheckbox;
