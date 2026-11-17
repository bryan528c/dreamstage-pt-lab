'use strict';

/* Review data travels only when an authenticated user explicitly requests it. */
const AI = {
  token: '', expiresAt: 0, ready: null, busy: false, consent: false,
  notice: '', audioFile: null, audioId: '', practiceId: null,
};
const audioAccept = Object.keys(PTLAB_CONFIG.audioTypes).map(ext => '.' + ext).join(',');
const aiInReview = () => S?.stage === 'review' && !bootHome;
const aiOnline = () => PTLAB_CONFIG.apiUrl && location.protocol !== 'file:';

function aiAudioFormat(blob, name) {
  const ext = name?.split('.').pop().toLowerCase();
  if (ext && Object.hasOwn(PTLAB_CONFIG.audioTypes, ext)) return ext;
  const mime = blob.type.split(';')[0];
  const aliases = {'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mp3': 'mp3', 'video/mp4': 'mp4'};
  return aliases[mime] || Object.keys(PTLAB_CONFIG.audioTypes).find(ext => PTLAB_CONFIG.audioTypes[ext] === mime);
}

function aiSavedOptions() {
  const items = [...audioCache.values()].filter(item => item.session === S.id);
  return '<option value="">녹음을 선택하세요</option>' + items.map((item, i) =>
    `<option value="${esc(item.id)}" ${item.id === AI.audioId ? 'selected' : ''}>이 회차의 녹음 ${i + 1}</option>`
  ).join('');
}

function aiFeedbackCard() {
  const feedback = S?.aiFeedback;
  if (!feedback || typeof feedback.summary !== 'string') return '';
  const lines = items => Array.isArray(items) ? items.map(x => `<li>${esc(x)}</li>`).join('') : '';
  const questions = Array.isArray(feedback.followups) ? feedback.followups : [];
  return `<section class="ai-outcome">
    <p class="local-note">${esc(S.aiEvaluatedAt || '')} · 연습용 AI 분석</p>
    <h3>한 문장 총평</h3><p>${esc(feedback.summary)}</p>
    <h3>잘한 점</h3><ul>${lines(feedback.strengths)}</ul>
    <h3>우선 수정할 점</h3><ol>${lines(feedback.priorities)}</ol>
    <h3>첫 30초 개선 예시</h3><blockquote>${esc(feedback.better_opening)}</blockquote>
    <h3>숫자·근거·가설 구분</h3><p>${esc(feedback.data_check)}</p>
    <h3>현실성·실행·검증</h3><p>${esc(feedback.feasibility)}</p>
    <h3>발표 전달에 대한 판단 범위</h3><p>${esc(feedback.speech_scope)}</p>
    <h3>예상 반론 및 답변 접근</h3>
    ${questions.map((x, i) => `<div class="list-card"><strong>${i + 1}. ${esc(x?.question)}</strong><p class="smalltext">확인 의도 · ${esc(x?.reason)}</p><p class="smalltext">답변 접근 · ${esc(x?.answer_approach)}</p></div>`).join('')}
    <h3>다음 연습 한 가지</h3><p>${esc(feedback.next_drill)}</p>
    <p class="local-note">판단 범위는 제출한 텍스트입니다. 발음·억양·표정·시선·슬라이드 디자인은 이 자료로 판단할 수 없습니다.</p>
    <button class="small" data-ai-act="download-feedback">피드백 JSON 저장</button></section>`;
}

function aiClearSession() {
  AI.token = '';
  AI.expiresAt = 0;
  AI.consent = false;
}

