// ffmpeg 코어를 도는 워커.
//
// @ffmpeg/ffmpeg 래퍼를 안 쓴다. 그쪽은 자기 worker.js 를 CDN URL 로 new Worker
// 하는데, 워커 스크립트는 교차 출처에서 못 만든다 ("Script at
// https://esm.sh/... cannot be accessed from origin ..."). 그래서 워커 파일만
// 우리가 같이 올리고, 무거운 코어는 그대로 CDN 에서 받는다. importScripts 는
// 교차 출처가 허용된다.
//
// 워커가 필요한 이유는 하나 더 있다. WORKERFS 는 워커 안에서만 쓸 수 있는데,
// 20GB 짜리 영상을 wasm 힙에 복사하지 않고 읽으려면 그게 유일한 길이다.

let core = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function load({ coreURL, wasmURL }) {
  importScripts(coreURL);
  // 코어의 locateFile 은 mainScriptUrlOrBlob 의 `#base64(...)` 조각에서
  // wasm 경로를 읽는다. 이 형식이 아니면 wasm 을 못 찾는다.
  const hint = btoa(JSON.stringify({ wasmURL, workerURL: "" }));
  core = await self.createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${hint}`,
  });
  core.setLogger((data) => post({ type: "log", data }));
  if (core.setProgress) core.setProgress((data) => post({ type: "progress", data }));
  return true;
}

function exec({ args }) {
  core.setTimeout(-1);
  core.exec(...args);
  const ret = core.ret;
  core.reset();
  return ret;
}

const HANDLERS = {
  load,
  exec,
  mount({ fsType, options, mountPoint }) {
    const fs = core.FS.filesystems[fsType];
    if (!fs) throw new Error(`no such filesystem: ${fsType}`);
    core.FS.mount(fs, options, mountPoint);
    return true;
  },
  unmount({ mountPoint }) {
    core.FS.unmount(mountPoint);
    return true;
  },
  mkdir({ path }) {
    try {
      core.FS.mkdir(path);
    } catch (_) {
      // 이미 있으면 그만이다.
    }
    return true;
  },
  readFile({ path }) {
    return core.FS.readFile(path);
  },
  unlink({ path }) {
    try {
      core.FS.unlink(path);
    } catch (_) {
      // 없으면 그만이다.
    }
    return true;
  },
};

self.onmessage = async ({ data: { id, type, data } }) => {
  const handler = HANDLERS[type];
  try {
    if (!handler) throw new Error(`unknown message: ${type}`);
    if (type !== "load" && !core) throw new Error("ffmpeg core not loaded");
    const result = await handler(data || {});
    post({ id, type, data: result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (err) {
    post({ id, type: "error", data: String((err && err.message) || err) });
  }
};
