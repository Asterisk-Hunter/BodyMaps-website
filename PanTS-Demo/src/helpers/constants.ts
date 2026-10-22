import type { Color } from "@cornerstonejs/core/types";
import type {
    APP_CONSTANTS_TYPE,
    cornerstoneCustomColorLUTType, MiscColorMapType,
    OrganSystemsType,
    SegmentationCategories,
    SubSystems,
    Systems
} from "../types";

const configuredApiBase = String(import.meta.env.VITE_API_BASE || "").trim();
const hasWindow = typeof window !== "undefined";
const browserHost = hasWindow ? window.location.hostname : "";
const isBrowserLocalhost = browserHost === "localhost" || browserHost === "127.0.0.1";
const apiBaseLooksLocalhost = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(configuredApiBase);

export const API_BASE = configuredApiBase
	? (apiBaseLooksLocalhost && !isBrowserLocalhost ? window.location.origin : configuredApiBase.replace(/\/$/, ""))
	: (hasWindow ? window.location.origin : "");
// export const API_BASE = "http://localhost:5001";

// old
// const x = {
//   1:  [229, 68, 68, 128],
//   2:  [229, 117, 68, 128],
//   3:  [229, 165, 68, 128],
//   5:  [229, 213, 68, 128],
//   6:  [197, 229, 68, 128],
//   7:  [149, 229, 68, 128],
//   8:  [100, 229, 68, 128],
//   11: [68, 229, 84, 128],
//   12: [65, 105, 225, 255], // Kidney (royal blue)
//   13: [30, 144, 255, 255], // Kidney (dodger blue)
//   14: [68, 229, 229, 128],
//   15: [173, 216, 230, 255], // Lung (light blue)
//   16: [135, 206, 235, 255], // Lung (sky blue)
//   17: [68, 84, 229, 128],
//   18: [100, 68, 229, 128],
//   19: [149, 68, 229, 128],
//   20: [197, 68, 229, 128],
//   21: [229, 68, 213, 128],
//   23: [229, 68, 165, 128],
//   25: [229, 68, 117, 128],
//   26: [229, 117, 68, 128],
//   27: [229, 68, 68, 128],
//   28: [229, 213, 68, 128]
//55

