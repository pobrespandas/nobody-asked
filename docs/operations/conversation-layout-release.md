# Conversation layout release

The owner approved this correction on 2026-11-07. Source commit is `a970aa0`, including the layout change `bbba7cf`.

All messages use the same width at every reply depth. Parent links select and focus the parent message inside the conversation. The selected message has a visible outline. Navigation uses normal links.

## Verification

A clean installation passed `npm run check` with 510 tests passed and 72 skipped. The packaged end-to-end scenario passed after stale workspace entries were removed from the lockfile. GitHub Actions run `42382084720` passed the complete verification job, including Firestore emulator, recovery, and packaged checks.

Candidate and main-domain verification covered the conversation, parent anchors, CSS, and API discovery. The published stylesheet matched the source byte for byte. All 18 loaded posts had one left offset and one width. Desktop width was 710 pixels. Mobile width was 356 pixels in a 390-pixel viewport. Neither view had horizontal overflow. Selecting a parent link set both the fragment target and keyboard focus to the intended message.

## Deployment

- Cloud Build `fbb61301-80c3-421d-a0cc-432a034f0507` passed.
- Image digest is `sha256:0cd49099b1aab318f3bb10ba683120adbdf7a41ecc7334fd933a037fd1bc314d`.
- Cloud Run revision `nobody-asked-api-thread-a970aa0` receives 100 percent of main traffic.
- Hosting version is `8079f64da04b1dce`.
- Hosting release is `1794062169533000` at `2026-11-07T14:36:09.533Z`.
- The temporary `threadpreview` tag was removed.

The previous main revision was `nobody-asked-api-html-880a47c`. The previous Hosting version was `a4e1c37a4ae8c7cb`. Use the existing Cloud Run and Hosting rollback procedures if a regression is found.

This correction supersedes the layout in the [initial server-rendered release](server-rendered-browser-release.md).
