"""Synthetic report regressions; never import the GPU/data-loading API module."""
from __future__ import annotations

import ast
import importlib.util
import os
import re
import sys
import tempfile
import uuid
from io import BytesIO
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

import pytest

SERVER = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("report_evidence", SERVER / "services/report_evidence.py")
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)

SYNTHETIC = """Synthetic source - not patient data.
FINDINGS:
Pleura:
Synthetic loculated left pleural effusion.
Pancreas:
No mass. Not enlarged. No pancreatic lesion.
Nodes:
Synthetic bulky inguinal nodes.
IMPRESSION:
1. Synthetic pleural and nodal findings require review.
2. This fixture is not a diagnosis.
""".strip()


def api_functions(*names, **namespace):
    if "_measure_report_structures" in names:
        for dependency in ("_report_measurement_inputs", "_report_measurement_signature", "_compute_report_measurements"):
            if dependency not in names:
                names += (dependency,)
        spec = importlib.util.spec_from_file_location("report_measurements", SERVER / "services/report_measurements.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        namespace.setdefault("read_native_volume", module.read_native_volume)
        namespace.setdefault("measure_binary_structure", module.measure_binary_structure)
        cache_spec = importlib.util.spec_from_file_location("_report_cache_for_api_tests", SERVER / "services/report_measurement_cache.py")
        cache_module = importlib.util.module_from_spec(cache_spec)
        sys.modules[cache_spec.name] = cache_module
        cache_spec.loader.exec_module(cache_module)
        namespace.setdefault("cached_report_measurements", cache_module.get_or_compute)
    tree = ast.parse((SERVER / "api/api_blueprint.py").read_text(encoding="utf-8"))
    selected = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            node.decorator_list = []
            selected.append(node)
    assert len(selected) == len(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), "isolated_report_api", "exec"), namespace)
    return namespace


@pytest.mark.parametrize("raw", ["", "FINDINGS:\nPancreas:\nNo mass. Not enlarged.", "FINDINGS:\nPancreas enlarged."])
@pytest.mark.parametrize("hu,volume", [(60, 85), (900, 9000), (-900, 0)])
def test_measurements_and_keywords_never_establish_clinical_status(raw, hu, volume):
    data = evidence.report_payload("7", raw, organ_volumes={
        "pancreas": {"mean_hu": hu, "volume": volume, "status": "normal"},
        "lung_left": {"mean_hu": -600, "volume": 100, "status": "check"},
    })
    assert {value["status"] for value in data["organ_volumes"].values()} == {"not_assessed"}
    assert data["source_report"]["text"] == raw
    assert data["coverage"]["status"] == "limited"
    assert data["coverage"]["measured_structures"] == 2
    assert data["provenance"]["image_review_performed"] is False
    assert data["report_schema_version"] == "3"
    assert data["comments"] == ""
    assert data["impression"] == []
    assert data["assessment_scope"]["supported_outputs"] == ["segmentation_measurements"]
    assert data["assessment_scope"]["disease_assessment"] == "not_supported"


def test_full_source_survives_missing_masks_unrecognized_sections_and_lesion_formats():
    raw = SYNTHETIC + "\nPancreas lesions:\nUnstructured source text that old regex discarded."
    data = evidence.report_payload("7", raw)
    assert data["masks_available"] is False
    assert data["source_report"]["text"] == raw
    assert "bulky inguinal nodes" in data["source_report"]["findings"]
    assert "require review" in data["source_report"]["impression"][0]
    assert data["source_report"]["purpose"] == "unverified_reference"
    assert data["lesions"] == {}
    assert "not assessed" in " ".join(data["coverage"]["limitations"])


def test_case_insensitive_sections_preserve_decimals_numbering_and_preamble():
    raw = "Preamble_x000D_Findings:\r\nSynthetic 1.5 cm finding.\rImpression:\n1. Review 1.5 cm finding."
    parsed = evidence.source_report(raw)
    assert parsed["text"].startswith("Preamble\nFindings:")
    assert parsed["findings"] == "Synthetic 1.5 cm finding."
    assert parsed["impression"] == ["1. Review 1.5 cm finding."]
    assert evidence.source_report("unstructured source")["findings"] == "unstructured source"


