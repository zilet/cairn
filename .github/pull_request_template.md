## Summary

<!-- What changed and why, in plain language -->

## User-facing behavior

<!-- How does the PWA / API / MCP behave differently? -->

## Constitution check

- [ ] Reads remain suggestions, not gates
- [ ] No user-facing 0–100 scores added
- [ ] No push / notification behavior introduced
- [ ] Plan-affecting changes still go through propose → review → apply (or are clearly manual-only)

## Technical checklist

- [ ] `npm test` passes
- [ ] If `public/` changed: `sw.js` `CACHE` version bumped
- [ ] If schema changed: `db.ts` + `migrate.ts` updated per CONTRIBUTING.md
- [ ] `api.ts` and `mcp.ts` kept in sync (if applicable)

## Screenshots / recordings

<!-- Optional — especially for PWA changes -->