// src/OpenDeepFun/post.py 의 JS 이식본.
//
// 파이썬 쪽이 원본이다. 여기서 값을 바꾸지 마라 — 상수도 처리 순서도 전부
// post.py 를 따라간다. scipy 의존부(uniform/maximum/minimum_filter1d,
// find_peaks)는 아래에 직접 구현했고, scipy 와 같은 규칙을 지킨다:
//
//   * 필터 창은 [i - size//2, i + (size-1)//2] 이고 mode="nearest" 는 인덱스를
//     양 끝으로 잘라 붙인다.
//   * find_peaks 는 평탄부의 중점을 극점으로 잡고, height → distance →
//     prominence 순서로 거른다. 순서가 바뀌면 결과가 달라진다.

export const SLOPE_PASSES = 4;
export const AMPLITUDE_PASSES = 6;
export const AGC_MIN_SPAN = 0.45;

export const GAP_RATIO_SCALE = 0.6;
export const GAP_PROMINENCE_SCALE = 0.625;

export const ANCHOR_PASSES = 4;

export const DEFAULTS = {
  out_min: 0,
  out_max: 100,
  min_amplitude: 8,
  stroke_gain: 1.2,
  stroke_min: 40.0,
  max_speed: 650.0,
  min_interval_ms: 60.0,
  anchor: true,
  anchor_window_s: 2.0,
  anchor_strength: 0.5,
  recenter: true,
  recenter_deadband: 3.0,
  subframe: true,
  shoulder_peaks: false,
  shoulder_valleys: false,
  shoulder_frac: 0.25,
  shoulder_drop: 0.15,
  shoulder_min_ms: 300.0,
  shoulder_min_amp: 15.0,
  vibrate: false,
  vibrate_amp: 15.0,
  vibrate_slope: 400.0,
  vibrate_min_half_ms: 30.0,
  vibrate_gap_ms: 400.0,
  vibrate_heatmap_ratio: 0.8,
  vibrate_context_ms: 2000.0,
  vibrate_context_min: 3,
  vibrate_rhythm_factor: 3.0,
  vibrate_max_cycles: 7,
  vibrate_still_p2p: 0.08,
  vibrate_still_win_ms: 200.0,
  vibrate_min_still_ms: 300.0,
  vibrate_max_still_ms: 1500.0,
  prominence_ratio: 0.10,
  prominence_min: 0.08,
  adaptive_window: 200,
  merge_ms: 120.0,
  heatmap_threshold: 0.20,
  gap_fill_s: 3.0,
  agc: false,
  agc_window_s: 30.0,
};

export function params(overrides) {
  const p = Object.assign({}, DEFAULTS);
  for (const key of Object.keys(overrides || {})) {
    if (!(key in DEFAULTS)) throw new Error("unknown parameter: " + key);
    p[key] = overrides[key];
  }
  return p;
}

// --- ndarray/scipy 대역 ------------------------------------------------------

function clampIndex(i, n) {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

// scipy.ndimage.uniform_filter1d(x, size, mode="nearest")
//
// scipy 처럼 창 합을 굴린다(들어오는 값을 더하고 나가는 값을 뺀다). 누적합으로
// 바꾸면 마지막 비트가 달라져서 float32 로 내릴 때 결과가 갈릴 수 있다.
function uniformFilter1d(x, size) {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const left = size >> 1;
  const right = size - left - 1;

  const ext = new Float64Array(n + left + right);
  for (let i = 0; i < ext.length; i++) ext[i] = x[clampIndex(i - left, n)];

  let sum = 0;
  for (let i = 0; i < size; i++) sum += ext[i];
  out[0] = sum / size;
  for (let i = 1; i < n; i++) {
    sum += ext[i + left + right] - ext[i - 1];
    out[i] = sum / size;
  }
  return out;
}

function extremumFilter1d(x, size, wantMax) {
  const n = x.length;
  const out = new Float64Array(n);
  const left = size >> 1;
  const right = size - left - 1;
  for (let i = 0; i < n; i++) {
    let best = x[clampIndex(i - left, n)];
    for (let k = -left + 1; k <= right; k++) {
      const v = x[clampIndex(i + k, n)];
      if (wantMax ? v > best : v < best) best = v;
    }
    out[i] = best;
  }
  return out;
}

const maximumFilter1d = (x, size) => extremumFilter1d(x, size, true);
const minimumFilter1d = (x, size) => extremumFilter1d(x, size, false);

// scipy.signal._peak_finding_utils._local_maxima_1d 의 중점 규칙
function localMaxima1d(x) {
  const mid = [];
  const n = x.length;
  const iMax = n - 1;
  let i = 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < iMax && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        mid.push((i + ahead - 1) >> 1);
        i = ahead;
      }
    }
    i++;
  }
  return mid;
}

