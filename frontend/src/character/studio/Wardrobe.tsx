import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { NoColorSpace, TextureLoader, type Texture } from 'three';
import { problemText } from '../../api/client';
import { lookApi } from '../../api/endpoints';
import type { Look, LookRequest } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { can } from '../../auth/can';
import { studioHref } from '../../studio/screens';
import { useTabs } from '../../ui/tabs';
import { isDefinitiveRejection, isRevisionConflict } from '../api';
import { factoryApi, wardrobeUrls, wardrobePartSha, type WardrobeColors, type WardrobeCoverage, type WardrobeOutfit, type WardrobePart } from '../factory/api';
import { compatiblePartSlots, garmentSlots, hasConflictingPartSlots, partLabels as labels, selectPartSlot, variantSlots } from '../factory/parts';
import '../factory/meshy-motion.css';
import { usePolling } from '../use-polling';
import { ModelViewer } from '../viewer';
import type { Tuck } from '../native-wardrobe';
import { createHeldLoads } from './held-loads';
import { PartPreview } from './PartPreview';
import { fitReason, reshapable, unfittedParts } from './wardrobe-view';
import { WardrobeShape } from './WardrobeShape';
import './wardrobe.css';

const hairSlots: readonly string[] = ['hair', 'hairFront', 'hairBack'];
const slotOrder: readonly string[] = [...hairSlots, ...variantSlots.filter(slot => slot !== 'hair')];
const methodLabels: Record<string, string> = { 'worn-extract-v1': '입힌 채', 'body-shell-v1': '몸 셸', 'uniform-slot-v1': '단독' };
const keyOf = (part: { job_id: string; version: string }, slot: string) => `${part.job_id}:${part.version}:${slot}`;
// Slots with a coverage record: garments hide skin and layer; a hat and hair layer too.
const coveredSlots: readonly string[] = [...garmentSlots, 'hat', 'hair'];
type Worn = Record<string, WardrobePart>;
type Palette = { regions: WardrobeColors['regions']; material: number; mask: Texture };

/** A worn garment's colour regions and the mask texture that tells where they are. */
async function loadPalette(part: WardrobePart, signal: AbortSignal): Promise<Palette> {
  const value = await factoryApi.wardrobeColors(part, signal);
  const mask = await new TextureLoader().loadAsync(wardrobeUrls.colorMask(part));
  mask.flipY = false; mask.colorSpace = NoColorSpace; mask.needsUpdate = true;
  return { regions: value.regions, material: value.material, mask };
}

