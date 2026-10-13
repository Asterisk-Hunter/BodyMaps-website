import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import TeamPage from "../routes/TeamPage";

describe("team page", () => {
  it("links the three supplied profiles and leaves the other cards unlinked", () => {
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
    const ahmad = screen.getByRole("link", { name: "Ahmad Durre Rehman on LinkedIn" });
    expect(ahmad).toHaveAttribute("href", "https://linkedin.com/in/ahmad-durre-rehman-121577382");
    expect(ahmad).toHaveAttribute("target", "_blank");
    expect(ahmad).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByRole("link", { name: /on LinkedIn$/ })).toHaveLength(3);
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
      "Alexander Poon",
      "Ahmad Durre Rehman",
      "Yusuf Abdulkadir",
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
      // Keep the placeholder silhouettes; only Ahmad supplied a profile link.
      expect(screen.queryByAltText(name)).not.toBeInTheDocument();
      if (name !== "Ahmad Durre Rehman") {
        expect(screen.queryByRole("link", { name: new RegExp(name) })).not.toBeInTheDocument();
      }
    });
  });
});
