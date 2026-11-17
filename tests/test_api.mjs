import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Miniflare, Response, convertV4MiniflareOptions} from 'miniflare';
import limits from '../source/contract.json' with {type: 'json'};

const origin = 'https://example.github.io';
const password = 'synthetic-session-fixture-not-a-live-credential';
const validReview = {
  caseId: 'C01', deck: '상품 상세 화면의 핵심 정보를 비교할 수 있게 정리합니다.',
  transcript: '', answers: [{question: '효과는 어떻게 확인합니까?', answer: '구매전환율과 반품률을 비교합니다.'}],
  duration: {prep: 2500, present: 290, qa: 590}, practiceMode: 'strict', workspace: 'browser',
};
const feedback = {
  summary: '구매전환율을 비교하세요.', strengths: ['고객 문제를 정의했습니다.'],
  priorities: ['기간을 명시하세요.'], better_opening: '상품 상세의 구매 결정을 돕는 제안입니다.',
  data_check: '방문자 중 구매자의 비율을 기준으로 비교하세요.', feasibility: '한 상품군에서 실험하세요.',
  speech_scope: '제출된 자료의 텍스트만 확인했습니다.',
  followups: [{question: '왜 이 상품군입니까?', reason: '선정 근거 확인', answer_approach: '실험 가능성과 규모로 판단'}],
  next_drill: '첫 30초를 다시 말해 보세요.',
};
const bundles = fileURLToPath(new URL('../backend/.wrangler/test/worker.js', import.meta.url));
const instances = [];
const upstreamResponse = body => Response.json({
  status: 'completed',
  output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(body)}]}],
});

function startWorker({hasKey = true, outbound = () => upstreamResponse(feedback)} = {}) {
  const worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: bundles, compatibilityDate: '2026-11-01',
    compatibilityFlags: ['enable_request_signal'],
    durableObjects: {ACCESS: {className: 'AccessGate', useSQLite: true}},
    bindings: {
      PAGES_ORIGIN: origin,
      ACCESS_PASSWORD: password,
      ...(hasKey ? {OPENAI_API_KEY: 'synthetic-upstream-test-credential'} : {}),
      OPENAI_FEEDBACK_MODEL: 'gpt-6-luna', OPENAI_FEEDBACK_REASONING: 'none',
      OPENAI_TRANSCRIBE_MODEL: 'gpt-transcribe',
    },
    outboundService(request) {
      assert.match(request.url, /^https:\/\/api\.openai\.com\/v1\/(?:responses|audio\/transcriptions)$/);
      assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-upstream-test-credential');
      return outbound(request);
    },
  }));
  instances.push(worker);
  return worker;
}

function call(worker, path, {headers, body, method = body === undefined ? 'GET' : 'POST'} = {}) {
  return worker.dispatchFetch('http://worker.test/api/' + path, {
    method, headers: {Origin: origin, ...headers}, body,
  });
}

async function login(worker, value = password) {
  return call(worker, 'login', {
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: value}),
  });
}

function paidHeaders(token, id = crypto.randomUUID()) {
  return {
    Authorization: 'Bearer ' + token, 'X-PT-Consent': 'yes', 'X-PT-Request-Id': id,
  };
}

function review(worker, token, inputs = {}) {
  return call(worker, 'feedback', {
    body: JSON.stringify(validReview), ...inputs,
    headers: {'Content-Type': 'application/json', ...paidHeaders(token), ...inputs.headers},
  });
}

async function rejectOversizedUpload(worker, headers) {
  const url = new URL('/api/transcribe', await worker.ready);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {method: 'POST', headers: {
      ...headers, Origin: origin, Connection: 'close', 'Content-Length': limits.maxAudioBytes + 1,
    }}, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {data += chunk;});
      response.on('end', () => {
        resolve({status: response.statusCode, error: JSON.parse(data).error});
        request.destroy();
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Expected early size rejection')));
    // Check the header limit without requiring the client to finish sending a rejected upload.
    request.write('x');
  });
}

