"""AbdomenAtlas catalog: metadata -> PanTS-like columns, the viewer mask table, file resolution."""
import numpy as np
import pandas as pd
import pytest

from services import abdomenatlas_catalog as at
from services.label_scheme import VIEWER_IDS, VIEWER_LABELS


def raw_csv():
    """Rows shaped like AbdomenAtlas3.0MiniWithMeta.csv (real column names, values copied from it)."""
    return pd.DataFrame({
        "BDMAP ID": ["BDMAP_00000001", "BDMAP_00000002", "BDMAP_00000003", "BDMAP_00000004"],
        "spacing": ["[0.8222656 0.8222656 2.5      ]", "[1.5 1.5 1.5]", "", "garbage"],
        "shape": ["(512, 512, 339)", "(512, 512, 391)", "", "(512, 512)"],
        "sex": ["F", "", "M", "M"],
        "age": ["51", "", "62", "above 89"],
        "scanner": ["siemens", "", "philips", "ge"],
        "contrast": ["Arterial", "Plain", "Venous", "Delay"],
        "number of liver lesion instances": [25.0, 0.0, 0.0, 0.0],
        "number of pancreatic lesion instances": [0.0, 0.0, 3.0, 0.0],
        "number of kidney lesion instances": [0.0, 0.0, 1.0, 0.0],
        "number of colon lesion instances": [0.0, 0.0, 0.0, 0.0],
        "narrative report": ["secret text"] * 4,
        "radiologist note": ["secret note"] * 4,
    })


# ------------------------------------------------------------------ ids
def test_the_id_helper_pads_and_accepts_the_prefix():
    assert at.abdomenatlas_id(7) == "BDMAP_00000007"
    assert at.abdomenatlas_id("bdmap_12") == "BDMAP_00000012"
    assert at.abdomenatlas_id("BDMAP00000012") == "BDMAP_00000012"
    for bad in ("", "BDMAP_", "BDMAP_abc", "../x", "CV_00000001"):
        with pytest.raises(ValueError):
            at.abdomenatlas_id(bad)


# ----------------------------------------------------------- normalization
def test_columns_are_the_ones_the_search_code_reads():
    out = at.normalize_metadata(raw_csv())
    assert list(out["BDMAP ID"]) == ["BDMAP_00000001", "BDMAP_00000002", "BDMAP_00000003", "BDMAP_00000004"]
    assert set(out["dataset"]) == {"AbdomenAtlas"}
    assert list(out["sex"]) == ["F", "", "M", "M"]
    assert list(out["manufacturer"]) == ["siemens", "", "philips", "ge"]


def test_contrast_uses_the_pants_vocabulary():
    out = at.normalize_metadata(raw_csv())
    assert list(out["ct phase"]) == ["Arterial", "Non-contrast", "Venous", "Delay"]
    assert at.canonical_phase(None) == "" and at.canonical_phase(float("nan")) == ""
    assert at.canonical_phase("Portal Venous") == "Venous"
    assert at.canonical_phase("something new") == "Something New"      # kept, not dropped


def test_age_spacing_and_shape_come_out_in_the_pants_sheet_form():
    out = at.normalize_metadata(raw_csv())
    assert out["age"].iloc[0] == 51.0 and np.isnan(out["age"].iloc[1]) and out["age"].iloc[3] == 90.0
    assert list(out["spacing"]) == ["(0.8223, 0.8223, 2.5)", "(1.5, 1.5, 1.5)", "", ""]
    assert list(out["shape"]) == ["(512, 512, 339)", "(512, 512, 391)", "", ""]
    assert out["study year"].isna().all()


def test_tumor_status_and_types_come_from_the_lesion_counts():
    out = at.normalize_metadata(raw_csv())
    assert list(out["tumor?"]) == [1.0, 0.0, 1.0, 0.0]
    # largest count first, ties alphabetical
    assert list(out["tumor type"]) == ["liver", "", "pancreas;kidney", ""]


