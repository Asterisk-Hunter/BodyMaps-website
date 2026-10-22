// Tell IndexNow search engines (Bing, which ChatGPT and Copilot search use, plus Yandex, Seznam, Naver) that the public
// pages changed, so they re-crawl them instead of waiting. Run after a deploy that changes public page content:
//   node PanTS-Demo/scripts/indexnow-submit.mjs            (submits every URL in public/sitemap.xml)
//   node PanTS-Demo/scripts/indexnow-submit.mjs --dry-run  (prints the request without sending it)
// The key is the one public/<32 hex>.txt file, which must already be live at https://bodymaps.wse.jhu.edu/<key>.txt.
// Google does not use IndexNow; it needs the sitemap submitted in Search Console.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "bodymaps.wse.jhu.edu";
const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const keys = readdirSync(pub).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (keys.length !== 1) throw new Error(`expected exactly one IndexNow key file in public/, found ${keys.length}`);
const key = keys[0].slice(0, 32);
const urlList = [...readFileSync(join(pub, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const body = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList };

if (process.argv.includes("--dry-run")) {
	console.log(JSON.stringify(body, null, 2));
} else {
	const live = await fetch(body.keyLocation).then((r) => (r.ok ? r.text() : ""));
	if (live.trim() !== key) throw new Error(`${body.keyLocation} does not serve the key yet (deploy first)`);
	const res = await fetch("https://api.indexnow.org/indexnow", {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
	});
	// 200 = accepted, 202 = accepted and the key is still being verified; anything else is a failure.
	console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs`);
	if (res.status !== 200 && res.status !== 202) process.exit(1);
}
