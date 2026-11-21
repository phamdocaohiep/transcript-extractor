import { beforeEach, expect, it, vi } from 'vitest';
import {
  ALARM_NAME,
  CONFIG_KEY,
  DEVICE_KEY,
  checkSubscription,
  configureSubscription,
  setMockDevices,
  scheduleSubscription,
  assertEntitlement,
} from './subscription';
let stored: Record<string, unknown>;
beforeEach(() => {
  stored = {};
  vi.stubGlobal('navigator', {
    locks: { request: async (_key: string, action: () => Promise<unknown>) => action() },
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
        }),
      },
    },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
    },
    runtime: { sendMessage: vi.fn(async () => ({ success: true, data: { status: 'active' } })) },
  });
});
it('keeps a stable installation identity when the worker restarts', async () => {
  const first = await checkSubscription();
  const second = await checkSubscription();
  expect(first.deviceId).toBe(second.deviceId);
  expect(stored[DEVICE_KEY]).toBe(first.deviceId);
  expect(second.devices).toEqual([first.deviceId]);
});
it('registers the installation only when a device slot is available', async () => {
  await configureSubscription({ status: 'active', deviceLimit: 2 });
  expect((await setMockDevices(2)).status).toBe('device_limit');
  const state = await setMockDevices(0);
  expect(state.status).toBe('active');
  expect(state.devices).toEqual([state.deviceId]);
});
it.each(['expired', 'revoked'] as const)('returns %s and denies download access', async status => {
  const state = await configureSubscription({ status, deviceLimit: 2 });
  expect(state.status).toBe(status);
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, data: state } as never);
  await expect(assertEntitlement()).rejects.toThrow(status);
});
it('keeps the backend alarm enabled even if an older stored setting disabled it', async () => {
  stored[CONFIG_KEY] = { enabled: false, status: 'active', deviceLimit: 2 };
  await scheduleSubscription();
  expect(chrome.alarms.create).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 15 });
  expect(chrome.alarms.clear).not.toHaveBeenCalled();
});
it('does not replace an existing 15-minute alarm when the worker wakes up', async () => {
  vi.mocked(chrome.alarms.get).mockResolvedValue({ periodInMinutes: 15 } as never);
  await scheduleSubscription();
  expect(chrome.alarms.create).not.toHaveBeenCalled();
});
it('validates configuration before storing it', async () => {
  await expect(configureSubscription({ status: 'active', deviceLimit: 0 })).rejects.toThrow(
    'Device limit'
  );
  expect(stored[CONFIG_KEY]).toBeUndefined();
});
