# Release notes

Completed v1/v2 implementation changesets have been incorporated into
`packages/agent-sdk/CHANGELOG.md` and the manifest is explicitly pinned to
`2.0.0`. They are consumed; reapplying them would create unintended version
bumps. Internal workspace packages are not public release targets.

For a future release, record changes here if helpful, choose the final public
SDK version once, and follow `PUBLISHING.md`. The canonical pipeline publishes
the SDK and its eight exact-version platform payloads together. It does not
run `changeset version` or publish workspace packages automatically.
