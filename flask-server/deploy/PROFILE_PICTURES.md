# Account profile pictures

Run `alembic upgrade head` against the deployment's existing account database
before starting the redesigned backend. Migration `a0c94f83b7d2` only adds
`user_avatar`; existing account rows and files are unchanged. Back up the
database using the deployment's normal procedure first. No media directory,
object storage, nginx alias, or new environment variable is required.

Apply the exact `/api/auth/avatar` location in `nginx-bodymaps.conf` and run
`nginx -t` before reloading nginx during the approved deployment. Its 6M limit
allows a 5 MiB picture plus multipart framing; the generic API stays at 2M and
the backend still enforces the smaller file limit. Without this location, nginx
rejects otherwise valid pictures larger than 2M before Flask receives them.

For an approved release that cannot change the existing nginx configuration,
build the frontend with `VITE_AVATAR_MAX_BYTES=921600`. The picture picker then
advertises and enforces a 900 KB limit, leaving multipart overhead below the
existing 2M proxy limit. The default remains 5 MiB, and configured values cannot
raise the backend's 5 MiB maximum. An HTML proxy 413 response produces a clear
request to choose a smaller image without discarding the staged picture.
This is a build-time setting; rebuild when changing it. Once an administrator
has applied and verified the 6M location, omit this override and rebuild to
restore the full 5 MB picker limit. Database migration and authorization remain
required in either mode.

The table contains at most one normalized PNG thumbnail per account, up to
256 pixels per side. Pictures follow the account database across workers,
releases, devices and backups. Account deletion immediately revokes image
access along with the session; restoration during the existing 30-day grace
period restores the picture. Final account purge removes it through the foreign
key. Removing a picture deletes its row immediately. Account JSON export includes
the current normalized PNG as `account.profile_picture` with `media_type` and
`base64` fields, only when a picture exists.

API (all routes require the existing account session):

- `PUT /api/auth/avatar`: multipart `avatar`, optional `name`; returns `{user}`.
- `DELETE /api/auth/avatar`: optional JSON `{name}`; returns `{user}`.
- User responses include nullable `avatar_url`. GET that URL with credentials
  to read your own picture. Other accounts receive 404; anonymous clients 401.

Uploads accept JPEG, PNG and still WebP files up to 5 MiB and 16 million decoded
pixels. A bounded multipart parser runs independently of the scan upload limit.
The server decodes, applies EXIF orientation, resizes, and re-encodes the image;
filenames, location/EXIF data, comments, embedded profiles and original bytes are
discarded. SVG, animated images, corrupt images and unsupported formats fail
without changing the saved picture or name. Thirty upload attempts per account
per hour per worker bound decoding abuse. Image responses are private/no-store,
and old version URLs stop working after replacement or removal.

From `flask-server`, run regression checks with:

```sh
python -m pytest tests/functional/test_avatar_endpoints.py tests/functional/test_auth_endpoints.py tests/unit/test_account_deletion.py
```

Rollback: the previous application can run with this additive table left in
place. Downgrading the migration drops saved pictures; it is not necessary for
an application rollback.