def test_html_preserves_full_source_escapes_markup_and_never_reassures():
    data = evidence.report_payload("7", SYNTHETIC + "\n<script>alert('x')</script>",
                                   organ_volumes={"pancreas": {"volume": 95, "mean_hu": 60}})
    html = evidence.render_report_html(data, api_prefix="/mounted/api")
    assert "Synthetic loculated left pleural effusion." in html
    assert "Synthetic bulky inguinal nodes." in html
    assert "No mass. Not enlarged." in html
    assert "&lt;script&gt;" in html and "<script>" not in html
    assert "Clinical assessment" in html and "Not assessed" in html
    assert '/mounted/api/generate-report-pdf/7' in html
    for unsupported in ("Everything else looked normal", "All clear", "Organs reviewed", "None detected", "Your scan found"):
        assert unsupported not in html


def test_missing_source_is_explicit_and_legacy_text_is_preserved():
    data = evidence.report_payload("7", "")
    html = evidence.render_report_html(data)
    assert "No stored source report is available" in html
    assert "Segmentation measurements unavailable" in html
    assert evidence.source_text({"comments": "Pleura: source.", "impression": ["Nodes: source."]}) == (
        "Pleura: source.\n\nIMPRESSION:\nNodes: source."
    )


def test_source_loader_prefers_structured_report_and_observes_workbook_changes(tmp_path):
    import openpyxl

    path = tmp_path / "synthetic.xlsx"
    def write(text):
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.title = "PanTS_metadata"
        sheet.append(["PanTS ID", "Fusion report", "Structured Report", "age", "sex", "ct phase", "study type"])
        sheet.append(["synthetic-7", "Wrong derived source", text, 40, "F", "portal", "synthetic"])
        workbook.save(path)
        workbook.close()
    functions = api_functions("_load_report_source", "_norm_colname", _metadata_xlsx_path=lambda: str(path))
    write(SYNTHETIC)
    first = functions["_load_report_source"]("synthetic-7")
    assert first[0] == SYNTHETIC
    assert first[3] == "Structured Report"
    assert first[1] == {"age": 40, "sex": "F"}
    assert first[2] == {"study_type": "synthetic", "contrast": "portal"}
    write("Updated synthetic source")
    assert functions["_load_report_source"]("synthetic-7")[0] == "Updated synthetic source"
    write("")
    fallback = functions["_load_report_source"]("synthetic-7")
    assert fallback[0] == "Wrong derived source"
    assert fallback[3] == "Fusion report"


def test_builder_retains_source_when_measurements_fail_and_does_not_log_text(capsys):
    def fail(_):
        raise ValueError("synthetic geometry unavailable")
    functions = api_functions("_build_report_data", report_payload=evidence.report_payload,
                              get_dataset_from_case_id=lambda _: "PanTS", secure_filename=str,
                              get_panTS_id=lambda _: "synthetic-7",
                              _load_report_source=lambda _: (SYNTHETIC, {}, {}, "Structured Report"),
                              _measure_report_structures=fail)
    data = functions["_build_report_data"]("7")
    assert data["source_report"]["text"] == SYNTHETIC
    assert data["masks_available"] is False
    assert "explicitly named masks" in " ".join(data["coverage"]["limitations"])
    assert capsys.readouterr().out == ""


