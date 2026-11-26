//! macOS host for the quick entry bar: a borderless, non-activating `NSPanel`
//! that takes over the Tauri window's content view.
//!
//! This mirrors `crate::tray::platform::macos_panel`, which does the same for
//! the tray popup. A non-activating panel can become the key window (so the
//! text field receives typing) without making this app the active one; when it
//! goes away, keyboard focus is simply back where the user was working.
//!
//! Unlike the tray popup, the panel is positioned here directly, in Cocoa
//! screen points (`NSEvent.mouseLocation`, `NSScreen.visibleFrame`, the
//! panel's own frame). Resizing the hidden Tauri window instead would keep its
//! bottom edge fixed and push a growing bar up and off the screen, and its
//! position API converts between logical and physical pixels with a single
//! scale factor, which is wrong between monitors of different density.

use objc2::{
    class, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol, ProtocolObject},
    MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSBackingStoreType, NSPanel, NSPopUpMenuWindowLevel, NSView, NSWindow,
    NSWindowCollectionBehavior as Behavior, NSWindowDelegate, NSWindowStyleMask,
};
use objc2_foundation::{NSNotification, NSPoint, NSRect};
use std::cell::{Cell, RefCell};
use tauri::WebviewWindow;

use super::quick::{top_left, Area, Placement};

struct PanelState {
    original: Retained<NSWindow>,
    panel: Retained<QuickEntryPanel>,
}

thread_local! {
    static PANEL: RefCell<Option<PanelState>> = const { RefCell::new(None) };
}

define_class!(
    // SAFETY: This class adds no ivars and uses AppKit's designated initializer.
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    struct QuickEntryPanel;

    impl QuickEntryPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            false
        }
    }

    unsafe impl NSObjectProtocol for QuickEntryPanel {}

    // SAFETY: The callbacks run on the AppKit main thread.
    unsafe impl NSWindowDelegate for QuickEntryPanel {
        // Forwarding key changes lets Tauri emit its usual focus events for
        // the window, which the frontend uses to close the bar on blur.
        #[allow(non_snake_case)]
        #[unsafe(method(windowDidBecomeKey:))]
        fn windowDidBecomeKey(&self, notification: &NSNotification) {
            if let Some(delegate) = original_delegate() {
                delegate.windowDidBecomeKey(notification);
            }
        }

        #[allow(non_snake_case)]
        #[unsafe(method(windowDidResignKey:))]
        fn windowDidResignKey(&self, notification: &NSNotification) {
            if let Some(delegate) = original_delegate() {
                delegate.windowDidResignKey(notification);
            }
        }
    }
);

fn original_delegate() -> Option<Retained<ProtocolObject<dyn NSWindowDelegate>>> {
    PANEL.with_borrow(|state| state.as_ref()?.original.delegate())
}

fn create_panel(original: &NSWindow) -> Option<Retained<QuickEntryPanel>> {
    let content = original.contentView()?;
    let allocated = QuickEntryPanel::alloc(original.mtm()).set_ivars(());
    // SAFETY: The allocated object is an NSPanel subclass. NonactivatingPanel
    // has to be part of the style mask from the outset.
    let panel: Retained<QuickEntryPanel> = unsafe {
        objc2::msg_send![
            super(allocated),
            initWithContentRect: original.frame(),
            styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            backing: NSBackingStoreType::Buffered,
            defer: false,
        ]
    };
    // SAFETY: The panel lifetime is managed solely by Retained.
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setFloatingPanel(true);
    panel.setHidesOnDeactivate(false);
    panel.setLevel(NSPopUpMenuWindowLevel);
    panel.setHasShadow(false);
    panel.setOpaque(original.isOpaque());
    panel.setBackgroundColor(Some(&original.backgroundColor()));
    let mut behavior =
        Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary | Behavior::Transient;
    if objc2::available!(macos = 13.0) {
        behavior.insert(Behavior::CanJoinAllApplications);
    }
    panel.setCollectionBehavior(behavior);

    original.orderOut(None);
    // Tao expects its native window to retain a content view even while hidden.
    let placeholder = NSView::initWithFrame(original.mtm().alloc(), content.frame());
    original.setContentView(Some(&placeholder));
    panel.setContentView(Some(&content));
    panel.setDelegate(Some(ProtocolObject::from_ref(&*panel)));
    PANEL.with_borrow_mut(|state| {
        *state = Some(PanelState {
            original: original.retain(),
            panel: panel.clone(),
        });
    });
    Some(panel)
}

