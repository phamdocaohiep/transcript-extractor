export const SUBSCRIPTION_KEY = 'subscription_state_v1';
export const CONFIG_KEY = 'subscription_config_v1';
export const DEVICE_KEY = 'installation_id_v1';
const REGISTRY_KEY = 'subscription_mock_registry_v1';
export const ALARM_NAME = 'subscription-check';
export interface Configuration {
  status: 'active' | 'expired' | 'revoked';
  deviceLimit: number;
}
export interface Entitlement {
  mode: 'mock';
  status: 'active' | 'expired' | 'revoked' | 'device_limit' | 'error';
  deviceId: string;
  deviceLimit: number;
  devices: string[];
  checkedAt: number;
  nextCheckAt: number;
  error?: string;
}
export const DEFAULT_CONFIGURATION: Configuration = {
  status: 'active',
  deviceLimit: 2,
};

export async function loadConfiguration(): Promise<Configuration> {
  const data = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as
    | Partial<Configuration>
    | undefined;
  return {
    status:
      data?.status && ['active', 'expired', 'revoked'].includes(data.status)
        ? data.status
        : 'active',
    deviceLimit:
      Number.isSafeInteger(data?.deviceLimit) && (data?.deviceLimit ?? 0) >= 1
        ? data!.deviceLimit!
        : 2,
  };
}

/** Mock API request/response boundary. Replace this provider with the signed server response later. */
async function requestEntitlement(deviceId: string, config: Configuration): Promise<Entitlement> {
  const data = (await chrome.storage.local.get(REGISTRY_KEY))[REGISTRY_KEY];
  const devices: string[] = Array.isArray(data)
    ? [...new Set(data.filter(id => typeof id === 'string'))]
    : [];
  if (
    config.status === 'active' &&
    !devices.includes(deviceId) &&
    devices.length < config.deviceLimit
  ) {
    devices.push(deviceId);
    await chrome.storage.local.set({ [REGISTRY_KEY]: devices });
  }
  const status =
    config.status !== 'active'
      ? config.status
      : devices.indexOf(deviceId) < 0 || devices.indexOf(deviceId) >= config.deviceLimit
        ? 'device_limit'
        : 'active';
  return {
    mode: 'mock',
    status,
    deviceId,
    deviceLimit: config.deviceLimit,
    devices,
    checkedAt: Date.now(),
    nextCheckAt: Date.now() + 15 * 60_000,
  };
}

export async function checkSubscription(): Promise<Entitlement> {
  return navigator.locks.request('subscription-check', async () => {
    let id = (await chrome.storage.local.get(DEVICE_KEY))[DEVICE_KEY];
    if (typeof id !== 'string' || !id) {
      id = crypto.randomUUID();
      await chrome.storage.local.set({ [DEVICE_KEY]: id });
    }
    const config = await loadConfiguration();
    const state = await requestEntitlement(id as string, config);
    await chrome.storage.local.set({ [SUBSCRIPTION_KEY]: state });
    return state;
  });
}

export async function configureSubscription(value: Configuration): Promise<Entitlement> {
  if (!Number.isSafeInteger(value.deviceLimit) || value.deviceLimit < 1 || value.deviceLimit > 100)
    throw new Error('Device limit must be between 1 and 100.');
  if (!['active', 'expired', 'revoked'].includes(value.status))
    throw new Error('Invalid subscription status.');
  await chrome.storage.local.set({ [CONFIG_KEY]: value });
  await scheduleSubscription();
  return checkSubscription();
}

export async function scheduleSubscription(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing?.periodInMinutes !== 15)
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 15 });
}

export async function assertEntitlement(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_SUBSCRIPTION' });
  if (!result?.success || result.data?.status !== 'active')
    throw new Error(
      result?.error || `Subscription access denied (${result?.data?.status ?? 'unavailable'}).`
    );
}

/** Seed virtual devices for exercising the device-limit response before the server exists. */
export async function setMockDevices(count: number): Promise<Entitlement> {
  const config = await loadConfiguration();
  if (!Number.isSafeInteger(count) || count < 0 || count > config.deviceLimit)
    throw new Error('Invalid simulated device count.');
  await chrome.storage.local.set({
    [REGISTRY_KEY]: Array.from({ length: count }, (_, i) => `simulated-${i + 1}`),
  });
  return checkSubscription();
}