def test_measurement_geometry_is_validated_instead_of_silently_cropped(tmp_path):
    import nibabel as nib
    import numpy as np

    image_dir = tmp_path / "image_only/synthetic-7"
    mask_dir = tmp_path / "mask_only/synthetic-7/segmentations"
    image_dir.mkdir(parents=True)
    mask_dir.mkdir(parents=True)
    ct = np.full((3, 3, 3), 900.0)
    mask = np.full((3, 3, 3), 19, dtype=np.uint8)
    nib.save(nib.Nifti1Image(ct, np.eye(4)), image_dir / "ct.nii.gz")
    nib.save(nib.Nifti1Image(mask, np.eye(4)), mask_dir / "pancreas.nii.gz")
    constants = SimpleNamespace(PANTS_PATH=str(tmp_path), MAIN_NIFTI_FILENAME="ct.nii.gz",
                                COMBINED_LABELS_NIFTI_FILENAME="combined_labels.nii.gz",
                                PREDEFINED_LABELS={0: "background", 19: "pancreas"})
    functions = api_functions("_measure_report_structures", Constants=constants, nib=nib, np=np,
                              os=os, tempfile=tempfile, Path=Path, re=re, get_panTS_id=lambda _: "synthetic-7")
    measure = functions["_measure_report_structures"]
    organs, lesions, imaging = measure("7")
    assert organs["pancreas"]["status"] == "not_assessed"
    assert organs["pancreas"]["mean_hu"] == 900
    assert organs["pancreas"]["mask_source"] == "segmentations/pancreas.nii.gz"
    assert lesions == {}
    assert imaging["shape"] == [3, 3, 3]
    bad_affine = np.eye(4)
    bad_affine[0, 3] = 10
    nib.save(nib.Nifti1Image(mask, bad_affine), mask_dir / "pancreas.nii.gz")
    with pytest.raises(ValueError, match="geometry"):
        measure("7")
    nib.save(nib.Nifti1Image(mask[:2], np.eye(4)), mask_dir / "pancreas.nii.gz")
    with pytest.raises(ValueError, match="geometry"):
        measure("7")


@pytest.mark.parametrize("legacy", [False, True])
def test_default_pdf_preserves_long_measurements_but_excludes_source_clinical_claims(tmp_path, monkeypatch, legacy):
    from reportlab.pdfgen import canvas
    from PyPDF2 import PdfReader

    template = tmp_path / "blank-template.pdf"
    pdf = canvas.Canvas(str(template))
    pdf.showPage()
    pdf.save()
    monkeypatch.setenv("TEMPLATE_PATH", str(template))
    raw = SYNTHETIC + "\nStomach healthy. No stomach cancer. Pancreas enlarged.\nFINAL SOURCE MARKER"
    organs = {f"synthetic_structure_{i:03}": {"volume": 95 + i, "mean_hu": 60} for i in range(60)}
    organs["stomach"] = {"volume": 95, "mean_hu": 60}
    data = evidence.report_payload("7", raw, organ_volumes=organs)
    if legacy:
        data.pop("source_report")
        data.pop("assessment_scope")
        data["comments"] = raw
        data["impression"] = ["Stomach healthy. No stomach cancer."]
    functions = api_functions("_draw_report_pdf", os=os, report_assessment_scope=evidence.report_assessment_scope, source_text=evidence.source_text,
                              report_limitations=evidence.report_limitations,
                              measurement_display=evidence.measurement_display,
                              get_panTS_id=lambda _: "synthetic-7",
                              Constants=SimpleNamespace(PANTS_PATH=str(tmp_path), MAIN_NIFTI_FILENAME="ct.nii.gz",
                                                        COMBINED_LABELS_NIFTI_FILENAME="combined_labels.nii.gz"))
    output = tmp_path / "synthetic-report.pdf"
    functions["_draw_report_pdf"](data, str(tmp_path / "temp.pdf"), str(output))
    reader = PdfReader(str(output))
    assert len(reader.pages) >= 3
    text = " ".join("\n".join(page.extract_text() for page in reader.pages).split())
    for required in ("CT Segmentation Summary", "Not assessed", "Scope and limitations",
                     "Synthetic Structure 059", "stomach or any other organ", "unverified reference in the viewer"):
        assert required.lower() in text.lower()
    for unsupported in ("Stomach healthy.", "No stomach cancer.", "Pancreas enlarged.", "FINAL SOURCE MARKER",
                        "Synthetic loculated left pleural effusion.", "Synthetic bulky inguinal nodes.",
                        "Organs Reviewed", "Everything else looked normal"):
        assert unsupported not in text


