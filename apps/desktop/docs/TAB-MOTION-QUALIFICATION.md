# Tab motion sampling

The #127 CI failure in run `41964055784` reached the intermediate-position assertion after the 222 px opening displacement passed. Its old fixture wrote frames only after assertions, so that run supplies no frame-time evidence.

The same symptom is reproducible with the actual shell at a controlled Chromium CPU throttle of 40: open/close still move 222 px, but the original 32-rAF sampler records no intermediate positions. Fresh timestamped evidence has gaps of 2,711 ms on open and 6,803 ms on close, exceeding the existing 200 ms animation. This reproduces the sampling limitation; it does not retrospectively prove the unrecorded CI scheduler timing.

The focused test now installs Playwright's clock before application code, pauses from browser clock time after startup, and samples 32 explicit 16 ms advances. It retains the displacement, intermediate-position, inert/disabled exiting-control and reduced-motion assertions. Frames are written and attached before those assertions. The clock resumes for the existing rapid close/reopen journey. Production Motion configuration, duration, easing and reduced-motion handling are unchanged.

The same CPU-throttled probe passes with 16 ms sample gaps and ten intermediate positions for each direction. Its complete original rapid-reopen assertions pass as well. These controlled animation-time observations qualify interpolation and interaction semantics; they do not measure physical frame delivery or guarantee device performance.

Evidence is under `/tmp/moonbase-116-qualification-20261105/`: `motion-cpu-red-evidence.log`, `motion-red-evidence/`, `motion-cpu-clock-4.log` and `motion-clock-evidence-4/`. The first 20 ordinary normal/reduced-motion repeats passed before clock control; subsequent focused/final qualification belongs to the integrated delivery ledger. Earlier failed clock-fixture attempts are retained separately. No product workaround, disabled motion or removed assertion is involved.

## Middle-tab sampling

Find-layer CI run `41982795034` passed the positive/222px middle-tab closing displacement guards, then found no sampled intermediate position. Its supplied log does not establish frame timing. The middle-tab fixture still used an uncontrolled 32-rAF loop after the earlier open/close correction.

A new 40× CPU probe reproduces that exact assertion with 222px displacement, 33 samples, zero intermediates, a 7,190.9ms maximum gap and only `transform: none` observations. It writes timestamps and actual survivor/plus DOM transforms before assertions. The unchanged production animation passes when the fixture uses the existing clock technique: 32 advances of 16ms, ten non-scrolled and nine scrolled intermediates, actual matrix transforms, 222px/74px displacement respectively, unchanged vertical/monotonic/plus-control assertions. Both throttled cases pass within their existing 30s deadlines. Eight ordinary middle/open/close/reduced-motion repeats also pass. A test-only CSS negative control that removes survivor transforms still fails interpolation; that override is absent from tracked code.

Evidence: `middle-motion-red.log`/`middle-motion-red/`, `middle-motion-clock-green.log`/`middle-motion-clock-green/`, `middle-motion-clock-summary.json`, `middle-motion-negative.log` and `middle-motion-normal-reduced-green.log`, all under the same qualification directory. The fixture now attaches its frame JSON before assertions and resumes the clock after sampling. No production duration, easing, motion or reduced-motion change, assertion removal or deadline extension is involved. This establishes a controlled sampling failure and correction, not retrospective proof of CI scheduling or physical performance.
