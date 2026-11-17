"""Browser acceptance tests using public Pages or a temporary Pages-style host."""
import argparse
from contextlib import ExitStack, contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer, BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SLIDE_TEXT = "상품 상세에서 구매 전에 꼭 알아야 할 정보의 순서를 바꿉니다. 적용 전후에 구매전환율과 반품률을 비교합니다."
SYNTHETIC_TEXT = "실제 면접 내용과 관계없는 모의 전사 자료입니다. 고객이 쉽게 비교하도록 정보를 정리하겠습니다."
BROWSER_CASES = []


class QuietStatic(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@contextmanager
def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class MockAI(BaseHTTPRequestHandler):
    calls = []
    page_origin = ""
    fail = False

    def log_message(self, *_args):
        pass

    def send_result(self, body, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", self.page_origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "authorization,content-type,x-pt-audio-format,x-pt-consent,x-pt-request-id")
        self.end_headers()
        if body is not None:
            self.wfile.write(json.dumps(body, ensure_ascii=False).encode())

    def do_OPTIONS(self):
        self.send_result(None, 204)

    def do_GET(self):
        self.calls.append(self.path)
        if self.fail:
            self.send_result({"error": "AI 서버가 일시적으로 중단됐습니다."}, 503)
        else:
            self.send_result({"ready": True})

    def do_POST(self):
        self.calls.append(self.path)
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/api/login":
            assert json.loads(data) == {"password": "local-test-password"}
            self.send_result({"token": "synthetic-test-session", "expiresAt": 4102444800000, "ready": True})
            return
        assert self.headers["Authorization"] == "Bearer synthetic-test-session"
        assert self.headers["X-PT-Consent"] == "yes"
        assert len(self.headers["X-PT-Request-Id"]) == 36
        if self.path == "/api/transcribe":
            assert self.headers["X-PT-Audio-Format"] == "webm"
            assert data == b"synthetic audio payload"
            self.send_result({"text": SYNTHETIC_TEXT})
            return
        assert self.path == "/api/feedback"
        packet = json.loads(data)
        assert packet["caseId"].startswith("C")
        assert SLIDE_TEXT in packet["deck"]
        assert packet["transcript"] == SYNTHETIC_TEXT
        assert {"name", "audio", "notes", "file"}.isdisjoint(packet)
        self.send_result({"feedback": {
            "summary": "근거를 제시했습니다.", "strengths": ["측정 지표 제시"],
            "priorities": ["비교 기간 명시"], "better_opening": "고객 문제를 먼저 말하세요.",
            "data_check": "비교 기준 통일", "feasibility": "한 상품군부터 시험",
            "speech_scope": "발표 텍스트만 확인", "followups": [
                {"question": "왜 이 방법인가요?", "reason": "대안 검토", "answer_approach": "비용과 효과 비교"},
            ], "next_drill": "30초 결론 연습",
        }})


def button(page, action, value=None):
    selector = f'[data-act="{action}"]'
    if value is not None:
        selector += f'[data-value="{value}"]'
    return page.locator(selector)


def ai_button(page, action):
    return page.locator(f'[data-ai-act="{action}"]')


def confirmed_action(page, name):
    button(page, name).click()
    page.get_by_role("dialog").get_by_role("button", name="계속", exact=True).click()


def start(page, workspace="browser"):
    button(page, "set-workspace", workspace).click()
    page.locator("#soundWanted").uncheck()
    page.locator("#agree").check()
    button(page, "start").click()
    expect(button(page, "select-case")).to_have_count(3)


def select_case(page):
    button(page, "select-case").first.click()
    button(page, "begin-prep").click()


def assert_pptx(download, text=None):
    assert download.suggested_filename.endswith(".pptx"), download.suggested_filename
    with ZipFile(download.path()) as pptx:
        assert pptx.testzip() is None
        assert "[Content_Types].xml" in pptx.namelist()
        slides = [n for n in pptx.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
        if text:
            xml = pptx.read(slides[0]).decode()
            assert text in xml and "<p:sp>" in xml and "<a:t>" in xml
        else:
            assert len(slides) == 4


def observe(context):
    page = context.new_page()
    errs, api_requests = [], []
    page.on("pageerror", lambda exc: errs.append(str(exc)))
    page.on("request", lambda request: api_requests.append(request.url) if "/api/" in request.url else None)
    return page, errs, api_requests


def test_strict(browser, url, public):
    context = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 950})
    page, errors, api_requests = observe(context)
    page.clock.install()
    response = page.goto(url, wait_until="load")
    assert response.status == 200
    expect(page.get_by_role("heading", level=1)).to_contain_text("시간 안에 완성하기")
    assert (page.reload(wait_until="load")).status == 200
    license_url = url.rsplit("/", 1)[0] + "/licenses/PptxGenJS-LICENSE.txt"
    assert context.request.get(license_url).status == 200
    start(page)
    assert "01:00" in page.locator(".clock [data-time]").inner_text() or "00:59" in page.locator(".clock [data-time]").inner_text()
    page.clock.fast_forward(61_000)
    expect(page.locator("#slideCanvas")).to_be_visible()
    expect(page.locator(".clock [data-time]")).to_have_text("50:00")
    expect(button(page, "pause")).to_have_count(0)
    editor = page.locator("#slideCanvas .object.text").first
    editor.dblclick()
    expect(editor).to_have_attribute("contenteditable", "true")
    editor.fill(SLIDE_TEXT)
    page.locator("#notes").fill("페이지 새로고침 복구 확인")
    button(page, "add-slide").click()
    with page.expect_download() as result:
        button(page, "pptx").click()
    deck = result.value
    assert_pptx(deck, SLIDE_TEXT)
    page.reload(wait_until="load")
    button(page, "resume").click()
    expect(page.locator("#notes")).to_have_value("페이지 새로고침 복구 확인")
    expect(page.locator(".slide-tab")).to_have_count(2)

    page.clock.fast_forward(3_001_000)
    expect(page.get_by_role("heading", name="이제 발표를 시작합니다.")).to_be_visible()
    expect(page.locator("#slideCanvas")).to_have_count(0)
    assert page.evaluate("JSON.parse(localStorage.getItem('ptlab-v3-session')).locked")
    button(page, "start-presentation").click()
    expect(page.locator("#countNumber")).to_be_visible()
    page.clock.run_for(5_100)
    expect(page.locator("#presentCanvas")).to_be_visible()
    page.clock.fast_forward(301_000)
    expect(page.locator("#answerNote")).to_be_visible()
    page.locator("#answerNote").fill("질의응답 메모 복구 확인")
    button(page, "next-question").click()
    page.clock.fast_forward(600_000)
    expect(page.locator("#ai-review-panel")).to_be_visible()
    assert api_requests == [], api_requests
    with page.expect_download() as result:
        button(page, "backup").click()
    backup = result.value.path().read_bytes()
    saved = json.loads(backup)
    assert saved["stage"] == "review" and saved["answers"]["0"] == "질의응답 메모 복구 확인"
    assert saved["durations"] == {"choose": 60, "prep": 3000, "present": 300, "qa": 600}
    assert "token" not in saved

    if public:
        ai_button(page, "status").click()
        expect(page.locator("#aiNotice")).to_contain_text("서버", timeout=20_000)
        assert len(api_requests) == 1 and api_requests[0].endswith("/api/status"), api_requests
    else:
        ai_button(page, "status").click()
        expect(page.locator("#aiNotice")).to_contain_text("서버 설정이 확인")
        page.locator("#aiAccess").fill("local-test-password")
        ai_button(page, "login").click()
        expect(page.locator("#aiConsent")).to_be_visible()
        ai_button(page, "evaluate").click()
        expect(page.locator("#aiNotice")).to_contain_text("동의")
        assert MockAI.calls == ["/api/status", "/api/login"]
        page.locator("#aiConsent").check()
        page.locator("#aiAudioFile").set_input_files({"name": "too-large.webm", "mimeType": "audio/webm", "buffer": bytes(24_000_001)})
        ai_button(page, "transcribe").click()
        expect(page.locator("#aiNotice")).to_contain_text("24,000,000")
        assert len(MockAI.calls) == 2
        page.locator("#aiAudioFile").set_input_files({"name": "synthetic.webm", "mimeType": "audio/webm", "buffer": b"synthetic audio payload"})
        ai_button(page, "transcribe").click()
        expect(page.locator("#transcript")).to_have_value(SYNTHETIC_TEXT)
        page.evaluate("""() => {
          const b = document.querySelector('[data-ai-act=evaluate]');
          b.click();
          b.click();
        }""")
        expect(page.locator(".ai-outcome")).to_contain_text("근거를 제시했습니다.")
        assert MockAI.calls == ["/api/status", "/api/login", "/api/transcribe", "/api/feedback"]
        assert page.evaluate("!JSON.stringify(localStorage).includes('synthetic-test-session')")
        assert page.evaluate("sessionStorage.length") == 0
        page.reload(wait_until="load")
        button(page, "open-history").first.click()
        expect(page.locator(".ai-outcome")).to_contain_text("근거를 제시했습니다.")
        expect(page.locator("#aiAccess")).to_be_visible()
        MockAI.fail = True
        try:
            ai_button(page, "status").click()
            expect(page.locator("#aiNotice")).to_contain_text("중단")
            with page.expect_download() as report:
                button(page, "report").click()
            assert "PT LAB" in report.value.path().read_text(encoding="utf-8")
            button(page, "new-session").click()
            start(page)
        finally:
            MockAI.fail = False

    assert not errors, errors
    deck_bytes = deck.path().read_bytes()
    context.close()
    BROWSER_CASES.append("Pages subpath, reload, strict flow, deadline lock, editable PPTX, review and backups")
    if not public:
        BROWSER_CASES.append("AI never starts before review; consent, upload cap, stub feedback, manual retry and outage")
    return deck_bytes, backup


def test_study(browser, url, deck, backup):
    context = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 950})
    page, errors, api_requests = observe(context)
    page.clock.install()
    assert page.goto(url, wait_until="load").status == 200
    button(page, "set-mode", "study").click()
    page.locator("#prepMinutes").select_option("10")
    start(page, "powerpoint")
    select_case(page)
    expect(button(page, "study-help")).to_be_visible()
    button(page, "pause").click()
    paused = page.locator(".clock [data-time]").inner_text()
    page.clock.fast_forward(30_000)
    expect(page.locator(".clock [data-time]")).to_have_text(paused)
    button(page, "pause").click()
    page.clock.run_for(2_000)
    assert paused != page.locator(".clock [data-time]").inner_text()
    with page.expect_download() as result:
        button(page, "blank-pptx").click()
    assert_pptx(result.value)
    confirmed_action(page, "submit")
    page.locator("#importPptx").set_input_files({"name": "synthetic-external.pptx",
        "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "buffer": deck})
    expect(page.get_by_text("2장 텍스트 확인", exact=False)).to_be_visible()
    permission = context.new_cdp_session(page)
    origin = f"{urlsplit(url).scheme}://{urlsplit(url).netloc}"
    context_id = permission.send("Target.getTargetInfo")["targetInfo"]["browserContextId"]
    permission.send("Browser.setPermission", {"permission": {"name": "microphone"}, "setting": "denied",
                     "origin": origin, "browserContextId": context_id})
    page.locator("#micWanted").check()
    button(page, "start-presentation").click()
    expect(page.get_by_role("dialog", name="녹음을 시작하지 못했습니다")).to_be_visible()
    page.get_by_role("button", name="녹음 없이 시작").click()
    page.clock.run_for(5_100)
    expect(page.get_by_role("heading", name="PowerPoint로 전환해 발표하세요.")).to_be_visible()
    confirmed_action(page, "end-presentation")
    button(page, "view-deck").click()
    expect(page.get_by_role("dialog")).to_contain_text(SLIDE_TEXT)
    page.get_by_role("button", name="닫기", exact=True).click()
    confirmed_action(page, "finish")
    expect(page.locator("#ai-review-panel")).to_be_visible()
    assert api_requests == [], api_requests

    button(page, "new-session").click()
    page.locator("#importSession").set_input_files({"name": "synthetic-v3-backup.json", "mimeType": "application/json", "buffer": backup})
    expect(page.get_by_role("heading", name="한 번을 끝까지 완성했습니다.")).to_be_visible()
    expect(page.locator(".summary-metrics")).to_contain_text("브라우저 작성")
    assert page.evaluate("JSON.parse(localStorage.getItem('ptlab-v3-history')).length") == 2
    assert not errors, errors
    context.close()
    BROWSER_CASES.append("study pause/resume, PowerPoint flow, template, external text, microphone denial and v3 import")


def test_recording(browser, url):
    context = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 950})
    context.grant_permissions(["microphone"], origin=f"{urlsplit(url).scheme}://{urlsplit(url).netloc}")
    page, errors, api_requests = observe(context)
    page.clock.install()
    page.goto(url, wait_until="load")
    start(page, "powerpoint")
    select_case(page)
    confirmed_action(page, "submit")
    page.locator("#micWanted").check()
    button(page, "start-presentation").click()
    expect(page.locator("#countNumber")).to_be_visible(timeout=10_000)
    page.clock.run_for(5_100)
    expect(page.get_by_text("이 기기에 녹음 중", exact=True)).to_be_visible()
    confirmed_action(page, "end-presentation")
    # Browser fake microphone still produces real MediaRecorder events.
    page.clock.run_for(1_200)
    confirmed_action(page, "finish")
    audio = page.locator("#audioList audio")
    expect(audio).to_have_count(1)
    media = audio.evaluate("""async element => {
      await element.play();
      const paused = element.paused;
      element.pause();
      return {paused, source: element.src};
    }""")
    assert media["paused"] is False and media["source"].startswith("blob:")
    with page.expect_download() as result:
        button(page, "audio-download").click()
    assert result.value.path().stat().st_size > 0
    page.reload(wait_until="load")
    button(page, "open-history").first.click()
    expect(audio).to_have_count(1)
    assert api_requests == [], api_requests
    assert not errors, errors
    context.close()
    BROWSER_CASES.append("synthetic microphone grant, recording, playback, download and reload")


