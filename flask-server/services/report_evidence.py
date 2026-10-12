"""Lossless report evidence and non-diagnostic segmentation presentation.

No text classification or clinical inference belongs here. A stored AI report
is evidence of what that source says, not a fresh interpretation of the scan.
"""
from __future__ import annotations

import html
import math
import re

REPORT_SCHEMA_VERSION = "3"
REPORT_SOURCE = "RadGPT metadata workbook"
ASSESSMENT_SCOPE_EXPLANATION = (
    "This auto-report feature provides segmentation measurements only. "
    "It does not provide a validated disease assessment or screen for cancer. "
    "Measurements cannot establish health or exclude disease in the stomach or any other organ."
)
REPORT_LIMITATIONS = (
    "This is a limited automated summary, not a complete review of the CT study.",
    "Segmentation measurements do not establish normality or diagnose disease. "
    "Unmentioned or unsegmented structures are not assessed.",
    "The stored AI report has not been verified by a clinician in BodyMaps. "
    "It may contain errors or omit findings; review the full study with a radiologist.",
)


def report_assessment_scope():
    """Capabilities belong to this feature, never to labels or source wording.

    A fresh object also prevents callers from expanding shared capabilities by
    mutating a payload. Legacy payloads use the same conservative scope.
    """
    return {
        "supported_outputs": ["segmentation_measurements"],
        "disease_assessment": "not_supported",
        "explanation": ASSESSMENT_SCOPE_EXPLANATION,
    }


def normalize_report_text(raw):
    return str(raw or "").replace("_x000D_", "\n").replace("\r\n", "\n").replace("\r", "\n").strip()


def source_report(raw):
    """Retain every source line even when optional section parsing fails."""
    text = normalize_report_text(raw)
    headings = list(re.finditer(r"(?im)^\s*(FINDINGS|IMPRESSION)\s*:\s*", text))
    sections = {"findings": [], "impression": []}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        value = text[heading.end():end].strip()
        if value:
            sections[heading.group(1).lower()].append(value)
    return {
        "available": bool(text),
        "source": REPORT_SOURCE,
        "text": text,
        "findings": "\n\n".join(sections["findings"]) if headings else text,
        # Preserve paragraphs/numbering; sentence splitting can corrupt decimals.
        "impression": sections["impression"],
        "reviewed_by_clinician": False,
        "purpose": "unverified_reference",
    }


def report_payload(case_id, raw, *, organ_volumes=None, lesions=None, patient=None,
                   imaging=None, measurements_available=False, source_load_failed=False, source_column=None):
    source = source_report(raw)
    source["source_column"] = source_column
    source["load_failed"] = source_load_failed is True
    organs = {
        name: {**values, "status": "not_assessed", "measurement_source": "CT + segmentation"}
        for name, values in (organ_volumes or {}).items()
    }
    result = {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "case_id": str(case_id),
        "patient": patient or {},
        "imaging": imaging or {},
        "masks_available": measurements_available is True,
        "organ_volumes": organs,
        "lesions": lesions or {},
        # These compatibility fields describe generated findings, which this
        # measurements-only feature cannot provide. Preserve source prose only
        # in the explicitly unverified reference object.
        "comments": "",
        "impression": [],
        "assessment_scope": report_assessment_scope(),
        "source_report": source,
        "provenance": {
            "report_source": REPORT_SOURCE,
            "source_column": source_column,
            "measurements_source": "CT + segmentation",
            "image_review_performed": False,
        },
        "coverage": {
            "status": "limited",
            "measured_structures": len(organs),
        },
    }
    result["coverage"]["limitations"] = report_limitations(result)
    return result


def source_text(data):
    """Also safely render older payloads without reinterpreting their text."""
    source = data.get("source_report") or {}
    if "text" in source:
        return str(source["text"] or "")
    comments = str(data.get("comments") or "").strip()
    impression = data.get("impression") or []
    if isinstance(impression, str):
        impression = [impression]
    return "\n\n".join(part for part in (
        comments,
        "IMPRESSION:\n" + "\n".join(str(item) for item in impression) if impression else "",
    ) if part)


