/**
 * Runs inside the page (via page.evaluate), so it only sees its own arguments -
 * no closures over the outer module are available here.
 *
 * Why not "stop as soon as scrollHeight stops growing for one check"?
 * Lazy-loaded content (images, infinite-scroll feeds, intersection-observer
 * widgets) is inserted into the DOM only after a network round trip and a
 * render pass *after* the scroll event fires. A single before/after height
 * comparison samples the DOM mid-flight: it reads the old height, concludes
 * "nothing changed", and stops while the browser is still fetching the next
 * batch. Everything below that point is then never scrolled into view and
 * never captured. The fix is to require the height to stay the same for
 * several consecutive checks (`stableRounds`) before calling it "the bottom",
 * which gives in-flight requests a chance to land and bumps scrollHeight again.
 *
 * Defaults (all overridable via `options`):
 *
 * - `checkDelay` = 300ms: how long to wait after each scroll before reading
 *   scrollHeight. This should be long enough to cover a same-origin/CDN
 *   round trip plus layout for one batch of lazy content (typically tens to
 *   a couple hundred ms on a warm connection), but short enough that waiting
 *   it out `stableRounds` times doesn't by itself dominate the page's render
 *   budget. 300ms is the interval Puppeteer/Chrome examples commonly use for
 *   polling scroll-triggered loads, and matches the previous implementation's
 *   own scroll-step interval (200ms) plus margin for a render tick.
 * - `stableRounds` = 3: number of consecutive unchanged-height checks
 *   required before declaring "reached the bottom". 1 round is exactly the
 *   old (buggy) behaviour. 2 rounds already tolerates one slow batch, but
 *   gives a false "done" if a site loads content in two separate waves with
 *   a gap between them (e.g. images, then a second XHR for related items).
 *   3 rounds costs only `2 * checkDelay` extra wall-clock time over 2 rounds,
 *   and comfortably survives multi-wave lazy loading without needing a huge
 *   `checkDelay`. Going much higher mostly protects against pathological
 *   sites that are better handled by the hard caps below.
 * - `maxScrolls` = 100: hard cap on scroll steps, independent of `timeout`.
 *   `timeout` alone is not a safe backstop here: a very long `checkDelay`
 *   (tuned for a slow API) combined with a generous `timeout` could still
 *   spin for a huge number of rounds on a genuinely endless feed. 100 steps
 *   at the previous implementation's 200px-per-step default covers 20000px
 *   (roughly 15-25 "pages" on common viewport heights) before giving up,
 *   which is far more than almost any real lazy-loaded page needs, while
 *   still bounding worst-case work on infinite-scroll pages that never
 *   settle.
 *
 * These three numbers trade off against each other, not independently:
 * - `checkDelay` too short -> content still in flight reads as "unchanged"
 *   -> false "reached bottom" (the original bug), no matter how high
 *   `stableRounds` is set.
 * - `maxScrolls` (or `timeout`) too low -> the hard cap fires before slow
 *   lazy content finishes loading -> content below that point is missed,
 *   same symptom as the bug this rewrite fixes, just via a different cause.
 * - `maxScrolls`/`timeout` too high -> a page that never stops growing (or
 *   loads very slowly) stalls the whole scrape job for that long.
 * The defaults above were chosen as a middle ground for typical lazy-loaded
 * pages; callers scraping known slow/fast or known-endless pages should
 * override them via the `options` argument.
 */
export default async (timeout, viewportN, options = {}) => {
	const {
		checkDelay = 300,
		stableRounds = 3,
		maxScrolls = 100,
		// defaults to the whole page; callers may pass a CSS selector for a
		// specific scrollable container instead.
		containerSelector = null
	} = options;

	const getContainer = () => {
		if (containerSelector) {
			const el = document.querySelector(containerSelector);
			if (el) {
				return el;
			}
			// selector no longer matches (container replaced/removed) - fall
			// back to the page instead of crashing or getting stuck.
		}
		return document.scrollingElement || document.documentElement || document.body;
	};

	const readHeight = () => {
		const container = getContainer();
		// document.body.scrollHeight ignores overflow set on <html>, so prefer
		// the resolved scrolling element/documentElement when scrolling the page.
		return (container && container.scrollHeight) || document.body.scrollHeight || 0;
	};

	const scrollDown = (distance) => {
		const container = getContainer();
		if (container && container !== document.documentElement && container !== document.body) {
			container.scrollBy(0, distance);
		} else {
			window.scrollBy(0, distance);
		}
	};

	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const distance = 200;
	const maxHeight = window.innerHeight * viewportN;
	const start = Date.now();

	let totalScrolled = 0;
	let lastHeight = readHeight();
	let stableCount = 0;
	let scrolls = 0;

	while (true) {
		// Hard caps first: must always be able to exit, even if reading the
		// container or scrolling throws because it was swapped out mid-loop.
		if (
			Date.now() - start >= timeout ||
			scrolls >= maxScrolls ||
			totalScrolled >= maxHeight
		) {
			return;
		}

		try {
			scrollDown(distance);
			totalScrolled += distance;
			scrolls++;
		} catch {
			// container vanished mid-scroll (e.g. SPA re-render) - nothing more
			// to scroll, so stop instead of throwing out of page.evaluate.
			return;
		}

		await wait(checkDelay);

		let height;
		try {
			height = readHeight();
		} catch {
			return;
		}

		if (height === lastHeight) {
			stableCount++;
		} else {
			// covers both growth (lazy content landed) and shrinkage (content
			// removed, possibly to be re-added asynchronously) - either way the
			// page is still changing, so the "reached bottom" streak restarts.
			stableCount = 0;
			lastHeight = height;
		}

		if (stableCount >= stableRounds) {
			return;
		}
	}
};
