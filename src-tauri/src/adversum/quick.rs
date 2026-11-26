//! The floating quick entry bar: a small window above everything else, at
//! the top center of the screen the pointer is on.
//!
//! On macOS the webview is hosted in a non-activating panel
//! (`quick_panel.rs`), so typing into the bar never activates this app and
//! the user's own application keeps its place.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

pub(crate) const WINDOW_LABEL: &str = "adversum-quick";
const WIDTH: f64 = 680.0;
const MIN_HEIGHT: f64 = 60.0;
const MAX_HEIGHT: f64 = 560.0;
/// Distance from the top of the screen, as a share of its height.
const TOP_FRACTION: f64 = 0.16;
const SHOWN_EVENT: &str = "adversum://quick-shown";
static VISIBLE: AtomicBool = AtomicBool::new(false);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// Top-center position on a monitor, in logical points. Inputs are the
/// monitor's physical origin and size and its scale factor.
fn top_center(origin: (f64, f64), size: (f64, f64), scale: f64) -> (f64, f64) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let (width, height) = (size.0 / scale, size.1 / scale);
    (
        origin.0 / scale + ((width - WIDTH) / 2.0).max(0.0),
        origin.1 / scale + height * TOP_FRACTION,
    )
}

fn position(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    if !crate::platform::supports_window_positioning() {
        return Ok(());
    }
    let cursor = app.cursor_position()?;
    let monitor = match app.monitor_from_point(cursor.x, cursor.y)? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let origin = monitor.position();
    let size = monitor.size();
    let (x, y) = top_center(
        (f64::from(origin.x), f64::from(origin.y)),
        (f64::from(size.width), f64::from(size.height)),
        monitor.scale_factor(),
    );
    window.set_position(LogicalPosition::new(x, y))
}

pub(crate) fn show(app: &AppHandle) {
    let Some(window) = window(app) else {
        return;
    };
    if let Err(error) = position(app, &window) {
        log::warn!("Failed to position the quick entry bar: {error}");
    }
    #[cfg(target_os = "macos")]
    let shown = super::quick_panel::show(&window, true);
    #[cfg(not(target_os = "macos"))]
    let shown = window.show().and_then(|()| window.set_focus());
    if let Err(error) = shown {
        log::warn!("Failed to show the quick entry bar: {error}");
        return;
    }
    VISIBLE.store(true, Ordering::SeqCst);
    let _ = window.emit(SHOWN_EVENT, ());
}

pub(crate) fn hide(app: &AppHandle) {
    VISIBLE.store(false, Ordering::SeqCst);
    let Some(window) = window(app) else {
        return;
    };
    #[cfg(target_os = "macos")]
    let hidden = super::quick_panel::hide(&window);
    #[cfg(not(target_os = "macos"))]
    let hidden = window.hide();
    if let Err(error) = hidden {
        log::warn!("Failed to hide the quick entry bar: {error}");
    }
}

pub(crate) fn toggle(app: &AppHandle) {
    if VISIBLE.load(Ordering::SeqCst) {
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

/// Keeps the bar on screen (for the confirmation toast) but hands keyboard
/// focus back to the application the user was working in.
#[tauri::command]
pub fn adversum_quick_release_focus(app: AppHandle) -> Result<(), String> {
    let Some(window) = window(&app) else {
        return Ok(());
    };
    #[cfg(target_os = "macos")]
    return super::quick_panel::show(&window, false).map_err(|error| error.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}

/// Fits the window to its content; the width is fixed.
#[tauri::command]
pub fn adversum_quick_resize(app: AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() {
        return Err("Invalid quick entry height".into());
    }
    let Some(window) = window(&app) else {
        return Ok(());
    };
    window
        .set_size(LogicalSize::new(
            WIDTH,
            height.clamp(MIN_HEIGHT, MAX_HEIGHT),
        ))
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    super::quick_panel::sync_frame(&window).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{top_center, TOP_FRACTION, WIDTH};

    #[test]
    fn bar_is_centered_near_the_top_of_the_monitor() {
        // 1440x900 pt display at 2x, at the origin.
        let (x, y) = top_center((0.0, 0.0), (2880.0, 1800.0), 2.0);
        assert_eq!(x, (1440.0 - WIDTH) / 2.0);
        assert_eq!(y, 900.0 * TOP_FRACTION);
    }

    #[test]
    fn bar_follows_a_secondary_monitor_with_its_own_scale() {
        // 1920x1080 pt display at 1x, to the right of a 1440 pt wide one.
        let (x, y) = top_center((1440.0, -180.0), (1920.0, 1080.0), 1.0);
        assert_eq!(x, 1440.0 + (1920.0 - WIDTH) / 2.0);
        assert_eq!(y, -180.0 + 1080.0 * TOP_FRACTION);
    }

    #[test]
    fn narrow_or_unscaled_monitors_do_not_push_the_bar_off_screen() {
        let (x, _) = top_center((0.0, 0.0), (500.0, 400.0), 1.0);
        assert_eq!(x, 0.0);
        let (x, y) = top_center((100.0, 50.0), (2000.0, 1000.0), 0.0);
        assert_eq!(x, 100.0 + (2000.0 - WIDTH) / 2.0);
        assert_eq!(y, 50.0 + 1000.0 * TOP_FRACTION);
    }
}
