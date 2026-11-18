"""Browser smoke check for assignment navigation with a mocked API.

Run against an isolated Vite server on port 5185. This does not exercise the
medical image renderer or substitute for the backend workflow tests.
"""
import json
from playwright.sync_api import sync_playwright


def main():
    user = {"id": "reader", "email": "reader@example.org", "name": "Reader", "plan": "free",
            "email_verified": True, "roles": ["annotator"]}
    project = {"id": "project-1", "name": "Ducts", "target_names": {"7": "Bile duct"}}

    def route_api(route):
        url = route.request.url
        if "/api/auth/me" in url:
            body = {"user": user}
        elif "/api/annotation-projects/capabilities" in url:
            body = {"enabled": True, "can_manage": False, "can_review": False}
        elif "/api/me/assignments" in url:
            body = {"assignments": [{"id": "assignment-1", "project": project, "case_count": 1, "counts": {}}]}
        elif "/api/assignments/assignment-1/cases" in url:
            body = {"cases": [{"case_key": "PanTS_00000055", "status": "in_progress"}]}
        elif "/api/auth/oauth/providers" in url:
            body = {"google": False, "github": False}
        else:
            body = {"items": [], "jobs": []}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless=True)
        page = browser.new_page()
        page.route("**/api/**", route_api)
        page.goto("http://127.0.0.1:5185/work", wait_until="domcontentloaded")
        page.get_by_role("heading", name="Your worklist").wait_for(timeout=30000)
        page.get_by_role("button", name="View cases").click()
        link = page.get_by_role("link", name="Open", exact=True)
        link.wait_for()
        assert link.get_attribute("href") == "/case/PanTS_00000055?assignment=assignment-1&hd=1"
        print("PASS: signed-in worklist loads and opens the assignment-specific case URL")
        browser.close()


if __name__ == "__main__":
    main()
