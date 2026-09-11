# Real-device acceptance checks (pending)

Keep the beta label until these checks are completed on current Chrome/Edge,
Firefox and Safari, including at least one mobile browser. Automated mocks do not
establish browser compatibility or real microphone fault detection.

1. Open the test over HTTPS. Confirm no microphone prompt before Start. Deny
   permission, then allow it and retry. Stop while permission is pending and verify
   a late grant does not leave the microphone active.
2. Read the passage for 25 seconds. Check progress, live level, result and timeline.
   Stay silent for a second run: it must say inconclusive, not healthy or faulty.
3. Keep normal pauses, read louder/softer, tap a keyboard and make a mouth click.
   Review false positives; click-like spikes must not be called hardware faults.
4. Perform Before and After with nothing changed. Confirm the retained-connection
   label, and repeat several times to inspect variability.
5. End the session, change input and run After. Verify the reconnected label and
   settings warnings. Compare a hub and direct USB without changing other factors.
6. Unplug the active mic mid-run, hide the tab, end the session and reload. Check
   that incomplete runs are discarded, completed Before results survive cancelled
   After runs, and the microphone indicator clears after release.
7. Leave a completed run idle for 60 seconds; capture must release automatically.
   Uncheck the keep-connection option and verify immediate release after a run.
8. Check narrow mobile width, keyboard navigation, screen-reader status updates,
   200% text enlargement and all local navigation links.
9. Check the browser console for errors and the network panel for any audio or
   measurement payload uploads (none should occur). Confirm no audible mic loopback.
10. Induce known capture issues where practical and compare against an independent
    recording/monitor. Synthetic tests alone cannot establish sensitivity to real
    device faults, sustained crackle or audio processing artifacts.
