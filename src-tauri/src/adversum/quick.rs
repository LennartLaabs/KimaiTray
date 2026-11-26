//! The floating quick entry bar and the confirmation toast that follows a
//! quick action. Both use the same small window above everything else, on the
//! screen the pointer is on:
//!
//! - as the **bar** it sits horizontally centered, 20 % below the top of the
//!   visible area (below the menu bar), and takes the keyboard. Its top edge
//!   is fixed; the suggestion list grows downward.
//! - as the **toast** it sits at the bottom center and never takes the
//!   keyboard, so the user's application keeps working. While an action can
//!   be undone, Cmd+Z is registered as a global shortcut for it.
//!
//! On macOS the webview is hosted in a non-activating panel
//! (`quick_panel.rs`) that is placed directly in screen points. That avoids
//! every conversion between logical and physical pixels, which is what goes
//! wrong with mixed Retina and non-Retina monitors.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub(crate) const WINDOW_LABEL: &str = "adversum-quick";
const BAR_WIDTH: f64 = 680.0;
const TOAST_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 60.0;
const MAX_HEIGHT: f64 = 560.0;
/// Distance of the bar's top edge from the top of the visible screen area.
const BAR_TOP_FRACTION: f64 = 0.20;
/// Distance of the toast's bottom edge from the bottom of the visible area.
const TOAST_BOTTOM_FRACTION: f64 = 0.08;
const SHOWN_EVENT: &str = "adversum://quick-shown";
const UNDO_LATEST_EVENT: &str = "adversum://quick-undo-latest";
const UNDO_ACCELERATOR: &str = "CommandOrControl+Z";

/// What the window currently shows, and with it where it sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Placement {
    Bar,
    Toast,
}

impl Placement {
    pub(crate) fn width(self) -> f64 {
        match self {
            Placement::Bar => BAR_WIDTH,
            Placement::Toast => TOAST_WIDTH,
        }
    }
}

/// The visible part of a screen (without menu bar and Dock) in points, with
/// `y` growing downward from the top of that area's coordinate space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Area {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// Top-left corner of a window of the given size. The bar hangs from a fixed
/// line near the top, so a taller bar extends downward. The toast stands on a
/// fixed line near the bottom.
pub(crate) fn top_left(placement: Placement, area: Area, size: (f64, f64)) -> (f64, f64) {
    let (width, height) = size;
    let x = area.x + ((area.width - width) / 2.0).max(0.0);
    let y = match placement {
        Placement::Bar => area.y + area.height * BAR_TOP_FRACTION,
        Placement::Toast => area.y + area.height * (1.0 - TOAST_BOTTOM_FRACTION) - height,
    };
    // Never above the visible area, whatever the size.
    (x, y.max(area.y))
}

pub(crate) fn clamp_height(height: f64) -> f64 {
    height.clamp(MIN_HEIGHT, MAX_HEIGHT)
}

/// What is on screen right now; `None` while the window is hidden.
static SHOWING: Mutex<Option<Placement>> = Mutex::new(None);
static UNDO_SHORTCUT_ACTIVE: AtomicBool = AtomicBool::new(false);

fn showing() -> Option<Placement> {
    *SHOWING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_showing(placement: Option<Placement>) {
    *SHOWING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = placement;
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// Registers or releases Cmd+Z for undoing the latest quick action. It is
/// only held while a toast offers "Undo", so it takes the key combination
/// away from other applications for a few seconds at most.
fn set_undo_shortcut(app: &AppHandle, active: bool) {
    if !crate::platform::supports_global_shortcuts() {
        return;
    }
    let shortcuts = app.global_shortcut();
    if active {
        if UNDO_SHORTCUT_ACTIVE.swap(true, Ordering::SeqCst) {
            return;
        }
        let handle = app.clone();
        let registered = shortcuts.on_shortcut(UNDO_ACCELERATOR, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(popup) = handle.get_webview_window("tray-popup") {
                    let _ = popup.emit(UNDO_LATEST_EVENT, ());
                }
            }
        });
        if let Err(error) = registered {
            UNDO_SHORTCUT_ACTIVE.store(false, Ordering::SeqCst);
            log::warn!("Undo shortcut is unavailable: {error}");
        }
    } else if UNDO_SHORTCUT_ACTIVE.swap(false, Ordering::SeqCst) {
        // Already gone when upstream re-registered all shortcuts meanwhile.
        let _ = shortcuts.unregister(UNDO_ACCELERATOR);
    }
}

