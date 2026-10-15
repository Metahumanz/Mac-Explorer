// Playwright mouse events cannot drive AppKit's drag loop. Inject its real-file
// payload into Chromium; file-drag-smoke separately verifies the AppKit source.
export async function dropNativeFiles(page, files, target, y = 0.5) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Drop target is not visible');
  const session = await page.context().newCDPSession(page);
  try {
    const point = { x: box.x + box.width / 2, y: box.y + box.height * y };
    const data = { items: [], files, dragOperationsMask: 17 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await session.send('Input.dispatchDragEvent', { type, ...point, data });
  } finally { await session.detach(); }
}
