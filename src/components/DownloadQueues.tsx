import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { groupKey } from '../lib/identity';
import { VideoDownload, type QueueState } from './VideoDownload';

interface Entry {
  id: number;
  title: string;
  closed?: boolean;
}

function supports(url?: string) {
  if (!url) return false;
  try {
    const address = new URL(url);
    if (address.protocol !== 'https:') return false;
    if (/(^|\.)youtube\.com$/.test(address.hostname))
      return (
        (address.pathname === '/watch' && !!address.searchParams.get('v')) ||
        (address.pathname === '/playlist' && !!address.searchParams.get('list')) ||
        /^\/shorts\/[^/]+/.test(address.pathname)
      );
    if (/(^|\.)udemy\.com$/.test(address.hostname))
      return /^\/course\/[^/]+\/learn(?:\/|$)/.test(address.pathname);
    return /(^|\.)coursera\.org$/.test(address.hostname) && address.pathname.startsWith('/learn/');
  } catch {
    return false;
  }
}

// Workers stay mounted when selection changes. Each owns its source tab,
// cancellation controller, permission pause and existing per-tab download lock.
export function DownloadQueues({
  screen,
  onBusyChange,
  visible = true,
}: {
  screen: 'main' | 'settings';
  onBusyChange: (busy: boolean) => void;
  visible?: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<number>();
  const [states, setStates] = useState<Record<number, QueueState>>({});
  const [message, setMessage] = useState('');
  const dismissed = useRef(new Map<number, string>());
  const addresses = useRef(new Map<number, string>());
  const busy = Object.values(states).some(state => state.busy);

  const receive = useCallback((id: number, state: QueueState) => {
    setStates(previous => {
      const old = previous[id];
      if (
        old &&
        Object.keys(state).every(
          key => old[key as keyof QueueState] === state[key as keyof QueueState]
        )
      )
        return previous;
      return { ...previous, [id]: state };
    });
  }, []);

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const update = (follow = true) => {
      const current = ++revision;
      void chrome.tabs
        .query({ currentWindow: true })
        .then(tabs => {
          if (disposed || current !== revision) return;
          for (const tab of tabs)
            if (tab.id !== undefined && tab.url) addresses.current.set(tab.id, groupKey(tab.url));
          const found = tabs.filter(
            tab =>
              tab.id !== undefined &&
              supports(tab.url) &&
              dismissed.current.get(tab.id) !== groupKey(tab.url)
          );
          setEntries(previous => [
            ...previous,
            ...found
              .filter(tab => !previous.some(entry => entry.id === tab.id))
              .map(tab => ({ id: tab.id!, title: tab.title || 'Untitled tab' })),
          ]);
          const active = found.find(tab => tab.active);
          setSelected(previous =>
            follow && active ? active.id : (previous ?? active?.id ?? found[0]?.id)
          );
          setMessage('');
        })
        .catch(() => {
          if (!disposed) setMessage('Could not read open tabs. Switch to a video tab to retry.');
        });
    };
    const changed = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (info.title)
        setEntries(previous =>
          previous.map(entry => (entry.id === id ? { ...entry, title: info.title! } : entry))
        );
      if (info.status === 'complete' || info.url) update(tab.active);
    };
    const removed = (id: number) => {
      revision++;
      setEntries(previous =>
        previous.map(entry => (entry.id === id ? { ...entry, closed: true } : entry))
      );
      setStates(previous => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    };
    const activated = () => update();
    update();
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
    const created = () => update(false);
    chrome.tabs.onCreated.addListener(created);
    return () => {
      disposed = true;
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
      chrome.tabs.onCreated.removeListener(created);
    };
  }, []);

  function closeQueue(id: number) {
    dismissed.current.set(id, addresses.current.get(id) || '');
    const remaining = entries.filter(value => value.id !== id);
    setEntries(remaining);
    setSelected(previous => (previous === id ? remaining[0]?.id : previous));
    setStates(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }

  return (
    <>
      <section
        className="te-queue-switcher"
        aria-label="Download queues"
        hidden={entries.length === 1}
      >
        {message && <p role="status">{message}</p>}
        {!entries.length && <p>Open a YouTube or Udemy page to start downloading.</p>}
        <ul className="flex flex-col gap-2">
          {entries.map((entry, index) => {
            const state = states[entry.id];
            const status = entry.closed
              ? 'Tab closed — stopped'
              : state?.needsAccess
                ? 'Waiting for permission'
                : state?.busy
                  ? 'Working'
                  : state?.error
                    ? 'Needs attention'
                    : 'Ready';
            return (
              <li key={entry.id} className="te-queue-entry">
                <button
                  className="te-btn te-queue-button"
                  aria-current={selected === entry.id ? 'true' : undefined}
                  onClick={() => setSelected(entry.id)}
                >
                  <span className="block break-words">{state?.title || entry.title}</span>
                  <span className="block te-muted text-sm">
                    Queue {index + 1} · {status}
                    {state?.total ? ` · ${state.saved}/${state.total} saved` : ''}
                  </span>
                </button>
                <button
                  className="te-small-button te-queue-close"
                  type="button"
                  aria-label={`Close queue: ${state?.title || entry.title}`}
                  title="Close queue; keep source tab and saved files"
                  onClick={() => closeQueue(entry.id)}
                >
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {entries.map(entry => (
        <div key={entry.id} hidden={selected !== entry.id}>
          {entry.closed ? (
            <p role="status">
              The source tab was closed. Its download stopped. Reopen the source page to resume
              saved progress.
            </p>
          ) : (
            <VideoDownload
              sourceTabId={entry.id}
              screen={screen}
              active={visible && selected === entry.id}
              settingsLocked={busy}
              onClose={() => closeQueue(entry.id)}
              onStateChange={receive}
            />
          )}
        </div>
      ))}
    </>
  );
}
