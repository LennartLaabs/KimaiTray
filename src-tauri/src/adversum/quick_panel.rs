//! macOS host for the quick entry bar: a borderless, non-activating `NSPanel`
//! that takes over the Tauri window's content view.
//!
//! This mirrors `crate::tray::platform::macos_panel`, which does the same for
//! the tray popup. A non-activating panel can become the key window (so the
//! text field receives typing) without making this app the active one; when it
//! goes away, keyboard focus is simply back where the user was working.

use objc2::{
    define_class,
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
    MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSBackingStoreType, NSPanel, NSPopUpMenuWindowLevel, NSView, NSWindow,
    NSWindowCollectionBehavior as Behavior, NSWindowDelegate, NSWindowStyleMask,
};
use objc2_foundation::NSNotification;
use std::cell::RefCell;
use tauri::WebviewWindow;

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

fn copy_frame(original: &NSWindow, panel: &NSWindow) {
    let frame = original.frame();
    if panel.frame() != frame {
        panel.setFrame_display(frame, true);
    }
}

fn existing() -> Option<(Retained<NSWindow>, Retained<QuickEntryPanel>)> {
    PANEL.with_borrow(|state| {
        state
            .as_ref()
            .map(|s| (s.original.clone(), s.panel.clone()))
    })
}

/// Shows the panel. With `key` it takes keyboard input; without, it is only
/// brought to the front and gives up the key status it may have had.
pub(super) fn show(window: &WebviewWindow, key: bool) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let (original, panel) = match existing() {
            Some(windows) => windows,
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
                (original.retain(), panel)
            }
        };
        copy_frame(&original, &panel);
        if key {
            panel.orderFrontRegardless();
            panel.makeKeyWindow();
        } else {
            // Ordering out drops the key status; AppKit hands it back to the
            // active application. Then the panel returns without it.
            panel.orderOut(None);
            panel.orderFrontRegardless();
        }
        log::debug!(
            "Quick entry panel presented: requested_key={key}, key={}, visible={}",
            panel.isKeyWindow(),
            panel.isVisible()
        );
    })
}

pub(super) fn hide(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|_| {
        if let Some((_, panel)) = existing() {
            panel.orderOut(None);
        }
    })
}

/// Applies the Tauri window's current frame (size and position) to the panel.
pub(super) fn sync_frame(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|_| {
        if let Some((original, panel)) = existing() {
            copy_frame(&original, &panel);
        }
    })
}
