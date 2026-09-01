---
"plans": minor
---

Questions the agent asks are now clickable. The app tells the agent it can
render forms, so Claude's AskUserQuestion arrives as a question card in the
transcript: the suggested answers stack one under the other as little bubbles,
descriptions and all (with a single choice, the click is the answer), every
question carries the tool's own "type your own answer" box, and
Skip tells the model you moved past it rather than killing the turn. Without
this the adapter disallowed the tool entirely and the model could only ask in
prose you had to answer by hand.
