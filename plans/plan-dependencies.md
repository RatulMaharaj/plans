---
status: done
---
# Plan Dependencies

The note asks for a plan to be able to depend on other plans, and suggests
ordering the folder by a frontmatter property — `order`.

Those are two different wants, and the number prefixes this folder used to
carry (`1_formatters.md`, `2_split-panes.md`) were an attempt at the second
that got removed precisely because filenames are a bad place to keep an
ordering. Whatever replaces them should not repeat that.

## `order` answers the smaller question

The tree sorts folders before files, each alphabetically (`FileTree.tsx:80-86`)
— that is the only ordering in the app. Frontmatter is already read on every
file during the walk: `frontmatter_status` (`lib.rs`) pulls `status:` out of
the first 2KB and caches it by mtime, and `PlanFile` carries it through to the
tree, where it renders as a tinted dot (`FileTree.tsx:444-449`).

So an `order:` number is genuinely cheap: the same cache reads a second key,
`PlanFile` grows a second field, and the sort comparator prefers it before
falling back to name. That is a small, self-contained change.

What it does *not* do is say anything about dependency. It is a manual
sequence, maintained by hand, and it drifts the same way the filename prefixes
did — insert one plan in the middle and you renumber the rest.

## Dependency is the thing actually being asked for

"This plan depends on that one" is a fact about a pair of plans, and it wants
to be written where it is true rather than encoded in a global sequence:

```yaml
---
status: active
needs: [view-mode-per-buffer.md]
---
```

An ordering then *derives* from the graph instead of being maintained
alongside it. Two plans that do not depend on each other have no order, which
is the honest answer and something a single `order:` integer cannot express.

The plans already do this in prose — this file's neighbours link each other
with relative markdown links, and
[`new-file-opens-ready-to-type.md`](./new-file-opens-ready-to-type.md) names
its interaction with `view-mode-per-buffer.md` in a section rather than in
frontmatter. That is evidence the relationship is real and currently
unstructured, and also evidence that prose may be carrying it well enough.

## The question triage has to answer

**Is anything actually blocked on this, or is it tidiness?** With eight plans
in one flat folder, the honest answer is probably tidiness — which is an
argument for doing the cheap half and stopping:

- `order:` in frontmatter, read by the existing status cache, used by the tree
  sort. Small, useful now, and does not commit the app to a graph.
- `needs:` deferred until there are enough plans that reading them is hard, or
  until something needs to *act* on the dependency (refusing to start a plan,
  or offering the next one).

The risk of doing the graph now is building a dependency system for a folder
that fits on one screen.

## Open questions

- Where does an ordering apply — the whole tree, or only inside a folder? A
  repo-wide sequence across unrelated folders means nothing.
- What sorts *un-numbered* files against numbered ones? Alphabetical after all
  numbered ones is the least surprising, and it means adopting `order:` can be
  partial.
- Does `status:` already imply enough sequence? `active` before `draft` before
  `triage` before `done` may be the ordering people actually want, and it needs
  no new field at all — worth trying before adding one.
- If `needs:` ever lands, what does a cycle do? Nothing should be unopenable
  because two plans reference each other.

## Next

- [x] Decide whether sorting by `status:` alone is enough — try it first, since
      it costs nothing. **Tried, and it is.** "Order files by" in settings and
      in the palette switches the tree between name and status; the vocabulary
      is the one already in settings, so "first" means first in your list, and
      a file with an unrecognised status or none at all sorts last. Ordering
      applies inside each folder, which is the only place a sequence means
      anything — a repo-wide order across unrelated folders does not.
- [ ] `order:` is **not** being added. The whole argument for it was that
      `status:` might not carry enough sequence; it does, it costs no new field,
      and unlike a hand-maintained integer it cannot drift out of step with
      itself. Reopen this only if a real folder wants an order that its
      statuses genuinely cannot express.
- [ ] Leave `needs:` alone until a plan is genuinely hard to find without it
