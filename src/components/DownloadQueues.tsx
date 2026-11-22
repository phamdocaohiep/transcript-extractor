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
  const entriesRef = useRef(entries);
  const statesRef = useRef(states);
  entriesRef.current = entries;
  statesRef.current = states;
  const [message, setMessage] = useState('');
  const dismissed = useRef(new Map<number, string>());
  const addresses = useRef(new Map<number, string>());
  const busy = Object.values(states).some(state => state.busy);

  const discard = useCallback((id: number) => {
    const remaining = entriesRef.current.filter(entry => entry.id !== id);
    entriesRef.current = remaining;
    setEntries(remaining);
    setSelected(previous => (previous === id ? remaining[0]?.id : previous));
    setStates(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);
  const receive = useCallback(
    (id: number, state: QueueState) => {
      if (!entriesRef.current.some(entry => entry.id === id)) return;
      if (
        entriesRef.current.some(entry => entry.id === id && entry.closed) &&
        !state.busy &&
        !state.transferring
      ) {
        discard(id);
        return;
      }
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
    },
    [discard]
  );

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const update = (follow = true) => {
      const current = ++revision;
      void chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(tabs => {
          if (disposed || current !== revision) return;
          for (const tab of tabs)
            if (tab.id !== undefined && tab.url) addresses.current.set(tab.id, groupKey(tab.url));
          const found = tabs.filter(
            tab =>
              tab.id !== undefined &&
              tab.active &&
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
      if (tab.active && (info.status === 'complete' || info.url)) update();
    };
    const removed = (id: number) => {
      revision++;
      if (statesRef.current[id]?.transferring) {
        const next = entriesRef.current.map(entry =>
          entry.id === id ? { ...entry, closed: true } : entry
        );
        entriesRef.current = next;
        setEntries(next);
      } else discard(id);
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
  }, [discard]);

  function closeQueue(id: number) {
    dismissed.current.set(id, addresses.current.get(id) || '');
    discard(id);
  }

  const grouped = entries.filter(entry => (states[entry.id]?.total || 0) > 1);
  // One keyed list preserves each worker when its loaded item count changes.
  const ordered: Array<Entry | null> = [
    ...entries.filter(entry => !grouped.includes(entry)),
    null,
    ...grouped,
  ];
  return (
    <>
      {ordered.map(entry =>
        entry === null ? (
          <section
            key="queue-switcher"
            className="te-queue-switcher"
            aria-label="Download queues"
            hidden={entries.length > 0 && !grouped.length && !message}
          >
            {message && <p role="status">{message}</p>}
            {!entries.length && <p>Switch to a YouTube or Udemy tab to start downloading.</p>}
            <ul className="flex flex-col gap-2">
              {grouped.map((entry, index) => {
                const state = states[entry.id];
                const status = entry.closed
                  ? 'Finishing download'
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
        ) : (
          <div
            key={entry.id}
            hidden={
              screen === 'settings'
                ? selected !== entry.id
                : (states[entry.id]?.total || 0) > 1 && selected !== entry.id
            }
            onClickCapture={() => {
              if ((states[entry.id]?.total || 0) <= 1) setSelected(entry.id);
            }}
            onFocusCapture={() => {
              if ((states[entry.id]?.total || 0) <= 1) setSelected(entry.id);
            }}
          >
            {entry.closed && (
              <p role="status">Source tab closed. Finishing the current download only.</p>
            )}
            <VideoDownload
              sourceTabId={entry.id}
              screen={screen}
              active={visible && selected === entry.id}
              settingsLocked={busy}
              onClose={() => closeQueue(entry.id)}
              onStateChange={receive}
              sourceClosed={entry.closed}
            />
          </div>
        )
      )}
    </>
  );
}