def test_tumor_status_is_unknown_when_no_count_can_be_read():
    raw = raw_csv()
    for col in [c for c in raw.columns if c.startswith("number of")]:
        raw[col] = ["", "n/a", None, "x"]
    out = at.normalize_metadata(raw)
    assert out["tumor?"].isna().all() and list(out["tumor type"]) == [""] * 4
    out = at.normalize_metadata(raw[["BDMAP ID", "sex"]])                # no lesion columns at all
    assert out["tumor?"].isna().all() and list(out["tumor type"]) == [""] * 4


def test_private_text_never_reaches_the_search_table():
    out = at.normalize_metadata(raw_csv())
    assert not any("report" in c or "note" in c for c in out.columns)
    assert "secret" not in out.to_csv()


def test_the_id_column_is_required():
    with pytest.raises(ValueError):
        at.normalize_metadata(pd.DataFrame({"sex": ["F"]}))


# ---------------------------------------------------- the viewer mask table
def test_every_drawn_structure_uses_the_viewer_label_of_the_same_name():
    assert len({label for _stem, label in at.VIEWER_MASK_FILES}) == len(at.VIEWER_MASK_FILES), "one id per file"
    for stem, label in at.VIEWER_MASK_FILES:
        assert VIEWER_LABELS[label]["key"] == stem


def test_lesions_are_painted_last_and_a_part_after_its_organ():
    stems = [stem for stem, _label in at.VIEWER_MASK_FILES]
    assert stems[-3:] == ["pancreatic_lesion", "liver_lesion", "kidney_lesion"]
    for parent, part in (("pancreas", "pancreas_head"), ("pancreas", "pancreas_body"), ("pancreas", "pancreas_tail")):
        assert stems.index(parent) < stems.index(part)
    for vessel_over in ("liver", "pancreas", "kidney_left"):
        assert stems.index(vessel_over) < stems.index("veins")


def test_the_files_the_viewer_cannot_show_are_listed_and_never_drawn():
    drawn = {stem for stem, _label in at.VIEWER_MASK_FILES}
    assert drawn.isdisjoint(at.UNMAPPED_MASK_FILES)
    # a new viewer label with one of these names would be a reason to start drawing the file
    assert all(stem not in VIEWER_IDS for stem in at.UNMAPPED_MASK_FILES)


# ------------------------------------------------------------- file paths
def test_paths_follow_the_dataset_layout(tmp_path):
    root, overlay = tmp_path / "data", tmp_path / "overlay"
    case = "BDMAP_00000005"
    assert at.resolve_ct_path(case, str(root)) == str(root / "image_only" / case / "ct.nii.gz")
    assert at.resolve_ct_path(case, None) == ""
    assert at.resolve_mask_path(case, str(overlay)) is None and at.resolve_mask_path(case, None) is None
    mask = overlay / "mask_only" / case / "combined_labels.nii.gz"
    mask.parent.mkdir(parents=True)
    mask.write_bytes(b"x")
    assert at.resolve_mask_path(case, str(overlay)) == str(mask)
    # thumbnail: overlay first, then the dataset root, and a path to say 'missing' when neither has it
    assert at.resolve_profile_path(case, str(root), str(overlay)) == str(root / "profile_only" / case / "profile.jpg")
    drawn = root / "profile_only" / case / "profile.jpg"
    drawn.parent.mkdir(parents=True)
    drawn.write_bytes(b"x")
    assert at.resolve_profile_path(case, str(root), str(overlay)) == str(drawn)
    mine = overlay / "profile_only" / case / "profile.jpg"
    mine.parent.mkdir(parents=True)
    mine.write_bytes(b"y")
    assert at.resolve_profile_path(case, str(root), str(overlay)) == str(mine)


def test_the_metadata_file_is_found_by_env_path_then_by_the_dataset_folder(tmp_path):
    root = tmp_path / "data"
    root.mkdir()
    assert at.resolve_metadata_file(None, str(root)) is None
    csv = root / at.METADATA_CSV
    csv.write_text("BDMAP ID\n")
    assert at.resolve_metadata_file(None, str(root)) == str(csv)
    other = tmp_path / "other.csv"
    other.write_text("BDMAP ID\n")
    assert at.resolve_metadata_file(str(other), str(root)) == str(other)
    assert at.resolve_metadata_file(str(tmp_path / "missing.csv"), str(root)) == str(csv)
