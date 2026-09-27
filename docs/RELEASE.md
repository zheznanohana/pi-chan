# Public source release

## Scope

The release foregrounds π娘 as an anime-style AI companion built on Pi Coding Agent, with voice chat and a chat-to-prototype handoff.

Included: application source, Pi extensions, workbench integration, tests, character illustrations, sprites and current Live2D runtime model. Development workspace and original personal configuration remain untouched.

Excluded: personal conversations, memory stores, recordings, runtime data, private cloud configuration, environment files, historical screenshots, logs, backups, model weights, virtual environments, node_modules and old Git history.

## Verification

See `VERIFICATION.md` for checks performed on this release. Source checks and queue tests do not establish a complete fresh-machine speech-to-prototype run. Cloud services and model access require the user's own setup.

## Portability

Windows is the current runtime target. Optional speech backends and auxiliary tools retain development-machine path placeholders and need local configuration. The core startup and workbench source are separate from these optional backends.

## Credentials

The publishing snapshot is allowlisted and scanned before upload. Empty configuration examples contain no usable credentials. Gitleaks is a pattern-based check, not an absolute guarantee against every possible future secret; re-run it for subsequent changes and keep personal configuration outside Git.
