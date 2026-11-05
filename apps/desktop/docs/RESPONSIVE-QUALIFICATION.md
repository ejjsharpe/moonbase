# Compact transcript layout readiness

CI run `41971089484` at #130 head `9ffc802` reached the compact screenshot journey, then read 430px immediately after resizing to 640px. Chat's existing `useSyncExternalStore` subscribes to the `(max-width: 640px)` media-query change; viewport command completion does not acknowledge that callback or its React commit.

A controlled browser probe holds only that media notification. The recorded viewport is 640px, the query already matches, and the workspace remains 430px while the 210px sidebar is still rendered. The original immediate assertion fails with the exact CI values. Releasing the callback yields exactly 640px with no document overflow. The same probe passes with an observable-width assertion while notification delivery is delayed 500ms. Evidence is `/tmp/moonbase-116-qualification-20261105/resize-{red,green}/`, with before/after JSON and the red trace; this establishes a reproducible readiness race, not retrospective proof of the CI runner's scheduling.

The fixture now awaits the exact 640px workspace width using the existing assertion deadline. All Markdown/Copy/link/error checks, compact and 200% captures, no-overflow assertions and reduced-motion coverage remain. No layout, media hook, animation, timing constant or production source changes.