@pytest.mark.parametrize("case_id,masks_available", [
    (None, True), ("", True), ("../7", True), (r"..\7", True),
    ("CV_00000007", True), ("CV_00000007", False), ("\u00b2", True), ("7", False),
])
def test_pdf_source_only_or_invalid_image_ids_never_construct_or_probe_image_paths(
    tmp_path, monkeypatch, case_id, masks_available,
):
    from reportlab.pdfgen import canvas
    from PyPDF2 import PdfReader

    template = tmp_path / "blank-template.pdf"
    pdf = canvas.Canvas(str(template))
    pdf.showPage()
    pdf.save()
    monkeypatch.setenv("TEMPLATE_PATH", str(template))

    def unexpected_image_access(*args):
        pytest.fail("A source-only or invalid case ID must not access dataset image paths")

    data = evidence.report_payload("unused", SYNTHETIC, measurements_available=masks_available)
    data["case_id"] = case_id
    functions = api_functions(
        "_draw_report_pdf",
        os=SimpleNamespace(getenv=os.getenv, path=SimpleNamespace(exists=unexpected_image_access)),
        report_assessment_scope=evidence.report_assessment_scope, source_text=evidence.source_text, report_limitations=evidence.report_limitations,
        measurement_display=evidence.measurement_display,
        get_panTS_id=unexpected_image_access,
        # Any attempt to construct a dataset path also fails before filesystem IO.
        Constants=SimpleNamespace(),
    )
    output = tmp_path / "source-only.pdf"
    functions["_draw_report_pdf"](data, str(tmp_path / "temp.pdf"), str(output))
    text = "\n".join(page.extract_text() for page in PdfReader(str(output)).pages)
    assert "Synthetic loculated left pleural effusion." not in text
    assert "Synthetic bulky inguinal nodes." not in text
    assert "Segmentation measurements unavailable." in text
    assert "Assessment scope" in text or "ASSESSMENT SCOPE" in text


@pytest.mark.parametrize("case_id", ["0007", 7])
def test_pdf_canonicalizes_numeric_case_id_before_constructing_image_paths(tmp_path, monkeypatch, case_id):
    from reportlab.pdfgen import canvas

    template = tmp_path / "blank-template.pdf"
    pdf = canvas.Canvas(str(template))
    pdf.showPage()
    pdf.save()
    monkeypatch.setenv("TEMPLATE_PATH", str(template))
    ids, paths = [], []

    def canonical_folder(value):
        assert type(value) is int
        ids.append(value)
        return f"PanTS_{value:08d}"

    def image_exists(path):
        paths.append(path)
        return False

    data = evidence.report_payload("unused", SYNTHETIC, measurements_available=True)
    data["case_id"] = case_id
    functions = api_functions(
        "_draw_report_pdf",
        os=SimpleNamespace(getenv=os.getenv, path=SimpleNamespace(exists=image_exists)),
        report_assessment_scope=evidence.report_assessment_scope, source_text=evidence.source_text, report_limitations=evidence.report_limitations,
        measurement_display=evidence.measurement_display, get_panTS_id=canonical_folder,
        Constants=SimpleNamespace(PANTS_PATH=str(tmp_path), MAIN_NIFTI_FILENAME="ct.nii.gz"),
    )
    functions["_draw_report_pdf"](data, str(tmp_path / "temp.pdf"), str(tmp_path / "numeric.pdf"))
    assert ids == [7]
    assert paths == [f"{tmp_path}/image_only/PanTS_00000007/ct.nii.gz"]


def test_json_disables_cache_and_legacy_pdf_uses_shared_builder():
    from flask import Flask, jsonify

    calls = []
    functions = api_functions("get_report_data", "get_report", jsonify=jsonify,
                              _build_report_data=lambda _: evidence.report_payload("7", SYNTHETIC),
                              generate_report_pdf=lambda case: calls.append(case) or "shared PDF")
    app = Flask(__name__)
    with app.test_request_context():
        response = functions["get_report_data"]("7")
        assert "no-store" in response.headers["Cache-Control"]
        assert response.get_json()["source_report"]["text"] == SYNTHETIC
        assert functions["get_report"]("0007") == "shared PDF"
    assert calls == ["7"]


