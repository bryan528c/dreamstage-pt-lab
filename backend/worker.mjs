import limits from '../source/contract.json' with { type: 'json' };
import {validPassword} from './access.mjs';
import {ApiError, feedbackInput, runFeedback, runTranscription} from './openai.mjs';

export {AccessGate} from './access.mjs';

const methods = new Map([
  ['/api/status', 'GET'], ['/api/login', 'POST'], ['/api/logout', 'POST'],
  ['/api/feedback', 'POST'], ['/api/transcribe', 'POST'],
]);
const allowedHeaders = ['authorization', 'content-type', 'x-pt-audio-format', 'x-pt-consent', 'x-pt-request-id'];
const ready = env => validPassword(env.ACCESS_PASSWORD) && Boolean(env.OPENAI_API_KEY);

function gateError(result) {
  if (result.status !== 200) throw new ApiError(result.status, result.error);
  return result;
}

function declaredSize(request, limit, required = false) {
  const value = request.headers.get('Content-Length');
  if (value === null && !required) return null;
  if (value === null) throw new ApiError(411, '파일 크기를 확인할 수 없습니다. 녹음 파일을 선택해 다시 보내 주세요.');
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new ApiError(400, '빈 요청이거나 자료 크기가 잘못되었습니다.');
  if (Number(value) > limit) {
    throw new ApiError(413, limit === limits.maxAudioBytes ? '음성은 24,000,000바이트(24 MB)까지 전송할 수 있습니다.' : '요청 자료가 너무 큽니다.');
  }
  return Number(value);
}

async function inputJson(request, limit) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json' || !request.body) {
    throw new ApiError(400, 'JSON 형식의 입력이 필요합니다.');
  }
  declaredSize(request, limit);
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let length = 0;
  let text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new ApiError(413, '요청 자료가 너무 큽니다.');
      }
      text += decoder.decode(value, {stream: true});
    }
    const result = JSON.parse(text + decoder.decode());
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
  } finally {
    reader.releaseLock();
  }
  throw new ApiError(400, '올바른 JSON 객체를 보내 주세요.');
}

function audioInput(request) {
  const format = request.headers.get('X-PT-Audio-Format');
  if (!Object.hasOwn(limits.audioTypes, format)
    || request.headers.get('Content-Type') !== limits.audioTypes[format] || !request.body) {
    throw new ApiError(415, '지원하는 음성 형식으로 녹음 파일을 선택해 주세요.');
  }
  return {format, size: declaredSize(request, limits.maxAudioBytes, true)};
}

async function handle(request, env, ctx, path) {
  if (path === '/api/status') return {ready: ready(env)};
  const gate = env.ACCESS.getByName('personal-ai');
  if (path === '/api/login') {
    const {password} = await inputJson(request, 2048);
    if (typeof password !== 'string' || !password || password.length > 256) {
      throw new ApiError(400, '개인 접근 비밀번호를 입력해 주세요.');
    }
    const {token, expiresAt} = gateError(await gate.login(password));
    return {token, expiresAt, ready: ready(env)};
  }
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new ApiError(401, '개인 인증이 필요합니다. 복기에서 AI를 연결해 주세요.');
  if (path === '/api/logout') {
    gateError(await gate.logout(token));
    return {ok: true};
  }
  gateError(await gate.authenticate(token));
  if (!ready(env)) throw new ApiError(503, '서버의 OpenAI 설정을 확인해 주세요.');
  if (request.headers.get('X-PT-Consent') !== 'yes') {
    throw new ApiError(400, '전송과 API 이용에 대한 동의가 필요합니다.');
  }
  const id = request.headers.get('X-PT-Request-Id');
  if (!id || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) {
    throw new ApiError(400, '요청 식별자가 올바르지 않습니다. 페이지에서 다시 요청해 주세요.');
  }

  const transcription = path === '/api/transcribe';
  const audio = transcription ? audioInput(request) : null;
  const feedback = transcription ? null : feedbackInput(await inputJson(request, limits.maxFeedbackBytes));
  gateError(await gate.reserve(token, id));

  const controller = new AbortController();
  const abortClientRequest = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abortClientRequest, {once: true});
  if (request.signal.aborted) abortClientRequest();
  const timer = setTimeout(() => controller.abort(new ApiError(504, 'AI 처리 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.')),
    transcription ? 170_000 : 80_000);
  try {
    return transcription
      ? await runTranscription(env, request.body, audio.format, audio.size, controller)
      : await runFeedback(env, feedback, controller.signal);
  } catch (error) {
    if (controller.signal.reason instanceof ApiError) throw controller.signal.reason;
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'OpenAI 서비스 연결에 문제가 있습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abortClientRequest);
    const release = gate.release(id).catch(() => {});
    ctx.waitUntil(release);
    await release;
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const allowed = origin && origin === env.PAGES_ORIGIN;
    const headers = new Headers({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', Vary: 'Origin',
    });
    if (allowed) headers.set('Access-Control-Allow-Origin', origin);
    const json = (body, status = 200) => Response.json(body, {status, headers});

    const path = new URL(request.url).pathname;
    const method = methods.get(path);
    if ((origin && !allowed) || (!origin && !(path === '/api/status' && request.method === 'GET'))) {
      return json({error: '허용된 연습 페이지에서만 요청할 수 있습니다.'}, 403);
    }
    if (!method) return json({error: '지원하지 않는 경로입니다.'}, 404);
    if (request.method === 'OPTIONS') {
      const requested = (request.headers.get('Access-Control-Request-Headers') || '')
        .toLowerCase().split(',').map(header => header.trim()).filter(Boolean);
      if (request.headers.get('Access-Control-Request-Method') !== method
        || requested.some(header => !allowedHeaders.includes(header))) {
        return json({error: '허용되지 않은 사전 요청입니다.'}, 403);
      }
      headers.set('Access-Control-Allow-Methods', method);
      headers.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      headers.set('Access-Control-Max-Age', '600');
      headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      return new Response(null, {status: 204, headers});
    }
    if (request.method !== method) return json({error: '지원하지 않는 요청 방식입니다.'}, 405);
    try {
      return json(await handle(request, env, ctx, path));
    } catch (error) {
      return error instanceof ApiError
        ? json({error: error.message}, error.status)
        : json({error: 'AI 서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'}, 500);
    }
  },
};