function aiMount() {
  if (!aiInReview()) {
    AI.practiceId = null;
    AI.audioFile = null;
    AI.audioId = '';
    AI.consent = false;
    return;
  }
  if (AI.practiceId !== S.id) {
    AI.practiceId = S.id;
    AI.consent = false;
    AI.notice = '';
    AI.audioFile = null;
    AI.audioId = '';
  }
  if (AI.token && Date.now() >= AI.expiresAt) aiClearSession();
  const target = document.querySelector('.review-layout > .stack:last-child');
  if (!target) return;
  let root = document.getElementById('ai-review-panel');
  if (!root) {
    root = document.createElement('section');
    root.className = 'card ai-review';
    root.id = 'ai-review-panel';
    target.appendChild(root);
  }
  const disabled = AI.busy ? 'disabled' : '';
  const connection = AI.token
    ? `<p>개인 인증 완료 · ${new Date(AI.expiresAt).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit'})}까지</p>
       <button class="small" data-ai-act="logout" ${disabled}>AI 로그아웃</button>`
    : `<label for="aiAccess">개인 접근 비밀번호</label>
       <input id="aiAccess" type="password" autocomplete="off" maxlength="256" ${disabled}>
       <button class="small" data-ai-act="login" ${disabled}>AI 연결</button>`;
  const controls = aiOnline() ? `<div class="stack">
    <div class="ai-connect">
      ${connection}
      <button class="small" data-ai-act="status" ${disabled}>서버 상태 확인</button>
      ${AI.ready === false ? '<p class="local-note">서버 설정이 필요합니다. 일반 복기는 계속 사용할 수 있습니다.</p>' : ''}
    </div>
    ${AI.token && AI.ready ? `<label class="check-row"><input id="aiConsent" type="checkbox" ${AI.consent ? 'checked' : ''} ${disabled}><span>선택한 녹음 또는 과제·슬라이드 텍스트·녹취·답변을 OpenAI API로 보내는 데 동의합니다. 요청에 따라 API 요금이 발생합니다.</span></label>
      <div class="ai-block">
        <h3>발표 녹음 → 한국어 녹취</h3>
        <label for="aiSavedAudio">저장된 녹음</label>
        <select id="aiSavedAudio" ${disabled}>${aiSavedOptions()}</select>
        <label for="aiAudioFile">또는 녹음 파일 선택</label>
        <input type="file" id="aiAudioFile" accept="${audioAccept}" ${disabled}>
        ${AI.audioFile ? `<p class="local-note">선택한 파일 · ${esc(AI.audioFile.name)}</p>` : ''}
        <p class="local-note">최대 ${PTLAB_CONFIG.maxAudioBytes.toLocaleString('ko-KR')}바이트 (24 MB) · ${Object.keys(PTLAB_CONFIG.audioTypes).join(', ')}</p>
        <button data-ai-act="transcribe" ${disabled}>선택한 녹음 전사</button>
      </div>
      <div class="ai-block">
        <h3>슬라이드·발표 AI 피드백</h3>
        <p class="smalltext">제출 자료의 기본 텍스트, 실제 발표 내용, 답변 메모를 바탕으로 피드백을 받습니다.</p>
        <button class="primary" data-ai-act="evaluate" ${disabled}>AI 피드백 받기</button>
      </div>` : ''}
    </div>` : '<p class="local-note">이 페이지에서 AI 서버 연결을 사용할 수 없습니다. 연습 기록, 녹음, 직접 복기는 계속 사용할 수 있습니다.</p>';
  root.innerHTML = `<h2>OpenAI API 복기</h2><p class="smalltext">연습을 마친 뒤 선택한 자료로 전사와 피드백을 요청할 수 있습니다.</p>
    ${controls}<p id="aiNotice" class="local-note" role="status">${esc(AI.busy ? '요청을 처리하고 있습니다…' : AI.notice)}</p>${aiFeedbackCard()}`;
}

