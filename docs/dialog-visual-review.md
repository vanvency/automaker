# Dialog visual review

Reviewed 103 `DialogContent` usages across 89 component files on 21 September 2026.
The shared Dialog, Popover and Sheet now use consistent spacing, readable heading
line height, reserved close-button space, softer overlays, rounded surfaces and
viewport-aware scrolling. Mobile dialogs keep a viewport gutter, including custom
desktop widths; explicit full-screen viewers retain their safe-area layout.
Reduced-motion preferences disable entrance/exit animations.

Archive forms now separate the selected tasks, reason and explanation with clear
spacing. Archive cards use three columns at most so detailed reasons remain readable.
The changes do not alter confirmation actions or submit data.

## Browser verification

The following 15 dialogs passed checks at 1440×1000 and 390×844, in both light and
dark themes (60 combinations):

- New Work, Archived Works, Snoozed Works
- Add Task, Edit Task, Task Archives, Task Details, Request Changes
- Pipeline Settings
- Create Context, Create Memory
- Add MCP Server, Import MCP JSON
- Archive Work, Snooze Work

Checks covered viewport bounds, horizontal overflow, title/close-button overlap,
and Escape dismissal. Screenshot artifacts are in `/tmp/automaker-dialog-review/`.
Dialogs were opened and dismissed without submitting production changes.

MCP Edit JSON was unavailable because no server was configured. Logs was unavailable
on the selected task. Other conditional dialogs were reviewed through source and
shared styles, not exhaustively exercised with live data.

## Automated checks

- TypeScript and changed-file ESLint checks passed.
- Fourteen targeted dialog tests passed.
- Full UI suite: 534 passed, one failed. The failure is the existing
  `board-attention-visibility.test.ts` expectation that completed delivery remains
  in Done, while the current column logic places completed records in archives.
  That state-policy inconsistency was not changed by this visual update.
