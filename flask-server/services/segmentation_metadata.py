"""Names and colours travel atomically inside the saved NIfTI labelmap."""
import json

MARKER = "bodymaps_structures_v1"


def validate_structures(value):
    if not isinstance(value, dict) or len(value) > 255:
        raise ValueError("Invalid custom structure metadata")
    result = {}
    for key, entry in value.items():
        if not str(key).isdigit() or not 1 <= int(key) <= 255 or not isinstance(entry, dict):
            raise ValueError("Invalid custom structure index")
        name, color = entry.get("name"), entry.get("color")
        if not isinstance(name, str) or not name.strip() or len(name) > 128:
            raise ValueError("Invalid custom structure name")
        if (not isinstance(color, list) or len(color) != 4
                or any(type(v) is not int or not 0 <= v <= 255 for v in color)):
            raise ValueError("Invalid custom structure colour")
        result[str(int(key))] = {"name": name.strip(), "color": color}
    return result


def read_structures(image):
    for extension in image.header.extensions:
        if extension.get_code() != 6:
            continue
        try:
            data = json.loads(extension.get_content().decode("utf-8"))
            if isinstance(data, dict) and MARKER in data:
                return validate_structures(data[MARKER])
        except (ValueError, UnicodeError, AttributeError):
            continue
    return {}


def write_structures(image, structures):
    import nibabel as nib
    # Preserve unrelated extensions. The matching extension is replaced as part
    # of the same atomic write as its voxels, rather than a separate sidecar.
    kept = []
    for extension in image.header.extensions:
        try:
            data = json.loads(extension.get_content().decode("utf-8")) if extension.get_code() == 6 else None
        except (ValueError, UnicodeError, AttributeError):
            data = None
        if not isinstance(data, dict) or MARKER not in data:
            kept.append(extension)
    image.header.extensions.clear()
    image.header.extensions.extend(kept)
    payload = json.dumps({MARKER: validate_structures(structures)}, ensure_ascii=True).encode("utf-8")
    image.header.extensions.append(nib.nifti1.Nifti1Extension(6, payload))
