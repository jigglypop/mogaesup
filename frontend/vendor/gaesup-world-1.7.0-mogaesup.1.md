# Local gaesup-world engine patch

`gaesup-world-1.7.0-mogaesup.1.tgz` derives from the installed npm **1.7.0** package's `gaesupRelease.sourceCommit`, [`dc676864f9dbefa03958a7e67ba4ed8e5863767c`](https://github.com/jigglypop/gaesup-world/commit/dc676864f9dbefa03958a7e67ba4ed8e5863767c). The commit was fetched from the actual origin and exported into an isolated staging directory. Its source package.json says 1.6.0 because npm release metadata is updated during semantic release. This artifact preserves the 1.7.0 source and is not a rebuild of the current engine checkout's older 1.1.0 metadata.

The source fixes also live in `C:/dev/gaesup-world`, without changing that repository's branch, package version, or pre-existing `.claude` work. No npm publication occurred.

## Changes

- Remote avatars preserve authored GLB colours by default. `rendering.tintCharacter: true` explicitly opts into whole-character tinting.
- `rendering.materialPolicy` accepts the same `keep`, `prop`, and `figure` policies as local models. The app uses `figure` for both.
- `useMultiplayer({ visualRotationRef })` samples the visible group's world quaternion instead of a rotation-locked physics body. Velocity fallback faces canonical +Z, preserves its direction after stopping, and has no implicit 180-degree correction.
- Network animation tracking samples the playing scoped animation bridge. Remote animation resolution uses the canonical figure aliases and avoids an unrelated first clip.
- Receiver quaternions scale by their largest component before normalizing, preserving direction for large and tiny finite values and correcting quantized rotations.

The `.patch` records the exact source and regression changes against that release commit. Version/provenance-only package.json changes are recorded in `.provenance.json`.

## Package preservation

Exports, peer dependencies, runtime dependencies, and the npm files list equal the installed 1.7.0 contract. All **87** installed public/WASM/Unity files are present. The two WASMs and every binary GLB/image asset are byte-identical. Six text files differ only in CRLF/LF endings from exporting the Windows checkout; their contents are equal after newline normalization. Per-file hashes and these six paths are recorded in `.provenance.json`.

Artifact: **22,814,432 bytes**. SHA256: `bd16a45f64dafc19347359dc45e55b4d6d43a9784c20f9842ceef711d2b35c85`.

## Verification

- Exact release staging: five focused suites, **38 tests** passed. Current engine worktree: five focused suites, **37 tests** passed (the release has one additional DOM-nameplate regression).
- Whole `npm run typecheck`; ESM/CJS/declarations `npm run build`; `publint 0.3.24`: passed.
- Fresh consumer packed the identical SHA512 artifact and passed strict ESM/CJS/compat declarations, runtime imports, Rapier grounding, NPC/save runtime and Vite build.
- New public network API contract compiled in that fresh consumer.

These are CPU/unit/package checks. Browser visual appearance, GPU behaviour and multiplayer motion still require app runtime verification.

## Rebuild

Fetch/export the commit above, apply the adjacent source patch, set the staging package version and `gaesupRelease` to the values in the tarball, and install the release's dependencies. Run `npm run typecheck`, `npm run build`, `publint`, and `npm run test:package:built`; then `npm pack --ignore-scripts` after the fresh build. The package is consumed through `file:vendor/gaesup-world-1.7.0-mogaesup.1.tgz`.
