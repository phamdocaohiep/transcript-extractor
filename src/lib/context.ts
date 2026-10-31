/** Content scripts share extension storage, but their IndexedDB belongs to the website. */
export function isPageContext(): boolean {
  return (
    typeof location !== 'undefined' &&
    location.protocol !== 'chrome-extension:' &&
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime?.id)
  );
}