#[cfg(not(target_os = "macos"))]
mod portable {
    //! Placement through Tauri's window API, for platforms without the panel.
    use super::{clamp_height, top_left, Area, Placement};
    use tauri::{AppHandle, LogicalPosition, LogicalSize, WebviewWindow};

    fn area(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<Option<Area>> {
        let cursor = app.cursor_position()?;
        let monitor = match app.monitor_from_point(cursor.x, cursor.y)? {
            Some(monitor) => Some(monitor),
            None => window.primary_monitor()?,
        };
        Ok(monitor.map(|monitor| {
            let scale = monitor.scale_factor();
            let work = monitor.work_area();
            Area {
                x: f64::from(work.position.x) / scale,
                y: f64::from(work.position.y) / scale,
                width: f64::from(work.size.width) / scale,
                height: f64::from(work.size.height) / scale,
            }
        }))
    }

    pub(super) fn place(
        app: &AppHandle,
        window: &WebviewWindow,
        placement: Placement,
        height: f64,
    ) -> tauri::Result<()> {
        let size = (placement.width(), clamp_height(height));
        window.set_size(LogicalSize::new(size.0, size.1))?;
        if crate::platform::supports_window_positioning() {
            if let Some(area) = area(app, window)? {
                let (x, y) = top_left(placement, area, size);
                window.set_position(LogicalPosition::new(x, y))?;
            }
        }
        Ok(())
    }
}

fn present(app: &AppHandle, placement: Placement) -> bool {
    let Some(window) = window(app) else {
        return false;
    };
    #[cfg(target_os = "macos")]
    let presented = super::quick_panel::present(&window, placement, placement == Placement::Bar);
    #[cfg(not(target_os = "macos"))]
    let presented = portable::place(app, &window, placement, 0.0)
        .and_then(|()| window.show())
        .and_then(|()| match placement {
            Placement::Bar => window.set_focus(),
            Placement::Toast => Ok(()),
        });
    if let Err(error) = presented {
        log::warn!("Failed to show the quick entry window: {error}");
        return false;
    }
    set_showing(Some(placement));
    true
}

pub(crate) fn show(app: &AppHandle) {
    // A new entry replaces a toast that may still be up, and its undo key.
    set_undo_shortcut(app, false);
    if present(app, Placement::Bar) {
        if let Some(window) = window(app) {
            let _ = window.emit(SHOWN_EVENT, ());
        }
    }
}

pub(crate) fn hide(app: &AppHandle) {
    set_undo_shortcut(app, false);
    set_showing(None);
    let Some(window) = window(app) else {
        return;
    };
    #[cfg(target_os = "macos")]
    let hidden = super::quick_panel::hide(&window);
    #[cfg(not(target_os = "macos"))]
    let hidden = window.hide();
    if let Err(error) = hidden {
        log::warn!("Failed to hide the quick entry window: {error}");
    }
}

/// The shortcut closes an open bar and opens it otherwise, also over a toast.
pub(crate) fn toggle(app: &AppHandle) {
    if showing() == Some(Placement::Bar) {
        hide(app);
    } else {
        show(app);
    }
}

#[tauri::command]
pub fn adversum_quick_show(app: AppHandle) {
    show(&app);
}

#[tauri::command]
pub fn adversum_quick_hide(app: AppHandle) {
    hide(&app);
}

/// Shows the window as the confirmation toast at the bottom center, without
/// taking the keyboard. `undoable` controls the temporary Cmd+Z shortcut.
#[tauri::command]
pub fn adversum_quick_toast(app: AppHandle, undoable: bool) {
    // An open bar is not replaced; the user is typing the next entry.
    if showing() == Some(Placement::Bar) {
        return;
    }
    if present(&app, Placement::Toast) {
        set_undo_shortcut(&app, undoable);
    }
}

/// Fits the window to the height of its content. The width follows from what
/// the window shows, and its anchored edge stays where it is.
#[tauri::command]
pub fn adversum_quick_resize(app: AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() {
        return Err("Invalid quick entry height".into());
    }
    let (Some(window), Some(placement)) = (window(&app), showing()) else {
        return Ok(());
    };
    #[cfg(target_os = "macos")]
    let resized = super::quick_panel::resize(&window, placement, clamp_height(height));
    #[cfg(not(target_os = "macos"))]
    let resized = portable::place(&app, &window, placement, height);
    resized.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_height, top_left, Area, Placement, BAR_WIDTH, MAX_HEIGHT, MIN_HEIGHT, TOAST_WIDTH,
    };

