[English](README.md) | **한국어**

# OpenFunML

**ofs-ng**와 **OpenFunscripter** 용 익스텐션으로
영상에서 머신러닝된 모델을 통해 funscript를 생성합니다.

Windows만 지원합니다.
DirectX 12 GPU가 있으면 사용하고, 없으면 느린 CPU로 돌아갑니다.

![The OpenFunML panel](images/screen1.png)

## 주의사항

이 익스텐션으로 생성된 결과물은 완성된게 아닙니다.
움직임의 큰 흐름은 잡아주지만 그대로 쓸 품질은 아니고, 빈 타임라인에서 시작하지 않게 해주는 용도입니다.
AI 슬롭으로 커뮤니티가 망가지지 않도록 생성된 스크립트를 수정없이 그대로 업로드하지 말아주세요.

## 다운로드

두 익스텐션이 사용하는 엔진은 동일합니다.
사용하고 있는 에디터에 맞는 파일을 다운받아주세요.

| 파일 | 대상 |
|---|---|
| `OpenFunML-ofs-ng.zip` | ofs-ng |
| `OpenFunML-ofs.zip` | OpenFunscripter 3 |

## 설치

**ofs-ng** — 압축을 풀지 말고, **Plugins → Install plugin from zip…** 에서 zip을
고른 뒤 신뢰 프롬프트에서 확인을 클릭합니다.
제거는 **Plugins → OpenFunML → Uninstall…**

**OpenFunscripter 3** — 압축을 풀고 `install.ps1`
우클릭 → **PowerShell로 실행**. OFS 재시작 후 **Extensions → OpenFunML**을 켭니다.
ps1 스크립트가 잘 작동하지 않는다면 extensions 폴더에 수동으로 복사해야합니다.

> %APPDATA%\OFS\OFS3_data\extensions\OpenFunML

## 사용법

1. 에디터에서 영상을 엽니다.
2. **Plugins → OpenFunML** (ofs-ng) 또는 **Extensions → OpenFunML** (OFS 3).
3. **Model**을 고르고, **Compute**는 `auto`로 둡니다.
4. **Run model and generate**.

끝나면 정점이 **L0(스트로크)** 트랙에 들어갑니다.

![Run Model](images/screen2.png)
![Generated keypoints](images/screen3.png)

분석 결과가 영상별로 캐시되므로 옵션만 바뀐 경우 수정은 약 1초 정도면 끝납니다.
다른 영상이거나 다른 모델일 때는 전체 재분석이 일어납니다.

## 옵션

| 옵션 | 하는 일 |
|---|---|
| **Max speed** | 기기가 낼 수 있는 초당 단위 속도. 사람 스크립트는 95백분위 542, 99백분위 670 |
| **Heatmap threshold** | 낮출수록 피크를 더 찾습니다. 스트로크 개수를 좌우하는 가장 강한 값 |
| **Prominence min** | 피크 검출 하한. 조용한 구간의 흔들림을 무시하려면 올리세요 |
| **Stroke gain** | 각 스트로크를 자기 중심 기준으로 확대. 1.3을 넘으면 중앙값이 0–100 풀스윙이 됩니다(사람 스크립트는 79) |
| **Min stroke size** | 이보다 작은 스트로크를 중심 유지한 채 벌립니다. 30은 사람 스크립트의 10백분위 |
| **Anchor to position** | 빠른 스트로크를 모델이 본 높이에 붙들어 둡니다. 끄면 중앙으로 몰립니다 |
| **Time offset ms** | 전체 정점을 시간축으로 밉니다. 양수면 뒤로 |
| **Position min / max** | 스크립트에 기록되는 값 범위 |
| **Replace existing actions** | 끄면 기존 스크립트에 병합됩니다 |

## 모델 사용 조건

`.onnx` 모델을 아래 조건만 지켜진다면 다른 프로그램에서 쓰셔도 됩니다.
- 모델 파일명 유지 및 UI에서 모델명 확인 가능
- 유료 프로그램에는 사용 불가

출처 표기는 의무가 아니지만 남겨주시면 좋습니다.

## 이슈 확인

플러그인 폴더의 `log.txt`에 마지막 실행 기록이 남습니다.

| 에디터 | 경로 |
|---|---|
| ofs-ng | `%APPDATA%\ofs\ofs-ng\plugins\OpenFunML` |
| OFS 3 | `%APPDATA%\OFS\OFS3_data\extensions\OpenFunML` |

서명 없는 프로그램이라 백신 오탐이 납니다.
SmartScreen이 막으면 **추가 정보 → 실행**,
Defender가 격리하면 위 폴더를 제외 항목으로 추가하세요.
