# jamiblossom (사주 계산)

`jamiblossom-0.1.0.tgz` is the [`jamiblossom`](https://github.com/jigglypop/jamiblossum) package as `npm pack --ignore-scripts` writes it. Nothing in it was changed here, and no npm publication is involved.

It was packed from a working tree at commit [`12b5404be8134c586de4276bcf8f247b50bb2f6e`](https://github.com/jigglypop/jamiblossum/commit/12b5404be8134c586de4276bcf8f247b50bb2f6e) that held uncommitted changes; its `dist/` is that tree's build of 2026-10-29. The commit alone does not rebuild this file.

Artifact: **248,625 bytes**. SHA256: `a54e027d19e6ba68aa1c6b03899356aa79873a30fdd8d0d0b9bed08d12f4481c`.

## Use

The 사주 village (`frontend/src/saju/`) reads 사주 through `frontend/src/saju/engine.ts` only:

- `calculateZiweiChart(request).saju` gives the four pillars with their 십성, 지장간, 12운성 and 납음, the 대운 and the 신살. The 자미두수 chart it calculates on the way is not shown.
- `calculateSinsal` judges the 신살 again from three pillars for a birth without an hour.
- `isValidKoreanDate`, `koreanLunarToSolar`, `koreanLunarMonthDays`, `timeBranchOptionsAtSeoulDate` and `timeToIndexAtSeoulDate` check a birth date and name the 시진 of its day.

It brings `iztro` 2.5.8 and `lunar-javascript` 1.7.7, at the versions its own `package.json` pins.

## Update

Build the library in its own repository (`pnpm build`), run `npm pack --ignore-scripts` there, put the tarball here under its version's name, point `frontend/package.json` at it and run `npm install` at the root. `frontend/src/saju/__tests__/` holds the charts the village expects of it.