export const segmentation_category_colors: { [key: number]: Color } = {
	1: [255, 140, 0, 254], // Dark orange
	2: [255, 165, 0, 254], // Orange
	3: [255, 0, 0, 254], // Artery (red)
	4: [0, 191, 255, 254], // Urinary system (sky blue)
	5: [220, 20, 60, 254], // Artery (crimson red)
	6: [255, 160, 255, 254], // Digestive (salmon)
	7: [34, 139, 34, 254], // Green (bile duct)
	8: [255, 127, 80, 254], // Coral (GI tract)
	9: [245, 245, 245, 254], // Bone (light gray)
	10: [220, 220, 220, 254], // Bone (gray)
	11: [0, 128, 0, 254], // Dark green
	12: [68, 229, 133, 254],
	13: [68, 229, 181, 254],
	14: [178, 34, 34, 254], // Liver (brownish red)
	15: [68, 181, 229, 254],
	16: [68, 133, 229, 254],
	17: [255, 182, 193, 254], // Pancreas (light pink)
	18: [255, 105, 180, 254], // Pancreas (hot pink)
	19: [219, 112, 147, 254], // Pancreas (pale violet red)
	20: [255, 160, 122, 254], // Pancreas general (salmon)
	21: [255, 228, 181, 254], // Light tan (duct)
	22: [240, 10, 10, 254], // Pancreatic lesion (bright red)
	23: [72, 61, 139, 254], // Vein (dark slate blue)
	24: [255, 105, 180, 254], // Magenta/pink
	25: [138, 43, 226, 254], // Purple
	26: [255, 99, 71, 254], // Tomato red
	27: [255, 69, 0, 254], // Bright red-orange artery
	28: [106, 90, 205, 254], // Medium slate blue
	29: [255, 200, 120, 254], // Intestine (warm yellow-orange)
	30: [100, 149, 237, 254], // Renal vein left (cornflower blue)
	31: [70, 130, 180, 254],  // Renal vein right (steel blue)
	32: [192, 192, 192, 254], // CBD stent (silver-gray)
	33: [255, 140, 0, 254],   // Liver lesion (dark orange)
	34: [255, 215, 0, 254],   // Kidney lesion (gold)
	35: [220, 20, 60, 254],   // Colon lesion (crimson)
	// CancerVerse tumor types: each differs from its organ's own color and from the other tumors.
	36: [255, 0, 128, 254],   // Stomach lesion (rose)
	37: [0, 200, 200, 254],   // Adrenal gland lesion (cyan)
	38: [30, 144, 255, 254],  // Bladder lesion (dodger blue)
	39: [255, 20, 147, 254],  // Prostate lesion (deep pink)
	40: [154, 205, 50, 254],  // Esophagus lesion (yellow green)
	41: [186, 85, 211, 254],  // Spleen lesion (orchid)
	42: [199, 21, 133, 254],  // Uterus lesion (medium violet red)
	43: [210, 105, 30, 254],  // Duodenum lesion (chocolate)
	44: [0, 250, 154, 254],   // Gallbladder lesion (spring green)
	// AbdomenAtlas structures. The eight liver segments use the Okabe-Ito palette (distinguishable with color-vision deficiency)
	// and none matches the liver's own red-brown.
	45: [244, 164, 96, 254],  // Esophagus (sandy brown)
	46: [160, 82, 45, 254],   // Rectum (sienna)
	47: [200, 30, 80, 254],   // Celiac AA (raspberry)
	48: [255, 70, 110, 254],  // Celiac trunk (light raspberry)
	49: [30, 60, 200, 254],   // Portal and splenic vein (deep blue)
	50: [0, 191, 191, 254],   // Hepatic vessel (teal)
	51: [230, 159, 0, 254],   // Liver segment 1 (orange)
	52: [86, 180, 233, 254],  // Liver segment 2 (sky blue)
	53: [0, 158, 115, 254],   // Liver segment 3 (bluish green)
	54: [240, 228, 66, 254],  // Liver segment 4 (yellow)
	55: [0, 114, 178, 254],   // Liver segment 5 (blue)
	56: [213, 94, 0, 254],    // Liver segment 6 (vermillion)
	57: [204, 121, 167, 254], // Liver segment 7 (reddish purple)
	58: [120, 94, 240, 254],  // Liver segment 8 (violet)
};

// Rotating palette of colours to hand out to new classes.
// No colour clash with existing organ palette above.
// Kept seperate from segmentation_category_colors, as these are assigned dynamically, not per-organ.
export const NEW_CLASS_PALETTE: Color[] = [
	[255, 99, 132, 255],  // pink
	[54, 162, 235, 255],  // blue
	[255, 206, 86, 255],  // yellow
	[75, 192, 192, 255],  // teal
	[153, 102, 255, 255], // purple
	[255, 159, 64, 255],  // orange
	[46, 204, 113, 255],  // green
	[231, 76, 60, 255],   // red
  ];

export const segmentation_categories: SegmentationCategories[] = [
	"adrenal_gland_left",
	"adrenal_gland_right",
	"aorta",
	"bladder",
	"celiac_artery",
	"colon",
	"common_bile_duct",
	"duodenum",
	"femur_left",
	"femur_right",
	"gall_bladder",
	"kidney_left",
	"kidney_right",
	"liver",
	"lung_left",
	"lung_right",
	"pancreas",
	"pancreas_body",
	"pancreas_head",
	"pancreas_tail",
	"pancreatic_duct",
	"pancreatic_lesion",
	"postcava",
	"prostate",
	"spleen",
	"stomach",
	"superior_mesenteric_artery",
	"veins",
	"intestine",
	"renal_vein_left",
	"renal_vein_right",
	"cbd_stent",
	"liver_lesion",
	"kidney_lesion",
	"colon_lesion",
	// CancerVerse tumor types, ids 36-44 (appended: the ids above never move).
	"stomach_lesion",
	"adrenal_gland_lesion",
	"bladder_lesion",
	"prostate_lesion",
	"esophagus_lesion",
	"spleen_lesion",
	"uterus_lesion",
	"duodenum_lesion",
	"gallbladder_lesion",
	// AbdomenAtlas structures, ids 45-58 (appended: the ids above never move). The first five are in its 2D mask; the last nine
	// sit inside the liver, so the backend keeps them in a second map that only the 3D meshes read.
	"esophagus",
	"rectum",
	"celiac_aa",
	"celiac_trunk",
	"portal_vein_and_splenic_vein",
	"hepatic_vessel",
	"liver_segment_1",
	"liver_segment_2",
	"liver_segment_3",
	"liver_segment_4",
	"liver_segment_5",
	"liver_segment_6",
	"liver_segment_7",
	"liver_segment_8",
];

