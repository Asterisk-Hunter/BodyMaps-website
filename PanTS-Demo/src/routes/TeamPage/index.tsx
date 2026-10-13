import { preload } from "react-dom";
import styles from "./TeamPage.module.css";

type Member = {
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
const ZHOU_PHOTO = "/headshots/zongwei-zhou.webp";

// .webp images are used for better compression and faster loading times. Also, be sure to use small image sizes.
const MEMBERS: Member[] = [
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

function Avatar({
  photo,
  name,
  priority,
  portrait,
}: {
  photo?: string;
  name: string;
  priority?: boolean;
  portrait?: boolean;
}) {
  return (
    <div className={styles.avatarRing}>
      <div className={styles.avatarInner}>
        {photo ? (
          <img
            src={photo}
            alt={name}
            width={176}
            height={176}
            className={`${styles.avatarImg}${portrait ? ` ${styles.avatarPortrait}` : ""}`}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            decoding="async"
          />
        ) : (
          <svg
            width="68%"
            height="68%"
            viewBox="0 0 24 24"
            fill="#b3b3b3"
            aria-hidden="true"
          >
            <circle cx="12" cy="9" r="4.2" />
            <path d="M4.5 21c0-3.7 3.4-6.2 7.5-6.2s7.5 2.5 7.5 6.2z" />
          </svg>
        )}
      </div>
    </div>
  );
}

function MemberCard({
  member,
  priority,
}: {
  member: Member;
  priority?: boolean;
}) {
  return (
    <div className={styles.card}>
      <Avatar photo={member.photo} name={member.name} priority={priority} portrait={member.portrait} />
      <div>
        <div className={styles.memberName}>{member.name}</div>
        <div className={styles.memberRole}>{member.role}</div>
        {member.links?.linkedin && (
          <a
            className={styles.memberLink}
            href={member.links.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${member.name} on LinkedIn`}
          >
            LinkedIn
          </a>
        )}
      </div>
    </div>
  );
}

export default function TeamPage() {
  preload(ZHOU_PHOTO, { as: "image", fetchPriority: "high" });
  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="team-title">
        <h1 className={styles.title} id="team-title">
          Meet the <span className={styles.titleBold}>team.</span>
        </h1>
        <div className={styles.grid}>
          {MEMBERS.map((m, i) => (
            <MemberCard key={m.name} member={m} priority={i === 0} />
          ))}
        </div>
      </section>
    </div>
  );
}
