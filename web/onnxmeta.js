// ONNX 모델의 metadata_props 만 꺼낸다.
//
// onnxruntime-web 은 이걸 노출하지 않는데, 우리 파이프라인은 clip_len·크롭
// 비율·정규화 상수를 전부 여기서 읽는다 (src/OpenDeepFun/run.py 의 read_spec).
// 값이 틀리면 모델이 학습 때 못 본 입력을 받으므로 하드코딩하면 안 된다.
//
// 전체 protobuf 파서가 필요하진 않다. ModelProto 최상위만 훑고 field 14 만
// 읽는다 — 나머지는 길이를 보고 건너뛰므로 10MB 짜리도 즉시 끝난다.

const FIELD_METADATA_PROPS = 14;

function makeReader(bytes) {
  let pos = 0;
  return {
    get pos() { return pos; },
    set pos(v) { pos = v; },
    done: () => pos >= bytes.length,
    varint() {
      let result = 0;
      let shift = 0;
      for (;;) {
        if (pos >= bytes.length) throw new Error("truncated varint");
        const b = bytes[pos++];
        result += (b & 0x7f) * Math.pow(2, shift);
        if (!(b & 0x80)) return result;
        shift += 7;
        if (shift > 63) throw new Error("varint too long");
      }
    },
    text(len) {
      const out = new TextDecoder().decode(bytes.subarray(pos, pos + len));
      pos += len;
      return out;
    },
  };
}

function readEntry(bytes, from, to) {
  const r = makeReader(bytes);
  r.pos = from;
  let key = null;
  let value = null;
  while (r.pos < to) {
    const tag = r.varint();
    if ((tag & 7) !== 2) break;
    const len = r.varint();
    const field = tag >>> 3;
    const text = r.text(len);
    if (field === 1) key = text;
    else if (field === 2) value = text;
  }
  return [key, value];
}

export function readModelMetadata(bytes) {
  const meta = {};
  const r = makeReader(bytes);

  while (!r.done()) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;

    if (wire === 0) { r.varint(); continue; }
    if (wire === 5) { r.pos += 4; continue; }
    if (wire === 1) { r.pos += 8; continue; }
    if (wire !== 2) break;

    const len = r.varint();
    const end = r.pos + len;
    if (field === FIELD_METADATA_PROPS) {
      const [key, value] = readEntry(bytes, r.pos, end);
      if (key !== null) meta[key] = value === null ? "" : value;
    }
    r.pos = end;
  }
  return meta;
}

// run.py 의 read_spec 과 같은 기본값을 쓴다. 키가 없는 옛 모델도 그 시절
// 기본값으로 돌아야 한다.
export function readSpec(meta) {
  const num = (k, d) => (meta[k] !== undefined && meta[k] !== "" ? parseFloat(meta[k]) : d);
  const fps = num("deepfungen.target_fps", 30.0);
  return {
    clipLen: Math.round(num("deepfungen.clip_len", 96)),
    size: Math.round(num("deepfungen.target_size", 160)),
    fps,
    mean: num("deepfungen.normalize_mean", 0.45),
    std: num("deepfungen.normalize_std", 0.25),
    velocityScale: num("deepfungen.velocity_scale", fps / 2.0),
    cropRatio: num("deepfungen.max_crop_ratio", 1.3333),
    outputs: (meta["deepfungen.outputs"] ||
      "position,velocity,heatmap_peak,heatmap_valley").split(","),
    version: meta["deepfungen.version"] || "unknown",
  };
}
