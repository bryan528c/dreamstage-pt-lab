# DreamStage PT LAB

신세계라이브쇼핑 이커머스 Dream Stage 대비 독립 제작 PT 연습 도구입니다. 18개 과제와 수치는 모두 자체 제작한 가상 자료입니다. 공식 신세계·UCG 프로그램, 채용 평가표, 실제 기출과 관계없는 연습용입니다.

- 전형 안내에 따른 시간은 PowerPoint 작성 50분, 발표 5분, 질의응답 10분입니다. 실제 전형에서는 생성형 AI 사용이 금지됩니다.
- 1분 주제 선택, 선택지 3개, 미선택 시 첫 과제 자동 배정은 연습 설정입니다. 학습 모드에서는 작성 시간과 주제 범위를 조절할 수 있습니다.
- GitHub Pages는 브라우저 편집, 편집 가능한 PPTX 저장, 외부 PPTX의 기본 텍스트 읽기, 녹음, 기록, 자가 복기를 제공합니다. PowerPoint 직접 작성 모드는 설치된 PowerPoint에서 파일을 만들고 발표할 때 사용합니다.
- 기존 localhost의 완료 회차는 복기 화면에서 **전체 기록 JSON**을 받고 Pages의 **기록 불러오기**에서 엽니다. 진행 중인 기록은 **기록 백업**에서 받을 수 있습니다. 녹음과 원본 PPTX는 별도로 저장하고, 녹음은 해당 회차 복기 화면에서 가져옵니다.

[GitHub Pages](https://bryan528c.github.io/dreamstage-pt-lab/)

## 복기

연습을 마친 뒤 개인 접근 비밀번호로 연결하고, 자료 전송과 API 사용에 동의한 다음 전사 또는 피드백을 직접 실행합니다. 전사는 선택한 파일 하나를 보내고, 피드백은 가상 과제, 슬라이드에서 읽은 텍스트, 발표 메모 또는 전사문, 질의응답 메모를 보냅니다. AI 서버 설정과 관계없이 일반 연습 및 자가 복기를 사용할 수 있습니다.

전사 한도는 **24,000,000바이트**입니다. 지원 형식은 FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, WebM입니다. 녹음은 Worker에서 OpenAI로 multipart 스트리밍합니다. 전사문은 고유명사와 수치를 직접 확인하세요. 피드백은 제출된 텍스트에 근거하며 디자인·발음·억양·시선·표정은 텍스트로 평가할 수 없습니다.

## GitHub Pages

1. 저장소 **Settings → Pages → Source**에서 **GitHub Actions**를 선택합니다.
2. 공개 API 출처를 **Settings → Secrets and variables → Actions → Variables**의 `PTLAB_API_URL`에 지정합니다. 값은 `https://호스트` 형식의 Worker 출처입니다. 변수가 비어 있으면 일반 연습 모드로 빌드합니다.
3. `main`에 푸시하거나 **Actions → DreamStage GitHub Pages → Run workflow**를 실행합니다. 워크플로가 테스트 후 `dist/`의 HTML과 JSZip·PptxGenJS 라이선스 두 개만 배포합니다.

`source/cases.json`이 과제 원본입니다. 과제 변경 후 `python source/build.py --sync-cases`로 `source/cases.js`와 HTML을 갱신합니다. 빌드는 `dist/index.html`과 `dist/DreamStage_PT연습실_v4_AI.html`을 같은 소스에서 생성합니다. 로컬 빌드에서는 `python source/build.py --config source/config.example.json` 또는 `--api-url https://호스트`를 사용할 수 있습니다. CSP는 빌드할 때 동일한 API 출처와 인라인 스크립트 해시를 사용합니다.

## Cloudflare Worker

현재 배포 설정은 `backend/wrangler.toml`에 있습니다. `PAGES_ORIGIN`은 `https://bryan528c.github.io`입니다. CORS의 origin에는 저장소 경로가 포함되지 않습니다. Worker URL을 바꾼 경우 `PTLAB_API_URL`을 갱신한 뒤 Pages 워크플로를 실행합니다.

1. Node.js 24 환경에서 `npm ci`를 실행합니다. Wrangler 인증이 처음이면 `npx wrangler login`으로 인증합니다.
2. `npm run deploy:api`로 배포합니다. 무료 SQLite Durable Object 마이그레이션이 함께 적용됩니다.
3. Cloudflare의 **Workers & Pages → dreamstage-pt-lab-api → Settings → Variables and Secrets**에서 `ACCESS_PASSWORD`와 `OPENAI_API_KEY`를 각각 **Secret**으로 추가하고 적용합니다. `ACCESS_PASSWORD`는 본인만 아는 24자 이상 임의 비밀번호를 사용합니다. CLI로는 `npx wrangler secret put ACCESS_PASSWORD --config backend/wrangler.toml`과 `npx wrangler secret put OPENAI_API_KEY --config backend/wrangler.toml`이 각각 입력을 요청합니다.
4. Pages에서 복기 화면을 연 뒤 AI 연결과 짧은 녹음 전사 1회, 피드백 1회로 해당 OpenAI 프로젝트의 모델 접근과 결제 설정을 확인합니다. 서버 상태 확인은 OpenAI를 호출하지 않습니다.

발급된 브라우저 세션은 30분간 유효하며 새로고침 시 다시 인증합니다. 서버는 만료 시각, 세션 검증용 해시와 요청 제한 정보만 Durable Object에 기록합니다. 동시 1건, 하루 10건이며 오전 9시(KST)에 일일 한도가 갱신됩니다. 업로드와 응답은 요청 동안 처리되고 애플리케이션 로그와 저장소에는 남기지 않습니다. OpenAI 사용에는 프로젝트의 API 요금 및 데이터 처리 정책이 적용됩니다. 피드백은 Responses API의 `store: false`와 구조화 출력, 출력 상한 4,400토큰을 사용합니다.

2026년 11월 공식 문서 기준 Cloudflare Workers Free의 HTTP 요청 제한은 100 MB, 실행 시간은 CPU 시간 10 ms입니다. 클라이언트가 연결된 HTTP 요청에는 별도 고정 wall-clock 상한이 없으며 앱은 OpenAI 대기를 피드백 80초, 전사 170초로 제한합니다. 무료 플랜은 하루 100,000 Workers 요청과 무료 SQLite Durable Objects 할당량을 제공합니다. 전사는 OpenAI의 25 MB 제한에 multipart 헤더 여유를 남깁니다. 기본 모델은 피드백 `gpt-6-luna`와 파일 전사 `gpt-transcribe`이며 `wrangler.toml`에서 서버 배포 시 각각 변경할 수 있습니다.

- [Cloudflare Workers 한도](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare 가격과 무료 할당량](https://developers.cloudflare.com/workers/platform/pricing/)
- [SQLite Durable Objects 가격](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Secret 관리](https://developers.cloudflare.com/workers/configuration/secrets/)
- [GitHub Pages 공식 워크플로](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)
- [OpenAI 파일 전사](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI 구조화 출력](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI 데이터 관리](https://developers.openai.com/api/docs/guides/your-data)

## 변경 후 검증

```sh
npm ci
npm run test:api
python -m pip install -r tests/requirements.txt
python -m playwright install chromium
python tests/test_browser.py
python source/build.py
python tests/check_release.py dist
```

공개 페이지에서는 `python tests/test_browser.py --public-url https://bryan528c.github.io/dreamstage-pt-lab/`로 합성 마이크와 PPTX를 사용해 실전·학습 흐름을 다시 검사할 수 있습니다. API 자동화는 Workerd와 모의 OpenAI 응답을 사용합니다.
