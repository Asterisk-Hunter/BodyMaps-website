# Completed-result reopening and account history

## Confirmed causes

The sidebar and History page read account-scoped browser localStorage. The
existing `/api/me/jobs` endpoint was used only to verify legacy local entries,
and only when those entries already existed. A new device therefore saw no
runs. Authentication itself worked; history hydration was missing.

Opening a completed run does not invoke inference. It probes the original CT,
loads NIfTI headers, downloads CT and mask pixel data, and creates the viewer.
The preliminary HEAD had no deadline and preceded the viewer's five-minute
deadline. CT/mask preparation and volume loading were serialized. The session
3D-manifest route also reread the entire labelmap on every reopen.

## Changes

- Hydrate run IDs/model/status from owner-filtered `/me/jobs` after sign-in,
  with bounded refresh on focus/visibility/online (at most once per minute).
  Verify response owner, current identity and session/history revisions before
  applying anything. Cancel on account switch/unmount. Failed reads keep the
  existing local list; no account is inferred from a response.
- Preserve existing local names, batch membership and viewed state. On a new
  device, use model/date names: those presentation fields are not yet stored
  by the server. Per-row local removals stay hidden in that browser. A later
  server list removes previously server-confirmed jobs deleted elsewhere,
  without discarding not-yet-submitted local uploads.
- Bound the admission HEAD to15seconds, abort on navigation, preserve401/403/404
  refusal, and show a retryable service error rather than an endless spinner.
- Start CT and mask header work together and initiate their full-resolution
  volume loads together. No downsampling, quantization, changed labels or
  changed input URLs. Existing stale-generation cleanup still owns resources.
- Cache the derived session mesh manifest on the server. Check authentication,
  ownership and source availability before consulting it. Source stat stamps,
  session identity, generator version and label scheme bind the cached result.
  Atomic writes; corruption or unavailable cache storage falls back to normal
  computation. No scan data or credentials are newly cached in the browser.

## Limits and deployment checks

This removes avoidable waterfalls and repeated metadata computation; it does
not make a large scan instant over a slow connection. Full private CT/mask
transfers still occur after a cold browser start. No production speedup factor
is claimed without a live browser trace. Memory can peak higher when two
independent loads overlap; test a largest supported scan on deployment hardware.

After review/merge and VPN-enabled deployment, verify: same account on a fresh
device shows completed jobs; another account shows none of those jobs; logout
during a fetch cannot restore history; opening a three-day-old result does not
call inference; inspect Network timing for HEAD, CT, mask and mesh manifest.
Repeat reopen with unchanged and changed masks. Check retry on a hung service.
No servers were accessed or deployed to while preparing this change.

## Primary guidance consulted

- React: [fetch cleanup and stale-response races](https://react.dev/learn/synchronizing-with-effects#fetching-data).
- Cornerstone: [streaming volume loading](https://www.cornerstonejs.org/docs/concepts/streaming-image-volume/streaming/)
  and [cache lifecycle](https://www.cornerstonejs.org/docs/concepts/cornerstone-core/cache/).
- MDN: [private versus shared HTTP caches](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching).

Persistent private-scan browser caching and a new DICOM streaming server were
not introduced as a quick fix. Existing private/no-store API policy is retained.
