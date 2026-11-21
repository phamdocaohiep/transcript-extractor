// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubscriptionSettings } from './SubscriptionSettings';
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})) } },
    runtime: {
      sendMessage: vi.fn(async (request: { type: string; data?: { status?: string } }) => ({
        success: true,
        data: {
          mode: 'mock',
          status: request.data?.status || 'active',
          deviceId: 'installation',
          devices: ['installation'],
          deviceLimit: 2,
          checkedAt: Date.now(),
          nextCheckAt: Date.now() + 900_000,
        },
      })),
    },
  });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});
it('shows subscription status and device usage without exposing the backend polling schedule', async () => {
  await act(async () => root.render(<SubscriptionSettings />));
  expect(element.querySelector('h2')?.textContent).toBe('Subscription');
  expect(element.textContent).toContain('1 of 2 device slots used');
  expect(element.textContent).not.toMatch(/15|interval|minutes/);
  expect(element.querySelector('details')?.open).toBe(false);
});
it('saves the simulation settings through the existing backend contract', async () => {
  await act(async () => root.render(<SubscriptionSettings />));
  const select = element.querySelector('select')!;
  await act(async () => {
    select.value = 'expired';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const button = [...element.querySelectorAll('button')].find(
    item => item.textContent === 'Save subscription settings'
  )!;
  await act(async () => button.click());
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
    type: 'CONFIGURE_SUBSCRIPTION',
    data: { status: 'expired', deviceLimit: 2 },
  });
  expect(element.querySelector('[role="status"]')?.textContent).toBe('expired');
});
