import { DurableObject } from 'cloudflare:workers';

const encoder = new TextEncoder();
const SESSION_MS = 30 * 60_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const MAX_LOGIN_FAILURES = 8;
const MAX_DAILY_CALLS = 10;
const LEASE_MS = 200_000;
const UNAUTHORIZED = {status: 401, error: '개인 인증이 필요하거나 만료됐습니다. 다시 연결해 주세요.'};

function sha(value) {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 24 && password.length <= 256;
}

export class AccessGate extends DurableObject {
  async tokenHash(token) {
    // Changing the password also invalidates previously issued sessions.
    const bytes = await sha(JSON.stringify([this.env.ACCESS_PASSWORD, token]));
    return new Uint8Array(bytes).toHex();
  }

  async login(password) {
    if (!validPassword(this.env.ACCESS_PASSWORD)) {
      return {status: 503, error: '서버에 개인 접근 비밀번호를 설정해야 합니다.'};
    }
    const [actual, expected] = await Promise.all([sha(password), sha(this.env.ACCESS_PASSWORD)]);
    const verified = crypto.subtle.timingSafeEqual(actual, expected);
    const now = Date.now();
    const token = verified ? crypto.getRandomValues(new Uint8Array(32)).toHex() : null;
    const session = token ? {hash: await this.tokenHash(token), expiresAt: now + SESSION_MS} : null;
    return this.ctx.storage.transaction(async txn => {
      let attempts = await txn.get('login');
      if (!attempts || attempts.until <= now) attempts = {count: 0, until: now + LOGIN_WINDOW_MS};
      if (attempts.count >= MAX_LOGIN_FAILURES) {
        return {status: 429, error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.'};
      }
      if (!session) {
        await txn.put('login', {...attempts, count: attempts.count + 1});
        return {status: 401, error: '개인 접근 비밀번호를 확인해 주세요.'};
      }
      await txn.delete('login');
      await txn.put('session', session);
      return {status: 200, token, expiresAt: session.expiresAt};
    });
  }

  async authenticate(token) {
    const hash = await this.tokenHash(token);
    const session = await this.ctx.storage.get('session');
    return session?.hash === hash && session.expiresAt > Date.now() ? {status: 200} : UNAUTHORIZED;
  }

  async logout(token) {
    const hash = await this.tokenHash(token);
    return this.ctx.storage.transaction(async txn => {
      const session = await txn.get('session');
      if (session?.hash !== hash || session.expiresAt <= Date.now()) return UNAUTHORIZED;
      await txn.delete('session');
      return {status: 200};
    });
  }

  async reserve(token, id) {
    const hash = await this.tokenHash(token);
    return this.ctx.storage.transaction(async txn => {
      const now = Date.now();
      const session = await txn.get('session');
      if (session?.hash !== hash || session.expiresAt <= now) return UNAUTHORIZED;
      const lease = await txn.get('lease');
      let daily = await txn.get('daily');
      const day = Math.floor(now / 86_400_000);
      if (daily?.day !== day) daily = {day, ids: []};
      if (daily.ids.includes(id)) return {status: 409, error: '이미 접수한 요청입니다. 중복 전송을 막았습니다.'};
      if (lease?.until > now) return {status: 429, error: '이미 AI 요청을 처리 중입니다. 완료될 때까지 기다려 주세요.'};
      if (daily.ids.length >= MAX_DAILY_CALLS) {
        return {status: 429, error: '하루 AI 요청 한도에 도달했습니다. 한국시간 오전 9시에 초기화됩니다.'};
      }
      await txn.put('daily', {day, ids: [...daily.ids, id]});
      await txn.put('lease', {id, until: now + LEASE_MS});
      return {status: 200};
    });
  }

  async release(id) {
    await this.ctx.storage.transaction(async txn => {
      if ((await txn.get('lease'))?.id === id) await txn.delete('lease');
    });
  }
}
