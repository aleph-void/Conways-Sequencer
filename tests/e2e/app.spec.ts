import { enableMidi, expect, midiLog, test, type MidiLogEntry } from './fixtures'

test.describe('shell', () => {
  test('loads with Aleph Void branding and a default song', async ({ midiPage: page }) => {
    await expect(page).toHaveTitle(/Conway's Sequencer · Aleph Void/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("Conway's Sequencer")
    await expect(page.locator('a[href="https://alephvoid.com"]').first()).toBeVisible()
    await expect(page.getByTestId('brand-logo').first()).toBeVisible()
    await expect(page.getByTestId('channel-count')).toContainText('8 / 62 channels')
    await expect(page.getByTestId('sections-table').locator('tbody tr')).toHaveCount(1)
  })

  test('carries Open Graph and Twitter Card metadata for link previews', async ({ midiPage: page }) => {
    const origin = 'https://conways-sequencer.alephvoid.com'
    const meta = (selector: string) => page.locator(`meta[${selector}]`).getAttribute('content')

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${origin}/`)
    expect(await meta('property="og:type"')).toBe('website')
    expect(await meta('property="og:url"')).toBe(`${origin}/`)
    expect(await meta('property="og:title"')).toBe("Conway's Sequencer")
    expect(await meta('property="og:description"')).toMatch(/Conway's Game/)
    expect(await meta('property="og:image"')).toBe(`${origin}/og-image.png`)
    expect(await meta('property="og:image:width"')).toBe('1200')
    expect(await meta('property="og:image:height"')).toBe('630')
    expect(await meta('property="og:image:alt"')).toBeTruthy()
    expect(await meta('name="twitter:card"')).toBe('summary_large_image')
    expect(await meta('name="twitter:title"')).toBe("Conway's Sequencer")
    expect(await meta('name="twitter:image"')).toBe(`${origin}/og-image.png`)
    expect(await meta('name="twitter:image:alt"')).toBeTruthy()

    // Scrapers fetch the card from the same path on whatever host serves the build.
    const image = await page.request.get(new URL('/og-image.png', page.url()).toString())
    expect(image.ok()).toBe(true)
    expect(image.headers()['content-type']).toMatch(/^image\/png/)
    expect((await image.body()).length).toBeGreaterThan(10_000)
  })

  test('gives the grid most of the viewport and lets the settings drawer collapse', async ({ midiPage: page }) => {
    const viewport = page.viewportSize()!
    const gridPanel = page.getByTestId('grid-panel')
    const withDrawer = (await gridPanel.boundingBox())!
    await expect(page.getByTestId('settings-drawer')).toBeVisible()

    await page.getByTestId('toggle-settings').click()
    await expect(page.getByTestId('settings-drawer')).toHaveCount(0)
    await expect(page.getByTestId('toggle-settings')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('play')).toBeVisible()
    const collapsed = (await gridPanel.boundingBox())!
    expect(collapsed.height).toBeGreaterThan(withDrawer.height)
    expect(collapsed.height).toBeGreaterThan(viewport.height * 0.6)
    // Nothing scrolls off-screen: the shell is sized to the viewport.
    expect(collapsed.y + collapsed.height).toBeLessThanOrEqual(viewport.height)

    await page.reload()
    await expect(page.getByTestId('settings-drawer')).toHaveCount(0)
    await page.getByTestId('toggle-settings').click()
    await expect(page.getByTestId('sections-table')).toBeVisible()
  })

  test('shows the module view with its outputs lighting up as the song plays', async ({ midiPage: page }) => {
    await expect(page.getByTestId('module-view')).toHaveCount(0)
    await page.getByTestId('toggle-module-view').click()
    const view = page.getByTestId('module-view')
    await expect(view).toBeVisible()
    await expect(page.getByTestId('toggle-module-view')).toHaveAttribute('aria-pressed', 'true')
    await expect(view.locator('[data-testid^="module-output-"]')).toHaveCount(64)
    const output = (n: number) => page.getByTestId(`module-output-${n}`)
    await expect(output(1)).toHaveAttribute('title', /Output 1 · note 36 \(C2\) · Out 1 · low/)
    await expect(output(64)).toHaveAttribute('title', /Play gate · low/)
    await expect(page.getByTestId('module-high')).toHaveText('none')
    // The grid is still there to work on, and the view sits beside it rather than over it.
    const grid = (await page.getByTestId('grid-panel').boundingBox())!
    const panel = (await view.boundingBox())!
    expect(panel.x).toBeGreaterThanOrEqual(grid.x + grid.width)
    await expect(page.getByTestId('cell-0-0-0')).toBeVisible()

    // A one-bar song with channel 1 high on every step: output 1 stays lit while playing.
    const bars = page.getByTestId('sections-table').locator('tbody tr').first().getByTestId('section-bars')
    await bars.fill('1')
    await bars.press('Tab')
    const first = (await page.getByTestId('cell-0-0-0').boundingBox())!
    const last = (await page.getByTestId('cell-0-0-15').boundingBox())!
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await page.mouse.down()
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 16 })
    await page.mouse.up()
    await expect(page.getByTestId('cell-0-0-15')).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('play').click()
    await expect(output(64)).toHaveAttribute('data-high', 'true')
    await expect(output(1)).toHaveAttribute('data-high', 'true')
    await expect(output(2)).toHaveAttribute('data-high', 'false')
    await expect(page.getByTestId('module-high')).toContainText(/^1, (63, )?64$/)

    await page.getByTestId('stop').click()
    await expect(output(64)).toHaveAttribute('data-high', 'false')
    await expect(output(1)).toHaveAttribute('data-high', 'false')
    await expect(page.getByTestId('module-high')).toHaveText('none')

    // The choice survives a reload, and the view can be hidden again.
    await page.reload()
    await expect(page.getByTestId('module-view')).toBeVisible()
    await page.getByTestId('toggle-module-view').click()
    await expect(page.getByTestId('module-view')).toHaveCount(0)
  })

  test('toggles full screen from the toolbar', async ({ midiPage: page }) => {
    const button = page.getByTestId('toggle-fullscreen')
    await expect(button).toHaveText(/Full screen/)
    await expect(button).toHaveAttribute('aria-pressed', 'false')

    // Headless Chromium has no real window to go full screen, so stub the
    // API the way a browser would drive it: resolve, then fire fullscreenchange.
    await page.evaluate(() => {
      let element: Element | null = null
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element })
      document.documentElement.requestFullscreen = async () => {
        element = document.documentElement
        document.dispatchEvent(new Event('fullscreenchange'))
      }
      document.exitFullscreen = async () => {
        element = null
        document.dispatchEvent(new Event('fullscreenchange'))
      }
    })

    await button.click()
    await expect(button).toHaveText(/Exit full screen/)
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await button.click()
    await expect(button).toHaveText(/^.*Full screen$/)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  test('explains when Web MIDI is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: undefined })
    })
    await page.goto('/')
    await expect(page.getByTestId('midi-status')).toContainText('not available')
    await expect(page.getByTestId('enable-midi')).toBeDisabled()
  })
})

test.describe('MIDI output selection', () => {
  test('lists the interfaces and remembers the choice across reloads', async ({ midiPage: page }) => {
    await expect(page.getByTestId('midi-status')).toContainText('Enable MIDI')
    await page.getByTestId('enable-midi').click()
    const select = page.getByTestId('midi-output')
    await expect(select.locator('option')).toHaveCount(3)
    await expect(select.locator('option').nth(1)).toHaveText(/Conway Interface \(Fake Devices\)/)
    await select.selectOption('conway')
    await expect(page.getByTestId('midi-status')).toContainText('Sending to Conway Interface')

    await page.reload()
    await page.getByTestId('enable-midi').click()
    await expect(page.getByTestId('midi-output')).toHaveValue('conway')
    await expect(page.getByTestId('midi-status')).toContainText('Sending to Conway Interface')
  })

  test('reacts to hot-plugging', async ({ midiPage: page }) => {
    await page.getByTestId('enable-midi').click()
    await page.getByTestId('midi-output').selectOption('other')
    await expect(page.getByTestId('midi-status')).toContainText('Some Other Synth')
    await page.evaluate(async () => {
      const access = await navigator.requestMIDIAccess()
      ;(access.outputs as unknown as Map<string, unknown>).delete('other')
      window.__midiStateChange?.()
    })
    await expect(page.getByTestId('midi-output').locator('option')).toHaveCount(2)
    await expect(page.getByTestId('midi-status')).toContainText('Select an output')
  })

  test('sends MIDI clock and transport messages to a separate sync output', async ({ midiPage: page }) => {
    await enableMidi(page)
    const sync = page.getByTestId('sync-output')
    await expect(sync).toHaveValue('')
    await sync.selectOption('other')
    await expect(sync).toHaveValue('other')
    await expect(page.getByTestId('midi-status')).toHaveText('Sending to Conway Interface')

    await page.getByTestId('play').click()
    const synced = (log: MidiLogEntry[]) => log.filter((e) => e.port === 'other')
    await expect.poll(async () => synced(await midiLog(page)).length, { timeout: 5000 }).toBeGreaterThan(30)
    await page.getByTestId('play').click() // pause
    await expect(page.getByTestId('play')).toContainText('Resume')
    let log = synced(await midiLog(page))
    // Start, then Timing Clock 24 times per 500 ms quarter note, then Stop, and nothing else.
    expect(log[0]!.data).toEqual([0xfa])
    const ticks = log.filter((e) => e.data[0] === 0xf8)
    expect(ticks.length).toBeGreaterThan(24)
    expect(ticks[0]!.timestamp).toBeCloseTo(log[0]!.timestamp!, 0)
    expect(ticks[24]!.timestamp! - ticks[0]!.timestamp!).toBeCloseTo(500, 1)
    expect(log.at(-1)!.data).toEqual([0xfc])
    expect(log.every((e) => [0xf8, 0xfa, 0xfc].includes(e.data[0]!))).toBe(true)
    // The module's port saw none of it.
    const module = (await midiLog(page)).filter((e) => e.port === 'conway')
    expect(module.length).toBeGreaterThan(0)
    expect(module.every((e) => e.data[0]! < 0xf0)).toBe(true)

    // Resuming tells the receiver where to pick up, then continues.
    const before = log.length
    await page.getByTestId('play').click()
    await expect.poll(async () => synced(await midiLog(page)).length).toBeGreaterThan(before + 2)
    log = synced(await midiLog(page))
    expect(log[before]!.data[0]).toBe(0xf2)
    expect(log[before]!.data[1]).toBeGreaterThan(0)
    expect(log[before + 1]!.data).toEqual([0xfb])
    await page.getByTestId('stop').click()

    // The choice is remembered across reloads.
    await page.reload()
    await page.getByTestId('enable-midi').click()
    await expect(page.getByTestId('sync-output')).toHaveValue('other')
  })
})

test.describe('track orientation', () => {
  test('turns the tracks to run right to left, top to bottom or bottom to top', async ({ midiPage: page }) => {
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
    const grid = page.getByTestId('grid')
    const select = page.getByTestId('track-orientation')
    const cell = (c: number, s: number) => page.getByTestId(`cell-${c}-0-${s}`)

    // Left to right: later steps to the right, the next channel below, the header on the left.
    await expect(grid).toHaveAttribute('data-orientation', 'ltr')
    let a = await box('cell-0-0-0')
    let b = await box('cell-0-0-1')
    let c = await box('cell-1-0-0')
    let head = await box('channel-header-0')
    expect(b.x).toBeGreaterThan(a.x)
    expect(b.y).toBe(a.y)
    expect(c.y).toBeGreaterThan(a.y)
    expect(head.x + head.width).toBeLessThanOrEqual(a.x + 1)

    // Right to left: a mirror image, with the headers on the right and the song's start beside them.
    await select.selectOption('rtl')
    await expect(grid).toHaveAttribute('data-orientation', 'rtl')
    a = await box('cell-0-0-0')
    b = await box('cell-0-0-1')
    c = await box('cell-1-0-0')
    head = await box('channel-header-0')
    expect(b.x).toBeLessThan(a.x)
    expect(b.y).toBe(a.y)
    expect(c.y).toBeGreaterThan(a.y)
    expect(head.x).toBeGreaterThanOrEqual(a.x + a.width - 1)
    await expect(cell(0, 0)).toBeInViewport()
    await expect(page.getByTestId('channel-header-0')).toBeInViewport()

    // Top to bottom: each channel is a column, later steps below, the next channel to the right.
    await select.selectOption('ttb')
    await expect(grid).toHaveAttribute('data-orientation', 'ttb')
    a = await box('cell-0-0-0')
    b = await box('cell-0-0-1')
    c = await box('cell-1-0-0')
    head = await box('channel-header-0')
    expect(b.y).toBeGreaterThan(a.y)
    expect(b.x).toBe(a.x)
    expect(c.x).toBeGreaterThan(a.x)
    expect(c.y).toBe(a.y)
    expect(head.y + head.height).toBeLessThanOrEqual(a.y + 1)
    // The section strip runs down the left edge, and the move buttons now point sideways.
    const section = await box('grid-section-0')
    expect(section.height).toBeGreaterThan(section.width)
    expect(section.x + section.width).toBeLessThanOrEqual(a.x)
    await expect(page.getByTestId('channel-header-0').getByTestId('channel-down')).toHaveAttribute('title', 'Move right')

    // Drawing still works: a drag down the column paints a run. Collapse the drawer for room.
    await page.getByTestId('toggle-settings').click()
    const from = await box('cell-0-0-2')
    const to = await box('cell-0-0-5')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()
    for (const step of [2, 3, 4, 5]) await expect(cell(0, step)).toHaveAttribute('aria-checked', 'true')
    await expect(cell(0, 1)).toHaveAttribute('aria-checked', 'false')
    await expect(cell(0, 6)).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('toggle-settings').click()

    // Bottom to top: the headers sit at the bottom and the song climbs from them, start in view.
    await select.selectOption('btt')
    await expect(grid).toHaveAttribute('data-orientation', 'btt')
    a = await box('cell-0-0-0')
    b = await box('cell-0-0-1')
    c = await box('cell-1-0-0')
    head = await box('channel-header-0')
    expect(b.y).toBeLessThan(a.y)
    expect(b.x).toBe(a.x)
    expect(c.x).toBeGreaterThan(a.x)
    expect(head.y).toBeGreaterThanOrEqual(a.y + a.height - 1)
    await expect(cell(0, 0)).toBeInViewport()
    await expect(page.getByTestId('channel-header-0')).toBeInViewport()
    await expect(cell(0, 5)).toHaveAttribute('aria-checked', 'true')

    // The choice is a browser preference: it survives a reload and a different song.
    await page.reload()
    await expect(grid).toHaveAttribute('data-orientation', 'btt')
    await expect(select).toHaveValue('btt')
    await page.getByTestId('song-browser-tab').click()
    await page.getByTestId('browser-new-song').click()
    await expect(grid).toHaveAttribute('data-orientation', 'btt')
  })
})