def test_pdf_route_uses_unique_files_and_cleans_both_outputs(tmp_path):
    from flask import Flask, jsonify, send_file

    paths = []
    def draw(data, temporary, output):
        paths.append((temporary, output))
        Path(temporary).write_bytes(b"temporary")
        Path(output).write_bytes(b"synthetic-pdf")
    functions = api_functions("generate_report_pdf", os=os, uuid=uuid, BytesIO=BytesIO,
                              PDF_DIR=str(tmp_path), _is_safe_id=lambda _: True,
                              _resolve_case_id_or_token=lambda value: value,
                              _build_report_data=lambda _: evidence.report_payload("7", SYNTHETIC),
                              _draw_report_pdf=draw, send_file=send_file, jsonify=jsonify)
    app = Flask(__name__)
    with app.test_request_context():
        for _ in range(2):
            response = functions["generate_report_pdf"]("7")
            response.direct_passthrough = False
            assert response.get_data() == b"synthetic-pdf"
            assert "no-store" in response.headers["Cache-Control"]
    assert paths[0] != paths[1]
    assert not list(tmp_path.iterdir())


def test_combined_mask_without_named_structure_identity_is_not_measured(tmp_path):
    import nibabel as nib
    import numpy as np

    directory = tmp_path / "mask_only/synthetic-7"
    directory.mkdir(parents=True)
    # Numeric 19 has multiple incompatible meanings in existing label maps.
    nib.save(nib.Nifti1Image(np.full((2, 2, 2), 19, dtype=np.uint8), np.eye(4)),
             directory / "combined_labels.nii.gz")
    functions = api_functions("_measure_report_structures", os=os, Path=Path, re=re,
                              Constants=SimpleNamespace(PANTS_PATH=str(tmp_path), MAIN_NIFTI_FILENAME="ct.nii.gz"),
                              get_panTS_id=lambda _: "synthetic-7")
    with pytest.raises(ValueError, match="explicit structure mask names"):
        functions["_measure_report_structures"]("7")


class DefaultReportText(HTMLParser):
    """Read visible summary text, excluding the explicitly collapsed reference."""
    def __init__(self):
        super().__init__()
        self.reference_depth = 0
        self.text = []
        self.references = []

    def handle_starttag(self, tag, attrs):
        if tag == "details":
            self.references.append(dict(attrs))
            self.reference_depth += 1

    def handle_endtag(self, tag):
        if tag == "details":
            self.reference_depth -= 1

    def handle_data(self, data):
        if not self.reference_depth:
            self.text.append(data)


@pytest.mark.parametrize("legacy", [False, True])
def test_default_html_does_not_assert_unsupported_stomach_or_other_source_claims(legacy):
    raw = "Stomach healthy. No stomach cancer. Pancreas enlarged. No disease elsewhere."
    data = evidence.report_payload("7", raw, organ_volumes={"stomach": {"volume": 95, "mean_hu": 60}})
    if legacy:
        data.pop("source_report")
        data.pop("assessment_scope")
        data["comments"] = raw
        data["impression"] = ["All organs healthy."]
        data["organ_volumes"]["stomach"]["status"] = "normal"
    rendered = evidence.render_report_html(data)
    parsed = DefaultReportText()
    parsed.feed(rendered)
    summary = " ".join(parsed.text)
    assert raw in rendered  # No deletion or keyword filtering of original evidence.
    assert parsed.references == [{"id": "source-reference"}]
    assert "Unverified source reference" in rendered
    assert "not findings or conclusions generated" in rendered
    for unsupported in ("Stomach healthy.", "No stomach cancer.", "Pancreas enlarged.", "No disease elsewhere.", "All organs healthy."):
        assert unsupported not in summary
    assert "stomach or any other organ" in summary
    assert "disease assessment not supported" in summary
    assert "Not assessed" in summary


