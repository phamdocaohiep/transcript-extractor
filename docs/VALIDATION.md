# Reliability and recovery validation — 16 October 2026

This checkout implements the reliability/recovery milestone. It does not add
payment, licensing, cloud sync, transcription, or a paid-feature gate.

## Implemented

- Notes are queued under individual keys. Import acknowledges each note only
  after the IndexedDB write commits; retries use the same note ID.
- Extraction saves through the worker's extension-origin database. The popup
  offers retry and a downloadable recovery copy when saving fails.
- Group identity recognizes Coursera course paths, YouTube playlists and
  standalone videos. A one-time transaction repairs existing associations.
  Moving a video to another playlist moves its annotations in the same transaction.
- Coursera no longer manufactures timestamps. Udemy duration estimates retain
  an explicit marker through persistence, backup, reader, search and exports.
  SRT/VTT export refuses estimated timing.
- Search cache identity includes content. Older asynchronous indexing cannot
  overwrite a newer index.
- Complete JSON backups include all six library stores and inline PNG assets.
  Restore validates version, record shapes, keys, URLs, image types and
  relationships before writing. Existing keys win and insertion is atomic.
  The current limit is 250 MB. Preferences and active collection jobs are excluded.
- Collection writes have worker-serialized run/tab ownership and revisions.
  Resume preserves completed/skipped items; retry-failed resets failed items.
  Completion requires a confirmed library save. Missing owner tabs offer recovery.
- The library includes first-run guidance and backup controls.
- Noisy production logging is gated. The search-model fetch uses an immutable
  revision. Vulnerable tooling was updated and unused vite-plugin-copy removed.
- Privacy/listing copy distinguishes local processing from source caption requests.

## Automated checks

- Typecheck and lint pass (15 existing warnings, no errors).
- 604 tests across 31 files pass, including failed note delivery/retry,
  concurrent producers, group migration and reassignment, backup round-trip,
  invalid imports, transaction abort, stale search, indexing races, batch
  ownership/cancellation/retry, and timing provenance.
- Production build and store-readiness checks pass. The latter parse classic
  scripts without executing them and check seven required assets, including
  the worker and dashboard. They are not Chrome Web Store certification.
- npm audit reported zero known vulnerabilities after the tooling update.

## Browser checks performed

The test library at http://127.0.0.1:5173/dashboard.html is a development origin,
separate from the installed extension's real library. Only self-authored sample
records were imported there.

- Validated a backup and inspected record counts before choosing Merge backup.
- Confirmed the restored entry, note, highlight and screenshot after reload.
- Downloaded a new backup and compared all six collections with the input:
  every record and screenshot data URL matched.
- Searched the restored transcript using keyword and bundled semantic search;
  the result displayed its approximate timestamp.
- Captured screenshots in screenshots/recovery-reader.png and
  screenshots/recovery-search.png. These contain verification data and are
  evidence for development, not finished promotional screenshots.

## Live coverage and remaining release gates

- Captured minimal, sanitized markup from a signed-in Udemy Business transcript
  panel. The player showed an unavailable-media message, while caption text was
  present without exposed timestamps. This fixture tests extraction logic; it
  does not certify live extraction/save/reopen in the updated extension.
- Captured a Vietnamese YouTube no-captions button and tested that it does not
  falsely advertise available captions. Successful live YouTube extraction and
  Coursera extraction remain unverified.
- Browser security review blocked opening chrome://extensions/ because its URL
  scheme is disallowed. The updated installed extension could not be refreshed
  through the available browser tools. No workaround was attempted.
- Before distribution, load/reload dist/ in a dedicated test profile and verify
  extraction → save → close popup → reopen library, capture/seek, interruption,
  cancellation, resume, retry, and backup/restore on representative supported sites.
- Confirm recovery on a second profile, retake store-size promotional screenshots,
  and validate the proposition with beta users. No outreach was sent.
- Decide purchase delivery, offline activation, update/support terms and paid
  entitlements before implementing checkout. Nothing was published.
