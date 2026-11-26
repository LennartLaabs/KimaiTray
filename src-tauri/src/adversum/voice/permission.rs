//! Microphone permission on macOS (TCC), through `AVCaptureDevice`.

use block2::RcBlock;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    /// `AVMediaTypeAudio`, an `NSString` constant.
    static AVMediaTypeAudio: *const AnyObject;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Permission {
    Granted,
    /// Denied by the user, or restricted by a device policy.
    Denied,
    /// macOS has not asked yet.
    Undetermined,
}

impl Permission {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Permission::Granted => "granted",
            Permission::Denied => "denied",
            Permission::Undetermined => "undetermined",
        }
    }
}

/// Maps `AVAuthorizationStatus`: 0 not determined, 1 restricted, 2 denied,
/// 3 authorized.
pub(crate) fn from_status(status: isize) -> Permission {
    match status {
        3 => Permission::Granted,
        0 => Permission::Undetermined,
        _ => Permission::Denied,
    }
}

pub(crate) fn status() -> Permission {
    // SAFETY: A class method without side effects; the media type constant
    // is a valid NSString for the lifetime of the process.
    let status: isize = unsafe {
        msg_send![
            class!(AVCaptureDevice),
            authorizationStatusForMediaType: AVMediaTypeAudio
        ]
    };
    from_status(status)
}

/// Lets macOS ask for microphone access. `done` is called on an arbitrary
/// thread with the user's answer; without a pending question it is called
/// right away with the stored answer.
pub(crate) fn request(done: impl Fn(bool) + Send + 'static) {
    let handler = RcBlock::new(move |granted: Bool| done(granted.as_bool()));
    // SAFETY: The block is copied by AVFoundation and takes one BOOL, as the
    // completion handler of this method requires.
    unsafe {
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: AVMediaTypeAudio,
            completionHandler: &*handler
        ];
    }
}

#[cfg(test)]
mod tests {
    use super::{from_status, Permission};

    #[test]
    fn authorization_status_values_are_mapped() {
        assert_eq!(from_status(0), Permission::Undetermined);
        assert_eq!(from_status(1), Permission::Denied);
        assert_eq!(from_status(2), Permission::Denied);
        assert_eq!(from_status(3), Permission::Granted);
        assert_eq!(Permission::Granted.as_str(), "granted");
        assert_eq!(Permission::Denied.as_str(), "denied");
        assert_eq!(Permission::Undetermined.as_str(), "undetermined");
    }
}