def test_csp(browser, url):
    page = browser.new_page()
    page.goto(url)
    violated = page.evaluate("""() => new Promise(resolve => {
      document.addEventListener('securitypolicyviolation', event => resolve(event.effectiveDirective), {once: true});
      fetch('http://127.0.0.1:1/unapproved-origin').catch(() => {});
    })""")
    assert violated == "connect-src"
    page.close()
    BROWSER_CASES.append("unapproved external request blocked by CSP")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-url")
    args = parser.parse_args()
    with sync_playwright() as playwright, ExitStack() as stack:
        if args.public_url:
            url = args.public_url
        else:
            directory = Path(stack.enter_context(TemporaryDirectory(prefix="ptlab-browser-")))
            api = stack.enter_context(serve(MockAI))
            MockAI.page_origin = stack.enter_context(serve(partial(QuietStatic, directory=directory)))
            output = directory / "dreamstage-pt-lab"
            subprocess.run([sys.executable, "source/build.py", "--local-test", "--api-url", api, "--output", str(output)],
                           cwd=ROOT, check=True)
            url = MockAI.page_origin + "/dreamstage-pt-lab/"
        chrome = os.environ.get("PTLAB_BROWSER_EXECUTABLE") or None
        browser = playwright.chromium.launch(headless=True, executable_path=chrome,
            args=["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
        stack.callback(browser.close)
        deck, backup = test_strict(browser, url, bool(args.public_url))
        test_study(browser, url, deck, backup)
        recording_browser = playwright.chromium.launch(headless=True, executable_path=chrome,
            channel=None if chrome else "chromium",
            args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                  "--autoplay-policy=no-user-gesture-required"])
        stack.callback(recording_browser.close)
        test_recording(recording_browser, url)
        test_csp(browser, url)
        for result in BROWSER_CASES:
            print("PASS", result)


if __name__ == "__main__":
    main()
