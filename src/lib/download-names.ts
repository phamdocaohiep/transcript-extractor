const PREFIX = 'output-name:';

export const outputNameKey = (url: string) => `${PREFIX}${url}`;

export function validOutputName(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !/[/\\\p{Cc}]|^\.{1,2}$/u.test(value);
}

/** Chrome may ignore DownloadOptions.filename when any extension listens for naming. */
export function installNames() {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (
      item.byExtensionId !== chrome.runtime.id ||
      !item.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)
    ) {
      suggest();
      return;
    }
    const key = outputNameKey(item.url);
    void chrome.storage.session.get(key).then(
      values => {
        const name: unknown = values[key];
        suggest(validOutputName(name) ? { filename: name, conflictAction: 'uniquify' } : undefined);
      },
      () => suggest()
    );
    return true;
  });
}
