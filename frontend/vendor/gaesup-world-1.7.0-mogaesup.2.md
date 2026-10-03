# Local gaesup-world engine patch

`gaesup-world-1.7.0-mogaesup.2.tgz` derives from the npm **1.7.0** package's `gaesupRelease.sourceCommit`, [`dc676864f9dbefa03958a7e67ba4ed8e5863767c`](https://github.com/jigglypop/gaesup-world/commit/dc676864f9dbefa03958a7e67ba4ed8e5863767c), exported into an isolated staging directory. It replaces `1.7.0-mogaesup.1`; the adjacent `.patch` is cumulative against that release commit. No npm publication occurred.

## Changes

From mogaesup.1:

- Remote avatars keep authored GLB colours by default; `rendering.tintCharacter: true` opts into whole-character tinting. `rendering.materialPolicy` accepts `keep`, `prop` and `figure`.
- `useMultiplayer({ visualRotationRef })` samples the visible group's world quaternion. Velocity fallback faces canonical +Z and keeps its direction after stopping.
- Network animation tracking samples the playing scoped animation; remote resolution uses the figure aliases.
- Receiver quaternions are scaled by their largest component before normalizing.

New in mogaesup.2:

- Every update carries `t`, the sender's sample time (ms). Receivers draw a peer on the sender's timeline: the clock offset is the smallest arrival−send gap over 2 s windows, slewed; the playout delay adapts to the measured interval and lateness (60–320 ms). Late samples extrapolate at most 120 ms, only while moving, and ease back over 250 ms. A jump over 6 m (1.5 m in the first 1.5 s) snaps. Updates without `t` fall back to arrival times.
- The receiver chooses idle/walk/run from the drawn speed with hysteresis (starts at 0.8 m/s, stops at 0.35 m/s) and holds a clip at least 150 ms; cross-fades no longer warp.
- The remote body is a kinematic sensor and the drawn avatar is a world-space sibling placed every frame, so a visitor never shoves the local player and moves smoothly above the physics rate. Remote figures cast and receive shadows and get the contact shadow.
- A moving remote avatar keeps the frame scheduler at its active rate.
- A hidden tab sends one paused update (zero velocity, idle) instead of freezing mid-stride.

## Package preservation

Exports, dependencies, peer dependencies and the files list equal mogaesup.1. The tarball holds the same 2322 paths except two renamed hashed chunks. Every recorded asset, including both WASMs, is byte-identical to mogaesup.1 (hashes in `.provenance.json`).

Artifact: **22,819,499 bytes**. SHA256: `23daad9aaf82169e941beb1e13bcb1545a902fbbd7578ccecd4353a35316b30d`.

## Verification

- `src/core/networks`: 230 tests passed, including jitter pacing, stop without slide, keepalive, teleport, late first position, Welcome snapshot and stream stop.
- Acceptance suite passed; the moving-update byte budget is 136 (the update now carries `t`).
- `npm run typecheck`, `npm run build`, `publint 0.3.24` and `npm run test:package:built` passed.

## Rebuild

Export the commit above, apply the `.patch`, set `version` and `gaesupRelease` to the values in the tarball, install the release's dependencies, run the checks above and `npm pack --ignore-scripts` after the fresh build. The app consumes it through `file:vendor/gaesup-world-1.7.0-mogaesup.2.tgz`.
