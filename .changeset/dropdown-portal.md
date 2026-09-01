---
"plans": patch
---

Dropdown menus are no longer cut off inside sheets. The menu used to render
inside the sheet, whose `overflow: hidden` clipped it at the edge; it now
renders in a portal at the trigger's measured position, so the folder picker
in the new-file sheet opens whole. It follows the trigger on scroll and
resize, and still flips above the trigger when there is no room below.