// CancerVerse annotates tumors in 13 organs and releases tumor masks only, so a CancerVerse case's
// mask holds just these labels (ids = position in segmentation_categories + 1; they match the
// backend's cancerverse_catalog.LESION_LABEL_IDS).
export const CANCERVERSE_TUMOR_KEYS: SegmentationCategories[] = [
	"pancreatic_lesion",
	"liver_lesion",
	"kidney_lesion",
	"colon_lesion",
	"stomach_lesion",
	"adrenal_gland_lesion",
	"bladder_lesion",
	"prostate_lesion",
	"esophagus_lesion",
	"spleen_lesion",
	"uterus_lesion",
	"duodenum_lesion",
	"gallbladder_lesion",
];
export const CANCERVERSE_TUMOR_IDS: ReadonlySet<number> = new Set(
	CANCERVERSE_TUMOR_KEYS.map((key) => segmentation_categories.indexOf(key) + 1),
);

// The structures only AbdomenAtlas has (the last 14 of the list above).
export const ATLAS_ONLY_KEYS: SegmentationCategories[] = segmentation_categories.slice(-14);

// The nine AbdomenAtlas structures inside the liver start hidden: their surfaces coincide with the liver's own, so drawn
// together they flicker over it. They are a toggle away in the Liver group of the organ panel.
export const HIDDEN_BY_DEFAULT_KEYS: SegmentationCategories[] = [
	"hepatic_vessel",
	"liver_segment_1",
	"liver_segment_2",
	"liver_segment_3",
	"liver_segment_4",
	"liver_segment_5",
	"liver_segment_6",
	"liver_segment_7",
	"liver_segment_8",
];
export const HIDDEN_BY_DEFAULT_IDS: ReadonlySet<number> = new Set(
	HIDDEN_BY_DEFAULT_KEYS.map((key) => segmentation_categories.indexOf(key) + 1),
);

// The organ classes of the PanTS catalog: the list above minus the nine tumor types that only
// CancerVerse uses and the fourteen structures that only AbdomenAtlas has. The landing page quotes this number.
export const ORGAN_CLASS_COUNT = segmentation_categories.length - 9 - ATLAS_ONLY_KEYS.length;

export const OrganSystemsArray: Systems[] = [
	"Vascular System",
	"Digestive System",
	"Endocrine System",
	"Urinary System",
	"Skeletal System",
	"Lymphatic System",
	"Reproductive System",
	"Respiratory System"
	// "Adrenal Glands",
	// "Pancreas",
	// "Kidneys",
	// "Femur",
	// "Lung",
	// "Other"
];

export const OrgansSubsystemsArray: SubSystems[] = [
	"Kidneys",
	"Pancreas",
	"Colon",
	"Liver"
]

export const MiscColorMap: MiscColorMapType = {
	"Kidneys": [144, 238, 200],
	"Pancreas": [244, 160, 160],
	"Colon": [238, 130, 238],
	"Liver": [205, 92, 92]
}

