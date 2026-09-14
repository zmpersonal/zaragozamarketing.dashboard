// Re-fetch everything already on screen, page by page. A periodic refresh must
// not collapse a list the agent expanded with "Show 50 more" (round 11).

/**
 * fetchPage(offset) -> { threads, total }. Fetches pages from 0 until at least
 * `loadedCount` rows are covered (at least one page), and returns them joined.
 */
export async function reloadLoadedPages(fetchPage, loadedCount, pageSize) {
  const threads = [];
  let total = 0;
  let offset = 0;
  do {
    const page = await fetchPage(offset);
    threads.push(...page.threads);
    total = page.total;
    offset += pageSize;
    if (page.threads.length < pageSize) break;
  } while (offset < loadedCount);
  return { threads, total };
}
