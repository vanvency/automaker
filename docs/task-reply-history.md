# Task Reply history

Timeline lists individual Reply entries with their timestamp, original text and
attachment filenames. Long replies expand to show the complete text. The open
Timeline refreshes every ten seconds.

Follow-up submissions through the shared execution facade are appended to
`.automaker/features/<featureId>/reply-history.jsonl` before execution. Each has a
unique ID, so identical repeated messages remain distinct and subsequent agent
output cannot overwrite them. Entries record submitted instructions, not proof
that an agent completed them; internal follow-up actions use the same history.

For older tasks, Timeline also reads user messages from Pi sessions attributed
to that task, extracting the original instructions from the default Reply
template. Direct user conversation messages are included where task ownership
and timestamps are available. A reply ID in new dispatches prevents showing the
same submission twice. Historical messages from deleted sessions, other providers
without retained records, or templates that cannot be identified cannot be
reconstructed reliably.

Reply history stays with the task after archiving or releasing its checkout.
It does not identify individual people: Automaker's current authentication does
not provide a per-user identity for these submissions.
