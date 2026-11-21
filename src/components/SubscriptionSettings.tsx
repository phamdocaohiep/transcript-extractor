import { useEffect, useState } from 'react';
import {
  DEFAULT_CONFIGURATION,
  loadConfiguration,
  type Configuration,
  type Entitlement,
} from '../lib/subscription';

export function SubscriptionSettings() {
  const [configuration, setConfiguration] = useState<Configuration>(DEFAULT_CONFIGURATION);
  const [state, setState] = useState<Entitlement | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const config = await loadConfiguration();
        const response = await chrome.runtime.sendMessage({ type: 'CHECK_SUBSCRIPTION' });
        if (disposed) return;
        setConfiguration(config);
        if (!response?.success || !response.data)
          throw new Error(response?.error || 'Could not check subscription.');
        setState(response.data);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : 'Could not check subscription.');
      } finally {
        if (!disposed) setBusy(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  async function update(type: string, data?: unknown) {
    setBusy(true);
    setError('');
    try {
      const response = await chrome.runtime.sendMessage({ type, data });
      if (!response?.success || !response.data)
        throw new Error(response?.error || 'Could not update subscription.');
      setState(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update subscription.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="te-glass p-3 flex flex-col gap-3" aria-label="Subscription settings">
      <h2 className="font-semibold">Subscription</h2>
      <p role="status">
        {state
          ? state.status.replace(/_/g, ' ')
          : error
            ? 'Subscription unavailable'
            : 'Checking subscription…'}
      </p>
      {state && (
        <p className="te-muted text-sm">
          {state.devices.length} of {state.deviceLimit} device slots used
        </p>
      )}
      <button className="te-btn" disabled={busy} onClick={() => void update('CHECK_SUBSCRIPTION')}>
        Check subscription now
      </button>
      <p className="te-muted text-xs">
        The subscription API is pending. Local simulation is currently enabled.
      </p>
      <details>
        <summary className="cursor-pointer text-sm">Simulation settings</summary>
        <fieldset disabled={busy} className="mt-3 flex flex-col gap-3">
          <label>
            Status
            <select
              className="te-select w-full"
              value={configuration.status}
              onChange={event =>
                setConfiguration({
                  ...configuration,
                  status: event.target.value as Configuration['status'],
                })
              }
            >
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="revoked">Revoked</option>
            </select>
          </label>
          <label>
            Device limit
            <input
              className="te-select w-full"
              type="number"
              min="1"
              max="100"
              value={configuration.deviceLimit}
              onChange={event =>
                setConfiguration({ ...configuration, deviceLimit: Number(event.target.value) })
              }
            />
          </label>
          <button
            className="te-btn"
            onClick={() => void update('CONFIGURE_SUBSCRIPTION', configuration)}
          >
            Save subscription settings
          </button>
          <button
            className="te-btn"
            onClick={() =>
              void update(
                'SET_MOCK_DEVICES',
                state?.deviceLimit ?? DEFAULT_CONFIGURATION.deviceLimit
              )
            }
          >
            Simulate full device limit
          </button>
          <button className="te-btn" onClick={() => void update('SET_MOCK_DEVICES', 0)}>
            Reset simulated devices
          </button>
        </fieldset>
      </details>
      {error && (
        <p role="alert" className="te-note te-note--warn">
          {error}
        </p>
      )}
    </section>
  );
}