function selectByPeakDistance(peaks, priority, distance) {
  const n = peaks.length;
  const keep = new Uint8Array(n).fill(1);
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => priority[a] - priority[b]);
  for (let k = n - 1; k >= 0; k--) {
    const j = order[k];
    if (!keep[j]) continue;
    for (let m = j - 1; m >= 0 && peaks[j] - peaks[m] < distance; m--) keep[m] = 0;
    for (let m = j + 1; m < n && peaks[m] - peaks[j] < distance; m++) keep[m] = 0;
  }
  return keep;
}

function peakProminences(x, peaks) {
  const n = x.length;
  const out = new Float64Array(peaks.length);
  for (let k = 0; k < peaks.length; k++) {
    const peak = peaks[k];
    const h = x[peak];
    let i = peak;
    let leftMin = h;
    while (i >= 0 && x[i] <= h) {
      if (x[i] < leftMin) leftMin = x[i];
      i--;
    }
    i = peak;
    let rightMin = h;
    while (i < n && x[i] <= h) {
      if (x[i] < rightMin) rightMin = x[i];
      i++;
    }
    out[k] = h - Math.max(leftMin, rightMin);
  }
  return out;
}

// scipy.signal.find_peaks 의 부분집합 — height / distance / prominence 만.
function findPeaks(x, opts) {
  const { height = null, distance = null, prominence = null } = opts || {};
  let peaks = localMaxima1d(x);

  if (height !== null) peaks = peaks.filter((i) => x[i] >= height);

  if (distance !== null && peaks.length) {
    const priority = peaks.map((i) => x[i]);
    const keep = selectByPeakDistance(peaks, priority, distance);
    peaks = peaks.filter((_, i) => keep[i]);
  }

  if (prominence !== null && peaks.length) {
    const prom = peakProminences(x, peaks);
    peaks = peaks.filter((_, i) => prom[i] >= prominence);
  }

  return peaks;
}

function negated(x) {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = -x[i];
  return out;
}

function unionSorted(a, b) {
  const set = new Set();
  for (const v of a) set.add(v);
  for (const v of b) set.add(v);
  return Array.from(set).sort((p, q) => p - q);
}

function ptp(x, from, to) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < to; i++) {
    if (x[i] < lo) lo = x[i];
    if (x[i] > hi) hi = x[i];
  }
  return hi - lo;
}

// np.percentile 기본값(linear interpolation)
function percentile(values, q) {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  if (n === 0) return NaN;
  const pos = ((n - 1) * q) / 100.0;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(values) {
  return percentile(values, 50);
}

const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// --- post.py 이식 ------------------------------------------------------------

export function overlapAdd(chunks, starts, total) {
  const acc = new Float64Array(total);
  const wsum = new Float64Array(total);

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const s = starts[c];
    const n = chunk.length;
    // np.hanning(n + 2)[1:-1]
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (n + 1));
    }
    const e = Math.min(s + n, total);
    const k = e - s;
    for (let i = 0; i < k; i++) {
      acc[s + i] += chunk[i] * w[i];
      wsum[s + i] += w[i];
    }
  }

  // numpy 는 float64 로 누적한 뒤 마지막에 float32 로 내린다. 아래 단계들이
  // float32 신호를 전제로 하므로 여기서 dtype 을 맞춰 둔다.
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = acc[i] / Math.max(wsum[i], 1e-8);
  return out;
}

