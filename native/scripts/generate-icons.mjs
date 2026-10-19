import fs from 'node:fs/promises';
import path from 'node:path';

const names = {
  arrowLeft: 'arrow-left', arrowRight: 'arrow-right', arrowUp: 'arrow-up', refresh: 'rotate-cw',
  plus: 'plus', scissors: 'scissors', copy: 'copy', paste: 'clipboard-paste', rename: 'text-cursor-input',
  share: 'share-2', trash: 'trash-2', sort: 'arrow-down-wide-narrow', list: 'list', grid: 'layout-grid',
  chevronUp: 'chevron-up', chevronDown: 'chevron-down', chevronRight: 'chevron-right', more: 'ellipsis',
  panelRight: 'panel-right', panelLeft: 'panel-left', search: 'search', close: 'x', pin: 'pin',
  computer: 'monitor', drive: 'hard-drive', network: 'globe', airdrop: 'radar', folder: 'folder-open',
  desktop: 'monitor', download: 'download', document: 'file-text', image: 'image', music: 'music-2', sun: 'sun', moon: 'moon', arrowDown: 'arrow-down',
  cloud: 'cloud', archive: 'archive',
  video: 'film', terminal: 'terminal', undo: 'undo-2', settings: 'app-window', check: 'check', eye: 'eye',
};
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const artwork = {};
for (const [name, source] of Object.entries(names)) {
  const text = await fs.readFile(path.join('node_modules/lucide-react/dist/esm/icons', `${source}.js`), 'utf8');
  const match = text.match(/const __iconNode = (\[[\s\S]*?\]);/);
  if (!match) throw new Error(`Missing icon nodes: ${source}`);
  const literal = match[1].replace(/([{,]\s*)([A-Za-z][A-Za-z0-9]*):/g, '$1"$2":').replace(/,\s*([\]}])/g, '$1');
  const nodes = JSON.parse(literal);
  if (!Array.isArray(nodes) || nodes.some(node => !Array.isArray(node) || !['path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon'].includes(node[0]))) throw new Error(`Invalid static artwork: ${source}`);
  artwork[name] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${nodes.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).filter(([key]) => key !== 'key').map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}/>`).join('')}</svg>`;
}
const views = {
  eject: '<path d="m5 11 5-6 5 6Z"/><path d="M5 16h10"/>',
  viewExtra: '<rect x="2" y="2" width="15" height="13" rx="1.5"/><path d="M4 18h11"/>',
  viewLarge: '<rect x="4" y="3" width="12" height="11" rx="1.5"/><path d="M4 17h12"/>',
  viewMedium: '<rect x="6" y="2" width="8" height="8" rx="1"/><path d="M5 13h10M6 16h8"/>',
  viewSmall: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="11" y="3" width="5" height="5" rx="1"/><rect x="3" y="11" width="5" height="5" rx="1"/><rect x="11" y="11" width="5" height="5" rx="1"/>',
  viewList: '<path d="M2 4h6m4 0h6M2 8h6m4 0h6M2 12h6m4 0h6M2 16h6m4 0h6"/>',
  viewDetails: '<path d="M2 4h16M2 8h16M2 12h16M2 16h16"/>',
  viewTiles: '<rect x="2" y="3" width="4" height="4" rx="1"/><path d="M10 4h8M10 7h5"/><rect x="2" y="12" width="4" height="4" rx="1"/><path d="M10 13h8M10 16h5"/>',
  viewContent: '<rect x="2" y="2" width="4" height="4" rx="1"/><path d="M10 3h8M10 6h5"/><rect x="2" y="8" width="4" height="4" rx="1"/><path d="M10 9h8M10 12h5"/><rect x="2" y="14" width="4" height="4" rx="1"/><path d="M10 15h8M10 18h5"/>',
};
for (const [name, paths] of Object.entries(views)) artwork[name] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const swift = `import AppKit\n\n// Lucide artwork is distributed under the ISC license; see native/ICON-LICENSE.txt.\nenum ExplorerSVG {\n  private static var cache: [String: NSImage] = [:]\n  static func image(_ name: String, size: CGFloat, color: NSColor) -> NSImage? {\n    guard let source = artwork[name], let rgb = color.usingColorSpace(.sRGB) else { return nil }\n    let hex = String(format: "#%02x%02x%02x", Int((rgb.redComponent * 255).rounded()), Int((rgb.greenComponent * 255).rounded()), Int((rgb.blueComponent * 255).rounded()))\n    let key = "\\(name)|\\(size)|\\(hex)"\n    if let existing = cache[key] { return existing }\n    guard let image = NSImage(data: Data(source.replacingOccurrences(of: "currentColor", with: hex).utf8)) else { return nil }\n    image.size = NSSize(width: size, height: size)\n    if cache.count > 512 { cache.removeAll() }\n    cache[key] = image\n    return image\n  }\n  private static let artwork: [String: String] = [\n${Object.entries(artwork).map(([name, svg]) => `    "${name}": #"${svg}"#,`).join('\n')}\n  ]\n}\n`;
await fs.writeFile('native/Sources/MacExplorerNative/ExplorerSVG.swift', swift);
await fs.copyFile('node_modules/lucide-react/LICENSE', 'native/ICON-LICENSE.txt');
console.log(`Generated ${Object.keys(artwork).length} native SVG icons.`);
