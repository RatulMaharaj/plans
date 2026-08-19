---
"plans": patch
---

Fixes the agent failing with "env: node: No such file or directory" when the
app is launched from Finder. Resolving `npx` to an absolute path was only half
the job — `npx` is a script whose shebang runs `env node`, and `env` searches
the *child's* PATH, which was launchd's. The agent is now started with the PATH
your shell would give it.

A launch failure no longer suggests signing in. An agent that never started and
one that is signed out look nothing alike and need opposite advice.