// 여기서부터 신호는 float32 다 — post.py 가 그렇다. Float32Array 에 넣었다
// 빼는 것으로 numpy 의 단계별 반올림을 그대로 재현한다. float64 로 계산하면
// 3600 샘플 누적합에서만 위치가 0.01 어긋나고, 그게 극점 하나를 밀어 최종
// 키포인트가 17ms 까지 벌어졌다.
export function fusePositionVelocity(position, velocity, fps, velocityScale, cutoffS = 1.0) {
  const n = position.length;
  const w = Math.max(3, Math.round(cutoffS * fps));

  const scaled = new Float32Array(n);
  for (let i = 0; i < n; i++) scaled[i] = velocity[i] / velocityScale;

  const integrated = new Float32Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run = Math.fround(run + scaled[i]);
    integrated[i] = run;
  }

  const base = Float32Array.from(uniformFilter1d(integrated, w));
  for (let i = 0; i < n; i++) integrated[i] = integrated[i] - base[i];

  const low = Float32Array.from(uniformFilter1d(position, w));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clamp(low[i] + integrated[i], 0.0, 1.0);
  return out;
}

export function rollingAgc(signal, fps, windowS) {
  const n = signal.length;
  const w = Math.max(3, Math.round(windowS * fps));
  const lo = Float32Array.from(minimumFilter1d(signal, w));
  const hi = Float32Array.from(maximumFilter1d(signal, w));
  const span = new Float32Array(n);
  for (let i = 0; i < n; i++) span[i] = hi[i] - lo[i];

  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) diff[i] = signal[i] - lo[i];

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = span[i] > AGC_MIN_SPAN ? Math.fround(diff[i] / Math.fround(Math.max(span[i], 1e-6))) : signal[i];
    out[i] = clamp(v, 0.0, 1.0);
  }
  return out;
}

export function extremaFromHeatmap(heatmap, threshold, minDistance = 3) {
  return findPeaks(heatmap, { height: threshold, distance: minDistance });
}

export function adaptiveExtrema(signal, window, ratio, minProminence, minDistance = 3, from = 0, to = -1) {
  const end = to < 0 ? signal.length : to;
  const n = end - from;
  if (n < 8) return [[], []];

  const peaks = new Set();
  const valleys = new Set();
  const step = Math.max(1, Math.floor(window / 2));

  for (let start = 0; start < n; start += step) {
    const stop = Math.min(start + window, n);
    if (stop - start < 4) continue;
    const chunk = signal.slice(from + start, from + stop);
    const prom = Math.max(ptp(chunk, 0, chunk.length) * ratio, minProminence);
    for (const i of findPeaks(chunk, { prominence: prom, distance: minDistance })) {
      peaks.add(i + start);
    }
    for (const i of findPeaks(negated(chunk), { prominence: prom, distance: minDistance })) {
      valleys.add(i + start);
    }
    if (stop >= n) break;
  }

  return [
    Array.from(peaks).sort((a, b) => a - b),
    Array.from(valleys).sort((a, b) => a - b),
  ];
}

export function mergeCloseExtrema(idx, signal, fps, thresholdMs) {
  if (idx.length < 3) return idx.slice();

  const minGap = (thresholdMs / 1000.0) * fps;
  const keep = [idx[0]];
  for (let i = 1; i < idx.length - 1; i++) {
    const cur = idx[i];
    const nxt = idx[i + 1];
    if (cur - keep[keep.length - 1] < minGap && nxt - cur < minGap) {
      if (
        Math.abs(signal[cur] - signal[keep[keep.length - 1]]) <
        Math.abs(signal[nxt] - signal[cur])
      ) {
        continue;
      }
    }
    keep.push(cur);
  }
  keep.push(idx[idx.length - 1]);
  return Array.from(new Set(keep)).sort((a, b) => a - b);
}