def test_feature_scope_is_explicit_and_cannot_be_expanded_by_source_or_stale_payload():
    data = evidence.report_payload("7", "All diseases ruled out. Every organ is healthy.")
    scope = data["assessment_scope"]
    assert scope["supported_outputs"] == ["segmentation_measurements"]
    assert scope["disease_assessment"] == "not_supported"
    assert scope["explanation"] == evidence.ASSESSMENT_SCOPE_EXPLANATION
    assert data["comments"] == "" and data["impression"] == []
    assert data["source_report"]["text"] == "All diseases ruled out. Every organ is healthy."
    scope["supported_outputs"].append("cancer_screening")
    scope["disease_assessment"] = "supported"
    scope["explanation"] = "Every organ is healthy."
    assert evidence.report_assessment_scope()["supported_outputs"] == ["segmentation_measurements"]
    rendered = evidence.render_report_html(data)
    parsed = DefaultReportText()
    parsed.feed(rendered)
    assert "Every organ is healthy." not in " ".join(parsed.text)
    assert evidence.ASSESSMENT_SCOPE_EXPLANATION in rendered


@pytest.mark.parametrize("legacy", [False, True])
def test_html_ignores_arbitrary_incoming_limitation_claims(legacy):
    unsupported = "All organs healthy. No stomach cancer."
    data = evidence.report_payload("7", SYNTHETIC)
    if legacy:
        data.pop("source_report")
        data["comments"] = SYNTHETIC
    data["coverage"] = {"limitations": [unsupported]}
    rendered = evidence.render_report_html(data)
    assert unsupported not in rendered
    for limitation in evidence.REPORT_LIMITATIONS:
        assert limitation in rendered
    assert "explicitly named masks and matching CT geometry" in rendered


def test_canonical_limitations_use_typed_availability_and_preserve_failure_messages():
    data = evidence.report_payload("7", "", source_load_failed=True)
    assert data["source_report"]["load_failed"] is True
    assert "The stored source report could not be loaded." in data["coverage"]["limitations"]
    assert "No stored source report is available for this case." in data["coverage"]["limitations"]
    assert any("Segmentation measurements unavailable" in value for value in data["coverage"]["limitations"])

    available = evidence.report_payload("7", SYNTHETIC, measurements_available=True)
    assert evidence.report_limitations(available) == list(evidence.REPORT_LIMITATIONS)
    available["coverage"]["limitations"] = ["All organs healthy. No stomach cancer."]
    available["masks_available"] = "true"
    available["source_report"]["available"] = "true"
    limitations = evidence.report_limitations(available)
    assert "No stored source report is available for this case." in limitations
    assert any("Segmentation measurements unavailable" in value for value in limitations)
    assert "No stomach cancer" not in " ".join(limitations)


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("has_source", [False, True])
def test_pdf_ignores_incoming_limitations_and_only_promises_existing_reference(tmp_path, monkeypatch, legacy, has_source):
    from reportlab.pdfgen import canvas
    from PyPDF2 import PdfReader

    template = tmp_path / "blank-template.pdf"
    pdf = canvas.Canvas(str(template))
    pdf.showPage()
    pdf.save()
    monkeypatch.setenv("TEMPLATE_PATH", str(template))
    raw = SYNTHETIC if has_source else ""
    data = evidence.report_payload("7", raw)
    if legacy:
        data.pop("source_report")
        data["comments"] = raw
    data["coverage"] = {"limitations": ["All organs healthy. No stomach cancer."]}
    functions = api_functions(
        "_draw_report_pdf", os=os, source_text=evidence.source_text,
        report_assessment_scope=evidence.report_assessment_scope,
        report_limitations=evidence.report_limitations,
        measurement_display=evidence.measurement_display,
    )
    output = tmp_path / "guarded-summary.pdf"
    functions["_draw_report_pdf"](data, str(tmp_path / "temp.pdf"), str(output))
    text = " ".join("\n".join(page.extract_text() for page in PdfReader(str(output)).pages).split())
    assert "All organs healthy." not in text
    assert "No stomach cancer." not in text
    assert "Measurements cannot establish health or exclude disease" in text
    assert "Segmentation measurements unavailable" in text
    if has_source:
        assert "source text remains available as an unverified reference in the viewer" in text
        assert "No original source report is available" not in text
    else:
        assert "source text remains available" not in text
        assert "No original source report is available for this case." in text


