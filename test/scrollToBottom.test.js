import { expect } from 'chai';
import http from 'http';
import finalhandler from 'finalhandler';
import serveStatic from 'serve-static';
import puppeteer from '@website-scraper/puppeteer-version-wrapper';
import scrollToBottomBrowser from '../lib/browserUtils/scrollToBottom.js';

const SERVE_WEBSITE_PORT = 4570;

describe('scrollToBottom browser util', () => {
	let server, browser;

	before('start webserver', () => server = startWebserver(SERVE_WEBSITE_PORT));
	after('stop webserver', () => server.close());

	before('launch browser', async () => browser = await puppeteer.launch());
	after('close browser', async () => await browser.close());

	let page;
	beforeEach('open page', async () => page = await browser.newPage());
	afterEach('close page', async () => await page.close());

	// The mock page appends one lazy item ~250ms after each scroll lands near
	// the bottom, up to 5 items total. A naive single before/after height
	// comparison would stop after the very first scroll step, before any
	// item is appended, and miss the rest of the content.
	it('should wait for asynchronously-inserted content before stopping', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/lazy-load.html`);

		await page.evaluate(scrollToBottomBrowser, 15000, 50, { checkDelay: 150, stableRounds: 3 });

		const itemsAdded = await page.evaluate(() => window.itemsAdded);
		expect(itemsAdded).to.eql(5);

		const lazyItems = await page.evaluate(() => document.querySelectorAll('.lazy-item').length);
		expect(lazyItems).to.eql(5);
	});

	// With a checkDelay shorter than the page's own insertion delay, each
	// check samples the DOM before the next batch lands, so consecutive
	// reads look "unchanged" even though the page is still loading.
	// This pins down the failure mode the rewrite fixes: given the same
	// mock page, too-short a delay must not reach the full item count.
	it('should stop early when checkDelay is far shorter than the load delay', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/lazy-load.html`);

		await page.evaluate(scrollToBottomBrowser, 15000, 50, { checkDelay: 10, stableRounds: 3, maxScrolls: 5 });

		const itemsAdded = await page.evaluate(() => window.itemsAdded);
		expect(itemsAdded).to.be.lessThan(5);
	});

	// A short overall timeout must force an exit at the hard cap instead of
	// hanging, even though the page would otherwise keep growing forever
	// (maxItems is never reached because stableRounds would never see 3
	// consecutive unchanged reads before the timeout anyway).
	it('should exit at the timeout instead of hanging when the page keeps growing', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/lazy-load.html`);

		const start = Date.now();
		await page.evaluate(scrollToBottomBrowser, 500, 50, { checkDelay: 300, stableRounds: 3, maxScrolls: 1000 });
		const elapsed = Date.now() - start;

		expect(elapsed).to.be.lessThan(2000);
	});

	// maxScrolls is an independent hard cap from timeout: with a very large
	// timeout but a tiny maxScrolls, the function must still return quickly
	// instead of relying solely on the timeout to bail out.
	it('should exit at maxScrolls instead of hanging when the page keeps growing', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/lazy-load.html`);

		const start = Date.now();
		await page.evaluate(scrollToBottomBrowser, 60000, 50, { checkDelay: 50, stableRounds: 3, maxScrolls: 3 });
		const elapsed = Date.now() - start;

		expect(elapsed).to.be.lessThan(2000);
	});

	// Content that is removed and then asynchronously re-added (height goes
	// down, then back up) must not be mistaken for "reached the bottom" just
	// because one of the two changes happens to match a stale reading.
	it('should not stop while height is dropping then recovering', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/index.html`);

		await page.evaluate(() => {
			const filler = document.createElement('div');
			filler.id = 'shrink-filler';
			filler.style.height = '4000px';
			document.body.appendChild(filler);

			// after a short delay, remove it (height drops), then after
			// another delay add a smaller replacement back (height rises again)
			setTimeout(() => {
				filler.remove();
				setTimeout(() => {
					const replacement = document.createElement('div');
					replacement.id = 'shrink-filler-replacement';
					replacement.style.height = '2000px';
					document.body.appendChild(replacement);
				}, 200);
			}, 200);
		});

		await page.evaluate(scrollToBottomBrowser, 10000, 50, { checkDelay: 150, stableRounds: 3 });

		const hasReplacement = await page.evaluate(() => !!document.getElementById('shrink-filler-replacement'));
		expect(hasReplacement).to.eql(true);
	});

	// A container that is removed mid-scroll (SPA re-render) must not make
	// the function throw out of page.evaluate or hang; it should fall back
	// to scrolling the page itself.
	it('should not throw or hang when the scroll container is removed mid-scroll', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/index.html`);

		await page.evaluate(() => {
			const container = document.createElement('div');
			container.id = 'scroll-container';
			container.style.height = '200px';
			container.style.overflow = 'auto';
			const inner = document.createElement('div');
			inner.style.height = '5000px';
			container.appendChild(inner);
			document.body.appendChild(container);

			setTimeout(() => container.remove(), 100);
		});

		let caught = null;
		try {
			await page.evaluate(scrollToBottomBrowser, 5000, 50, {
				checkDelay: 100,
				stableRounds: 2,
				containerSelector: '#scroll-container'
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.eql(null);
	});

	// A containerSelector that never matches anything must behave like no
	// selector at all (scroll the page), not crash.
	it('should fall back to scrolling the page when containerSelector matches nothing', async () => {
		await page.goto(`http://localhost:${SERVE_WEBSITE_PORT}/index.html`);

		let caught = null;
		try {
			await page.evaluate(scrollToBottomBrowser, 2000, 10, {
				checkDelay: 100,
				stableRounds: 2,
				containerSelector: '#does-not-exist'
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.eql(null);
	});
});

function startWebserver (port) {
	const serve = serveStatic('./test/mock', { index: ['index.html'] });
	const server = http.createServer((req, res) => serve(req, res, finalhandler(req, res)));
	return server.listen(port);
}