function spread(perStroke, n) {
  const acc = new Float64Array(n);
  const cnt = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    acc[i] += perStroke[i];
    cnt[i] += 1.0;
  }
  for (let i = 1; i < n; i++) {
    acc[i] += perStroke[i - 1];
    cnt[i] += 1.0;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = acc[i] / Math.max(cnt[i], 1.0);
  return out;
}

function shiftIntoRange(pos, outMin, outMax) {
  const n = pos.length;
  if (n < 2) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = clamp(pos[i], outMin, outMax);
    return out;
  }
  const delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const hi = Math.max(Math.max(pos[i], pos[i + 1]) - outMax, 0.0);
    const lo = Math.max(outMin - Math.min(pos[i], pos[i + 1]), 0.0);
    delta[i] = lo - hi;
  }
  const spreadDelta = spread(delta, n);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = pos[i] + spreadDelta[i];
  return out;
}

function subframeOffset(signal, idx) {
  const n = signal.length;
  const out = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (i <= 0 || i >= n - 1) continue;
    const a = signal[i - 1];
    const b = signal[i];
    const c = signal[i + 1];
    const denom = a - 2.0 * b + c;
    if (Math.abs(denom) <= 1e-9) continue;
    const d = (0.5 * (a - c)) / denom;
    out[k] = Math.abs(d) > 0.5 ? 0.0 : d;
  }
  return out;
}

function shoulderDt(spanMs, frac, minIntervalMs) {
  const dt = Math.max(spanMs * frac, minIntervalMs);
  if (dt > spanMs - minIntervalMs) return null;
  return dt;
}

function addShoulders(atMs, pos, p) {
  if (atMs.length < 3) return [atMs, pos];

  const addT = [];
  const addP = [];
  for (let i = 1; i < atMs.length - 1; i++) {
    const prevDt = atMs[i] - atMs[i - 1];
    const nextDt = atMs[i + 1] - atMs[i];
    if (prevDt < p.shoulder_min_ms || nextDt < p.shoulder_min_ms) continue;

    const rise = pos[i] - pos[i - 1];
    const fall = pos[i] - pos[i + 1];
    if (rise * fall <= 0) continue;
    if (!(rise > 0 ? p.shoulder_peaks : p.shoulder_valleys)) continue;
    const amp = Math.min(Math.abs(rise), Math.abs(fall));
    if (amp < p.shoulder_min_amp) continue;

    const left = shoulderDt(prevDt, p.shoulder_frac, p.min_interval_ms);
    const right = shoulderDt(nextDt, p.shoulder_frac, p.min_interval_ms);
    if (left === null || right === null) continue;

    const offset = -sign(rise) * amp * p.shoulder_drop;
    const y = clamp(pos[i] + offset, p.out_min, p.out_max);
    addT.push(atMs[i] - left);
    addP.push(y);
    addT.push(atMs[i] + right);
    addP.push(y);
  }

  if (!addT.length) return [atMs, pos];
  return mergeSorted(atMs, pos, addT, addP);
}

// np.argsort(kind="stable") 로 이어붙인 뒤 정렬하는 것과 같게: 기존 점이 먼저다.
function mergeSorted(atMs, pos, addT, addP) {
  const items = [];
  for (let i = 0; i < atMs.length; i++) items.push([atMs[i], pos[i], i]);
  for (let i = 0; i < addT.length; i++) items.push([addT[i], addP[i], atMs.length + i]);
  items.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  return [items.map((v) => v[0]), items.map((v) => v[1])];
}