def report_limitations(data):
    """Generate trusted messages from typed availability, never incoming prose.

    Older coverage.limitations fields may contain clinical claims. They are
    reference metadata, not authority to expand this feature's assessment.
    """
    limitations = list(REPORT_LIMITATIONS)
    source = data.get("source_report")
    if isinstance(source, dict):
        available = source.get("available") is True and bool(source_text(data).strip())
        load_failed = source.get("load_failed") is True
    else:
        # Legacy payloads have source prose but no structured availability flag.
        available = bool(source_text(data).strip())
        load_failed = False
    if not available:
        limitations.append("No stored source report is available for this case.")
    if load_failed:
        limitations.append("The stored source report could not be loaded.")
    if data.get("masks_available") is not True:
        limitations.append(
            "Segmentation measurements unavailable: explicitly named masks and matching CT geometry are required."
        )
    return limitations


def measurement_display(value, digits=1):
    try:
        number = float(value)
    except (ValueError, TypeError):
        return "Unavailable"
    return f"{number:.{digits}f}" if math.isfinite(number) else "Unavailable"


def render_report_html(data, api_prefix="/api"):
    """Show measured data; retain source claims only as a collapsed reference."""
    escape = lambda value: html.escape(str(value), quote=True)
    case_id = escape(data.get("case_id", ""))
    text = source_text(data) or "No stored source report is available for this case."
    scope = report_assessment_scope()
    limitations = "".join(f"<li>{escape(item)}</li>" for item in report_limitations(data))
    rows = "".join(
        f"<tr><th scope='row'>{escape(name.replace('_', ' ').title())}</th>"
        f"<td>{measurement_display(values.get('volume'), 2)}</td>"
        f"<td>{measurement_display(values.get('mean_hu'))}</td><td>Not assessed</td></tr>"
        for name, values in sorted((data.get("organ_volumes") or {}).items())
    )
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CT segmentation summary - Case {case_id}</title><style>
body{{font:16px/1.6 system-ui,sans-serif;color:#17212b;background:#f4f6f8;margin:0}}
main{{max-width:900px;margin:32px auto;padding:28px;background:white;border-radius:16px}}
h1,h2{{line-height:1.25}} h2{{margin-top:32px}} .notice{{padding:16px;background:#fff6e6;border-left:4px solid #b66b19}}
pre{{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;background:#f8fafc;padding:20px;border:1px solid #dbe1e8}}
details{{margin-top:32px;border:1px solid #dbe1e8;padding:16px;border-radius:8px}} summary{{cursor:pointer;font-weight:600}}
.table-wrap{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;font-size:14px}}
th,td{{text-align:left;border-bottom:1px solid #dbe1e8;padding:10px}} a{{color:#1859a0}}
@media(max-width:600px){{main{{margin:0;padding:20px;border-radius:0}}}}
</style></head><body><main><h1>CT segmentation summary</h1><p>BodyMaps - Case {case_id}</p>
<div class="notice"><strong>Segmentation measurements only - disease assessment not supported</strong><p>{escape(scope['explanation'])}</p><ul>{limitations}</ul></div>
<p><a href="{escape(api_prefix)}/generate-report-pdf/{case_id}">Download segmentation summary PDF</a></p>
<h2>Segmentation measurements</h2><p>Source: CT + segmentation. These values do not establish whether a structure is normal or abnormal.</p>
<div class="table-wrap"><table><thead><tr><th>Structure</th><th>Volume (cc)</th><th>Mean HU</th><th>Clinical assessment</th></tr></thead>
<tbody>{rows or '<tr><td colspan="4">Segmentation measurements unavailable.</td></tr>'}</tbody></table></div>
<details id="source-reference"><summary>Unverified source reference</summary>
<p>Source: {REPORT_SOURCE}. This stored text is preserved for reference only. Its claims are not findings or conclusions generated by this auto-report feature and may exceed its capabilities.</p>
<pre>{escape(text)}</pre></details>
</main></body></html>"""