    /// 1512x982 pt MacBook display: menu bar 38 pt, Dock 70 pt.
    const LAPTOP: Area = Area {
        x: 0.0,
        y: 38.0,
        width: 1512.0,
        height: 874.0,
    };

    #[test]
    fn the_bar_hangs_at_twenty_percent_and_grows_downward() {
        let small = top_left(Placement::Bar, LAPTOP, (BAR_WIDTH, 76.0));
        let tall = top_left(Placement::Bar, LAPTOP, (BAR_WIDTH, 420.0));
        assert_eq!(small.0, (1512.0 - BAR_WIDTH) / 2.0);
        // Below the menu bar, 20 % into the visible area.
        assert_eq!(small.1, 38.0 + 874.0 * 0.20);
        // The input field does not move when the suggestion list appears.
        assert_eq!(small, tall);
    }

    #[test]
    fn the_toast_stands_near_the_bottom_whatever_its_height() {
        let low = top_left(Placement::Toast, LAPTOP, (TOAST_WIDTH, 60.0));
        let high = top_left(Placement::Toast, LAPTOP, (TOAST_WIDTH, 90.0));
        let bottom = 38.0 + 874.0 * 0.92;
        assert_eq!(low.0, (1512.0 - TOAST_WIDTH) / 2.0);
        assert_eq!(low.1 + 60.0, bottom);
        assert_eq!(high.1 + 90.0, bottom);
    }

    #[test]
    fn placement_follows_a_second_monitor_with_its_own_origin() {
        // External display to the right of the laptop, top edge 200 pt higher.
        let external = Area {
            x: 1512.0,
            y: -200.0,
            width: 2560.0,
            height: 1415.0,
        };
        let (x, y) = top_left(Placement::Bar, external, (BAR_WIDTH, 76.0));
        assert_eq!(x, 1512.0 + (2560.0 - BAR_WIDTH) / 2.0);
        assert_eq!(y, -200.0 + 1415.0 * 0.20);
    }

    #[test]
    fn nothing_is_placed_outside_a_small_area() {
        let tiny = Area {
            x: 100.0,
            y: 50.0,
            width: 400.0,
            height: 60.0,
        };
        assert_eq!(top_left(Placement::Bar, tiny, (BAR_WIDTH, 76.0)).0, 100.0);
        // A toast taller than the area still starts at its top edge.
        assert_eq!(
            top_left(Placement::Toast, tiny, (TOAST_WIDTH, 200.0)).1,
            50.0
        );
    }

    #[test]
    fn sizes_are_bounded() {
        assert_eq!(clamp_height(0.0), MIN_HEIGHT);
        assert_eq!(clamp_height(10_000.0), MAX_HEIGHT);
        assert_eq!(clamp_height(300.0), 300.0);
        assert_eq!(Placement::Bar.width(), BAR_WIDTH);
        assert_eq!(Placement::Toast.width(), TOAST_WIDTH);
    }
}
