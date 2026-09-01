---
"plans": patch
---

The chat title truncates instead of running under the Rename button. The
conversation picker's trigger had a fixed 220px cap, wider than a narrow
panel's header could give it; it is now also capped by the room that is
actually there. This pass also repaired a duplicated block in the stylesheet
that had swallowed the rule dimming file locations on tool lines.
