# Stitch Reference Index

Generated 2026-05-05 against design system **Lightbase Industrial**.

| Screen | Title | Stitch screen ID |
|---|---|---|
| App shell — sidebar collapsed | Suppliers Dashboard (Collapsed Sidebar) | `6eb45d412d624eaba373c8f4ac45d0e1` |
| Suppliers list + detail drawer (expanded shell) | Suppliers List with Detail Drawer | `dfff8609bb6f49df9369fc6ff3c06580` |
| Competitors summary | Competitors Grid | `661c4cfc492e4520b8dde6f54415dfe6` |
| Ideation board | Ideation Board | `21302ed9c43e408f8881b3e86080ff02` |
| Sign-in | Sign In - Lightbase Industrial | `c395f68361e04f54b128b232ea477652` |
| Empty state | Suppliers Empty State | `d25457a59fb84f368debe6011abedeb0` |

**Project:** `17082598893235100181`
**Design system asset:** `10333123981883130398`

To re-open a screen:
`mcp__stitch__get_screen` with `name: "projects/17082598893235100181/screens/<screenId>"`

To re-open the project:
`mcp__stitch__get_project` with `name: "projects/17082598893235100181"`

---

## Notes

- The "App shell — sidebar expanded" standalone screen was deferred after two generation timeouts. The Suppliers list screen (`dfff8609b…`) renders the expanded shell as its left chrome and serves as the canonical reference for it.
- All screens use the **Lightbase Industrial** design system (asset `10333123981883130398`): GEIST headline + body, ROUND_EIGHT geometry, NEUTRAL color variant seeded with `#18181b`. Full token guidance is in the design system's `designMd`.
- Screens are Gemini-generated and are visual references only. The React implementation in `src/components/` matches the *look* but not the literal HTML output.
