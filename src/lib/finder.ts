import { hasDirectoryAccess } from './preferences';

const host = 'com.transcript_extractor.finder';
export const markerName = '.transcript-extractor-finder.json';
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function request(message: Record<string, unknown>) {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(host, message);
  } catch {
    throw new Error(
      'Finder helper is not installed for this extension. Use the installation command in Settings.'
    );
  }
  if (!reply?.ok) throw new Error(reply?.error || 'Finder helper could not complete the request.');
  return reply;
}
async function readId(directory: FileSystemDirectoryHandle): Promise<string> {
  const file = await (await directory.getFileHandle(markerName)).getFile();
  if (file.size > 1024) throw new Error('Invalid Finder folder connection.');
  const value = JSON.parse(await file.text());
  if (value.version !== 1 || !validId.test(value.id || ''))
    throw new Error('Invalid Finder folder connection.');
  return value.id;
}
/** One setup-only folder chooser verifies the native path against a marker in the selected handle. */
export async function connectFolder(directory: FileSystemDirectoryHandle): Promise<void> {
  await request({ action: 'ping' });
  if (!(await hasDirectoryAccess(directory, true)))
    throw new Error('Folder access was not granted.');
  let id: string;
  try {
    id = await readId(directory);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
    id = crypto.randomUUID();
    const writer = await (
      await directory.getFileHandle(markerName, { create: true })
    ).createWritable();
    try {
      await writer.write(JSON.stringify({ version: 1, id }));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }
  await request({ action: 'register', id, name: directory.name });
}
/** Revealing never opens a picker: native Finder opens only a previously connected directory. */
export async function revealFile(
  directory: FileSystemDirectoryHandle,
  filename?: string
): Promise<void> {
  let id: string;
  try {
    id = await readId(directory);
  } catch {
    throw new Error('Connect this saved folder to the Finder helper in Settings first.');
  }
  if (filename && /[/\\]|^\.{1,2}$/.test(filename)) throw new Error('Invalid saved filename.');
  await request({ action: 'reveal', id, ...(filename ? { filename } : {}) });
}