function trueRuns(mask, from, to) {
  const runs = [];
  let start = -1;
  for (let i = from; i < to; i++) {
    if (mask[i] && start < 0) start = i;
    if (!mask[i] && start >= 0) {
      runs.push([start - from, i - from]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start - from, to - from]);
  return runs;
}

function fillVibration(atMs, pos, signal, heatmapPeak, heatmapValley, fps, p) {
  if (atMs.length < 2) return [atMs, pos];

  const n = signal.length;
  const hm = new Float64Array(n);
  for (let i = 0; i < n; i++) hm[i] = Math.max(heatmapPeak[i], heatmapValley[i]);
  const alive = p.heatmap_threshold * p.vibrate_heatmap_ratio;
  const half = Math.max(
    (p.vibrate_amp / Math.max(p.vibrate_slope, 1e-6)) * 1000.0,
    p.vibrate_min_half_ms
  );

  const w = Math.max(3, Math.round((p.vibrate_still_win_ms / 1000.0) * fps));
  const hi = Float32Array.from(maximumFilter1d(signal, w));
  const lo = Float32Array.from(minimumFilter1d(signal, w));
  const still = new Uint8Array(n);
  for (let i = 0; i < n; i++) still[i] = Math.fround(hi[i] - lo[i]) < p.vibrate_still_p2p ? 1 : 0;

  const addT = [];
  const addP = [];
  for (let i = 0; i < atMs.length - 1; i++) {
    const t0 = atMs[i];
    const t1 = atMs[i + 1];
    if (t1 - t0 < p.vibrate_gap_ms) continue;

    const ctx = p.vibrate_context_ms;
    const near = atMs.filter((t) => t >= t0 - ctx && t <= t1 + ctx);
    const before = atMs.filter((t) => t >= t0 - ctx && t <= t0).length;
    const after = atMs.filter((t) => t >= t1 && t <= t1 + ctx).length;
    if (before < p.vibrate_context_min || after < p.vibrate_context_min) continue;

    const d = [];
    for (let k = 1; k < near.length; k++) {
      const gap = near[k] - near[k - 1];
      if (Math.abs(gap - (t1 - t0)) > 1e-6) d.push(gap);
    }
    if (d.length < 3 || t1 - t0 < p.vibrate_rhythm_factor * median(d)) continue;

    const f0 = Math.max(Math.round((t0 * fps) / 1000.0), 0);
    const f1 = Math.min(Math.round((t1 * fps) / 1000.0), n);
    if (f1 - f0 < 2) continue;

    for (const [a, b] of trueRuns(still, f0, f1)) {
      const fa = f0 + a;
      const fb = f0 + b;
      const ta = (fa * 1000.0) / fps;
      const tb = (fb * 1000.0) / fps;
      if (!(tb - ta >= p.vibrate_min_still_ms && tb - ta <= p.vibrate_max_still_ms)) continue;

      let peak = -Infinity;
      for (let k = fa; k < fb; k++) if (hm[k] > peak) peak = hm[k];
      if (peak < alive) continue;

      let mean = 0;
      for (let k = fa; k < fb; k++) mean += signal[k];
      mean /= fb - fa;

      const base = p.out_min + mean * (p.out_max - p.out_min);
      const count = Math.min(
        Math.floor((tb - ta) / half),
        Math.max(1, p.vibrate_max_cycles) * 2
      );
      if (count < 2) continue;
      const start = ta + (tb - ta - count * half) / 2.0;
      for (let k = 1; k < count; k++) {
        const y = base + (p.vibrate_amp / 2.0) * (k % 2 ? 1.0 : -1.0);
        addT.push(start + k * half);
        addP.push(clamp(y, p.out_min, p.out_max));
      }
    }
  }

  if (!addT.length) return [atMs, pos];
  return mergeSorted(atMs, pos, addT, addP);
}

function recenterVideo(pos, p) {
  if (pos.length < 2) return pos;

  const low = percentile(pos, 1.0);
  const high = percentile(pos, 99.0);
  const below = low - p.out_min;
  const above = p.out_max - high;

  const offset = (above - below) / 2.0;
  if (Math.abs(offset) < p.recenter_deadband) return pos;

  const shifted = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i++) shifted[i] = pos[i] + offset;
  const moved = shiftIntoRange(shifted, p.out_min, p.out_max);
  for (let i = 0; i < moved.length; i++) moved[i] = clamp(moved[i], p.out_min, p.out_max);
  return moved;
}

