import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import LegalPage from "../routes/LegalPage";
import { CONTACT_URL } from "../helpers/copy";

const renderLegal = (kind: "terms" | "privacy") =>
  render(
    <MemoryRouter>
      <LegalPage kind={kind} />
    </MemoryRouter>,
  );

describe("legal pages", () => {
  it("terms: provisional status line, every section, nonclinical framing, contact route", () => {
    renderLegal("terms");
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByText(/Provisional terms, under review\./)).toBeInTheDocument();
    for (const heading of [
      "Nonclinical use only",
      "Accounts",
      "What you upload",
      "Rights in uploads and annotations",
      "Plans and donations",
      "Acceptable use",
      "Availability and liability",
      "Where the service is operated",
      "Changes to these Terms",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/placeholder|not yet in force|research use only/i);
    expect(text).toMatch(/masks you create are yours to use, including commercially/);
    expect(text).toMatch(/does not operate this site/);
    const link = screen.getByRole("link", { name: "contact page" });
    expect(link).toHaveAttribute("href", CONTACT_URL);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("privacy: provisional status line, every section, truthful analytics wording", () => {
    renderLegal("privacy");
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Notice" })).toBeInTheDocument();
    expect(screen.getByText(/Provisional privacy notice, under review\./)).toBeInTheDocument();
    for (const heading of [
      "What we collect",
      "Protected health information",
      "How we use it",
      "Site analytics, IP addresses and location",
      "Retention and deletion",
      "Sharing",
      "Your rights",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    const text = document.body.textContent ?? "";
    // The two sentences that were untrue today must be gone, replaced by the
    // guarantee + linkability disclosure and an honest retention statement.
    expect(text).not.toMatch(/deleted automatically|never used to identify you personally|placeholder/i);
    expect(text).toMatch(/will not use IP addresses, analytics events, browser identifiers, or derived location/);
    expect(text).toMatch(/so they are not anonymous/);
    expect(text).toMatch(/not yet deleted on a fixed schedule/);
  });

  it("links the documents to each other and the contact form where the text names them", () => {
    renderLegal("terms");
    expect(screen.getAllByRole("link", { name: "Privacy Notice" }).map((a) => a.getAttribute("href")))
      .toEqual(["/privacy", "/privacy"]);
    const contact = screen.getByRole("link", { name: "contact form" });
    expect(contact).toHaveAttribute("href", CONTACT_URL);
    expect(contact).toHaveAttribute("target", "_blank");
    expect(contact).toHaveAttribute("rel", "noopener noreferrer");
    expect(document.body.textContent).not.toMatch(/\[|\]\(/);
  });

  it("privacy: names the Terms as links and keeps short hyphenated words whole", () => {
    renderLegal("privacy");
    expect(screen.getAllByRole("link", { name: "Terms" }).map((a) => a.getAttribute("href")))
      .toEqual(["/terms", "/terms", "/terms"]);
    // Sharing and Your rights both send people to this site's contact page.
    const contact = screen.getAllByRole("link", { name: "contact form" });
    expect(contact).toHaveLength(2);
    for (const link of contact) {
      expect(link).toHaveAttribute("href", "/contact");
      expect(link).toHaveAttribute("target", "_blank");
    }
    expect(document.body.textContent).toMatch(/sent through the contact form, which delivers them through Formspree\./);
    expect(document.body.textContent).not.toMatch(/thebodymaps\.com/);
    const compounds = Array.from(document.querySelectorAll(".legal-compound")).map((el) => el.textContent);
    expect(compounds).toEqual(expect.arrayContaining(["de-identified", "need-to-know"]));
    expect(compounds.every((word) => (word ?? "").length <= 17)).toBe(true);
    expect(document.body.textContent).toMatch(/live room files are designed to expire/i);
  });

  it("ends with the site footer, in the footer wrapper the workspace uses", () => {
    renderLegal("privacy");
    const footer = screen.getByRole("contentinfo");
    expect(footer.parentElement).toHaveClass("design-footer");
    expect(screen.getByRole("link", { name: "BodyMaps" })).toHaveAttribute("href", "/");
  });
});
