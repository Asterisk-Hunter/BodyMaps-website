# Quality-first, diverse filtered search

Only default `top` / `quality` search changes. Thumbnail-quality tiers are
strict: no worse tier can leapfrog a better tier to fill a cohort.

Within a tier, the dataset-neutral score is 35% voxel-count percentile, 35%
inverse voxel-spacing-volume percentile, 15% compressed CT-byte percentile,
10% shape-sum percentile and 5% known age AND sex. These are existing metadata
proxies for detail/usability, not a validated clinical quality grade. Finite
positive measurements are ranked within the filtered frame; invalid/missing
measurements receive zero. Stable case ID breaks score ties.

Quality-ranked (dataset, tumor-status) queues merge deterministically, balancing
cohort exposure with tumor, dataset and existing sex/age tie-breaks. A dimension
is disabled when its filter is active. Sex/age retain the bounded 96-row greedy
ordering. Constant demographic dimensions skip work that cannot change order.
The entire order is computed before pagination; nothing is randomly sampled.

Both known tumor statuses recur within a round while their queues remain in the
same tier. This cannot be guaranteed after a minority cohort is exhausted, or
when it exists only in a worse thumbnail tier. Never add excluded rows or invert
tiers to manufacture diversity. Unknown status is its own cohort.

Explicit ID/age/shape/spacing sorts, Sample and Shuffle are unchanged. The
latter keep the original ranking function, renamed `rank_legacy_quality_results`.
The separate fixed-showcase selector in the guest-showcase PR does not call the
new ranking function, so its public admission list is not changed by this PR.

## Reproducible synthetic benchmark

Run `python scripts/benchmark_search_ranking.py` from `flask-server`. No clinical
files or dataset mounts are read. On this Windows CPU, 43,600 synthetic rows,
three runs: legacy median 3.055 s; new median 0.844 s. This fixture has constant
demographics (the screenshot's single-filter failure pattern), not a production
latency claim. A separate mixed-demographic regression has an 8 s CI ceiling.

Before: first twelve `synthetic_00000` through `synthetic_00011`, all PanTS,
all no-tumor. After, first six, then the same cohorts' next quality-ranked cases:

| Synthetic ID | Dataset | Tumor |
| --- | --- | --- |
| synthetic_00000 | PanTS | 0 |
| synthetic_01100 | AbdomenAtlas | 1 |
| synthetic_02000 | CancerVerse | 0 |
| synthetic_00100 | PanTS | 1 |
| synthetic_01000 | AbdomenAtlas | 0 |
| synthetic_02100 | CancerVerse | 1 |

Tests that encoded a universal PanTS-first bonus now check dataset-neutral
detail instead. Endpoint tests cover filter switches and unchanged explicit
sorts, and pagination tests check no duplicates, omissions or input mutation.