function decodeBits(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function decodeTuck(coverage: WardrobeCoverage): Tuck | null {
  if (!coverage.anchors || !coverage.tucks || !coverage.anchor_keys) return null;
  const decode = <T,>(values: Record<string, string>, make: (buffer: ArrayBuffer, length: number) => T) => Object.fromEntries(
    Object.entries(values).map(([key, value]) => { const bytes = decodeBits(value); return [key, make(bytes.buffer, bytes.length >> 2)]; }));
  return { anchors: decode(coverage.anchors, (buffer, length) => new Int32Array(buffer, 0, length)),
    moves: decode(coverage.tucks, (buffer, length) => new Float32Array(buffer, 0, length)), keys: coverage.anchor_keys };
}
function unionBits(target: Record<string, Uint8Array>, hidden: Record<string, string>) {
  for (const [key, value] of Object.entries(hidden)) {
    const bits = decodeBits(value);
    target[key] = target[key] ? target[key].map((byte, index) => byte | (bits[index] || 0)) : bits;
  }
}
type PendingSave = { id: string; key: string; revision: string; input: WardrobeOutfit };
/** How often a look being assembled is asked about. */
const LOOK_POLL_MS = 1500;
const outfitOfLook = (request: LookRequest): WardrobeOutfit => ({
  name: '', body: { job_id: request.body.jobId, version: request.body.version }, hair_color: request.hairColor,
  parts: Object.fromEntries(Object.entries(request.parts).map(([slot, part]) => [slot, { job_id: part.jobId, version: part.version, sha256: part.sha256 }])),
  colors: request.colors,
});

export default function Wardrobe() {
  const { user } = useAuth();
  // Saved outfits are the studio's own records: only operators change them.
  const admin = can(user, 'operator');
  // Rebuilding a part's shape is paid studio work on a part everyone shares.
  const paidOperator = can(user, 'paid_operator');
  const bodies = usePolling(factoryApi.wardrobeBodies, 30000);
  const outfits = usePolling(factoryApi.wardrobeOutfits, 30000);
  const [bodyId, setBodyId] = useState('');
  const registered = bodies.value?.bodies || [];
  const body = registered.find(item => item.job_id === bodyId) || registered.find(item => item.is_default) || registered[0];
  const readParts = useCallback((signal: AbortSignal) => body ? factoryApi.wardrobeParts(body.job_id, signal) : Promise.resolve(null), [body?.job_id, body?.version, body?.body_sha256]);
  const library = usePolling(readParts, 30000);
  const sameBody = (value: { job_id: string; version: string; body_sha256: string }) => body?.job_id === value.job_id && body.version === value.version && body.body_sha256 === value.body_sha256;
  const libraryMatchesBody = !!library.value && sameBody(library.value.body);
  const reloadParts = useCallback(async (signal?: AbortSignal) => {
    if (!body) return [];
    const value = await factoryApi.wardrobeParts(body.job_id, signal);
    if (!sameBody(value.body)) throw new Error('옷장 몸 버전이 바뀌었습니다. 몸과 파츠를 다시 불러와 주세요.');
    library.setValue(value);
    return value.parts;
  }, [body?.job_id, body?.version, body?.body_sha256, library.setValue]);
  const parts = libraryMatchesBody ? library.value!.parts : [];
  const unfitted = libraryMatchesBody ? unfittedParts(library.value!.unavailable, admin) : [];
  const slots = slotOrder.filter(slot => parts.some(part => part.slot === slot));
  const [slot, setSlot] = useState('hair');
  const activeSlot = slots.includes(slot) ? slot : slots[0];
  const tabs = useTabs(slots, activeSlot ?? '', setSlot);

  const mount = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<ModelViewer | null>(null);
  const [clips, setClips] = useState<{ name: string; index: number }[]>([]), [motion, setMotion] = useState(-1);
  const [attempt, setAttempt] = useState(0), [modelError, setModelError] = useState('');
  const [worn, setWorn] = useState<Worn>({}), applied = useRef<Worn>({});
  const [appliedKey, setAppliedKey] = useState('');
  const [coverages, setCoverages] = useState<Record<string, WardrobeCoverage>>({});
  // A part whose covered skin could not be read: shown with a retry, and it holds back no action (the server works out
  // the same skin when it assembles the look).
  const [coverageErrors, setCoverageErrors] = useState<Record<string, string>>({}), [coverageAttempt, setCoverageAttempt] = useState(0);
  // Colour regions and chosen colours, both keyed by part (a new part starts from its own colours).
  const [palettes, setPalettes] = useState<Record<string, Palette>>({});
  const [colors, setColors] = useState<Record<string, Record<string, string>>>({});
  // One colour mask per worn garment: loaded once, let go when the garment comes off or is replaced.
  const maskLoads = useRef<ReturnType<typeof createHeldLoads<WardrobePart, Palette>> | null>(null);
  useEffect(() => {
    const loads = createHeldLoads<WardrobePart, Palette>({
      load: loadPalette,
      release: palette => palette.mask.dispose(),
      ready: (key, palette) => setPalettes(current => ({ ...current, [key]: palette })),
      dropped: key => setPalettes(current => Object.fromEntries(Object.entries(current).filter(([item]) => item !== key))),
    });
    maskLoads.current = loads;
    return () => { loads.dispose(); maskLoads.current = null; };
  }, []);
  const [wearing, setWearing] = useState(false), [wearError, setWearError] = useState(''), [notice, setNotice] = useState('');
  const [hairColor, setHairColor] = useState<string | null>(null);
  const [outfitName, setOutfitName] = useState(''), [loadedId, setLoadedId] = useState('');
  const [busy, setBusy] = useState(false), [saveError, setSaveError] = useState('');
  const pendingSave = useRef<PendingSave | null>(null), pendingOutfit = useRef<WardrobeOutfit | null>(null);
  // The member's own character: saved here, assembled by the server, worn on their island.
  const [look, setLook] = useState<Look | null>(null), [lookBusy, setLookBusy] = useState(false), [lookError, setLookError] = useState('');
  const [lookReady, setLookReady] = useState(false), [lookAttempt, setLookAttempt] = useState(0);
  const lookGeneration = useRef(0), lookPending = useRef(false), lookRead = useRef<AbortController | null>(null);
  const restoreLook = useRef(false);
  const baking = look?.status === 'baking';
  useEffect(() => {
    const mine = ++lookGeneration.current;
    const controller = new AbortController();
    lookRead.current?.abort(); lookRead.current = controller;
    lookPending.current = false; restoreLook.current = false; pendingOutfit.current = null;
    setLook(null); setLookReady(false); setLookError(''); setLookBusy(false);
    lookApi.mine(controller.signal).then(value => {
      if (controller.signal.aborted || mine !== lookGeneration.current) return;
      setLook(value.look);
      if (value.look) {
        pendingOutfit.current = outfitOfLook(value.look.request);
        restoreLook.current = true;
        setBodyId(value.look.request.body.jobId);
      } else setLookReady(true);
    }, reason => { if (!controller.signal.aborted && mine === lookGeneration.current) setLookError(problemText(reason)); });
    return () => { controller.abort(); lookGeneration.current++; };
  }, [user?.id, lookAttempt]);
  useEffect(() => {
    if (!baking || lookBusy) return;
    const mine = lookGeneration.current;
    const controller = new AbortController();
    lookRead.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await lookApi.mine(controller.signal);
        if (controller.signal.aborted || mine !== lookGeneration.current) return;
        setLook(value.look); setLookError('');
        if (value.look?.status !== 'baking') return;
      } catch (reason) {
        if (controller.signal.aborted || mine !== lookGeneration.current) return;
        setLookError(problemText(reason));
      }
      timer = setTimeout(() => void poll(), LOOK_POLL_MS);
    };
    timer = setTimeout(() => void poll(), LOOK_POLL_MS);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [baking, lookBusy, user?.id]);

  useEffect(() => {
    setViewer(null); setModelError(''); setClips([]); applied.current = {}; setWorn({}); setAppliedKey(''); setNotice('');
    if (!body || !mount.current) return;
    let active = true;
    const instance = new ModelViewer(mount.current, 'studio');
    void instance.load(wardrobeUrls.body(body), { sha256: body.body_sha256, wardrobe: true }).then(value => {
      if (!active) return;
      setClips(value); instance.play(-1); setMotion(-1); setViewer(instance);
    }).catch(reason => { if (active) setModelError((reason as Error).message); });
    return () => { active = false; instance.dispose(); };
  }, [body?.job_id, body?.version, body?.body_sha256, attempt]);

  const wornKey = Object.values(worn).map(part => keyOf(part, part.slot)).sort().join('|');
  useEffect(() => {
    if (!viewer) return;
    let active = true; setWearing(true);
    const wearables = Object.values(worn).map(part => ({ id: keyOf(part, part.slot), slot: part.slot, url: wardrobeUrls.part(part), sha256: wardrobePartSha(part) }));
    void viewer.wear(wearables).then(done => { if (done && active) { applied.current = { ...worn }; setAppliedKey(wornKey); } })
      .catch(reason => { if (active) { setWearError((reason as Error).message); setWorn({ ...applied.current }); } })
      .finally(() => { if (active) setWearing(false); });
    return () => { active = false; };
  }, [wornKey, viewer]);
  useEffect(() => { viewer?.setHairColor(hairColor); }, [viewer, hairColor]);
  // A refit gives a job a new version: wear it in place of the one the list no longer has.
  useEffect(() => {
    const listed = libraryMatchesBody ? library.value!.parts : undefined;
    if (!listed) return;
    setWorn(current => {
      const next = { ...current }; let changed = false;
      for (const [slotName, part] of Object.entries(current)) {
        if (listed.some(item => keyOf(item, slotName) === keyOf(part, slotName))) continue;
        const replacement = listed.find(item => item.slot === slotName && item.job_id === part.job_id);
        if (replacement) { next[slotName] = replacement; changed = true; }
      }
      return changed ? next : current;
    });
  }, [library.value, libraryMatchesBody]);

  const coverageKey = (part: WardrobePart) => `${body?.job_id}:${body?.version}:${body?.geometry_sha256}|${keyOf(part, part.slot)}`;
  // Skin under worn garments: fetch each garment's covered body triangles once.
  useEffect(() => {
    if (!body) return;
    const controller = new AbortController();
    for (const part of Object.values(applied.current)) {
      const key = coverageKey(part);
      if (!coveredSlots.includes(part.slot) || coverages[key]) continue;
      void factoryApi.wardrobeCoverage(body.job_id, part, controller.signal)
        .then(value => {
          if (controller.signal.aborted) return;
          setCoverages(current => ({ ...current, [key]: value }));
          setCoverageErrors(current => Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)));
        })
        .catch(reason => { if (!controller.signal.aborted) setCoverageErrors(current => ({ ...current, [key]: `${labels[part.slot] || part.slot} 가림 영역: ${(reason as Error).message}` })); });
    }
    return () => controller.abort();
  }, [appliedKey, body?.job_id, body?.version, body?.geometry_sha256, coverageAttempt]);
  useEffect(() => {
    if (!viewer) return;
    const top = applied.current.top;
    if (top && applied.current.bottom && coverages[coverageKey(top)]?.covers_bottom) {
      setNotice('상의가 하의 구간까지 덮어 하의를 벗겼습니다.'); takeOff('bottom'); return;
    }
    const union: Record<string, Uint8Array> = {};
    for (const part of Object.values(applied.current)) {
      const coverage = coverages[coverageKey(part)];
      if (coverage) unionBits(union, coverage.hidden);
    }
    viewer.setHiddenBodyTriangles(Object.keys(union).length ? union : null);
    // Garments from different jobs overlap by centimetres: an inner garment (a waistband) is pressed
    // onto the skin where the outer garments worn with it (top, shoes) cover the body; shoes offer only
    // the leg above them unless they are boots. Hair presses only under a top or hat that covers the
    // head (a raised hood), never under a hood lying on the back.
    for (const [slotName, part] of Object.entries(applied.current)) {
      const coverage = coverages[coverageKey(part)];
      const tuck = coverage && decodeTuck(coverage);
      if (!tuck) continue;
      const outer: Record<string, Uint8Array> = {};
      for (const over of coverage.under || []) {
        const covering = applied.current[over] && coverages[coverageKey(applied.current[over])];
        if (!covering) continue;
        if (slotName !== 'hair') unionBits(outer, covering.over || covering.hidden);
        else if (covering.covers_head) unionBits(outer, covering.over || covering.hidden);
      }
      viewer.setTucked(slotName, tuck, Object.keys(outer).length ? outer : null);
    }
  }, [appliedKey, coverages, viewer]);

  function applyOutfit(outfit: WardrobeOutfit, listed: WardrobePart[]) {
    const next: Worn = {};
    const slots = compatiblePartSlots(Object.keys(outfit.parts));
    for (const [slotName, ref] of Object.entries(outfit.parts)) {
      if (!slots.includes(slotName)) continue;
      const part = listed.find(item => item.slot === slotName && item.job_id === ref.job_id && item.version === ref.version && item.sha256 === ref.sha256)
        // A refit gives the job a new version; its current part in that slot is the same part refitted.
        || listed.find(item => item.slot === slotName && item.job_id === ref.job_id);
      if (!part) { setWearError(`${labels[slotName] || slotName} 파츠를 옷장에서 찾을 수 없습니다.`); return; }
      next[slotName] = part;
    }
    setWearError(''); setWorn(next); setHairColor(outfit.hair_color || null);
    const removed = Object.keys(outfit.parts).filter(slot => !slots.includes(slot));
    setNotice(removed.length ? `겹치는 머리 파츠를 벗겼습니다: ${removed.map(slot => labels[slot] || slot).join(', ')}` : '');
    setColors(current => {
      const updated = { ...current };
      Object.entries(next).forEach(([slotName, part]) => {
        const saved = outfit.colors?.[slotName];
        if (saved && Object.keys(saved).length) updated[keyOf(part, slotName)] = { ...saved };
        else delete updated[keyOf(part, slotName)];
      });
      return updated;
    });
  }
  // Colour regions of worn clothing (hair keeps its own colour control). A part without a texture keeps its colours:
  // its load fails quietly and the swatches stay hidden.
  useEffect(() => {
    const garments = new Map<string, WardrobePart>();
    for (const part of Object.values(applied.current)) if (!hairSlots.includes(part.slot)) garments.set(keyOf(part, part.slot), part);
    maskLoads.current?.want(garments);
  }, [appliedKey]);
  useEffect(() => {
    if (!viewer) return;
    for (const part of Object.values(applied.current)) {
      const key = keyOf(part, part.slot), palette = palettes[key];
      if (!palette) continue;
      const chosen = colors[key] || {};
      viewer.setPartColors(part.slot, palette.material, palette.mask, palette.regions.map(region => region.light), [0, 1, 2, 3].map(index => chosen[String(index)] || null));
    }
  }, [appliedKey, palettes, colors, viewer]);
  // An outfit on another body is worn once that body and its parts have loaded. Restoring the saved look ends there, and
  // also when the bodies, the body's model or its parts fail to load: the screen opens and shows the error, and the
  // saved look still goes on once a retry brings what was missing.
  useEffect(() => {
    const outfit = pendingOutfit.current;
    const restored = () => { if (restoreLook.current) { restoreLook.current = false; setLookReady(true); } };
    if (outfit && bodies.value && !registered.some(item => item.job_id === outfit.body.job_id && item.version === outfit.body.version)) {
      pendingOutfit.current = null; restored();
      setWearError('저장된 몸 버전을 옷장에서 찾을 수 없습니다.'); return;
    }
    if (modelError || (!libraryMatchesBody && library.error) || (!bodies.value && bodies.error)) restored();
    if (!outfit || !viewer || !body || outfit.body.job_id !== body.job_id || outfit.body.version !== body.version || !libraryMatchesBody) return;
    pendingOutfit.current = null;
    applyOutfit(outfit, library.value!.parts);
    restored();
  }, [viewer, library.value, libraryMatchesBody, body?.job_id, body?.version, bodies.value, look?.request, modelError, library.error, bodies.error]);

  function toggle(part: WardrobePart) {
    setWearError(''); setNotice('');
    const dress = worn.top && coverages[coverageKey(worn.top)]?.covers_bottom;
    if (part.slot === 'bottom' && dress && !worn.bottom) setNotice('하의를 입어 원피스 상의를 벗겼습니다.');
    setWorn(current => {
      const next = { ...current }, prior = current[part.slot];
      if (prior && keyOf(prior, part.slot) === keyOf(part, part.slot)) delete next[part.slot];
      else {
        const selected = selectPartSlot(Object.keys(current), part.slot);
        for (const slot of Object.keys(next)) if (!selected.includes(slot)) delete next[slot];
        next[part.slot] = part;
        if (part.slot === 'bottom' && dress) delete next.top;
      }
      return next;
    });
  }
  function takeOff(slotName: string) {
    setWearError('');
    setWorn(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== slotName)));
  }
  function wear(id: string) {
    const outfit = outfits.value?.outfits[id];
    if (!outfit) return;
    setLoadedId(id); setOutfitName(outfit.name);
    if (body && outfit.body.job_id === body.job_id && outfit.body.version === body.version) applyOutfit(outfit, parts);
    else if (registered.some(item => item.job_id === outfit.body.job_id && item.version === outfit.body.version)) { pendingOutfit.current = outfit; setBodyId(outfit.body.job_id); }
    else setWearError('이 조합의 옷장 몸이 등록돼 있지 않거나 버전이 바뀌었습니다.');
  }
  async function saveOutfit() {
    if (!body || !libraryMatchesBody || !outfits.value || busy) return;
    if (hasConflictingPartSlots(Object.keys(applied.current))) { setSaveError('겹치는 머리 파츠를 벗긴 뒤 저장해 주세요.'); return; }
    const input: WardrobeOutfit = {
      name: outfitName.trim(), body: { job_id: body.job_id, version: body.version }, hair_color: hairColor,
      parts: Object.fromEntries(Object.entries(applied.current).map(([slotName, part]) => [slotName, { job_id: part.job_id, version: part.version, sha256: part.sha256 }])),
      colors: Object.fromEntries(Object.entries(applied.current)
        .filter(([slotName, part]) => !hairSlots.includes(slotName) && Object.keys(colors[keyOf(part, slotName)] || {}).length)
        .map(([slotName, part]) => [slotName, colors[keyOf(part, slotName)] || {}])),
    };
    const same = pendingSave.current && JSON.stringify(pendingSave.current.input) === JSON.stringify(input);
    const reuse = loadedId && outfits.value.outfits[loadedId]?.name === input.name ? loadedId : '';
    const request = same ? pendingSave.current! : { id: reuse || crypto.randomUUID().replace(/-/g, ''), key: crypto.randomUUID(), revision: outfits.value.revision, input };
    pendingSave.current = request; setBusy(true); setSaveError('');
    try {
      outfits.setValue(await factoryApi.saveWardrobeOutfit(request.id, request.input, request.revision, request.key));
      pendingSave.current = null; setLoadedId(request.id);
    } catch (reason) {
      if (isDefinitiveRejection(reason)) pendingSave.current = null;
      // Someone saved first: the revision read here is stale, so read the list again before the next try.
      if (isRevisionConflict(reason)) void outfits.refresh();
      setSaveError((reason as Error).message);
    } finally { setBusy(false); }
  }
  /** What is worn now, as the look the server assembles: the body, a part per slot, hair and garment colours. */
  function currentLook(): LookRequest | null {
    if (!body) return null;
    const worn = Object.entries(applied.current);
    return {
      body: { jobId: body.job_id, version: body.version },
      parts: Object.fromEntries(worn.map(([slotName, part]) => [slotName, { jobId: part.job_id, version: part.version, sha256: part.sha256 }])),
      hairColor: worn.some(([slotName]) => hairSlots.includes(slotName)) ? hairColor : null,
      colors: Object.fromEntries(worn
        .filter(([slotName, part]) => !hairSlots.includes(slotName) && Object.keys(colors[keyOf(part, slotName)] || {}).length)
        .map(([slotName, part]) => [slotName, colors[keyOf(part, slotName)] || {}])),
    };
  }
  async function saveLook() {
    const request = currentLook();
    if (!request || !libraryMatchesBody || !lookReady || lookPending.current) return;
    if (hasConflictingPartSlots(Object.keys(request.parts))) { setLookError('겹치는 머리 파츠를 벗긴 뒤 저장해 주세요.'); return; }
    lookPending.current = true;
    const mine = ++lookGeneration.current;
    lookRead.current?.abort();
    setLookBusy(true); setLookError('');
    try { const value = await lookApi.save(request); if (mine === lookGeneration.current) setLook(value.look); }
    catch (reason) { if (mine === lookGeneration.current) setLookError(problemText(reason)); }
    finally { if (mine === lookGeneration.current) { lookPending.current = false; setLookBusy(false); } }
  }
  async function wearLook() {
    if (lookPending.current) return;
    lookPending.current = true;
    const mine = ++lookGeneration.current;
    lookRead.current?.abort();
    setLookBusy(true); setLookError('');
    try { const value = await lookApi.wear(true); if (mine === lookGeneration.current) setLook(value.look); }
    catch (reason) { if (mine === lookGeneration.current) setLookError(problemText(reason)); }
    finally { if (mine === lookGeneration.current) { lookPending.current = false; setLookBusy(false); } }
  }
  async function remove(id: string) {
    if (!outfits.value || busy) return;
    setBusy(true); setSaveError('');
    try { outfits.setValue(await factoryApi.deleteWardrobeOutfit(id, outfits.value.revision)); if (loadedId === id) setLoadedId(''); }
    catch (reason) {
      if (isRevisionConflict(reason)) void outfits.refresh();
      setSaveError((reason as Error).message);
    }
    finally { setBusy(false); }
  }

  const settled = !!viewer && libraryMatchesBody && !wearing && wornKey === appliedKey;
  const savedOutfits = Object.entries(outfits.value?.outfits || {}).sort(([, a], [, b]) => (b.saved_at || '').localeCompare(a.saved_at || ''));
  const shapes = reshapable(worn, paidOperator);
  const coverageProblems = Object.values(applied.current).map(part => coverageErrors[coverageKey(part)]).filter((value): value is string => !!value);
  if (bodies.value && registered.length === 0) {
    // Bodies are registered on the base body screen, which only paid operators open.
    return <div className="wardrobe workspace-content"><div className="workspace-heading"><h1>옷장</h1></div>
      <p className="wardrobe-empty">등록된 옷장 몸이 없습니다.{paidOperator && <> <Link to={studioHref({ tab: 'character', mode: 'body' })}>기본몸 화면에서 등록</Link></>}</p></div>;
  }
  return <div className="wardrobe workspace-content">
    <div className="workspace-heading"><h1>옷장</h1>
      {registered.length > 0 && <select aria-label="옷장 몸" disabled={!lookReady} value={body?.job_id || ''} onChange={event => { pendingOutfit.current = null; restoreLook.current = false; setWearError(''); setBodyId(event.target.value); setLoadedId(''); }}>
        {registered.map(item => <option key={item.job_id} value={item.job_id}>{item.name}{item.is_default ? ' · 기본 몸' : ''}</option>)}
      </select>}
    </div>
    <div className="wardrobe-layout">
      <section className="wardrobe-stage">
        <div className="meshy-scene wardrobe-scene" ref={mount} />
        <div className="meshy-clips"><button disabled={!viewer} aria-pressed={motion === -1} onClick={() => { viewer?.play(-1); setMotion(-1); }}>기본 자세</button>
          {clips.map(clip => <button key={clip.index} disabled={!viewer} aria-pressed={motion === clip.index} onClick={() => { viewer?.play(clip.index); setMotion(clip.index); }}>{clip.name}</button>)}</div>
        {worn.hair && <div className="wardrobe-hair-color"><label>헤어 색상<input type="color" value={hairColor || '#8a7998'} onChange={event => setHairColor(event.target.value)} /></label>
          <span>{hairColor || '원본 색상'}</span><button type="button" onClick={() => setHairColor(null)}>원본 색상</button></div>}
        {(!viewer || wearing) && !modelError && !(bodies.error && !body) && <p role="status">{viewer ? '파츠를 입히는 중…' : '옷장 몸을 불러오는 중…'}</p>}
        {bodies.error && <p role="alert">{bodies.error} <button type="button" onClick={() => void bodies.refresh()}>몸 목록 다시 불러오기</button></p>}
        {modelError && <p role="alert">{modelError} <button type="button" onClick={() => setAttempt(value => value + 1)}>다시 불러오기</button></p>}
        {wearError && <p role="alert">{wearError}</p>}
        {coverageProblems.length > 0 && <p role="alert">{coverageProblems.join(' · ')} <button type="button" onClick={() => { setCoverageErrors({}); setCoverageAttempt(value => value + 1); }}>가림 영역 다시 불러오기</button></p>}
        {notice && <p role="status">{notice}</p>}
      </section>
      <section className="wardrobe-closet">
        <div className="wardrobe-slots" {...tabs.list} aria-label="파츠 종류">{slots.map(slotName =>
          <button key={slotName} type="button" {...tabs.tab(slotName)}>
            {labels[slotName] || slotName} <span>{parts.filter(part => part.slot === slotName).length}</span></button>)}</div>
        {body && !libraryMatchesBody && !library.error && <p role="status">파츠 목록을 불러오는 중…</p>}
        {library.value && !libraryMatchesBody && <p role="alert">몸과 파츠의 버전이 다릅니다. 새 몸의 파츠를 기다리는 중입니다.</p>}
        {library.error && <p role="alert">{library.error}</p>}
        {libraryMatchesBody && parts.length === 0 && <p className="wardrobe-empty">이 몸으로 만든 파츠가 없습니다.</p>}
        <div className="wardrobe-cards" {...(activeSlot ? tabs.panel(activeSlot) : {})}>{parts.filter(part => part.slot === activeSlot).map(part => {
          const wornPart = worn[part.slot], selected = !!wornPart && keyOf(wornPart, part.slot) === keyOf(part, part.slot);
          return <button key={keyOf(part, part.slot)} type="button" className="wardrobe-card" aria-pressed={selected} disabled={!viewer || !lookReady} onClick={() => toggle(part)}>
            <PartPreview part={part} refreshed={library.receivedAt} />
            <strong>{part.name}</strong>
            {/* Where a part came from and how it was fitted matter to operators, not to someone dressing up. */}
            {admin && <small>{[part.character_name !== part.name ? part.character_name : '', methodLabels[part.fit_method || ''] || ''].filter(Boolean).join(' · ')}</small>}
            {admin && part.fit_check?.status === 'fail' && <small className="wardrobe-card-fit">{part.fit_check.failures.join(' · ')}</small>}
          </button>;
        })}</div>
        {unfitted.length > 0 && <ul className="wardrobe-unfit">{unfitted.map(item => <li key={keyOf(item, item.slot)}>
          <strong>{item.name}</strong><small>{labels[item.slot] || item.slot} · {fitReason(item.reason)}</small></li>)}</ul>}
        <div className="wardrobe-worn"><h2>입은 파츠</h2>
          {Object.keys(worn).length === 0 ? <p className="wardrobe-empty">기본 몸만 입고 있습니다.</p>
            : <ul>{slotOrder.filter(slotName => worn[slotName]).map(slotName => <li key={slotName}>
              <span>{labels[slotName] || slotName}</span><strong>{worn[slotName]?.name}</strong>
              <button type="button" onClick={() => takeOff(slotName)}>벗기기</button></li>)}</ul>}
        </div>
        {Object.values(worn).some(part => palettes[keyOf(part, part.slot)]) && <div className="wardrobe-colors"><h2>옷 색</h2>
          <ul>{slotOrder.filter(slotName => worn[slotName] && palettes[keyOf(worn[slotName], slotName)]).map(slotName => {
            const key = keyOf(worn[slotName]!, slotName), chosen = colors[key] || {};
            return <li key={slotName}><span>{labels[slotName] || slotName}</span>
              <div className="wardrobe-swatches">{palettes[key]?.regions.map(region => {
                const value = chosen[String(region.index)] || region.color;
                return <label key={region.index} className="wardrobe-swatch" style={{ background: value }} aria-label={`${labels[slotName] || slotName} 색 ${region.index + 1}`}>
                  <input type="color" value={value} onChange={event => { const picked = event.target.value; setColors(current => ({ ...current, [key]: { ...(current[key] || {}), [String(region.index)]: picked } })); }} />
                </label>;
              })}</div>
              {Object.keys(chosen).length > 0 && <button type="button" onClick={() => setColors(current => Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)))}>원래 색</button>}
            </li>;
          })}</ul>
        </div>}
        {shapes.length > 0 && <div className="wardrobe-shapes"><h2>모양</h2>
          <ul>{shapes.map(([slotName, part]) =>
            <WardrobeShape key={slotName} part={part} label={labels[slotName] || slotName} reload={reloadParts}
              replace={next => setWorn(current => ({ ...current, [slotName]: next }))} />)}</ul>
        </div>}
        <div className="wardrobe-look"><h2>내 캐릭터</h2>
          <div className="wardrobe-look-row">
            <button type="button" className="is-primary" disabled={!lookReady || lookBusy || baking || !settled || !!wearError} onClick={() => void saveLook()}>{baking ? '입히는 중' : '내 캐릭터로 입기'}</button>
            {look?.status === 'ready' && (look.worn
              ? <><span role="status">섬에서 입고 있어요</span>{user && <Link to={`/@${user.username}`}>내 섬으로</Link>}</>
              : <button type="button" disabled={lookBusy} onClick={() => void wearLook()}>섬에서 입기</button>)}
            {baking && <span role="status">모델을 만드는 중…</span>}
          </div>
          {look?.status === 'failed' && look.error && <p role="alert">{look.error.message}</p>}
          {!lookReady && !lookError && <p role="status">내 캐릭터를 불러오는 중…</p>}
          {lookError && <p role="alert">{lookError} {!lookReady && <button type="button" onClick={() => setLookAttempt(value => value + 1)}>다시 불러오기</button>}</p>}
        </div>
        {admin && <form className="wardrobe-save" onSubmit={event => { event.preventDefault(); void saveOutfit(); }}>
          <label>조합 이름<input value={outfitName} maxLength={60} onChange={event => setOutfitName(event.target.value)} /></label>
          <button disabled={busy || !settled || !outfitName.trim() || !!wearError}>{busy ? '저장 중' : loadedId && outfits.value?.outfits[loadedId]?.name === outfitName.trim() ? '조합 덮어쓰기' : '조합 저장'}</button>
        </form>}
        {saveError && <p role="alert">{saveError}</p>}
        {savedOutfits.length > 0 && <div className="wardrobe-outfits"><h2>저장한 조합</h2><ul>{savedOutfits.map(([id, outfit]) => <li key={id} className={id === loadedId ? 'loaded' : ''}>
          <strong>{outfit.name}</strong>
          <small>{registered.find(item => item.job_id === outfit.body.job_id)?.name || '등록 해제된 몸'} · 파츠 {Object.keys(outfit.parts).length}개</small>
          <div><button type="button" disabled={busy || !viewer || !lookReady} onClick={() => wear(id)}>입히기</button>{admin && <button type="button" disabled={busy} onClick={() => void remove(id)}>삭제</button>}</div>
        </li>)}</ul></div>}
        {outfits.error && <p role="alert">{outfits.error}</p>}
      </section>
    </div>
  </div>;
}
