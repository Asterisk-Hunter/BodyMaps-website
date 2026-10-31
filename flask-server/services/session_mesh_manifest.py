"""Cache derived session mesh metadata on the server, never in the browser.

The caller must check ownership before entering and serialize one session's
builders. A source stat/version change invalidates the cache; the manifest's
public shape is unchanged. No voxel or mesh approximation is introduced.
"""
import json
import os
from pathlib import Path

from services.atomic_write import atomic_destination


def cached_manifest(case_id, segmentation_path, build, label_scheme):
    source = Path(segmentation_path)
    info = source.stat()
    binding = [1, case_id, str(source.resolve()), info.st_ino, info.st_size, info.st_mtime_ns,
               info.st_ctime_ns, str(label_scheme)]
    target = source.parent / 'render_only' / 'session_manifest_cache.json'
    try:
        saved = json.loads(target.read_text(encoding='utf-8'))
        if saved.get('binding') == binding and isinstance(saved.get('manifest'), dict):
            return saved['manifest']
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    manifest = build(case_id, os.fspath(source), route_base='sessions')
    # Do not cache a manifest if inference/editing replaced the source meanwhile.
    current = source.stat()
    if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (current.st_size, current.st_mtime_ns, current.st_ctime_ns):
        return manifest
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with atomic_destination(target) as temporary:
            Path(temporary).write_text(json.dumps({'binding': binding, 'manifest': manifest}), encoding='utf-8')
    except OSError:
        # Cache storage is optional; inability to write it must not break viewing.
        pass
    return manifest
