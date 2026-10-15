# Windows 11 Explorer on Mac

The user's reference is binding: reproduce Windows 11 File Explorer in Operate mode. Do not invent a new visual identity.

- Mica-like pale neutral tab strip, white active tab, quiet gray command bar, white file surface, fine gray separators.
- Four horizontal bands: 48px tabs, 60px navigation, 56px commands, flexible content; 30px status bar.
- 208px navigation pane; compact 36px rows; recognizable yellow folder shapes, outlined 16–18px command icons, colored navigation glyphs.
- Keep the separate personal-folder entry at the top. Quick Access starts with Applications, Desktop, Downloads, and Documents, followed by other available defaults and custom pins; preserve explicit drag ordering. Applications uses an outlined App Store-style A glyph at the same size and stroke weight as the other sidebar icons.
- System UI font with Chinese fallbacks, 13px body, 12px metadata, 20px home title. No marketing typography.
- Blue #0067c0 for focused/selected states, pale blue #e5f3ff selection, 4px control radii. Preserve macOS traffic lights.
- Single-clicking the address-bar background or current breadcrumb enters path editing; ancestor breadcrumbs remain navigation links. Menus open beside their trigger and stay inside the viewport. File rows open on double-click and select on single-click.
- File icons scale from 32 to 128 CSS pixels using a status-bar slider, four View presets, and Ctrl+wheel. The grid follows the chosen size; macOS native icons are rendered at sufficient physical resolution for Retina displays.
- Loading, empty directories, search progress, errors, cut state, multi-selection, collision failures, and progress feedback are explicit.
- At smaller desktop sizes, shrink optional columns and hide the details pane before compromising navigation or the filename column.

- View menu order follows the supplied Windows screenshot: four icon presets, list, details, tiles, content, details pane, preview pane, Show, then Apply to all folders. Keep a separate selection gutter and icon column; Show opens a viewport-clamped submenu with mouse and keyboard support.
- Small icons use horizontal labels; list fills downward into columns; tiles show type/size; content adds date/location. Show settings and mutually exclusive panes persist without resetting navigation or pins.

- More → Settings → General offers Light, Dark, and System, alongside the interface language. Preserve light appearance for existing installs until selected; persist nativeTheme before window creation. Dark uses #191919 file surfaces, #202020 navigation, #242424 menus/toolbars, readable neutral text, and #70c5ff accents. Never invert file icons or change system settings.
- Settings follows the Windows Explorer options dialog: a compact title bar, bordered tabs for General, Customize toolbar, and Keyboard shortcuts, grouped form controls, a scrolling content pane, and a fixed Close footer. Appearance, language, and toolbar choices apply immediately; wake and operation shortcuts have separate Save actions. Each operation supports recording, clearing, and restoring defaults; recording replaces all default aliases. Validate effective bindings against other operations, wake, and common reserved combinations before saving. Keep menu hints and accelerators synchronized across windows while preserving standard text editing. Arrow keys, Home, and End navigate tabs. More has one Settings entry.

Numbered tab shortcuts use Command-1 through Command-8 and Command-9 for the last tab; missing tab numbers do nothing. Eight layout shortcuts use Control-Shift-1 through Control-Shift-8 in View-menu order, avoiding macOS screenshot shortcuts. Existing custom bindings and wake shortcuts take priority during upgrade; conflicting new defaults remain unassigned.

## Motion

AirDrop and Network are virtual sidebar locations with their own tabs and history. Keep the existing Explorer shell: AirDrop has a plain page title, outlined drop area and one Choose files action; Network has a labeled SMB address form, compact shared-computer rows, connected shares and explicit discovery/loading/error/empty states. Native recipient selection and network authentication remain system windows; mounted-file browsing stays in the app. Preserve light/dark tokens, narrow-window layout, keyboard access and source files on every sharing path.

Settings defaults to 560 × 700 CSS pixels, capped to fit the application viewport. Drag its title bar to reposition it within the viewport; focused title bars also support arrow-key movement. Keep the title bar and Close footer visible when resizing, and center the dialog when reopened.

Follow Fluent timing: 83ms for hover/selection color, 167ms for menus, tabs and loaded file views, and 250ms for dialogs and right-side panes. Use `cubic-bezier(0, 0, 0, 1)` for arrivals. Navigation moves the file surface just 4px; panes enter 12px from the right. Never stagger individual files or delay an operation for animation. Cancel interrupted navigation animations, retain focus/scroll/selection, and skip motion when Reduce Motion is enabled. Menus dismiss immediately so actions remain responsive.

- Images and PDF first pages retain content thumbnails. Word/Excel/PowerPoint use native Quick Look content previews when available; pagination and worksheet coverage are system-defined. Content thumbnails carry the actual default application icon at bottom right. Corrupt, locked, unsupported, or timed-out previews retain the system file icon. Refresh re-reads associations without changing system defaults.
