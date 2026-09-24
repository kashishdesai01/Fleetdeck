import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FleetState } from '../../apps/web/src/types.js';
const vehicle = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function state(page: Page): Promise<FleetState> {
  return (await page.request.get('/v1/state')).json() as Promise<FleetState>;
}
async function mutate(page: Page, path: string, body: unknown) {
  const { csrf } = (await (await page.request.get('/v1/me')).json()) as { csrf: string };
  return page.request.post(path, {
    headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() },
    data: body,
  });
}
async function prepare(page: Page) {
  const s = await state(page);
  for (const i of s.incidents.filter((i) => !i.condition_active && i.state !== 'resolved')) {
    const result = await mutate(page, `/v1/incidents/${i.id}/actions`, {
      action: 'resolve',
      version: i.version,
      note: 'Demo preparation: verified the recorded condition recovered.',
    });
    expect(result.ok()).toBe(true);
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Fleet overview', exact: true }).waitFor();
}
test.beforeEach(async ({ page }, info) => {
  await page.goto('/');
  if (info.title.startsWith('live console')) {
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(scan.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual(
      [],
    );
  }
  await page.getByRole('button', { name: 'Explore the demo', exact: true }).click();
  await page.getByRole('heading', { name: 'Fleet overview', exact: true }).waitFor();
  await prepare(page);
});
test('live console, accessible navigation, keyboard detail and mobile rendering', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await state(page)).vehicles.filter((v) => v.online).length)
    .toBe(25);
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(
    scan.violations.map((v) => ({
      id: v.id,
      description: v.description,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Inspect AMR-01', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'AMR-01', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close details', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/overview.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Fleet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your fleet', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('offline incident is investigated, assigned, recovered, and resolved with an audit note', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Inspect AMR-02', exact: true }).click();
  await page.getByRole('button', { name: 'Lose contact', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await state(page)).incidents.some(
          (i) => i.vehicle_id === vehicle(2) && i.type === 'offline' && i.condition_active,
        ),
      { timeout: 25000 },
    )
    .toBe(true);
  await page
    .locator('.drawer')
    .getByRole('button', { name: /Connection lost/ })
    .click();
  await page.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await expect(
    page.locator('.drawer').getByRole('button', { name: 'Acknowledge', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Assign to me', exact: true }).click();
  await expect(
    page.locator('.drawer').getByText('Alex Morgan', { exact: true }).first(),
  ).toBeVisible();
  await page.locator('.drawer').getByRole('button', { name: 'AMR-02', exact: true }).click();
  await page.getByRole('button', { name: 'Restore normal', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await state(page)).incidents.find(
          (i) => i.vehicle_id === vehicle(2) && i.type === 'offline' && i.state !== 'resolved',
        )?.condition_active,
    )
    .toBe(false);
  await page
    .locator('.drawer')
    .getByRole('button', { name: /Connection lost/ })
    .click();
  await page.getByRole('button', { name: 'Resolve with a note', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Resolution note' })
    .fill('Verified contact restored and observation time is fresh.');
  await page.getByRole('button', { name: 'Confirm resolution', exact: true }).click();
  await expect
    .poll(async () =>
      (await state(page)).incidents
        .filter((i) => i.vehicle_id === vehicle(2) && i.type === 'offline')
        .every((i) => i.state === 'resolved'),
    )
    .toBe(true);
  await expect(
    page.locator('.timeline').getByText('Verified contact restored and observation time is fresh.'),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/incident-workflow.png', fullPage: true });
});
test('lost command report holds reservation and the persisted outcome reconciles after recovery', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Inspect AMR-03', exact: true }).click();
  await page.getByRole('button', { name: 'Lose command reports', exact: true }).click();
  await page
    .locator('.drawer')
    .getByRole('button', { name: 'Create a mission', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('receiving');
  await expect(
    page.locator('.dispatch-modal').getByText('ML · Dispatch estimate', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dispatch mission', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mission control', exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await state(page)).missions.find(
          (m) => m.vehicle_id === vehicle(3) && m.state === 'uncertain',
        )?.state,
      { timeout: 30000 },
    )
    .toBe('uncertain');
  const s = await state(page),
    m = s.missions.find((m) => m.vehicle_id === vehicle(3) && m.state === 'uncertain')!;
  expect(
    (
      await mutate(page, '/v1/missions', { vehicleId: vehicle(3), destination: 'shipping' })
    ).status(),
  ).toBe(409);
  await page.screenshot({ path: 'test-results/uncertain-mission.png', fullPage: true });
  await page.getByRole('button', { name: 'Fleet', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect AMR-03', exact: true }).click();
  await page.getByRole('button', { name: 'Restore normal', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).missions.find((item) => item.id === m.id)?.state, {
      timeout: 30000,
    })
    .toBe('completed');
});
test('ETA preview is persisted, shown with provenance, and monitored after a real simulated mission', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: 'Inspect AMR-05', exact: true }).click();
  await page
    .locator('.drawer')
    .getByRole('button', { name: 'Create a mission', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('receiving');
  await expect(
    page.locator('.dispatch-modal').getByText('ML · Dispatch estimate', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.dispatch-modal').getByText(/eta-gbr-v1-/)).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .include('.dispatch-modal')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    scan.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/eta-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Dispatch mission', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mission control', exact: true })).toBeVisible();
  const m = (await state(page)).missions.find(
    (m) => m.vehicle_id === vehicle(5) && ['assigned', 'in_progress'].includes(m.state),
  )!;
  expect(m.eta?.source).toBe('model');
  expect(m.eta?.features?.distance).toBeGreaterThan(0);
  await page.locator('.mission-card').filter({ hasText: 'AMR-05' }).first().click();
  await expect(
    page.locator('.drawer').getByText('ML · Dispatch estimate', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await state(page)).missions.find((item) => item.id === m.id)?.state, {
      timeout: 45000,
    })
    .toBe('completed');
  await expect(page.locator('.drawer').getByText(/Observed completion report:/)).toBeVisible();
  const monitor = await page.request.get('/v1/eta/monitoring');
  expect(monitor.ok()).toBe(true);
  const body = await monitor.json();
  expect(
    body.recent.some(
      (row: { source: string; labeled: number }) => row.source === 'model' && row.labeled >= 1,
    ),
  ).toBe(true);
  const metrics = await page.request.get('/metrics');
  expect(await metrics.text()).toContain('fleetdeck_eta_recent_mae_seconds');
  await page.screenshot({ path: 'test-results/eta-mission.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('a dropped WebSocket still converges through authoritative reconciliation and reload', async ({
  page,
}) => {
  const before = (await state(page)).vehicles.find((v) => v.id === vehicle(4))!;
  await page.routeWebSocket('**/v1/ws', (ws) => ws.close());
  await page.reload();
  await page.getByRole('heading', { name: 'Fleet overview', exact: true }).waitFor();
  await expect
    .poll(async () => (await state(page)).vehicles.find((v) => v.id === vehicle(4))?.revision)
    .not.toBe(before.revision);
  await page.getByRole('button', { name: 'Inspect AMR-04', exact: true }).click();
  await expect(
    page.locator('.drawer').getByText('Last observation', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.drawer')
      .getByText(/^[0-9]s ago$/)
      .first(),
  ).toBeVisible();
});