let main, token, upstreamCalls = 0;
let respond;
before(async () => {
  main = startWorker({outbound: async req => {
    upstreamCalls++;
    return respond(req);
  }});
  const response = await login(main);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.ok(result.expiresAt > Date.now() + 29 * 60_000);
  assert.ok(result.expiresAt <= Date.now() + 30 * 60_000);
  assert.equal(result.ready, true);
  token = result.token;
});
after(async () => {
  await Promise.all(instances.map(worker => worker.dispose()));
});

test('status is public, tokenless and uncached, and legacy endpoints are absent', async () => {
  const status = await call(main, 'status');
  assert.equal(status.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await status.json(), {ready: true});
  assert.equal((await call(main, 'configure', {body: '{}'})).status, 404);
  assert.equal(upstreamCalls, 0);
});

test('only the exact Pages origin and approved preflight headers are allowed', async () => {
  const headers = {'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization, content-type, x-pt-consent, x-pt-request-id, x-pt-audio-format'};
  const ok = await call(main, 'transcribe', {method: 'OPTIONS', headers});
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(ok.headers.get('Access-Control-Allow-Credentials'), null);
  assert.match(ok.headers.get('Vary'), /Access-Control-Request-Headers/i);
  const wrong = await call(main, 'transcribe', {method: 'OPTIONS', headers: {...headers, Origin: origin + '.evil.test'}});
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call(main, 'feedback', {method: 'OPTIONS', headers: {...headers, 'Access-Control-Request-Headers': 'x-unexpected'}})).status, 403);
});

test('paid routes require a valid bearer independently of CORS', async () => {
  assert.equal((await call(main, 'feedback', {body: '{}'})).status, 401);
  assert.equal((await call(main, 'transcribe', {body: 'audio'})).status, 401);
  assert.equal((await review(main, '0'.repeat(64))).status, 401);
  assert.equal((await review(main, token, {headers: {Origin: 'null'}})).status, 403);
  assert.equal(upstreamCalls, 0);
});

test('consent, invalid JSON/audio and oversized requests get Korean client errors', async () => {
  const before = upstreamCalls;
  const noConsent = await review(main, token, {headers: {'X-PT-Consent': 'no'}});
  assert.equal(noConsent.status, 400);
  assert.match((await noConsent.json()).error, /동의/);
  assert.equal((await review(main, token, {body: '{'})).status, 400);
  assert.equal((await review(main, token, {body: JSON.stringify({caseId: 'unknown'})})).status, 400);
  assert.equal((await review(main, token, {body: 'x'.repeat(limits.maxFeedbackBytes + 1)})).status, 413);
  const headers = {...paidHeaders(token), 'Content-Type': 'audio/webm', 'X-PT-Audio-Format': 'webm'};
  assert.equal((await call(main, 'transcribe', {body: 'wav', headers: {...headers, 'X-PT-Audio-Format': 'wav'}})).status, 415);
  const tooBig = await rejectOversizedUpload(main, headers);
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.error, /24,000,000/);
  assert.equal(upstreamCalls, before);
});

test('Responses uses canonical case data, strict schema, store false and output cap', async () => {
  respond = async req => {
    const body = await req.json();
    assert.equal(body.store, false);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.max_output_tokens, 4400);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.schema.properties.followups.items.additionalProperties, false);
    const input = JSON.parse(body.input.split('\n')[1]);
    assert.equal(input.case.id, 'C01');
    assert.match(input.case.title, /상품 상세/);
    assert.ok(!Object.hasOwn(input, 'api_key') && !Object.hasOwn(input, 'name'));
    return upstreamResponse(feedback);
  };
  const res = await review(main, token);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(await res.json(), {feedback});
});

