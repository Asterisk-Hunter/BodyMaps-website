"""Bounded image decoding and transactional, account-owned avatar storage.

Only the normalized thumbnail survives. Original filenames, EXIF/location data,
comments, color profiles and original image bytes are never persisted. Keeping
one small PNG in the account database makes replacements atomic and account
purging automatic through the foreign key, with no media directory to migrate.
"""

import hashlib
from io import BytesIO
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select

from models.engine import session_scope
from models.user import User
from models.user_avatar import UserAvatar
from services.auth_store import _clean_name

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024
MAX_PIXELS = 16_000_000
THUMBNAIL_SIZE = 256
SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}
UNCHANGED_NAME = object()


class InvalidAvatar(ValueError):
    pass


def normalize_image(data: bytes) -> bytes:
    if not data or len(data) > MAX_FILE_BYTES:
        raise InvalidAvatar("Choose a JPEG, PNG or WebP image up to 5 MiB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.format not in SUPPORTED_FORMATS:
                    raise InvalidAvatar("Choose a JPEG, PNG or WebP image.")
                if source.width * source.height > MAX_PIXELS:
                    raise InvalidAvatar("Choose an image with at most 16 million pixels.")
                if getattr(source, "n_frames", 1) != 1:
                    raise InvalidAvatar("Choose a still image, not an animation.")
                source.load()  # Reject incomplete/corrupt content before persisting anything.
                oriented = ImageOps.exif_transpose(source)
                oriented.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE), Image.Resampling.LANCZOS)
                mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
                # A fresh image, rather than save(source), guarantees metadata is discarded.
                clean = Image.new(mode, oriented.size)
                clean.paste(oriented.convert(mode))
                output = BytesIO()
                clean.save(output, format="PNG")
                return output.getvalue()
    except InvalidAvatar:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InvalidAvatar("That image could not be read. Choose another JPEG, PNG or WebP.") from exc


def version_for(user_id: str) -> str | None:
    with session_scope() as session:
        return session.execute(
            select(UserAvatar.version).where(UserAvatar.user_id == user_id)
        ).scalar_one_or_none()


def get_image(user_id: str, version: str | None = None) -> bytes | None:
    with session_scope() as session:
        query = select(UserAvatar.png).where(UserAvatar.user_id == user_id)
        if version is not None:
            query = query.where(UserAvatar.version == version)
        return session.execute(query).scalar_one_or_none()


def set_image(user_id: str, png: bytes | None, *, name=UNCHANGED_NAME) -> dict | None:
    """Set/remove the normalized image and optional display name atomically."""
    with session_scope() as session:
        user = session.execute(select(User).where(User.id == user_id).with_for_update()).scalar_one_or_none()
        if user is None or user.is_system or user.deletion_requested_at is not None:
            return None
        if name is not UNCHANGED_NAME:
            if name is not None and not isinstance(name, str):
                raise ValueError("Name must be text")
            user.name = _clean_name(name)
        avatar = session.get(UserAvatar, user_id)
        if png is None:
            if avatar is not None:
                session.delete(avatar)
        else:
            if avatar is None:
                avatar = UserAvatar(user_id=user_id)
                session.add(avatar)
            avatar.png = png
            avatar.version = hashlib.sha256(png).hexdigest()
        session.flush()
        return user.to_public_dict()
