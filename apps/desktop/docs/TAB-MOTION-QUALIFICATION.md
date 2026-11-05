# Tab motion sampling

The #127 CI failure in run `41964055784` reached the intermediate-position assertion after the full 222 px open/close displacement passed. Its old fixture wrote frames only after assertions, so that run supplies no frame-time evidence.

The same symptom is reproducible with the actual shell at a controlled Chromium CPU throttle of 40: open/close still move 222 px, but the original 32-rAF sampler records no intermediate positions. Fresh timestamped evidence has gaps of 2,711 ms on open and 6,803 ms on close, exceeding the existing 200 ms animation. This reproduces the sampling limitation; it does not retrospectively prove the unrecorded CI scheduler timing.

The focused test now installs Playwright's clock before application code, pauses from browser clock time after startup, and samples 32 explicit 16 ms advances. It retains the displacement, intermediate-position, inert/disabled exiting-control and reduced-motion assertions. Frames are written and attached before those assertions. The clock resumes for the existing rapid close/reopen journey. Production Motion configuration, duration, easing and reduced-motion handling are unchanged.

The same CPU-throttled probe passes with 16 ms sample gaps and ten intermediate positions for each direction. Its complete original rapid-reopen assertions pass as well. These controlled animation-time observations qualify interpolation and interaction semantics; they do not measure physical frame delivery or guarantee device performance.

Evidence is under `/tmp/moonbase-116-qualification-20261105/`: `motion-cpu-red-evidence.log`, `motion-red-evidence/`, `motion-cpu-clock-4.log` and `motion-clock-evidence-4/`. The first 20 ordinary normal/reduced-motion repeats passed before clock control; subsequent focused/final qualification belongs to the integrated delivery ledger. Earlier failed clock-fixture attempts are retained separately. No product workaround, disabled motion or removed assertion is involved.
