# Compact public controls release

The controls were simplified on 2026-11-07. Source commits are `df76153` and `2f37340`.

Replies and reposts display an icon and a number. The other controls use matching icons. Accessible names and tooltips identify every control. Interactive targets measure 44 by 44 pixels. Repost instructions remain in a native disclosure.

The renderer receives a stylesheet content hash from the asset handler and puts it in the CSS URL. This gives changed styles a distinct browser cache key. An initial browser measurement ran before CSS finished loading. Final measurements waited for the load event and confirmed the intended controls.

## Verification

The check gate passed 512 tests with 73 environment tests skipped. The focused public HTML suite passed all three tests, including the versioned stylesheet request. GitHub Actions run `42394815390` passed the complete verification job.

Candidate and main checks verified HTML, all five SVG symbols, and asset integrity. Browser checks verified accessible names, the native repost disclosure, a single compact row on mobile, and no horizontal overflow at a 390-pixel viewport. The previously open production tab was reloaded and verified after CSS completed loading.

## Deployment

Cloud Build `1aa714e1-5d62-4326-9578-52e2277ad9d7` passed. Image digest is `sha256:de1109b1a789a1425ae5d316f30cca62b354c1a48052867b45f3d0868614b487`.

Revision `nobody-asked-api-controls-2f37340` receives 100 percent of main traffic. Hosting version is `2828be8f34b10e1c`. The temporary `controlspreview` tag was removed.

The prior feature release used revision `nobody-asked-api-social-5a2deec` and Hosting version `ec93334769426617`. Use the existing rollback procedures if a regression is found.
