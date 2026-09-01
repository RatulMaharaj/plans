---
"plans": patch
---

The "complete this plan" handoff prompt follows the plans skill instead of
carrying style rules of its own. The two had drifted into contradiction: the
prompt asked for a closing "Next checklist", which the skill forbids, and
argued against the step list the skill is built around, so an agent obeying
the prompt wrote a plan the skill said was wrong. The prompt now names the
move (flesh the plan out, set it ready, touch nothing else) and leaves the
shape to the skill. A saved copy of the old default prompt moves to the new
one; an edited prompt is left alone.
