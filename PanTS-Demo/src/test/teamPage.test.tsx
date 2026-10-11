import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import TeamPage from "../routes/TeamPage";

describe("team page", () => {
  it("links the two verified profiles and leaves the other cards unlinked", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const zhou = screen.getByRole("link", { name: "Zongwei Zhou, PhD on LinkedIn" });
    expect(zhou).toHaveAttribute("href", "https://www.linkedin.com/in/zongwei-zhou");
    expect(zhou).toHaveAttribute("target", "_blank");
    expect(zhou).toHaveAttribute("rel", "noopener noreferrer");
    const li = screen.getByRole("link", { name: "Wenxuan Li on LinkedIn" });
    expect(li).toHaveAttribute("href", "https://www.linkedin.com/in/wenxuan-li-chelsea");
    // Exactly two profile links; the other four members have none yet.
    expect(screen.getAllByRole("link", { name: /on LinkedIn$/ })).toHaveLength(2);
    expect(screen.getByText("Alan L. Yuille, PhD")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Yuille/ })).not.toBeInTheDocument();
  });

  it("lists the original members first and unchanged, then the new Core Contributors in the given order", () => {
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const existing = [
      ["Zongwei Zhou, PhD", "Principal Investigator"],
      ["Alan L. Yuille, PhD", "Scientific Advisor"],
      ["Wenxuan Li", "PhD Student"],
      ["Pedro RAS Bassi", "PhD Student"],
      ["Jaeden Pangaribuan", "Core Contributor"],
      ["Lucy Wu", "Core Contributor"],
    ];
    const added = [
      "Aditya Sanjeev",
      "Yusuf Abdulkadir",
      "Alexander Poon",
      "Ahmad Rehman",
      "Ishita Ahelleya",
      "Harleen Sachdev",
    ];
    const cards = Array.from(container.querySelectorAll("[class*=card]")).map((c) => c.textContent ?? "");
    expect(cards).toHaveLength(existing.length + added.length);
    existing.forEach(([name, role], i) => {
      expect(cards[i]).toContain(name);
      expect(cards[i]).toContain(role);
    });
    added.forEach((name, i) => {
      expect(cards[existing.length + i]).toContain(name);
      expect(cards[existing.length + i]).toContain("Core Contributor");
      // No photo and no verified profile yet: the placeholder silhouette and no link.
      expect(screen.queryByAltText(name)).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: new RegExp(name) })).not.toBeInTheDocument();
    });
  });
});
