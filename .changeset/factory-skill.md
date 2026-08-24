---
"plans": minor
---

A fourth bundled skill, `factory`: how an agent sets the Factory GitHub
Action up in a repository — install the gate script and push wrapper
verbatim, adapt the workflow's verify commands and runner to the target
repo's own CI, keep the two load-bearing lines (the gate's skip and the
recursion-guarded `GITHUB_TOKEN`), point the owner at `claude setup-token`
for the subscription secret, and prove the install with a push that
dispatches nothing. Installs with the others, opens from the palette like
the others.