def measurement_cache_api(tmp_path):
    image_dir = tmp_path / "image_only/synthetic-7"
    mask_dir = tmp_path / "mask_only/synthetic-7/segmentations"
    image_dir.mkdir(parents=True)
    mask_dir.mkdir(parents=True)
    ct_path = image_dir / "ct.nii.gz"
    ct_path.write_bytes(b"synthetic CT identity")
    (mask_dir / "pancreas.nii.gz").write_bytes(b"synthetic mask identity")
    functions = api_functions(
        "_measure_report_structures", os=os, Path=Path, re=re,
        Constants=SimpleNamespace(PANTS_PATH=str(tmp_path), MAIN_NIFTI_FILENAME="ct.nii.gz"),
        get_panTS_id=lambda _: "synthetic-7",
    )
    return functions, ct_path, mask_dir


def test_measurement_api_reuses_metrics_but_invalidates_changed_files_and_mask_names(tmp_path):
    functions, ct_path, mask_dir = measurement_cache_api(tmp_path)
    computations = []
    def compute(inputs):
        computations.append(inputs)
        return {name: {"volume": 95, "status": "not_assessed"} for name in inputs[1]}, {}, {"shape": [2, 2, 2]}
    functions["_compute_report_measurements"] = compute
    measure = functions["_measure_report_structures"]
    first = measure("7")
    first[0]["pancreas"]["volume"] = 999
    assert measure("7")[0]["pancreas"]["volume"] == 95
    assert len(computations) == 1
    ct_path.write_bytes(b"changed synthetic CT identity")
    measure("7")
    assert len(computations) == 2
    (mask_dir / "pancreas.nii.gz").write_bytes(b"changed synthetic mask identity")
    measure("7")
    assert len(computations) == 3
    (mask_dir / "stomach.nii.gz").write_bytes(b"new synthetic mask")
    assert "stomach" in measure("7")[0]
    assert len(computations) == 4
    (mask_dir / "stomach.nii.gz").unlink()
    assert "stomach" not in measure("7")[0]
    assert len(computations) == 5


def test_measurement_api_rejects_mask_list_changes_during_computation(tmp_path):
    functions, _, mask_dir = measurement_cache_api(tmp_path)
    computations = []
    def compute(inputs):
        computations.append(inputs)
        if len(computations) == 1:
            (mask_dir / "stomach.nii.gz").write_bytes(b"arrived during synthetic computation")
        return {name: {"volume": 95, "status": "not_assessed"} for name in inputs[1]}, {}, {}
    functions["_compute_report_measurements"] = compute
    with pytest.raises(ValueError, match="input paths changed"):
        functions["_measure_report_structures"]("7")
    assert "stomach" in functions["_measure_report_structures"]("7")[0]
    functions["_measure_report_structures"]("7")
    assert len(computations) == 2


def test_source_report_is_refreshed_when_measurements_are_cached(tmp_path):
    functions, _, _ = measurement_cache_api(tmp_path)
    computations, source_reads = [], []
    def compute(inputs):
        computations.append(inputs)
        return {"pancreas": {"volume": 95, "status": "not_assessed"}}, {}, {}
    def read_source(_):
        source_reads.append(True)
        return f"Synthetic source revision {len(source_reads)}", {}, {}, "Structured Report"
    functions["_compute_report_measurements"] = compute
    builder = api_functions(
        "_build_report_data", report_payload=evidence.report_payload,
        get_dataset_from_case_id=lambda _: "PanTS", secure_filename=str,
        get_panTS_id=lambda _: "synthetic-7", _load_report_source=read_source,
        _measure_report_structures=functions["_measure_report_structures"],
    )["_build_report_data"]
    first, second = builder("7"), builder("7")
    assert first["source_report"]["text"] == "Synthetic source revision 1"
    assert second["source_report"]["text"] == "Synthetic source revision 2"
    assert len(computations) == 1 and len(source_reads) == 2
