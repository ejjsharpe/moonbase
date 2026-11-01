# Independent application-boundary review, round 4

Reviewer: GPT-6 Astra, explicit `xhigh`, isolated read-only T3 worktree. PR #2 reviewed head `47d6e6b623cd4efc2d6e5c88abb908fd66643771`, base `8ef20b06222db32b54b4bdf9e6c2223a1ebd4da4`.

The shared recovery/observer/revision contracts and manual-license removal had no additional blocker. One **P2** remained: an unknown cleanup proxy with a throwing prototype trap caused pinned Effect to discard the service failure while combining causes, before the adapter could inspect it. The private application-error brand itself worked.

Fixed at resource release boundaries with `releaseResource` in `application/services`: synchronous throws and Promise rejections are normalized into safe application errors before Effect combines them. `ApplicationError.fromUnknown` centralizes nonthrowing formatting. `MODULES.md` requires external finalizers to use this boundary; real module owners must adopt it, rather than relying only on a later runtime adapter.

Two public proxy regression cases failed before normalization. Four combined-failure cases now pass for commands and subscriptions, covering `ensuring` and scoped releases, synchronous throws and rejected Promises, ordinary errors and throwing proxies. Typed Uncertain, exact file target and cleanup detail survive. All fourteen application public-client tests pass, with typecheck and source/browser-boundary checks. Fresh exact-head review remains required.

Reviewer validation at the previous head passed frozen install, uncached diagnostics/twelve tests, foundation check and exact-head GitHub runs. No tracked code was changed by the reviewer. Sibling runtime adoption, actual module fan-in, packaged/native/provider/SSH/manual checks and human acceptance remain separate evidence.