function anchorToSignal(pos, idx, signal, fps, p) {
  if (pos.length < 2) return pos;

  const w = Math.max(3, Math.round(p.anchor_window_s * fps));
  const base = uniformFilter1d(signal, w);

  const anchor = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    anchor[i] = p.out_min + base[idx[i]] * (p.out_max - p.out_min);
  }

  const diff = new Float64Array(pos.length - 1);
  for (let i = 0; i < pos.length - 1; i++) {
    const want = (anchor[i] + anchor[i + 1]) / 2.0;
    const mid = (pos[i] + pos[i + 1]) / 2.0;
    diff[i] = want - mid;
  }
  const pull = spread(diff, pos.length);
  let cur = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i++) cur[i] = pos[i] + p.anchor_strength * pull[i];

  for (let pass = 0; pass < ANCHOR_PASSES; pass++) {
    const moved = shiftIntoRange(cur, p.out_min, p.out_max);
    let worst = 0;
    for (let i = 0; i < cur.length; i++) worst = Math.max(worst, Math.abs(moved[i] - cur[i]));
    if (worst < 0.05) return moved;
    cur = moved;
  }
  return cur;
}

export function toKeypoints(signal, peaks, valleys, fps, p, boost = true) {
  let idx = unionSorted(peaks, valleys);
  if (idx.length < 2) return [[], []];

  const frac = p.subframe ? subframeOffset(signal, idx) : new Float64Array(idx.length);
  let atMs = idx.map((v, i) => Math.round(((v + frac[i]) * 1000.0) / fps));
  let val = idx.map((v) => signal[v]);

  const keepIdx = [0];
  for (let i = 1; i < idx.length; i++) {
    if (atMs[i] - atMs[keepIdx[keepIdx.length - 1]] >= p.min_interval_ms) keepIdx.push(i);
  }
  idx = keepIdx.map((i) => idx[i]);
  atMs = keepIdx.map((i) => atMs[i]);
  val = keepIdx.map((i) => val[i]);

  let pos = new Float64Array(val.length);
  for (let i = 0; i < val.length; i++) pos[i] = p.out_min + val[i] * (p.out_max - p.out_min);

  if (boost && pos.length >= 2) {
    const span = p.out_max - p.out_min;
    const m = pos.length - 1;
    const amp = new Float64Array(m);
    for (let i = 0; i < m; i++) amp[i] = Math.abs(pos[i + 1] - pos[i]);

    const target = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let t = p.stroke_gain !== 1.0 ? amp[i] * p.stroke_gain : amp[i];
      t = Math.max(t, Math.min(p.stroke_min, span));
      const dtS = Math.max((atMs[i + 1] - atMs[i]) / 1000.0, 1e-3);
      t = Math.min(t, p.max_speed * dtS);
      target[i] = Math.max(t, amp[i]);
    }

    for (let pass = 0; pass < AMPLITUDE_PASSES; pass++) {
      const need = new Float64Array(m);
      let done = true;
      for (let i = 0; i < m; i++) {
        need[i] = target[i] - Math.abs(pos[i + 1] - pos[i]);
        if (need[i] > 0.5) done = false;
      }
      if (done) break;
      for (let i = 0; i < m; i++) {
        if (need[i] <= 0.5) continue;
        const half = need[i] / 2.0;
        const s = pos[i + 1] >= pos[i] ? 1.0 : -1.0;
        pos[i] -= s * half;
        pos[i + 1] += s * half;
      }
      pos = shiftIntoRange(pos, p.out_min, p.out_max);
    }
  }

  if (p.anchor) pos = anchorToSignal(pos, idx, signal, fps, p);

  for (let pass = 0; pass < SLOPE_PASSES; pass++) {
    let changed = false;
    for (let i = 1; i < pos.length; i++) {
      const dtS = Math.max((atMs[i] - atMs[i - 1]) / 1000.0, 1e-3);
      const reach = p.max_speed * dtS;
      const delta = pos[i] - pos[i - 1];
      if (Math.abs(delta) <= reach) continue;
      const shift = ((Math.abs(delta) - reach) / 2.0) * sign(delta);
      pos[i] -= shift;
      pos[i - 1] += shift;
      changed = true;
    }
    if (!changed) break;
  }

  let keep = [0];
  for (let i = 1; i < pos.length; i++) {
    if (Math.abs(pos[i] - pos[keep[keep.length - 1]]) >= p.min_amplitude) keep.push(i);
  }
  if (keep.length < 2) keep = Array.from({ length: pos.length }, (_, i) => i);

  return [
    keep.map((i) => atMs[i]),
    keep.map((i) => clamp(pos[i], p.out_min, p.out_max)),
  ];
}