fn existing() -> Option<Retained<QuickEntryPanel>> {
    PANEL.with_borrow(|state| state.as_ref().map(|s| s.panel.clone()))
}

thread_local! {
    /// Visible frame of the screen the panel was last presented on, in
    /// Cocoa screen points (origin bottom-left, y growing upward).
    static SCREEN: Cell<Option<NSRect>> = const { Cell::new(None) };
}

fn contains(frame: NSRect, point: NSPoint) -> bool {
    point.x >= frame.origin.x
        && point.x < frame.origin.x + frame.size.width
        && point.y >= frame.origin.y
        && point.y < frame.origin.y + frame.size.height
}

/// The visible frame (without menu bar and Dock) of the screen under the
/// pointer; the main screen when the pointer is on none.
fn visible_frame_under_pointer() -> Option<NSRect> {
    // SAFETY: Plain AppKit class methods, called on the main thread. The
    // screens array and its elements stay alive for the duration of the call.
    unsafe {
        let pointer: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if !screens.is_null() {
            let count: usize = msg_send![screens, count];
            for index in 0..count {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
                let frame: NSRect = msg_send![screen, frame];
                if contains(frame, pointer) {
                    return Some(msg_send![screen, visibleFrame]);
                }
            }
        }
        let main: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
        (!main.is_null()).then(|| msg_send![main, visibleFrame])
    }
}

/// Sizes the panel for what it shows and puts it on its anchor line of the
/// remembered screen. Works in screen points throughout.
fn place(panel: &NSWindow, placement: Placement, height: f64) {
    let Some(screen) = SCREEN.get() else {
        return;
    };
    let size = (placement.width(), height);
    // `top_left` measures downward from the top of the visible area.
    let area = Area {
        x: screen.origin.x,
        y: 0.0,
        width: screen.size.width,
        height: screen.size.height,
    };
    let (x, from_top) = top_left(placement, area, size);
    let mut frame = panel.frame();
    frame.size.width = size.0;
    frame.size.height = size.1;
    frame.origin.x = x;
    // Cocoa's y axis points up: the frame origin is the bottom-left corner.
    frame.origin.y = screen.origin.y + screen.size.height - from_top - size.1;
    if panel.frame() != frame {
        panel.setFrame_display(frame, true);
    }
    log::debug!(
        "Quick entry panel placed: {placement:?} frame=({:.0}, {:.0}, {:.0}x{:.0}) visible=({:.0}, {:.0}, {:.0}x{:.0})",
        frame.origin.x,
        frame.origin.y,
        frame.size.width,
        frame.size.height,
        screen.origin.x,
        screen.origin.y,
        screen.size.width,
        screen.size.height
    );
}

/// Shows the panel on the screen under the pointer. With `key` it takes
/// keyboard input; without, it is only brought to the front and gives up the
/// key status it may have had, so the user's application keeps the keyboard.
pub(super) fn present(
    window: &WebviewWindow,
    placement: Placement,
    key: bool,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let panel = match existing() {
            Some(panel) => panel,
            None => {
                // SAFETY: Tauri owns this window and the callback runs on the UI thread.
                let Some(original) = (unsafe { webview.ns_window().cast::<NSWindow>().as_ref() })
                else {
                    return;
                };
                let Some(panel) = create_panel(original) else {
                    log::warn!("Cannot create quick entry panel: content view is unavailable");
                    return;
                };
                panel
            }
        };
        SCREEN.set(visible_frame_under_pointer());
        // Keep the current height; the frontend reports the real one right after.
        let height = super::quick::clamp_height(panel.frame().size.height);
        if key {
            place(&panel, placement, height);
            panel.orderFrontRegardless();
            panel.makeKeyWindow();
        } else {
            // Ordering out drops the key status; AppKit hands it back to the
            // active application. Then the panel returns without it.
            panel.orderOut(None);
            place(&panel, placement, height);
            panel.orderFrontRegardless();
        }
        log::debug!(
            "Quick entry panel presented: {placement:?} requested_key={key}, key={}, visible={}",
            panel.isKeyWindow(),
            panel.isVisible()
        );
    })
}

pub(super) fn hide(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|_| {
        if let Some(panel) = existing() {
            panel.orderOut(None);
        }
    })
}

/// Gives the panel a new height while its anchored edge stays in place.
pub(super) fn resize(
    window: &WebviewWindow,
    placement: Placement,
    height: f64,
) -> tauri::Result<()> {
    window.with_webview(move |_| {
        if let Some(panel) = existing() {
            place(&panel, placement, height);
        }
    })
}
