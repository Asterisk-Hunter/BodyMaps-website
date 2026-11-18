"""Isolated annotation viewer fixture. Never points at an existing database."""
import os
import sys
import tempfile
import uuid
from pathlib import Path

import nibabel as nib
import numpy as np

root = Path(tempfile.mkdtemp(prefix="bodymaps-annotation-e2e-"))
dataset = root / "dataset"
case = "PanTS_00000055"
image_dir = dataset / "image_only" / case
mask_dir = dataset / "mask_only" / case
image_dir.mkdir(parents=True)
mask_dir.mkdir(parents=True)
grid = np.indices((48, 48, 48))
radius = ((grid[0] - 24) ** 2 + (grid[1] - 24) ** 2 + (grid[2] - 24) ** 2) ** 0.5
image = np.where(radius < 20, 45, -1000).astype(np.int16)
mask = np.zeros(image.shape, dtype=np.uint8)
mask[((grid[0] - 24) ** 2 + (grid[1] - 24) ** 2 + (grid[2] - 24) ** 2) < 100] = 7
nib.save(nib.Nifti1Image(image, np.eye(4)), image_dir / "ct.nii.gz")
nib.save(nib.Nifti1Image(mask, np.eye(4)), mask_dir / "combined_labels.nii.gz")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + (root / "db.sqlite").as_posix(),
    "BODYMAPS_LOCAL_AUTO_SIGNIN": "true", "BODYMAPS_ANNOTATION_PROJECTS": "1",
    "PANTS_PATH": str(dataset), "PANTS_LABEL_SCHEMA": "viewer-v1", "MOUNT_GUARD": "0",
    "PERMISSIONS_DIR": str(root / "permissions"), "PANTS_VIEWER_LABEL_CACHE_PATH": str(root / "labels"),
    "MESH_PATH": str(root / "meshes"), "SESSIONS_DIR_PATH": str(root / "sessions"),
    "TRUST_PROXY": "false", "SECRET_KEY": "isolated-test-only",
})
(root / "sessions").mkdir()
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "flask-server"))
from models import engine
from models.user import User
from models.user_role import UserRole
from models.annotation_project import AnnotationAssignment, AnnotationCase, AnnotationProject
from services.local_dev_auth import LOCAL_USER_ID, LOCAL_EMAIL

engine.create_all()
project_id, assignment_id = str(uuid.uuid4()), str(uuid.uuid4())
with engine.session_scope() as session:
    session.add(User(id=LOCAL_USER_ID, email=LOCAL_EMAIL, name="Local annotator", is_system=False, plan="enterprise"))
    session.flush()
    for role in ("annotator", "annotation_manager"):
        session.add(UserRole(id=str(uuid.uuid4()), user_id=LOCAL_USER_ID, role=role))
    session.add(AnnotationProject(id=project_id, name="Fixture project", scan_source="pants", target_labels=[7],
                                  target_names={"7": "Common bile duct"}, baseline_mode="canonical", status="open"))
    session.flush()
    session.add(AnnotationAssignment(id=assignment_id, project_id=project_id, assignee_id=LOCAL_USER_ID,
                                     case_selector={"ids": [55]}, status="open"))
    session.flush()
    session.add(AnnotationCase(id=str(uuid.uuid4()), assignment_id=assignment_id, case_key=case, status="not_started"))

from app import app
print(f"FIXTURE_ROOT={root} ASSIGNMENT={assignment_id}", flush=True)
app.run(host="127.0.0.1", port=5186, threaded=True, use_reloader=False)
