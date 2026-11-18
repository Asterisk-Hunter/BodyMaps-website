"""Exercise a synthetic scan through a dedicated local fixture server."""
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                                    headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("dialog", lambda dialog: dialog.accept())
        page.on("pageerror", lambda error: print("PAGE ERROR:", error, flush=True))
        page.goto("http://127.0.0.1:5185/work", wait_until="domcontentloaded")
        page.get_by_role("heading", name="Fixture project").wait_for(timeout=60000)
        page.get_by_role("button", name="View cases").click()
        page.get_by_role("link", name="Open", exact=True).click()
        page.get_by_text("Targets: Common bile duct").wait_for(timeout=60000)
        page.get_by_role("button", name="Save draft", exact=True).first.click(timeout=120000)
        page.get_by_text("Draft saved", exact=True).wait_for(timeout=120000)
        page.get_by_role("button", name="Submit for review").click()
        page.get_by_text("Awaiting review", exact=True).wait_for(timeout=60000)
        print("PASS: real viewer loaded fixture, saved a private draft, and submitted it", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
