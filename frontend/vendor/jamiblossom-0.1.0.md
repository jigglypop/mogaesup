# jamiblossom (사주·자미두수 계산)

`jamiblossom-0.1.0.tgz` is the [`jamiblossom`](https://github.com/jigglypop/jamiblossum) package as `npm pack --ignore-scripts` writes it. Nothing in it was changed here, and no npm publication is involved.

It was packed from a working tree at commit [`12b5404be8134c586de4276bcf8f247b50bb2f6e`](https://github.com/jigglypop/jamiblossum/commit/12b5404be8134c586de4276bcf8f247b50bb2f6e) that held uncommitted changes; its `dist/` is that tree's build of 2026-10-29. The commit alone does not rebuild this file.

Artifact: **248,625 bytes**. SHA256: `a54e027d19e6ba68aa1c6b03899356aa79873a30fdd8d0d0b9bed08d12f4481c`.

## Use

The 사주 village (`frontend/src/saju/`) reads 사주 and the 자미두수 명반 through `frontend/src/saju/engine.ts` only:

- `calculateZiweiChart(request)` is one calculation for both (`chartOf`). Its `saju` gives the four pillars with their 십성, 지장간, 12운성 and 납음, the 대운 and the 신살.
- The rest of that chart is the 자미두수 명반 of the 자미두수 tab, which `frontend/src/saju/ziwei.ts` lays out: the twelve `palaces` with their stars (brightness and 생년사화), 12신, 대한 and 소한, the 명궁 and 신궁, 오행국, 명주 and 신주, `surrounded` (삼방사정), `flies` (비성사화) and the 대한 running today (`horoscope.decadal`). A birth without an hour has no 명반 there: the library would read the day at noon.
- The library reads today's date itself (Seoul's clock) when it calculates, for what is running now: the 사주's 대운 (`saju.currentDaYunIndex`) and the 명반's 대한. So `engine.ts` keeps a chart only for the Seoul day it was drawn on, and a page left open draws it again the next day.
- `ziwei.ts` reads two things of the chart by tables of its own, which `frontend/src/saju/__tests__/ziwei.test.ts` holds to the library's charts: the brightness codes of the Korean chart (`[+3]` … `[-3]`, the library's `fmtBright`) and the place of each earthly branch on the ring (its `PALACE_GRID_AREAS`).
- `calculateSinsal` judges the 신살 again from three pillars for a birth without an hour.
- `isValidKoreanDate`, `koreanLunarToSolar`, `koreanLunarMonthDays`, `timeBranchOptionsAtSeoulDate` and `timeToIndexAtSeoulDate` check a birth date and name the 시진 of its day.

It brings `iztro` 2.5.8 and `lunar-javascript` 1.7.7, at the versions its own `package.json` pins.

## Update

Build the library in its own repository (`pnpm build`), run `npm pack --ignore-scripts` there, put the tarball here under its version's name, point `frontend/package.json` at it and run `npm install` at the root. `frontend/src/saju/__tests__/` holds the charts the village expects of it.
