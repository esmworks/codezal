# Audit skill pack (vendored)

This folder is a **copy** of Cloudflare's `security-audit-skill` repository; the app reads these
files through `auditAssetsDir` (`extraResources/audit` in the packaged build). Hunter sub-agents
open the attack-class packs (`*.md`) with `read` and apply the relevant section; `report-schema.json`
and the `validate-*.cjs` files are the upstream counterparts of the record schema and are used in
tests for parity.

- Source: https://github.com/cloudflare/security-audit-skill
- Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (main)
- Copied on: 2026-09-15
- License: MIT (see `LICENSE`)

## Updating

1. Download the new tarball from upstream: `codeload.github.com/cloudflare/security-audit-skill/tar.gz/refs/heads/main`
2. Copy the files under `skills/security-audit/` into this folder and keep `LICENSE`.
3. Update the commit and date in this file.
4. Check that the `PACK_FILES` mapping in `packages/agent/src/audit/ledger.ts` matches the new file
   names; if the schema changed, align the fields in `packages/contracts/src/audit.ts` and check
   parity with `pnpm test`.

The `validate-*.test.cjs` files look for their own fixtures; vitest does not run them (only
`*.test.ts` files are collected). For a manual parity check:

```bash
node apps/desktop/resources/audit/validate-findings.cjs <findings.json>
node apps/desktop/resources/audit/validate-coverage-ledger.cjs <coverage-ledger.json>
```
