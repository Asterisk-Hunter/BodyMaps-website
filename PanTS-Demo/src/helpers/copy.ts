/**
 * Canonical site copy shared across surfaces. Change strings here, not inline:
 * src/test/copy.test.ts guards them so an upstream merge cannot silently revert
 * the wording (that happened once to the brand pass).
 */

/** Persistent nonclinical boundary. Same sentence everywhere it appears. */
export const NONCLINICAL_WARNING =
  "For nonclinical use only. Not medical advice or for patient care.";

/** Landing hero subtitle, directly under the wordmark. */
export const LANDING_SUBTITLE = "The intelligence layer for medical imaging AI";

/** One-paragraph orientation for a first-time visitor, under the stats row. */
export const LANDING_OVERVIEW =
  "Browse the library in 2D and 3D, upload your own CT for AI segmentation, and annotate or refine the results.";

/** Browser-tab / link-preview title (index.html <title>, og:title, twitter:title). */
export const SITE_TITLE = "BodyMaps: CT library, segmentation, and annotation";

/** Meta / og / twitter description. */
export const SITE_DESCRIPTION =
  "Browse body CT scans in 2D and 3D, upload CT for AI segmentation, and annotate results. For nonclinical use only.";


/** Footer, right column: inquiry routing. The link text follows this lead. */
export const FOOTER_INQUIRY_LEAD =
  "For private licensing and other inquiries, contact BodyMaps, Inc. through";

/** The one contact route: this site's contact page (routes/ContactPage). Its
 *  form sends inquiries to BodyMaps, Inc. */
export const CONTACT_URL = "/contact";
export const CONTACT_LINK_TEXT = "our contact form";

/** BodyMaps, Inc.'s Formspree form, the one thebodymaps.com/contact posts to,
 *  so inquiries from this site reach the same inbox and are routed the same
 *  way. */
export const CONTACT_FORM_ENDPOINT = "https://formspree.io/f/xlgvgorj";

/** Auth modal fine print, shown on sign-in and sign-up (links follow). */
export const AUTH_FINEPRINT_LEAD = "By continuing, you agree to the";
export const AUTH_FINEPRINT_MID = "and acknowledge the";

/** Header nav entry that opens the contact route in a new tab. */
export const NAV_CONTACT_LABEL = "CONTACT";