function fillKeypointGaps(signal, atMs, pos, fps, p) {
  if (atMs.length < 2) return [atMs, pos];

  const gap = Math.round(p.gap_fill_s * fps);
  const idx = atMs.map((t) => Math.round((t * fps) / 1000.0));

  const addAt = [];
  const addPos = [];
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k];
    const b = idx[k + 1];
    if (b - a <= gap) continue;
    if (b - a < 8 || ptp(signal, a, b) < 0.03) continue;

    const seg = signal.slice(a, b);
    const [subP, subV] = adaptiveExtrema(
      seg,
      p.adaptive_window,
      p.prominence_ratio * GAP_RATIO_SCALE,
      p.prominence_min * GAP_PROMINENCE_SCALE
    );
    if (subP.length + subV.length < 2) continue;
    const [subAt, subPos] = toKeypoints(seg, subP, subV, fps, p);
    const shift = Math.round((a * 1000.0) / fps);
    for (let i = 0; i < subAt.length; i++) {
      addAt.push(subAt[i] + shift);
      addPos.push(subPos[i]);
    }
  }

  if (!addAt.length) return [atMs, pos];

  const [allAt, allPos] = mergeSorted(atMs, Array.from(pos), addAt, addPos);
  const keepAt = [];
  const keepPos = [];
  for (let i = 0; i < allAt.length; i++) {
    if (i === 0 || allAt[i] - allAt[i - 1] >= p.min_interval_ms) {
      keepAt.push(allAt[i]);
      keepPos.push(allPos[i]);
    }
  }
  return [keepAt, keepPos];
}

export function postprocess(position, velocity, heatmapPeak, heatmapValley, fps, velocityScale, p) {
  let signal = fusePositionVelocity(position, velocity, fps, velocityScale);
  if (p.agc) signal = rollingAgc(signal, fps, p.agc_window_s);

  const peaksH = extremaFromHeatmap(heatmapPeak, p.heatmap_threshold);
  const valleysH = extremaFromHeatmap(heatmapValley, p.heatmap_threshold);
  const [peaksA, valleysA] = adaptiveExtrema(
    signal,
    p.adaptive_window,
    p.prominence_ratio,
    p.prominence_min
  );

  let peaks = unionSorted(peaksH, peaksA);
  let valleys = unionSorted(valleysH, valleysA);

  peaks = mergeCloseExtrema(peaks, signal, fps, p.merge_ms);
  valleys = mergeCloseExtrema(valleys, signal, fps, p.merge_ms);

  let [atMs, pos] = toKeypoints(signal, peaks, valleys, fps, p);
  [atMs, pos] = fillKeypointGaps(signal, atMs, pos, fps, p);

  if (p.recenter) pos = Array.from(recenterVideo(Float64Array.from(pos), p));

  if (p.vibrate) {
    [atMs, pos] = fillVibration(atMs, pos, signal, heatmapPeak, heatmapValley, fps, p);
  }
  if (p.shoulder_peaks || p.shoulder_valleys) {
    [atMs, pos] = addShoulders(atMs, pos, p);
  }

  return { atMs, pos, signal };
}
