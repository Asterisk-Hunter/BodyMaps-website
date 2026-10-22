import { preload } from "react-dom";
import styles from "./TeamPage.module.css";

import { MEMBERS, ZHOU_PHOTO, type Member } from "./members";

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
