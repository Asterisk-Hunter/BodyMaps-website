"""Continue the isolated synthetic annotation through review and a manual edit."""
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                                    headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("dialog", lambda dialog: dialog.accept())
        page.on("pageerror", lambda error: print("PAGE ERROR:", error, flush=True))
        page.goto("http://127.0.0.1:5185/account/annotation-projects", wait_until="domcontentloaded")
        page.get_by_role("option", name="Fixture project").wait_for(timeout=60000, state="attached")
        page.locator("select").filter(has=page.get_by_role("option", name="Fixture project")).select_option(label="Fixture project")
        page.get_by_role("button", name="Request rework").click(timeout=60000)
        page.get_by_text("Changes requested. The annotator can revise the draft.").wait_for(timeout=60000, state="attached")
        page.goto("http://127.0.0.1:5185/work", wait_until="domcontentloaded")
        page.get_by_role("button", name="View cases").click(timeout=60000)
        page.get_by_role("link", name="Open", exact=True).click()
        page.get_by_text("Changes requested", exact=True).wait_for(timeout=60000, state="attached")
        page.get_by_role("button", name="Segment", exact=True).click(timeout=120000)
        skip = page.get_by_role("button", name="Skip tour")
        if skip.is_visible(timeout=2000):
            skip.click()
        page.screenshot(path=r"C:\Users\panne\AppData\Local\Temp\annotation-layout.png")
        page.get_by_role("button", name="Select structure").click(timeout=10000)
        page.get_by_role("option", name="Common bile duct", exact=False).click()
        print("BUTTONS:", page.get_by_role("button").all_text_contents(), flush=True)
        page.screenshot(path=str(__import__("pathlib").Path(__import__("tempfile").gettempdir()) / "bodymaps-annotation-e2e.png"))
        print("PASS: reviewer requested rework and annotator opened the target structure", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