test('the 24 MB boundary streams as bounded multipart with a Korean language hint', async () => {
  respond = async req => {
    assert.match(req.url, /\/audio\/transcriptions$/);
    assert.match(req.headers.get('content-type'), /multipart\/form-data; boundary=/);
    const length = Number(req.headers.get('content-length'));
    assert.ok(length > limits.maxAudioBytes && length < 25_000_000);
    const form = await req.formData();
    assert.equal(form.get('language'), 'ko');
    assert.equal(form.get('model'), 'gpt-transcribe');
    const file = form.get('file');
    assert.equal(file.name, 'recording.webm');
    assert.equal(file.size, limits.maxAudioBytes);
    const bytes = new Uint8Array(await file.arrayBuffer());
    assert.equal(bytes[0], 26);
    assert.equal(bytes[limits.maxAudioBytes - 1], 29);
    return Response.json({text: '한국어 전사 모형 결과입니다.'});
  };
  const body = new Uint8Array(limits.maxAudioBytes);
  body[0] = 26;
  body[body.length - 1] = 29;
  const res = await call(main, 'transcribe', {
    headers: {...paidHeaders(token), 'Content-Type': 'audio/webm', 'X-PT-Audio-Format': 'webm'},
    body,
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(await res.json(), {text: '한국어 전사 모형 결과입니다.'});
});

test('quota, timeout, refusal, incomplete, parse and nested-schema errors are sanitized', async () => {
  const variants = [
    [() => Response.json({error: {message: 'sensitive fixture'}}, {status: 429}), 429, /한도/],
    [() => Response.json({error: 'sensitive fixture'}, {status: 504}), 504, /시간/],
    [() => Response.json({status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'sensitive fixture'}]}]}), 422, /처리할 수 없/],
    [() => Response.json({status: 'incomplete'}), 502, /끝까지/],
    [() => Response.json({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: 'sensitive fixture'}]}]}), 502, /JSON/],
    [() => upstreamResponse({...feedback, followups: [{question: 42}]}), 502, /형식/],
  ];
  for (const [handler, status, expected] of variants) {
    respond = handler;
    const res = await review(main, token);
    assert.equal(res.status, status);
    const error = (await res.json()).error;
    assert.match(error, expected);
    assert.doesNotMatch(error, /sensitive fixture/);
  }
});

test('login throttling, logout, and missing-key behavior enforce access', async () => {
  const separate = startWorker({hasKey: false, outbound: () => assert.fail('upstream disabled')});
  for (let i = 0; i < 8; i++) assert.equal((await login(separate, 'invalid')).status, 401);
  assert.equal((await login(separate)).status, 429);
  const offline = startWorker({hasKey: false, outbound: () => assert.fail('upstream disabled')});
  const res = await login(offline);
  assert.equal(res.status, 200);
  const session = await res.json();
  assert.equal(session.ready, false);
  assert.equal((await review(offline, session.token)).status, 503);
  assert.equal((await call(offline, 'logout', {method: 'POST', headers: paidHeaders(session.token)})).status, 200);
  assert.equal((await review(offline, session.token)).status, 401);
});

test('concurrency, cross-session duplicate prevention and daily quota are enforced atomically', async () => {
  let resume, entered;
  const hold = new Promise(resolve => {resume = resolve;});
  const started = new Promise(resolve => {entered = resolve;});
  let calls = 0;
  const separate = startWorker({outbound: async () => {
    if (++calls === 1) {
      entered();
      await hold;
    }
    return upstreamResponse(feedback);
  }});
  const session = await (await login(separate)).json();
  const id = crypto.randomUUID();
  const initial = review(separate, session.token, {headers: {'X-PT-Request-Id': id}});
  try {
    await Promise.race([started, initial.then(async response => {
      assert.fail('First request did not reach the mock upstream: ' + response.status + ' ' + await response.text());
    })]);
    assert.equal((await review(separate, session.token)).status, 429);
    assert.equal((await review(separate, session.token, {headers: {'X-PT-Request-Id': id}})).status, 409);
  } finally {
    resume();
  }
  assert.equal((await initial).status, 200);
  const next = await (await login(separate)).json();
  assert.equal((await review(separate, session.token)).status, 401);
  assert.equal((await review(separate, next.token, {headers: {'X-PT-Request-Id': id}})).status, 409);
  for (let i = 1; i < 10; i++) assert.equal((await review(separate, next.token)).status, 200);
  assert.equal((await review(separate, next.token)).status, 429);
  assert.equal(calls, 10);
});
