# Automatic report evidence and coverage

This automatic report feature provides measurements from available CT
segmentation masks. It does not assess disease or screen for cancer. Its scope
does not describe the capabilities of other models or features on the website.

## Report contract

Schema version `3` declares `assessment_scope.supported_outputs` as
`["segmentation_measurements"]` and `assessment_scope.disease_assessment` as
`"not_supported"`. Generated `comments` and `impression` are empty. Labels,
legacy flags, and source wording cannot expand these capabilities.

The `source_report` object preserves the complete stored text separately,
including sections outside the segmentation label set. Its purpose is
`unverified_reference`; source and clinician-review status are explicit.
`coverage` and `provenance` describe what was actually available.

The presence of an organ mask, an aggregate attenuation value, or the absence
of an automated warning cannot establish that an organ is healthy. Automatically
measured structures therefore have `status: "not_assessed"`. Similarly, a missing
lesion mask is not evidence that there is no lesion. In particular, a segmented
stomach must not become a "healthy stomach" or "no stomach cancer" conclusion.
The presentation must not infer either positive or negative disease findings
from keywords, whole-organ size, or an omitted finding.

The viewer, shared report, and HTML export lead with supported measurements and
their scope. Complete source text is available only inside a closed,
explicitly labelled "Unverified source reference" section. These stored claims
are not findings of this auto-report feature. The default PDF includes scope
and measurements and excludes source clinical claims entirely. Legacy payloads
receive the same restrictions, including legacy `normal` and `check` flags.
Reference text remains available without masks; unavailable measurements must
be clear.

Measurements use explicitly named, binary structure masks with CT-matching
geometry. Historical combined-label maps have incompatible numeric label
conventions; without verified structure identities they are not used to produce
organ measurements. Combined-only cases therefore retain their source report
but show unavailable measurements.

## What this fixes

- Unsupported counts of normal or healthy organs based on segmentation status.
- Unsupported claims of health or absence of disease, including stomach cancer,
  appearing as generated findings or in the default PDF.
- Source findings disappearing because their anatomy is not a segmentation label.
- Negated source wording being rewritten as a positive diagnosis.
- Report downloads taking a separate path that asks a language model to diagnose
  from aggregate organ measurements.

## What still requires validation

Preserving source text does not correct errors in that text or detect abnormalities
it never mentioned. Pleural, nodal, and other findings require appropriate image
assessment; no diagnostic sensitivity improvement is claimed by this change.
Suspected incorrect source statements must be reviewed against the study by a
qualified reviewer and corrected in the authoritative source with provenance.
Do not insert case-specific diagnoses into application code.

## Verification

Use synthetic reports and tiny generated masks in regression tests. Cover absent
source text, absent masks, findings outside organ labels, negated wording, stale
legacy payloads, HTML escaping, PDF pagination, and image-path canonicalization.
Assert that unsupported source claims remain in the reference data but never
appear as generated conclusions or in the default PDF. Check that opening the
reference preserves the original wording. Do not add patient reports, scans,
credentials or production databases to fixtures or pull requests.

Run `npm test` and `npm run build` in `PanTS-Demo`. In `flask-server`, run
`python -m pytest tests/unit/test_report_evidence.py tests/unit/test_report_measurements.py tests/unit/test_report_measurement_cache.py tests/unit/test_quiz_report_questions.py`.
The backend tests use generated files and isolate report functions from model
services, production data, and database initialization.

The stored source text is read again for every request. Measurement calculations
use native voxel arrays and axis reductions to avoid full floating-point mask
copies and large voxel-coordinate arrays. NIfTI scaling, binary-mask validation,
and CT/mask geometry checks still apply.

Only the small measurement results are cached, for at most eight cases and
120 seconds. Each lookup verifies the CT and named-mask file identities; changes
invalidate the entry. Concurrent requests for one case share a calculation.
Failures and calculations whose inputs change are not cached. The cache contains
no patient metadata or source report text, and callers receive independent copies
of the measurements. Do not restore an indefinite full-report cache.

After an approved release, check the report, its shared view, and both exports.
Confirm that complete source text is available only as a separate reference,
that the PDF excludes it, and that measurements carry no unsupported
normal/healthy conclusion. A deployment check is not a clinical accuracy
evaluation.
