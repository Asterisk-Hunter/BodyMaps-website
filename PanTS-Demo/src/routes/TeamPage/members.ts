// The team list, shared by the Team page and the static summary in index.html (src/seo/staticSummary.ts).
// .webp images are used for better compression and faster loading times. Also, be sure to use small image sizes.

export type Member = {
  name: string;
  role: string;
  photo?: string;
  portrait?: boolean;
  /** Verified public profiles only; a card with none stays unlinked. */
  links?: { linkedin?: string };
};

// preload only the first member's photo to ensure it loads quickly, improving performance.
// Called during render, not at module scope: the team page is in the main
// bundle, so a module-scope hint fired on every page and logged an
// unused-preload warning everywhere else.
export const ZHOU_PHOTO = "/headshots/zongwei-zhou.webp";

export const MEMBERS: Member[] = [
  {
    name: "Zongwei Zhou, PhD",
    role: "Principal Investigator",
    photo: ZHOU_PHOTO,
    links: { linkedin: "https://www.linkedin.com/in/zongwei-zhou" },
  },
  {
    name: "Alan L. Yuille, PhD",
    role: "Scientific Advisor",
    photo: "/headshots/alan-yuille.webp",
  },
  {
    name: "Wenxuan Li",
    role: "PhD Student",
    photo: "/headshots/wenxuan-li.webp",
    links: { linkedin: "https://www.linkedin.com/in/wenxuan-li-chelsea" },
  },
  {
    name: "Pedro RAS Bassi",
    role: "PhD Student",
    photo: "/headshots/pedro-bassi.webp",
  },
  {
    name: "Jaeden Pangaribuan",
    role: "Core Contributor",
    photo: "/headshots/jaeden-pangaribuan.webp"
  },
  {
    name: "Lucy Wu",
    role: "Core Contributor",
    photo: "/headshots/lucy-wu.webp",
  },
  { name: "Aditya Sanjeev", role: "Core Contributor" },
  {
    name: "Alexander Poon",
    role: "Core Contributor",
    photo: "/headshots/alexander-poon.webp",
    links: { linkedin: "https://www.linkedin.com/in/alexander-poon-88640b281/" },
  },
  {
    name: "Ahmad Durre Rehman",
    role: "Core Contributor",
    photo: "/headshots/ahmad-durre-rehman.jpg?v=20261013",
    portrait: true,
    links: { linkedin: "https://linkedin.com/in/ahmad-durre-rehman-121577382" },
  },
  { name: "Yusuf Abdulkadir", role: "Core Contributor" },
  { name: "Ishita Ahelleya", role: "Core Contributor" },
  { name: "Harleen Sachdev", role: "Core Contributor" },
];