export const OrganSystems: OrganSystemsType = {
	"Vascular System": [
		"aorta",
		"celiac_artery",
		"superior_mesenteric_artery",
		"postcava",
		"veins",
		"renal_vein_left",
		"renal_vein_right",
	],
	"Endocrine System": ["adrenal_gland_left", "adrenal_gland_right"],
	"Urinary System": [{ Kidneys: ["kidney_left", "kidney_right", "kidney_lesion"] }, "bladder"],
	// bladder
	"Skeletal System": ["femur_left", "femur_right"],

	"Digestive System": [
		{
			Pancreas: [
				"pancreas",
				"pancreas_body",
				"pancreas_head",
				"pancreas_tail",
				"pancreatic_duct",
				"pancreatic_lesion",
			],
		},
		{ Colon: ["colon", "colon_lesion"] },
		"duodenum",
		"intestine",
		"stomach",
		"liver",
		"liver_lesion",
		"common_bile_duct",
		"gall_bladder",
		"cbd_stent",
	],
	"Respiratory System": ["lung_left", "lung_right"],
	"Reproductive System": ["prostate"],
	"Lymphatic System": ["spleen"],
};

// The organ groups of an AbdomenAtlas case: the PanTS groups plus the structures only it has. The liver becomes a group of its own
// (the liver, its lesion, its hepatic vessels and its eight segments), the way the pancreas is one with its parts; the segments
// and vessels are 3D meshes only, the liver stays whole in the 2D overlay.
export const AtlasOrganSystems: OrganSystemsType = {
	...OrganSystems,
	"Vascular System": [
		...OrganSystems["Vascular System"],
		"celiac_aa",
		"celiac_trunk",
		"portal_vein_and_splenic_vein",
	],
	"Digestive System": [
		...OrganSystems["Digestive System"].filter((organ) => organ !== "liver" && organ !== "liver_lesion"),
		"esophagus",
		"rectum",
		{
			Liver: [
				"liver",
				"liver_lesion",
				"hepatic_vessel",
				"liver_segment_1",
				"liver_segment_2",
				"liver_segment_3",
				"liver_segment_4",
				"liver_segment_5",
				"liver_segment_6",
				"liver_segment_7",
				"liver_segment_8",
			],
		},
	],
};

const RED = [230, 25, 75, 255];
const BLUE = [0, 130, 200, 255];
const MAROON = [128, 0, 0, 255];
const BROWN = [170, 110, 40, 255];
const OLIVE = [128, 128, 0, 255];
//const OLIVE = [0, 0, 0, 0];
const TEAL = [0, 128, 128, 255];
const PURPLE = [145, 30, 180, 255];
const MAGENTA = [240, 50, 230, 255];
const LIME = [50, 205, 50, 255];

const cornerstoneCustomColorLUT: cornerstoneCustomColorLUTType = {
	0: [0, 0, 0, 0], // transparent for background
	1: RED,
	2: BLUE,
	3: MAROON,
	4: BROWN,
	5: OLIVE,
	6: TEAL,
	7: PURPLE,
	8: MAGENTA,
	9: LIME,
	// Add more mappings as needed
};
const NVCmapAlpha = 128;

function createNVColorMapFromCornerstoneLUT() {
	const R: number[] = [];
	const G: number[] = [];
	const B: number[] = [];
	const A: number[] = [];
	const I: number[] = [];
	Object.keys(cornerstoneCustomColorLUT).forEach((intensity) => {
		I.push(Number(intensity));
		const RGBA = cornerstoneCustomColorLUT[Number(intensity)];
		R.push(RGBA[0]);
		G.push(RGBA[1]);
		B.push(RGBA[2]);
		if (intensity === "0") {
			A.push(0);
		} else {
			A.push(NVCmapAlpha);
		}
	});

	const cmap = {
		R: R,
		G: G,
		B: B,
		A: A,
		I: I,
	};
	return cmap;
}

export const APP_CONSTANTS: APP_CONSTANTS_TYPE = {
	DEFAULT_SEGMENTATION_OPACITY: 0.6,
	API_ORIGIN: API_BASE,
	cornerstoneCustomColorLUT: cornerstoneCustomColorLUT,
	NVCmapAlpha: NVCmapAlpha,
	NVColormap: createNVColorMapFromCornerstoneLUT(),
};

export const ITEMS_PER_DATA_PAGE = 100;