async function aiRequest(path, {body, token, headers = {}, timeout = 12000} = {}) {
  if (!aiOnline()) throw new Error('AI 서버 연결 설정이 필요합니다.');
  if (token) headers.Authorization = 'Bearer ' + token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(PTLAB_CONFIG.apiUrl + '/api/' + path, {
      method: path === 'status' ? 'GET' : 'POST',
      body, headers, cache: 'no-store', credentials: 'omit', redirect: 'error',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (response.status === 401 && token) aiClearSession();
    if (!response.ok || !data) {
      throw new Error(typeof data?.error === 'string' ? data.error : 'AI 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.');
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AI 요청 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.');
    if (error instanceof TypeError) throw new Error('AI 서버에 연결할 수 없습니다. 일반 복기는 계속 사용할 수 있습니다.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function aiFeedbackPayload() {
  const deck = deckText().replace(/^외부 PPTX 미첨부: 자료 내용 미확인$/, '');
  const transcript = String(S.transcript || '').trim();
  const meaningfulDeck = deck.replace(/제목을 입력하세요|핵심 내용을 입력하세요|내용을 입력하세요|\[\d+장\]/g, '').replace(/\s/g, '');
  if (meaningfulDeck.length < 35 && transcript.length < 70) {
    throw new Error('작성한 PPTX의 텍스트를 첨부하거나 실제 발표 내용을 입력해 주세요.');
  }
  const questions = allQuestions();
  const limits = PTLAB_CONFIG;
  return JSON.stringify({
    caseId: currentCase().id,
    deck: deck.slice(0, limits.maxDeckChars),
    transcript: transcript.slice(0, limits.maxTranscriptChars),
    answers: Object.entries(S.answers || {}).slice(0, limits.maxAnswers).map(([index, text]) => ({
      question: questions[Number(index)] || index,
      answer: String(text).slice(0, limits.maxAnswerChars),
    })),
    duration: {prep: S.used.prep, present: S.used.present, qa: S.used.qa},
    practiceMode: S.mode,
    workspace: S.workspace,
  });
}

async function aiHandle(action) {
  if (!aiInReview() || AI.busy) return;
  const practice = S;
  if (action === 'download-feedback') {
    download('PT_AI_피드백_' + safeFilename(currentCase().id) + '.json',
      JSON.stringify({case: currentCase().title, feedback: S.aiFeedback, at: S.aiEvaluatedAt}, null, 2),
      'application/json');
    return;
  }
  const input = document.getElementById('aiAccess');
  const password = action === 'login' ? input?.value : null;
  if (input) input.value = '';
  AI.busy = true;
  aiMount();
  try {
    if (action === 'status') {
      AI.ready = (await aiRequest('status')).ready === true;
      AI.notice = AI.ready ? '서버 설정이 확인됐습니다. 모델 이용 가능 여부는 실제 전사·피드백 요청에서 확인됩니다.' : 'AI 서비스가 아직 설정되지 않았습니다.';
      return;
    }
    if (action === 'login') {
      if (!password) throw new Error('개인 접근 비밀번호를 입력해 주세요.');
      const reply = await aiRequest('login', {
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password}),
      });
      AI.token = reply.token;
      AI.expiresAt = reply.expiresAt;
      AI.ready = reply.ready === true;
      AI.notice = AI.ready ? '개인 인증이 완료됐습니다.' : '인증이 완료됐습니다. AI 요청에는 서버의 OpenAI 설정이 필요합니다.';
      return;
    }
    const token = AI.token;
    if (action === 'logout') {
      aiClearSession();
      await aiRequest('logout', {token});
      AI.notice = 'AI에서 로그아웃했습니다.';
      return;
    }
    if (!token) throw new Error('개인 인증이 필요합니다. 다시 연결해 주세요.');
    if (!AI.ready) throw new Error('AI 서버 설정을 확인해 주세요.');
    if (!AI.consent) throw new Error('자료 전송과 API 이용에 동의한 뒤 요청해 주세요.');
    const headers = {'X-PT-Consent': 'yes', 'X-PT-Request-Id': crypto.randomUUID()};
    if (action === 'transcribe') {
      const saved = audioCache.get(AI.audioId);
      const file = AI.audioFile || saved?.blob;
      if (!file?.size) throw new Error('녹음 파일 또는 저장된 녹음을 선택해 주세요.');
      if (file.size > PTLAB_CONFIG.maxAudioBytes) {
        throw new Error(PTLAB_CONFIG.maxAudioBytes.toLocaleString('ko-KR') + '바이트 (24 MB) 이하의 녹음을 선택해 주세요.');
      }
      const format = aiAudioFormat(file, AI.audioFile?.name || saved?.name);
      if (!format) throw new Error('지원하는 형식으로 녹음을 선택해 주세요.');
      headers['Content-Type'] = PTLAB_CONFIG.audioTypes[format];
      headers['X-PT-Audio-Format'] = format;
      const reply = await aiRequest('transcribe', {token, headers, body: file, timeout: 185000});
      if (!aiInReview() || S !== practice) return;
      const transcript = $('#transcript');
      transcript.value = reply.text;
      transcript.dispatchEvent(new Event('input', {bubbles: true}));
      save(true);
      AI.notice = '한국어 녹취를 ‘실제 발표 내용’에 반영했습니다. 고유명사와 숫자를 확인해 주세요.';
    } else if (action === 'evaluate') {
      const body = aiFeedbackPayload();
      if (new Blob([body]).size > PTLAB_CONFIG.maxFeedbackBytes) {
        throw new Error('피드백 자료가 너무 큽니다. 발표 내용이나 답변을 줄여 주세요.');
      }
      headers['Content-Type'] = 'application/json';
      const reply = await aiRequest('feedback', {token, headers, body, timeout: 95000});
      if (!aiInReview() || S !== practice) return;
      S.aiFeedback = reply.feedback;
      S.aiEvaluatedAt = new Date().toLocaleString('ko-KR');
      storeHistory();
      save(true);
      AI.notice = '피드백을 받았습니다.';
    }
  } catch (error) {
    if (S === practice) AI.notice = error.message;
  } finally {
    AI.busy = false;
    aiMount();
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-ai-act]');
  if (button) aiHandle(button.dataset.aiAct);
});

document.addEventListener('change', event => {
  if (event.target.id === 'aiConsent') AI.consent = event.target.checked;
  if (event.target.id === 'aiAudioFile') {
    AI.audioFile = event.target.files[0] || null;
    if (AI.audioFile) AI.audioId = '';
    aiMount();
  }
  if (event.target.id === 'aiSavedAudio') {
    AI.audioId = event.target.value;
    AI.audioFile = null;
    aiMount();
  }
});

document.addEventListener('ptlab-audio-changed', () => {
  const select = document.getElementById('aiSavedAudio');
  if (select && aiInReview()) select.innerHTML = aiSavedOptions();
});

const renderPractice = render;
render = function () {
  renderPractice();
  aiMount();
};
aiMount();
